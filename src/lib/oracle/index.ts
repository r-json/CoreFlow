/**
 * CoreFlow oracle signing service.
 *
 * The oracle attests to verified work by producing an Ed25519 signature over
 * the exact preimage the on-chain contract reconstructs and checks.
 *
 * ── Schema v2 (198 bytes) ────────────────────────────────────────────────────
 *
 *   offset  size  field
 *   0       4     magic         "CFWP"  (CoreFlow Work Proof)
 *   4       2     version       u16 BE  (= 2)
 *   6      32     network_id    sha256(network passphrase)
 *   38     32     contract      sha256(ScVal XDR of the contract address)
 *   70     32     worker        sha256(ScVal XDR of the worker address)
 *   102    32     token         sha256(ScVal XDR of the settlement asset)
 *   134     4     escrow_id     u32 BE
 *   138     4     payment_id    u32 BE
 *   142    16     amount        i128 BE (two's complement)
 *   158    16     hours         i128 BE (two's complement)
 *   174     8     start_date    u64 BE
 *   182     8     end_date      u64 BE
 *   190     8     nonce         u64 BE
 *
 * WHY EACH FIELD EXISTS. v1 signed only `escrow_id ‖ payment_id ‖ hours ‖ nonce`,
 * which said nothing about which chain, which contract, which payee, or how much.
 * One signature was therefore valid on every deployment of the contract on every
 * network for the same tuple — a Testnet attestation replayed verbatim against
 * Mainnet. Each field above closes one of those substitutions:
 *
 *   network_id  → a Testnet signature is not a Mainnet signature
 *   contract    → a signature for one deployment is not valid on another
 *   worker      → an attestation cannot be redirected to a different payee
 *   token       → nor to a different asset
 *   amount      → the oracle attests to the sum that will actually move
 *   period      → an attestation is scoped to one pay period
 *   nonce       → single use, enforced by the contract's monotonic watermark
 *   version     → lets a future schema be distinguished rather than confused
 *
 * The signing key lives only on the server (ORACLE_SECRET_KEY) and never touches
 * the client. The contract's per-escrow `oracle_pubkey` must equal this key's
 * public half, and (once an admin is configured) must be on the contract's
 * admin-managed oracle registry.
 *
 * Keep in sync with:
 *   contracts/core-flow/src/lib.rs  (build_proof_message)
 *   scripts/oracle-cli.mjs          (buildProofMessage)
 * `PROOF_VECTOR_V2` in the tests pins all three to one shared vector; the
 * contract also exposes `proof_preimage` so a signer can read the bytes rather
 * than rebuild them.
 */

import { createHash } from 'crypto';
import { Keypair, nativeToScVal } from '@stellar/stellar-sdk';

export const PROOF_MAGIC = Buffer.from('CFWP', 'ascii');
export const PROOF_VERSION = 2;
export const PROOF_MESSAGE_BYTES = 198;

let cachedKeypair: Keypair | null = null;

/** Loads the oracle keypair from ORACLE_SECRET_KEY (32-byte hex seed). */
export function getOracleKeypair(): Keypair {
  if (cachedKeypair) return cachedKeypair;
  const seedHex = process.env.ORACLE_SECRET_KEY;
  if (!seedHex || !/^[0-9a-fA-F]{64}$/.test(seedHex)) {
    throw new Error(
      'ORACLE_SECRET_KEY must be set to a 32-byte hex string (64 hex chars).'
    );
  }
  cachedKeypair = Keypair.fromRawEd25519Seed(Buffer.from(seedHex, 'hex'));
  return cachedKeypair;
}

/** The oracle's Ed25519 public key as hex — used as the escrow `oracle_pubkey`. */
export function getOraclePublicKeyHex(): string {
  return getOracleKeypair().rawPublicKey().toString('hex');
}

/** Test seam — drops the memoised keypair so a changed env var takes effect. */
export function resetOracleKeypairCache(): void {
  cachedKeypair = null;
}

function u16be(n: number): Buffer {
  const b = Buffer.alloc(2);
  b.writeUInt16BE(n);
  return b;
}

function u32be(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n >>> 0);
  return b;
}

function u64be(n: bigint): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64BE(n);
  return b;
}

/** 16-byte big-endian two's-complement encoding of an i128. */
function i128be(n: bigint): Buffer {
  const b = Buffer.alloc(16);
  let v = n & ((1n << 128n) - 1n); // wrap negatives to two's complement
  for (let i = 15; i >= 0; i--) {
    b[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return b;
}

/**
 * sha256 of a Stellar network passphrase — the same value Soroban exposes to a
 * contract as `env.ledger().network_id()`.
 */
export function networkId(passphrase: string): Buffer {
  return createHash('sha256').update(passphrase, 'utf8').digest();
}

/**
 * sha256 of an address's ScVal XDR, matching the contract's
 * `sha256(addr.to_xdr(env))`.
 *
 * Addresses serialize to a variable number of bytes (an account ScAddress and a
 * contract ScAddress differ in length), so hashing to a fixed 32 keeps the
 * preimage fixed-width. `soroban_sdk`'s `ToXdr` serializes the `Val`, i.e. the
 * ScVal envelope — which is what `nativeToScVal(addr, { type: 'address' })`
 * produces here, not the bare ScAddress.
 */
export function addressDigest(address: string): Buffer {
  const xdr = nativeToScVal(address, { type: 'address' }).toXDR();
  return createHash('sha256').update(xdr).digest();
}

export interface ProofContext {
  /** Stellar network passphrase, e.g. 'Test SDF Network ; September 2015'. */
  networkPassphrase: string;
  /** The CoreFlow contract address (C…). */
  contractId: string;
  /** Payee address (G… or C…), from the on-chain payment row. */
  worker: string;
  /** Settlement asset SAC address, from the on-chain payment row. */
  token: string;
  /** Escrowed amount in the asset's base units, from the on-chain payment row. */
  amount: bigint;
  /** Pay period start (unix seconds), from the on-chain payment row. */
  startDate: bigint;
  /** Pay period end (unix seconds), from the on-chain payment row. */
  endDate: bigint;
}

/** Builds the 198-byte domain-separated message the contract verifies. */
export function buildProofMessage(
  ctx: ProofContext,
  escrowId: number,
  paymentId: number,
  hours: bigint,
  nonce: bigint
): Buffer {
  const msg = Buffer.concat([
    PROOF_MAGIC,
    u16be(PROOF_VERSION),
    networkId(ctx.networkPassphrase),
    addressDigest(ctx.contractId),
    addressDigest(ctx.worker),
    addressDigest(ctx.token),
    u32be(escrowId),
    u32be(paymentId),
    i128be(ctx.amount),
    i128be(hours),
    u64be(ctx.startDate),
    u64be(ctx.endDate),
    u64be(nonce),
  ]);

  // A short preimage would still sign and still verify against a matching
  // short preimage, so a dropped field would fail only at the contract — as an
  // opaque signature rejection. Fail here instead, where the cause is visible.
  if (msg.length !== PROOF_MESSAGE_BYTES) {
    throw new Error(
      `Proof preimage must be ${PROOF_MESSAGE_BYTES} bytes, built ${msg.length}.`
    );
  }
  return msg;
}

/** Signs a work proof, returning the 64-byte Ed25519 signature as base64. */
export function signHoursProof(
  ctx: ProofContext,
  escrowId: number,
  paymentId: number,
  hours: number | bigint,
  nonce: number | bigint
): string {
  const msg = buildProofMessage(ctx, escrowId, paymentId, BigInt(hours), BigInt(nonce));
  return getOracleKeypair().sign(msg).toString('base64');
}

/** Verifies a signature locally against the same preimage. */
export function verifyHoursProof(
  ctx: ProofContext,
  escrowId: number,
  paymentId: number,
  hours: number | bigint,
  nonce: number | bigint,
  signatureBase64: string
): boolean {
  const msg = buildProofMessage(ctx, escrowId, paymentId, BigInt(hours), BigInt(nonce));
  try {
    return getOracleKeypair().verify(msg, Buffer.from(signatureBase64, 'base64'));
  } catch {
    return false;
  }
}
