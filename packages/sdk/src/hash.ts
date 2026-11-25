import { StrKey, hash } from '@stellar/stellar-base';
import { ClaimError } from './errors.js';

/** SHA-256. Strings are hashed as UTF-8. Returns a plain 32-byte `Uint8Array`. */
export function sha256(data: Uint8Array | string): Uint8Array {
  if (typeof data !== 'string' && !(data instanceof Uint8Array)) {
    throw new ClaimError('InvalidInput', 'sha256: expected a string or Uint8Array');
  }
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  return new Uint8Array(hash(bytes as never));
}

/**
 * Claim type id: `SHA-256(name)`.
 *
 * @example
 * const type = claimType('marketplace.delivery.v1');
 */
export function claimType(name: string): Uint8Array {
  if (typeof name !== 'string' || name.length === 0) {
    throw new ClaimError('InvalidInput', 'claimType: expected a non-empty string');
  }
  return sha256(name);
}

/** Network id: `SHA-256(network passphrase)`, the value Soroban exposes as `ledger().network_id()`. */
export function networkId(passphrase: string): Uint8Array {
  if (typeof passphrase !== 'string') {
    throw new ClaimError('InvalidInput', 'networkId: expected the network passphrase as a string');
  }
  return sha256(passphrase);
}

/**
 * Contract digest: SHA-256 of the 40-byte XDR of `ScVal::Address(contract)`,
 * i.e. `0x00000012 || 0x00000001 || 32-byte contract hash`.
 *
 * @param contractId contract address as a `C...` strkey
 */
export function contractDigest(contractId: string): Uint8Array {
  if (typeof contractId !== 'string' || !StrKey.isValidContract(contractId)) {
    throw new ClaimError('InvalidInput', 'contractId: expected a valid C... contract strkey');
  }
  const xdr = new Uint8Array(40);
  xdr.set([0x00, 0x00, 0x00, 0x12, 0x00, 0x00, 0x00, 0x01]);
  xdr.set(new Uint8Array(StrKey.decodeContract(contractId)), 8);
  return sha256(xdr);
}

/** 32 random bytes from `crypto.getRandomValues`, for unique-id claims. */
export function randomClaimId(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(32));
}
