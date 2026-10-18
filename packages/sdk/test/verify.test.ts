import { describe, expect, it } from 'vitest';
import { Networks } from '@stellar/stellar-base';
import { sha256, signClaim, verifyClaim, type Claim } from '../src/index.js';
import { ctx, expectClaimError, issuer, makeClaim, otherContractId, secret, T0 } from './fixtures.js';

const claim = makeClaim();
const signature = signClaim(claim, ctx, secret).signature;
const now = T0 + 60n;

describe('verifyClaim success', () => {
  it('returns undefined for a valid claim', () => {
    expect(verifyClaim(claim, ctx, signature, { now })).toBeUndefined();
  });
  it('accepts now as a number or a bigint', () => {
    verifyClaim(claim, ctx, signature, { now: Number(now) });
    verifyClaim(claim, ctx, signature, { now });
  });
  it('defaults now to the system clock', () => {
    const t = BigInt(Math.floor(Date.now() / 1000));
    const live = makeClaim({ issuedAt: t - 10n, expiresAt: t + 600n });
    verifyClaim(live, ctx, signClaim(live, ctx, secret).signature);
    const old = makeClaim({ issuedAt: 1000n, expiresAt: 2000n });
    expectClaimError(() => verifyClaim(old, ctx, signClaim(old, ctx, secret).signature), 'ClaimExpired');
  });
  it('accepts unique-id and xdr claims', () => {
    const c = makeClaim({ payloadEncoding: 'xdr', replay: { mode: 'unique-id', claimId: sha256('a') } });
    verifyClaim(c, ctx, signClaim(c, ctx, secret).signature, { now });
  });
});

describe('verifyClaim expiry boundary', () => {
  it('now == issuedAt is valid', () => {
    verifyClaim(claim, ctx, signature, { now: claim.issuedAt });
  });
  it('now == expiresAt is valid', () => {
    verifyClaim(claim, ctx, signature, { now: claim.expiresAt });
  });
  it('now == expiresAt + 1 is ClaimExpired', () => {
    expectClaimError(() => verifyClaim(claim, ctx, signature, { now: claim.expiresAt + 1n }), 'ClaimExpired');
  });
  it('now == 2^64-1 expires a normal claim; a claim with expiresAt 2^64-1 stays valid at 2^64-1', () => {
    const max = 0xffffffffffffffffn;
    expectClaimError(() => verifyClaim(claim, ctx, signature, { now: max }), 'ClaimExpired');
    const forever = makeClaim({ expiresAt: max });
    verifyClaim(forever, ctx, signClaim(forever, ctx, secret).signature, { now: max });
  });
});

describe('verifyClaim window', () => {
  it('rejects expiresAt == issuedAt and expiresAt < issuedAt', () => {
    for (const expiresAt of [T0, T0 - 1n]) {
      const c = makeClaim({ expiresAt });
      expectClaimError(() => verifyClaim(c, ctx, signClaim(c, ctx, secret).signature, { now: T0 }), 'InvalidWindow');
    }
  });
  it('reports the window before expiry', () => {
    const c = makeClaim({ expiresAt: T0 });
    expectClaimError(() => verifyClaim(c, ctx, signClaim(c, ctx, secret).signature, { now: T0 + 99n }), 'InvalidWindow');
  });
  it('accepts a window of one second', () => {
    const c = makeClaim({ expiresAt: T0 + 1n });
    verifyClaim(c, ctx, signClaim(c, ctx, secret).signature, { now: T0 + 1n });
  });
});

describe('verifyClaim replay fields', () => {
  it('rejects a sequence claim with a non-zero claim id', () => {
    const bad = makeClaim({ replay: { mode: 'sequence', nonce: 7n, claimId: sha256('x') } as never });
    expectClaimError(() => verifyClaim(bad, ctx, signature, { now }), 'InvalidReplayFields');
  });
  it('rejects a unique-id claim with a non-zero nonce', () => {
    const good = makeClaim({ replay: { mode: 'unique-id', claimId: sha256('x') } });
    const sig = signClaim(good, ctx, secret).signature;
    const bad = makeClaim({ replay: { mode: 'unique-id', claimId: sha256('x'), nonce: 9n } as never });
    expectClaimError(() => verifyClaim(bad, ctx, sig, { now }), 'InvalidReplayFields');
  });
  it('accepts an explicit all-zero claim id on a sequence claim', () => {
    const c = makeClaim({ replay: { mode: 'sequence', nonce: 7n, claimId: new Uint8Array(32) } as never });
    verifyClaim(c, ctx, signature, { now });
  });
  it('reports replay fields before the signature', () => {
    const bad = makeClaim({ replay: { mode: 'sequence', nonce: 7n, claimId: sha256('x') } as never });
    expectClaimError(() => verifyClaim(bad, ctx, new Uint8Array(64), { now }), 'InvalidReplayFields');
  });
});

describe('verifyClaim signature', () => {
  it('rejects an all-zero signature', () => {
    expectClaimError(() => verifyClaim(claim, ctx, new Uint8Array(64), { now }), 'InvalidSignature');
  });
  it('rejects a flipped signature bit', () => {
    const s = signature.slice();
    s[10] = (s[10] ?? 0) ^ 1;
    expectClaimError(() => verifyClaim(claim, ctx, s, { now }), 'InvalidSignature');
  });
  it.each<[string, Partial<Claim>]>([
    ['subject', { subject: sha256('order:43') }],
    ['claimType', { claimType: sha256('other.type') }],
    ['payloadHash', { payloadHash: sha256('other payload') }],
    ['payloadEncoding', { payloadEncoding: 'xdr' }],
    ['nonce', { replay: { mode: 'sequence', nonce: 8n } }],
    ['replay mode', { replay: { mode: 'unique-id', claimId: new Uint8Array(32) } }],
    ['issuedAt', { issuedAt: T0 + 1n }],
    ['expiresAt', { expiresAt: T0 + 7200n }],
  ])('rejects a tampered %s', (_name, over) => {
    expectClaimError(() => verifyClaim(makeClaim(over), ctx, signature, { now }), 'InvalidSignature');
  });
  it('rejects another network', () => {
    expectClaimError(() => verifyClaim(claim, { ...ctx, networkPassphrase: Networks.PUBLIC }, signature, { now }), 'InvalidSignature');
  });
  it('rejects another contract', () => {
    expectClaimError(() => verifyClaim(claim, { ...ctx, contractId: otherContractId }, signature, { now }), 'InvalidSignature');
  });
  it('rejects a claim naming another issuer', () => {
    const other = sha256('someone else');
    expectClaimError(() => verifyClaim(makeClaim({ issuer: other }), ctx, signature, { now }), 'InvalidSignature');
    expect(issuer).not.toEqual(other);
  });
});

describe('verifyClaim input validation', () => {
  it('rejects a signature that is not 64 bytes', () => {
    expectClaimError(() => verifyClaim(claim, ctx, new Uint8Array(63), { now }), 'InvalidInput');
    expectClaimError(() => verifyClaim(claim, ctx, new Uint8Array(65), { now }), 'InvalidInput');
    expectClaimError(() => verifyClaim(claim, ctx, 'sig' as never, { now }), 'InvalidInput');
  });
  it('rejects a bad now', () => {
    expectClaimError(() => verifyClaim(claim, ctx, signature, { now: -1 }), 'InvalidInput');
    expectClaimError(() => verifyClaim(claim, ctx, signature, { now: 1.5 }), 'InvalidInput');
    expectClaimError(() => verifyClaim(claim, ctx, signature, { now: NaN }), 'InvalidInput');
    expectClaimError(() => verifyClaim(claim, ctx, signature, { now: -1n }), 'InvalidInput');
    expectClaimError(() => verifyClaim(claim, ctx, signature, { now: 0x10000000000000000n }), 'InvalidInput');
  });
  it('rejects a malformed claim or context', () => {
    expectClaimError(() => verifyClaim(makeClaim({ subject: new Uint8Array(1) }), ctx, signature, { now }), 'InvalidInput');
    expectClaimError(() => verifyClaim(claim, { ...ctx, contractId: 'C' }, signature, { now }), 'InvalidInput');
  });
});
