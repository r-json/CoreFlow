import { sha256 } from './hash.js';

/** Name of one region of the 256-byte preimage. Matches the field names in claim-format.md. */
export type PreimageFieldName =
  | 'magic'
  | 'version'
  | 'network_id'
  | 'contract'
  | 'issuer'
  | 'claim_type'
  | 'subject'
  | 'payload_hash'
  | 'payload_encoding'
  | 'replay_mode'
  | 'nonce'
  | 'claim_id'
  | 'issued_at'
  | 'expires_at';

/** One region of the preimage: where it starts and how many bytes it takes. */
export interface PreimageField {
  readonly name: PreimageFieldName;
  readonly offset: number;
  readonly size: number;
}

const field = (name: PreimageFieldName, offset: number, size: number): PreimageField =>
  Object.freeze({ name, offset, size });

/**
 * Byte layout of the wire-version-1 preimage (claim-format.md section 2), in order.
 * The regions are contiguous and cover all 256 bytes.
 *
 * @example
 * for (const f of PREIMAGE_LAYOUT) console.log(f.name, preimage.subarray(f.offset, f.offset + f.size));
 */
export const PREIMAGE_LAYOUT: readonly PreimageField[] = Object.freeze([
  field('magic', 0, 4),
  field('version', 4, 2),
  field('network_id', 6, 32),
  field('contract', 38, 32),
  field('issuer', 70, 32),
  field('claim_type', 102, 32),
  field('subject', 134, 32),
  field('payload_hash', 166, 32),
  field('payload_encoding', 198, 1),
  field('replay_mode', 199, 1),
  field('nonce', 200, 8),
  field('claim_id', 208, 32),
  field('issued_at', 240, 8),
  field('expires_at', 248, 8),
]);

/** A Stellar network whose passphrase the SDK recognises. */
export interface KnownNetwork {
  readonly name: 'mainnet' | 'testnet' | 'futurenet';
  readonly passphrase: string;
}

/** Passphrases of the public Stellar networks. */
export const KNOWN_NETWORKS: readonly KnownNetwork[] = Object.freeze([
  Object.freeze({ name: 'mainnet', passphrase: 'Public Global Stellar Network ; September 2015' } as const),
  Object.freeze({ name: 'testnet', passphrase: 'Test SDF Network ; September 2015' } as const),
  Object.freeze({ name: 'futurenet', passphrase: 'Test SDF Future Network ; October 2022' } as const),
]);

/**
 * Name the public network a 32-byte `network_id` belongs to, or `undefined`
 * for any other value (a private network, or a corrupted preimage).
 *
 * @example
 * identifyNetwork(decodePreimage(bytes).networkId)?.name; // 'testnet'
 */
export function identifyNetwork(networkIdBytes: Uint8Array): KnownNetwork | undefined {
  if (!(networkIdBytes instanceof Uint8Array) || networkIdBytes.length !== 32) return undefined;
  return KNOWN_NETWORKS.find((n) => {
    const id = sha256(n.passphrase);
    return id.every((b, i) => b === networkIdBytes[i]);
  });
}
