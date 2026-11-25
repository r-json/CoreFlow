import { StrKey } from '@stellar/stellar-base';
import { assertBytes } from './bytes.js';
import { ClaimError } from './errors.js';

/**
 * Issuer key from its `G...` strkey form. An issuer key is a plain Ed25519
 * key; it does not need to be a funded Stellar account.
 *
 * @example
 * claim.issuer = issuerFromStrkey('GB...');
 *
 * @throws {ClaimError} `InvalidInput` unless `address` is a valid `G...` strkey.
 */
export function issuerFromStrkey(address: string): Uint8Array {
  if (typeof address !== 'string' || !StrKey.isValidEd25519PublicKey(address)) {
    throw new ClaimError('InvalidInput', 'issuer: expected a valid G... public key');
  }
  return new Uint8Array(StrKey.decodeEd25519PublicKey(address));
}

/**
 * `G...` strkey form of a 32-byte issuer key, for display and for tools that
 * expect a Stellar address.
 *
 * @throws {ClaimError} `InvalidInput` unless `issuer` is a 32-byte `Uint8Array`.
 */
export function issuerToStrkey(issuer: Uint8Array): string {
  assertBytes(issuer, 32, 'issuer');
  return StrKey.encodeEd25519PublicKey(issuer as never);
}
