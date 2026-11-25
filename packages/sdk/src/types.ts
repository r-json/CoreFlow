/**
 * A signed claim: a statement an issuer makes about a subject.
 * Field meanings and byte layout: docs/kit/claim-format.md.
 */
export interface Claim {
  /** Issuer Ed25519 public key, 32 bytes. */
  issuer: Uint8Array;
  /** `SHA-256(type string)`, 32 bytes. See `claimType`. */
  claimType: Uint8Array;
  /** What the claim is about, 32 bytes, chosen by the application. */
  subject: Uint8Array;
  /** `SHA-256(payload)`, 32 bytes. The payload travels off-chain. */
  payloadHash: Uint8Array;
  /** `'raw'` = application-defined bytes (wire 0); `'xdr'` = XDR `ScVal` (wire 1). */
  payloadEncoding: 'raw' | 'xdr';
  /** Replay protection: ordered `nonce` per scope, or a one-time `claimId`. */
  replay: { mode: 'sequence'; nonce: bigint } | { mode: 'unique-id'; claimId: Uint8Array };
  /** Unix seconds when the issuer signed (u64). */
  issuedAt: bigint;
  /** Unix seconds after which the claim is invalid (u64). Must be greater than `issuedAt`. */
  expiresAt: bigint;
}

/** What binds a claim to one network and one contract. */
export interface ClaimContext {
  /** Network passphrase, e.g. `Networks.TESTNET`. */
  networkPassphrase: string;
  /** Verifying contract address, a `C...` strkey. */
  contractId: string;
}
