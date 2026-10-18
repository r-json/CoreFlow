import { describe, expect, it } from 'vitest';
import { Keypair } from '@stellar/stellar-base';
import { ClaimError, encodeClaim, issuerPublicKey, sha256, signClaim, toHex, verifyClaim } from '../src/index.js';
import { ctx, expectClaimError, issuer, keypair, makeClaim, secret, seed, T0 } from './fixtures.js';

describe('issuerPublicKey', () => {
  it('derives the same public key from every secret form', () => {
    expect(issuerPublicKey(secret)).toEqual(issuer);
    expect(issuerPublicKey(seed)).toEqual(issuer);
    expect(issuerPublicKey(keypair)).toEqual(issuer);
    expect(Object.getPrototypeOf(issuerPublicKey(secret))).toBe(Uint8Array.prototype);
  });
  it('rejects malformed secrets', () => {
    expectClaimError(() => issuerPublicKey('S123'), 'InvalidInput');
    expectClaimError(() => issuerPublicKey(keypair.publicKey()), 'InvalidInput');
    expectClaimError(() => issuerPublicKey(new Uint8Array(31)), 'InvalidInput');
    expectClaimError(() => issuerPublicKey(new Uint8Array(33)), 'InvalidInput');
    expectClaimError(() => issuerPublicKey(Keypair.fromPublicKey(keypair.publicKey())), 'InvalidInput');
    expectClaimError(() => issuerPublicKey(42 as never), 'InvalidInput');
  });
});

describe('signClaim', () => {
  const claim = makeClaim();

  it('returns the preimage and a 64-byte signature that verify', () => {
    const { preimage, signature } = signClaim(claim, ctx, secret);
    expect(preimage).toEqual(encodeClaim(claim, ctx));
    expect(preimage).toHaveLength(256);
    expect(signature).toHaveLength(64);
    expect(Object.getPrototypeOf(signature)).toBe(Uint8Array.prototype);
    expect(keypair.verify(preimage as never, signature as never)).toBe(true);
    verifyClaim(claim, ctx, signature, { now: T0 });
  });
  it('produces the same signature from an S... string, a seed and a Keypair', () => {
    const a = signClaim(claim, ctx, secret).signature;
    expect(signClaim(claim, ctx, seed).signature).toEqual(a);
    expect(signClaim(claim, ctx, keypair).signature).toEqual(a);
  });
  it('is deterministic', () => {
    expect(signClaim(claim, ctx, secret).signature).toEqual(signClaim(claim, ctx, secret).signature);
  });
  it('signs unique-id claims and extreme u64 values', () => {
    const c = makeClaim({ replay: { mode: 'unique-id', claimId: sha256('id') }, issuedAt: 0n, expiresAt: 0xffffffffffffffffn });
    const { signature } = signClaim(c, ctx, secret);
    verifyClaim(c, ctx, signature, { now: 0 });
  });
  it('throws IssuerMismatch when the secret belongs to another key', () => {
    const other = Keypair.fromRawEd25519Seed(Buffer.from(sha256('another issuer')));
    expectClaimError(() => signClaim(claim, ctx, other.secret()), 'IssuerMismatch');
    expectClaimError(() => signClaim(claim, ctx, sha256('another issuer')), 'IssuerMismatch');
    expectClaimError(() => signClaim(claim, ctx, other), 'IssuerMismatch');
  });
  it('throws InvalidReplayFields for a claim carrying the inactive replay field', () => {
    const withId = makeClaim({ replay: { mode: 'sequence', nonce: 1n, claimId: sha256('x') } as never });
    expectClaimError(() => signClaim(withId, ctx, secret), 'InvalidReplayFields');
    const withNonce = makeClaim({ replay: { mode: 'unique-id', claimId: sha256('x'), nonce: 4n } as never });
    expectClaimError(() => signClaim(withNonce, ctx, secret), 'InvalidReplayFields');
  });
  it('throws InvalidInput for malformed claim, context or secret', () => {
    expectClaimError(() => signClaim(makeClaim({ subject: new Uint8Array(3) }), ctx, secret), 'InvalidInput');
    expectClaimError(() => signClaim(claim, { ...ctx, contractId: 'x' }, secret), 'InvalidInput');
    expectClaimError(() => signClaim(claim, ctx, 'not a secret'), 'InvalidInput');
    expect(() => signClaim(claim, ctx, new Uint8Array(5))).toThrow(ClaimError);
  });
});

describe('signClaim with a Keypair from another stellar-base copy', () => {
  it('accepts a keypair-shaped object and signs identically', () => {
    const claim = makeClaim();
    const own = signClaim(claim, ctx, secret).signature;
    // Simulates a Keypair created by a different installed copy of the library.
    const foreign = { canSign: () => true, rawSecretKey: () => Buffer.from(seed), publicKey: () => keypair.publicKey() };
    expect(toHex(signClaim(claim, ctx, foreign as never).signature)).toBe(toHex(own));
  });

  it('refuses a keypair-shaped object without a secret', () => {
    const foreign = { canSign: () => false, rawSecretKey: () => { throw new Error('no secret'); } };
    expectClaimError(() => signClaim(makeClaim(), ctx, foreign as never), 'InvalidInput');
  });
});
