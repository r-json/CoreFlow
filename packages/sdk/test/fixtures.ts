import { Keypair, Networks, StrKey } from '@stellar/stellar-base';
import { ClaimError, claimType, issuerPublicKey, sha256, type Claim, type ClaimContext, type ClaimErrorCode } from '../src/index.js';
import { expect } from 'vitest';

export const seed = sha256('sdk-unit-test-issuer');
export const keypair = Keypair.fromRawEd25519Seed(Buffer.from(seed));
export const secret = keypair.secret();
export const issuer = issuerPublicKey(seed);

export const contractId = StrKey.encodeContract(Buffer.from(sha256('sdk-unit-test-contract-0')));
export const otherContractId = StrKey.encodeContract(Buffer.from(sha256('sdk-unit-test-contract-1')));
export const ctx: ClaimContext = { networkPassphrase: Networks.TESTNET, contractId };

export const T0 = 1_790_000_000n;

export function makeClaim(over: Partial<Claim> = {}): Claim {
  return {
    issuer,
    claimType: claimType('marketplace.delivery.v1'),
    subject: sha256('order:42'),
    payloadHash: sha256('delivered'),
    payloadEncoding: 'raw',
    replay: { mode: 'sequence', nonce: 7n },
    issuedAt: T0,
    expiresAt: T0 + 3600n,
    ...over,
  };
}

/** Assert that `fn` throws a ClaimError with the given code. */
export function expectClaimError(fn: () => unknown, code: ClaimErrorCode): ClaimError {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(ClaimError);
    expect((e as ClaimError).code).toBe(code);
    expect((e as ClaimError).nextStep.length).toBeGreaterThan(0);
    return e as ClaimError;
  }
  throw new Error(`expected ClaimError ${code}, but nothing was thrown`);
}
