#!/usr/bin/env node
/**
 * CoreFlow oracle signing CLI (Deliverable 2).
 *
 * Signs work-hours attestations that `submit_hours_proof` will accept on-chain.
 *
 * IMPORTANT — message shape:
 * The contract does NOT verify a signature over a `{payees, nonce}` JSON blob.
 * It reconstructs an exact 32-byte message per PAYMENT and verifies against it:
 *
 *     escrow_id   u32  4 bytes BE
 *     payment_id  u32  4 bytes BE
 *     hours       i128 16 bytes BE (two's complement)
 *     nonce       u64  8 bytes BE
 *
 * So a batch input yields ONE SIGNATURE PER PAYEE, each with its own nonce,
 * consumed in ascending order — the contract's nonce watermark increments by
 * one per accepted proof. Signing a batch blob would produce signatures the
 * contract rejects every time.
 *
 * Keep in sync with:
 *   contracts/core-flow/src/lib.rs  (submit_hours_proof)
 *   src/lib/oracle/index.ts         (buildProofMessage)
 * The vitest in src/lib/oracle/__tests__ asserts this encoding matches.
 *
 * Usage:
 *   ORACLE_SECRET_KEY=<64 hex chars> node scripts/oracle-cli.mjs sign batch.json
 *   ORACLE_SECRET_KEY=... node scripts/oracle-cli.mjs sign -        # stdin
 *   ORACLE_SECRET_KEY=... node scripts/oracle-cli.mjs pubkey
 *
 * batch.json:
 *   { "escrowId": 1, "startNonce": 0,
 *     "payees": [ { "paymentId": 0, "hours": 40 },
 *                 { "paymentId": 1, "hours": 32 } ] }
 */
import { readFileSync } from 'node:fs';
import { Keypair } from '@stellar/stellar-sdk';

function loadKeypair() {
  const seed = process.env.ORACLE_SECRET_KEY;
  if (!seed || !/^[0-9a-fA-F]{64}$/.test(seed)) {
    console.error('ORACLE_SECRET_KEY must be a 32-byte hex seed (64 hex chars).');
    console.error('Generate one:  openssl rand -hex 32');
    process.exit(1);
  }
  return Keypair.fromRawEd25519Seed(Buffer.from(seed, 'hex'));
}

function u32be(n) { const b = Buffer.alloc(4); b.writeUInt32BE(n >>> 0); return b; }
function u64be(n) { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(n)); return b; }
function i128be(n) {
  const b = Buffer.alloc(16);
  let v = BigInt(n) & ((1n << 128n) - 1n);
  for (let i = 15; i >= 0; i--) { b[i] = Number(v & 0xffn); v >>= 8n; }
  return b;
}

/** The exact 32 bytes the contract reconstructs and verifies. */
function buildProofMessage(escrowId, paymentId, hours, nonce) {
  return Buffer.concat([u32be(escrowId), u32be(paymentId), i128be(hours), u64be(nonce)]);
}

function readPayload(path) {
  const raw = path === '-' ? readFileSync(0, 'utf8') : readFileSync(path, 'utf8');
  const p = JSON.parse(raw);
  if (!Number.isInteger(p.escrowId)) throw new Error('escrowId must be an integer');
  if (!Array.isArray(p.payees) || p.payees.length === 0) throw new Error('payees must be a non-empty array');
  return p;
}

const [cmd, arg] = process.argv.slice(2);

if (cmd === 'pubkey') {
  // Hex, because the contract stores oracle_pubkey as BytesN<32>.
  console.log(loadKeypair().rawPublicKey().toString('hex'));
} else if (cmd === 'sign') {
  if (!arg) { console.error('usage: oracle-cli.mjs sign <batch.json|->'); process.exit(1); }
  const kp = loadKeypair();
  const { escrowId, startNonce = 0, payees } = readPayload(arg);

  // Nonces are sequential from startNonce: the contract accepts exactly the
  // next expected value, so proofs must be submitted in this order.
  const signatures = payees.map((payee, i) => {
    const nonce = Number(startNonce) + i;
    const msg = buildProofMessage(escrowId, payee.paymentId, payee.hours, nonce);
    return {
      paymentId: payee.paymentId,
      hours: payee.hours,
      nonce,
      message: msg.toString('hex'),
      signature: kp.sign(msg).toString('base64'),
    };
  });

  console.log(JSON.stringify({
    escrowId,
    oraclePublicKey: kp.rawPublicKey().toString('hex'),
    signatures,
  }, null, 2));
} else {
  console.error('CoreFlow oracle CLI');
  console.error('  sign <batch.json|->   emit one Ed25519 signature per payee');
  console.error('  pubkey                print the oracle public key (hex)');
  process.exit(1);
}
