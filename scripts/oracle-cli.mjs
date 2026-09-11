#!/usr/bin/env node
/**
 * CoreFlow oracle signing CLI (Deliverable 2).
 *
 * Signs work attestations that `submit_hours_proof` will accept on-chain.
 *
 * ── Message shape (schema v2, 198 bytes) ────────────────────────────────────
 * The contract does NOT verify a signature over a `{payees, nonce}` JSON blob.
 * It reconstructs an exact preimage PER PAYMENT, from its own stored state, and
 * verifies against that:
 *
 *   magic "CFWP" 4 | version u16 2 | network_id 32 | contract 32 |
 *   worker 32 | token 32 | escrow_id u32 4 | payment_id u32 4 |
 *   amount i128 16 | hours i128 16 | start u64 8 | end u64 8 | nonce u64 8
 *
 * Every field but hours and nonce comes from the on-chain payment row, which is
 * why this CLI needs the escrow's worker/token/amount/period as input: it is
 * reproducing what the contract will build, not describing what you want paid.
 *
 * A batch yields ONE SIGNATURE PER PAYEE, each with its own nonce, consumed in
 * ascending order — the contract's watermark increments by one per accepted
 * proof. The contract also enforces `hours x rate_per_hour == amount`.
 *
 * Keep in sync with:
 *   contracts/core-flow/src/lib.rs  (build_proof_message)
 *   src/lib/oracle/index.ts         (buildProofMessage)
 * All three are pinned to the shared vector in docs/evidence/proof-vector-v2.json.
 * The contract also exposes `proof_preimage` for signers that prefer to read the
 * bytes rather than rebuild them.
 *
 * Usage:
 *   ORACLE_SECRET_KEY=<64 hex chars> node scripts/oracle-cli.mjs sign batch.json
 *   ORACLE_SECRET_KEY=... node scripts/oracle-cli.mjs sign -        # stdin
 *   ORACLE_SECRET_KEY=... node scripts/oracle-cli.mjs verify batch.json signed.json
 *   ORACLE_SECRET_KEY=... node scripts/oracle-cli.mjs pubkey
 *
 * batch.json:
 *   {
 *     "networkPassphrase": "Test SDF Network ; September 2015",
 *     "contractId": "C...",
 *     "escrowId": 1,
 *     "startNonce": 0,
 *     "payees": [
 *       { "paymentId": 0, "worker": "G...", "token": "C...",
 *         "amount": "10000", "hours": 40, "startDate": 1000, "endDate": 2000 }
 *     ]
 *   }
 */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { Keypair, nativeToScVal } from '@stellar/stellar-sdk';

const PROOF_MAGIC = Buffer.from('CFWP', 'ascii');
const PROOF_VERSION = 2;
const PROOF_MESSAGE_BYTES = 198;

function loadKeypair() {
  const seed = process.env.ORACLE_SECRET_KEY;
  if (!seed || !/^[0-9a-fA-F]{64}$/.test(seed)) {
    console.error('ORACLE_SECRET_KEY must be a 32-byte hex seed (64 hex chars).');
    console.error('Generate one:  openssl rand -hex 32');
    process.exit(1);
  }
  return Keypair.fromRawEd25519Seed(Buffer.from(seed, 'hex'));
}

function u16be(n) { const b = Buffer.alloc(2); b.writeUInt16BE(n); return b; }
function u32be(n) { const b = Buffer.alloc(4); b.writeUInt32BE(n >>> 0); return b; }
function u64be(n) { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(n)); return b; }
function i128be(n) {
  const b = Buffer.alloc(16);
  let v = BigInt(n) & ((1n << 128n) - 1n);
  for (let i = 15; i >= 0; i--) { b[i] = Number(v & 0xffn); v >>= 8n; }
  return b;
}

/** sha256(network passphrase) — what Soroban gives a contract as network_id(). */
const networkId = (passphrase) => createHash('sha256').update(passphrase, 'utf8').digest();

/** sha256(ScVal XDR of the address) — matches the contract's addr_digest. */
const addressDigest = (address) =>
  createHash('sha256').update(nativeToScVal(address, { type: 'address' }).toXDR()).digest();

/** The exact 198 bytes the contract reconstructs and verifies. */
function buildProofMessage(ctx, escrowId, paymentId, hours, nonce) {
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
  if (msg.length !== PROOF_MESSAGE_BYTES) {
    throw new Error(`Preimage must be ${PROOF_MESSAGE_BYTES} bytes, built ${msg.length}.`);
  }
  return msg;
}

function readPayload(path) {
  const raw = path === '-' ? readFileSync(0, 'utf8') : readFileSync(path, 'utf8');
  const p = JSON.parse(raw);
  if (!Number.isInteger(p.escrowId)) throw new Error('escrowId must be an integer');
  if (typeof p.networkPassphrase !== 'string' || !p.networkPassphrase) {
    throw new Error('networkPassphrase is required — it binds the proof to Testnet or Mainnet');
  }
  if (typeof p.contractId !== 'string' || !p.contractId) {
    throw new Error('contractId is required — it binds the proof to this deployment');
  }
  if (!Array.isArray(p.payees) || p.payees.length === 0) {
    throw new Error('payees must be a non-empty array');
  }
  for (const [i, payee] of p.payees.entries()) {
    for (const f of ['worker', 'token', 'amount', 'hours', 'startDate', 'endDate']) {
      if (payee[f] === undefined) throw new Error(`payees[${i}] is missing "${f}"`);
    }
  }
  return p;
}

/** One signature per payee, nonces sequential from startNonce. */
function signBatch(kp, payload) {
  const { escrowId, startNonce = 0, networkPassphrase, contractId, payees } = payload;
  return payees.map((payee, i) => {
    const nonce = Number(startNonce) + i;
    const paymentId = payee.paymentId ?? i;
    const ctx = {
      networkPassphrase,
      contractId,
      worker: payee.worker,
      token: payee.token,
      amount: BigInt(payee.amount),
      startDate: BigInt(payee.startDate),
      endDate: BigInt(payee.endDate),
    };
    const msg = buildProofMessage(ctx, escrowId, paymentId, BigInt(payee.hours), BigInt(nonce));
    return {
      paymentId,
      worker: payee.worker,
      hours: payee.hours,
      nonce,
      messageSha256: createHash('sha256').update(msg).digest('hex'),
      message: msg.toString('hex'),
      signature: kp.sign(msg).toString('base64'),
    };
  });
}

const [cmd, arg, arg2] = process.argv.slice(2);

if (cmd === 'pubkey') {
  // Hex, because the contract stores oracle_pubkey as BytesN<32>.
  console.log(loadKeypair().rawPublicKey().toString('hex'));
} else if (cmd === 'sign') {
  if (!arg) { console.error('usage: oracle-cli.mjs sign <batch.json|->'); process.exit(1); }
  const kp = loadKeypair();
  const payload = readPayload(arg);
  console.log(JSON.stringify({
    schema: 'CFWP-v2',
    escrowId: payload.escrowId,
    networkPassphrase: payload.networkPassphrase,
    contractId: payload.contractId,
    oraclePublicKey: kp.rawPublicKey().toString('hex'),
    signatures: signBatch(kp, payload),
  }, null, 2));
} else if (cmd === 'verify') {
  // Local verification + replay demonstration, so an operator can confirm a
  // batch before broadcasting rather than discovering a mismatch on-chain.
  if (!arg) { console.error('usage: oracle-cli.mjs verify <batch.json> [signed.json]'); process.exit(1); }
  const kp = loadKeypair();
  const payload = readPayload(arg);
  const expected = signBatch(kp, payload);
  const actual = arg2
    ? JSON.parse(readFileSync(arg2, 'utf8')).signatures
    : expected;

  let ok = true;
  for (const [i, sig] of expected.entries()) {
    const got = actual[i];
    const match = got && got.signature === sig.signature;
    if (!match) ok = false;
    console.log(`payment ${sig.paymentId}  nonce ${sig.nonce}  ${match ? 'VALID' : 'MISMATCH'}`);
  }

  // Replay check: the same payload signed at the NEXT nonce must differ. If it
  // did not, the nonce would not be part of the preimage and every signature
  // would be reusable forever.
  const replay = signBatch(kp, { ...payload, startNonce: Number(payload.startNonce ?? 0) + 1 });
  const nonceBinds = replay[0].signature !== expected[0].signature;
  console.log(`replay protection: nonce ${nonceBinds ? 'IS' : 'IS NOT'} bound into the signature`);
  if (!nonceBinds) ok = false;

  // Domain check: the same payload on the other network must differ.
  const otherNetwork = payload.networkPassphrase.includes('Test')
    ? 'Public Global Stellar Network ; September 2015'
    : 'Test SDF Network ; September 2015';
  const crossNet = signBatch(kp, { ...payload, networkPassphrase: otherNetwork });
  const netBinds = crossNet[0].signature !== expected[0].signature;
  console.log(`domain separation: network ${netBinds ? 'IS' : 'IS NOT'} bound into the signature`);
  if (!netBinds) ok = false;

  process.exit(ok ? 0 : 1);
} else {
  console.error('CoreFlow oracle CLI (schema CFWP-v2)');
  console.error('  sign <batch.json|->              emit one Ed25519 signature per payee');
  console.error('  verify <batch.json> [signed.json]  verify locally + prove replay/domain binding');
  console.error('  pubkey                           print the oracle public key (hex)');
  process.exit(1);
}
