import { Keypair, StrKey } from '@stellar/stellar-base';
import { ClaimError } from './errors.js';
import { assertReplayFields, encodeClaim } from './encode.js';
import type { Claim, ClaimContext } from './types.js';

/** Accepted forms of an issuer secret: `S...` strkey, 32-byte seed, or a `Keypair`. */
export type IssuerSecret = string | Uint8Array | Keypair;

function toKeypair(secret: IssuerSecret): Keypair {
  if (typeof secret === 'string') {
    if (!StrKey.isValidEd25519SecretSeed(secret)) {
      throw new ClaimError('InvalidInput', 'issuerSecret: expected a valid S... secret key');
    }
    return Keypair.fromSecret(secret);
  }
  if (secret instanceof Uint8Array) {
    if (secret.length !== 32) {
      throw new ClaimError('InvalidInput', 'issuerSecret: a raw seed must be 32 bytes');
    }
    return Keypair.fromRawEd25519Seed(secret as never);
  }
  if (secret instanceof Keypair) {
    if (!secret.canSign()) throw new ClaimError('InvalidInput', 'issuerSecret: the Keypair has no secret key');
    return secret;
  }
  throw new ClaimError('InvalidInput', 'issuerSecret: expected an S... string, a 32-byte seed or a Keypair');
}

/**
 * The 32-byte Ed25519 public key for an issuer secret. Use it as `claim.issuer`.
 *
 * @example
 * const issuer = issuerPublicKey(issuerSecret);
 */
export function issuerPublicKey(secret: IssuerSecret): Uint8Array {
  return new Uint8Array(toKeypair(secret).rawPublicKey());
}

/**
 * Encode and sign a claim on the issuer's backend. Never ship the secret to a browser.
 *
 * @example
 * const { preimage, signature } = signClaim(claim, ctx, 'S...');
 *
 * @returns the 256-byte `preimage` and the 64-byte Ed25519 `signature` over it
 * @throws {ClaimError} `IssuerMismatch` when the secret's public key is not `claim.issuer`;
 *   `InvalidReplayFields` when the inactive replay field is set; `InvalidInput` for malformed arguments.
 */
export function signClaim(
  claim: Claim,
  ctx: ClaimContext,
  issuerSecret: IssuerSecret,
): { preimage: Uint8Array; signature: Uint8Array } {
  const preimage = encodeClaim(claim, ctx);
  assertReplayFields(claim);
  const keypair = toKeypair(issuerSecret);
  // check:issuer-match begin
  const publicKey = new Uint8Array(keypair.rawPublicKey());
  if (!publicKey.every((b, i) => b === claim.issuer[i])) {
    throw new ClaimError('IssuerMismatch', 'the secret key does not belong to claim.issuer');
  }
  // check:issuer-match end
  return { preimage, signature: new Uint8Array(keypair.sign(preimage as never)) };
}
