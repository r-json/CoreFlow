#!/usr/bin/env node
/**
 * Drives full pay_batch lifecycles on Stellar Testnet until TARGET_TOTAL
 * transactions are recorded, appending every hash to all_50_hashes.txt.
 *
 * One cycle = 5 on-chain transactions:
 *   initialize_multi_sig_escrow -> submit_hours_proof x2 -> manager_approve
 *   -> finance_approve -> pay_batch
 *
 * Payees are paid in native XLM: the native SAC needs no trustline, so freshly
 * generated accounts can receive funds without a per-payee change-trust setup.
 *
 * Usage:
 *   ORACLE_SECRET_KEY=<64 hex> node scripts/generate-testnet-batches.mjs
 *
 * Env overrides:
 *   CONTRACT_ID, MANAGER_KEY, FINANCE_KEY, TARGET_TOTAL, HASH_FILE, START_COUNT
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CONTRACT   = process.env.CONTRACT_ID  || 'CCVIQZLSJIPSCFH2QGPKN5IOAA5ZQ4DOD4HLBZFMYKXPRAMCIOZGFJDF';
const MANAGER    = process.env.MANAGER_KEY  || 'coreflow-instawards-testnet';
const FINANCE    = process.env.FINANCE_KEY  || 'cf-finance';
const XLM_SAC    = process.env.XLM_SAC      || 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC';
const NETWORK    = process.env.NETWORK      || 'testnet';
const HASH_FILE  = process.env.HASH_FILE    || 'docs/evidence/all_50_hashes.txt';
const TARGET     = Number(process.env.TARGET_TOTAL || 50);
// Transactions already recorded in earlier validation runs.
const START      = Number(process.env.START_COUNT || 21);

const tmp = mkdtempSync(join(tmpdir(), 'cf-batch-'));

function sh(cmd, args) {
  return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}
/** stellar CLI writes progress to stderr; merge both streams before parsing. */
function stellar(args) {
  try {
    return execFileSync('stellar', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    return `${e.stdout || ''}${e.stderr || ''}`;
  }
}
function stellarBoth(args) {
  const r = execFileSync('stellar', [...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  return r;
}
function invoke(args) {
  // Capture stderr too — the tx hash and expert link are logged there.
  let out = '';
  try {
    out = execFileSync('bash', ['-c',
      `stellar ${args.map(a => `'${a.replace(/'/g, "'\\''")}'`).join(' ')} 2>&1`],
      { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
  } catch (e) {
    out = `${e.stdout || ''}${e.stderr || ''}`;
    throw new Error(`stellar invoke failed:\n${out}`);
  }
  return out;
}
function hashFrom(output) {
  const m = output.match(/explorer\/testnet\/tx\/([0-9a-f]{64})/);
  return m ? m[1] : null;
}
function record(label, hash) {
  if (!hash) return false;
  appendFileSync(HASH_FILE, `${hash}\t${label}\n`);
  return true;
}
function rnd(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }

if (!process.env.ORACLE_SECRET_KEY) {
  console.error('ORACLE_SECRET_KEY must be set (64 hex chars).');
  process.exit(1);
}
if (!existsSync(HASH_FILE)) writeFileSync(HASH_FILE, '');

const managerAddr = sh('stellar', ['keys', 'address', MANAGER]).trim();
const financeAddr = sh('stellar', ['keys', 'address', FINANCE]).trim();
const oraclePub   = sh('node', ['scripts/oracle-cli.mjs', 'pubkey']).trim();

let total = START;
let cycle = 0;

console.log(`contract=${CONTRACT}`);
console.log(`manager=${managerAddr}`);
console.log(`finance=${financeAddr}`);
console.log(`oracle=${oraclePub}`);
console.log(`starting at ${total}/${TARGET}\n`);

while (total < TARGET) {
  cycle++;
  const tag = `cycle${cycle}`;

  // --- random payees, funded so the native SAC transfer lands ---
  const payees = [];
  for (let i = 0; i < 2; i++) {
    const alias = `cf-payee-${Date.now()}-${i}`;
    sh('stellar', ['keys', 'generate', alias, '--network', NETWORK, '--fund']);
    payees.push({
      alias,
      address: sh('stellar', ['keys', 'address', alias]).trim(),
      amount: String(rnd(1, 5) * 10_000_000), // 1-5 XLM in stroops
    });
  }

  const payments = payees.map((p, i) => ({
    id: i + 1,
    worker: p.address,
    token: XLM_SAC,
    amount: p.amount,
    start_date: 1,
    end_date: 2,
    hours_logged: '0',
    rate_per_hour: '1',
    proof_verified: false,
    status: 0,
  }));

  // 1. create escrow (funds custody from the manager)
  const outInit = invoke(['contract', 'invoke', '--id', CONTRACT, '--source', MANAGER,
    '--network', NETWORK, '--', 'initialize_multi_sig_escrow',
    '--manager', managerAddr, '--finance_approver', financeAddr,
    '--oracle_pubkey', oraclePub, '--payments', JSON.stringify(payments)]);
  total += record(`${tag}:init`, hashFrom(outInit)) ? 1 : 0;

  const escrowId = Number((outInit.trim().split('\n').pop() || '').replace(/[^0-9]/g, ''));
  if (!escrowId) throw new Error(`could not parse escrow id:\n${outInit}`);

  // 2. oracle proofs — signatures produced by the CLI, one per payee
  const batchFile = join(tmp, `${tag}.json`);
  writeFileSync(batchFile, JSON.stringify({
    escrowId,
    startNonce: 0,
    payees: payees.map((_, i) => ({ paymentId: i, hours: rnd(8, 60) })),
  }));
  const signed = JSON.parse(sh('node', ['scripts/oracle-cli.mjs', 'sign', batchFile]));

  for (const s of signed.signatures) {
    const sigHex = Buffer.from(s.signature, 'base64').toString('hex');
    const out = invoke(['contract', 'invoke', '--id', CONTRACT, '--source', MANAGER,
      '--network', NETWORK, '--', 'submit_hours_proof',
      '--escrow_id', String(escrowId), '--payment_id', String(s.paymentId),
      '--hours_logged', String(s.hours), '--nonce', String(s.nonce), '--signature', sigHex]);
    total += record(`${tag}:proof${s.paymentId}`, hashFrom(out)) ? 1 : 0;
  }

  // 3. dual approval — two distinct keys
  const outMgr = invoke(['contract', 'invoke', '--id', CONTRACT, '--source', MANAGER,
    '--network', NETWORK, '--', 'manager_approve', '--escrow_id', String(escrowId)]);
  total += record(`${tag}:manager_approve`, hashFrom(outMgr)) ? 1 : 0;

  const outFin = invoke(['contract', 'invoke', '--id', CONTRACT, '--source', FINANCE,
    '--network', NETWORK, '--', 'finance_approve', '--escrow_id', String(escrowId)]);
  total += record(`${tag}:finance_approve`, hashFrom(outFin)) ? 1 : 0;

  // 4. settle
  const outPay = invoke(['contract', 'invoke', '--id', CONTRACT, '--source', MANAGER,
    '--network', NETWORK, '--', 'pay_batch', '--escrow_id', String(escrowId)]);
  const payHash = hashFrom(outPay);
  total += record(`${tag}:pay_batch`, payHash) ? 1 : 0;

  console.log(`${tag} escrow=${escrowId} pay_batch=${payHash} total=${total}/${TARGET}`);
}

const lines = readFileSync(HASH_FILE, 'utf8').trim().split('\n').filter(Boolean);
console.log(`\n=== TOTAL RECORDED: ${lines.length} (+${START} pre-existing = ${total}) ===`);
console.log('first 3:'); lines.slice(0, 3).forEach(l => console.log('  ' + l));
console.log('last 3:');  lines.slice(-3).forEach(l => console.log('  ' + l));
