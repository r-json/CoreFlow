import { describe, expect, it } from 'vitest';
import { Networks } from '@stellar/stellar-base';
import { PREIMAGE_LENGTH, contractDigest, encodeClaim, networkId, randomClaimId, sha256, toHex } from '../src/index.js';
import { ctx, expectClaimError, issuer, makeClaim, otherContractId } from './fixtures.js';

const slice = (b: Uint8Array, from: number, len: number) => b.slice(from, from + len);
const U64_MAX = 0xffffffffffffffffn;

describe('encodeClaim layout', () => {
  const claim = makeClaim();
  const p = encodeClaim(claim, ctx);
  const view = new DataView(p.buffer);

  it('is exactly 256 bytes', () => {
    expect(PREIMAGE_LENGTH).toBe(256);
    expect(p).toHaveLength(256);
  });
  it('writes magic and wire version', () => {
    expect(toHex(slice(p, 0, 4))).toBe('4346434c');
    expect(view.getUint16(4)).toBe(1);
  });
  it('binds network and contract', () => {
    expect(slice(p, 6, 32)).toEqual(networkId(Networks.TESTNET));
    expect(slice(p, 38, 32)).toEqual(contractDigest(ctx.contractId));
  });
  it('writes the claim fields at the documented offsets', () => {
    expect(slice(p, 70, 32)).toEqual(issuer);
    expect(slice(p, 102, 32)).toEqual(claim.claimType);
    expect(slice(p, 134, 32)).toEqual(claim.subject);
    expect(slice(p, 166, 32)).toEqual(claim.payloadHash);
    expect(p[198]).toBe(0);
    expect(p[199]).toBe(0);
    expect(view.getBigUint64(200)).toBe(7n);
    expect(slice(p, 208, 32)).toEqual(new Uint8Array(32));
    expect(view.getBigUint64(240)).toBe(claim.issuedAt);
    expect(view.getBigUint64(248)).toBe(claim.expiresAt);
  });
  it('is deterministic', () => {
    expect(encodeClaim(makeClaim(), ctx)).toEqual(p);
  });
});

describe('encodeClaim modes and encodings', () => {
  it("encodes payloadEncoding 'xdr' as 1", () => {
    expect(encodeClaim(makeClaim({ payloadEncoding: 'xdr' }), ctx)[198]).toBe(1);
  });
  it('encodes unique-id: mode 1, nonce 0, claim id in place', () => {
    const claimId = randomClaimId();
    const p = encodeClaim(makeClaim({ replay: { mode: 'unique-id', claimId } }), ctx);
    expect(p[199]).toBe(1);
    expect(new DataView(p.buffer).getBigUint64(200)).toBe(0n);
    expect(slice(p, 208, 32)).toEqual(claimId);
  });
  it('encodes sequence nonce 0 and 2^64-1', () => {
    const at = (nonce: bigint) =>
      new DataView(encodeClaim(makeClaim({ replay: { mode: 'sequence', nonce } }), ctx).buffer).getBigUint64(200);
    expect(at(0n)).toBe(0n);
    expect(at(U64_MAX)).toBe(U64_MAX);
  });
  it('encodes issuedAt 0 and expiresAt 2^64-1', () => {
    const p = encodeClaim(makeClaim({ issuedAt: 0n, expiresAt: U64_MAX }), ctx);
    const view = new DataView(p.buffer);
    expect(view.getBigUint64(240)).toBe(0n);
    expect(view.getBigUint64(248)).toBe(U64_MAX);
  });
  it('zeroes the inactive replay field even if an untyped caller set it', () => {
    const stray = { mode: 'sequence', nonce: 3n, claimId: new Uint8Array(32) } as never;
    expect(slice(encodeClaim(makeClaim({ replay: stray }), ctx), 208, 32)).toEqual(new Uint8Array(32));
    const strayNonce = { mode: 'unique-id', claimId: sha256('x'), nonce: 0n } as never;
    expect(new DataView(encodeClaim(makeClaim({ replay: strayNonce }), ctx).buffer).getBigUint64(200)).toBe(0n);
  });
});

describe('encodeClaim context binding', () => {
  it('changes with the network passphrase', () => {
    const a = encodeClaim(makeClaim(), ctx);
    const b = encodeClaim(makeClaim(), { ...ctx, networkPassphrase: Networks.PUBLIC });
    expect(a).not.toEqual(b);
  });
  it('changes with the contract id', () => {
    const a = encodeClaim(makeClaim(), ctx);
    const b = encodeClaim(makeClaim(), { ...ctx, contractId: otherContractId });
    expect(a).not.toEqual(b);
  });
});

describe('encodeClaim input validation', () => {
  const bad = (claim: unknown, c: unknown = ctx) => expectClaimError(() => encodeClaim(claim as never, c as never), 'InvalidInput');

  it.each(['issuer', 'claimType', 'subject', 'payloadHash'] as const)('rejects a %s of the wrong length', (field) => {
    bad(makeClaim({ [field]: new Uint8Array(31) }));
    bad(makeClaim({ [field]: new Uint8Array(33) }));
    bad(makeClaim({ [field]: [1, 2, 3] as never }));
  });
  it('rejects a unique-id claimId of the wrong length', () => {
    bad(makeClaim({ replay: { mode: 'unique-id', claimId: new Uint8Array(31) } }));
  });
  it.each([-1n, U64_MAX + 1n])('rejects out-of-range u64 %s', (v) => {
    bad(makeClaim({ issuedAt: v }));
    bad(makeClaim({ expiresAt: v }));
    bad(makeClaim({ replay: { mode: 'sequence', nonce: v } }));
  });
  it('rejects numbers where bigints are required', () => {
    bad(makeClaim({ issuedAt: 5 as never }));
    bad(makeClaim({ replay: { mode: 'sequence', nonce: 1 as never } }));
  });
  it('rejects an unknown payload encoding, replay mode, or a missing replay', () => {
    bad(makeClaim({ payloadEncoding: 'json' as never }));
    bad(makeClaim({ replay: { mode: 'other' } as never }));
    bad(makeClaim({ replay: undefined as never }));
  });
  it('rejects a non-object claim or context', () => {
    bad(null);
    bad(makeClaim(), null);
  });
  it('rejects a bad passphrase or contract id', () => {
    bad(makeClaim(), { ...ctx, networkPassphrase: 7 });
    bad(makeClaim(), { ...ctx, contractId: 'nope' });
    bad(makeClaim(), { ...ctx, contractId: undefined });
  });
});
