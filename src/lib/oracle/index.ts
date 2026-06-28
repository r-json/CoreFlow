/**
 * CoreFlow oracle signing service.
 *
 * The oracle attests to verified work hours by producing an Ed25519 signature
 * over the exact 32-byte message the on-chain contract reconstructs and checks:
 *
 *   escrow_id   (u32, 4 bytes BE)
 *   payment_id  (u32, 4 bytes BE)
 *   hours       (i128, 16 bytes BE, two's complement)
 *   nonce       (u64, 8 bytes BE)
 *
 * The signing key lives only on the server (ORACLE_SECRET_KEY) and never
 * touches the client. The contract's per-escrow `oracle_pubkey` must equal this
 * key's public half, which clients fetch from GET /api/oracle/pubkey.
 */

import { Keypair } from '@stellar/stellar-sdk';

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

/** Builds the 32-byte message the contract verifies. */
export function buildProofMessage(
  escrowId: number,
  paymentId: number,
  hours: bigint,
  nonce: bigint
): Buffer {
  return Buffer.concat([u32be(escrowId), u32be(paymentId), i128be(hours), u64be(nonce)]);
}

/** Signs a work-hours proof, returning the 64-byte Ed25519 signature as base64. */
export function signHoursProof(
  escrowId: number,
  paymentId: number,
  hours: number | bigint,
  nonce: number | bigint
): string {
  const msg = buildProofMessage(escrowId, paymentId, BigInt(hours), BigInt(nonce));
  return getOracleKeypair().sign(msg).toString('base64');
}
