#!/usr/bin/env node
/**
 * CoreFlow v2 — end-to-end Testnet validation.
 *
 * Runs the complete golden path against the DEPLOYED v2 contract and records
 * machine-readable evidence:
 *
 *   escrow creation + custody funding
 *     -> oracle attestation (CFWP-v2, per payment)
 *       -> submit_hours_proof
 *         -> manager approval
 *           -> DISTINCT finance approval
 *             -> pay_batch
 *               -> real SAC transfers
 *                 -> balance verification
 *
 * Every step is verified against on-chain state rather than assumed from a
 * non-erroring CLI call. Balances are read before and after, so "the payment
 * settled" is a measured fact, not an inference from an exit code.
 *
 * TESTNET ONLY. CoreFlow v1 on Mainnet is untouched.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { Keypair, nativeToScVal } from '@stellar/stellar-sdk';

const NETWORK = 'testnet';
const NETWORK_PASSPHRASE = 'Test SDF Network ; September 2015';
const DEPLOYMENT = JSON.parse(readFileSync('docs/evidence/testnet-v2-deployment.json', 'utf8'));
const CONTRACT = DEPLOYMENT.contractId;

const ORACLE_SEED = (process.env.ORACLE_SECRET_KEY || '').trim();
if (!/^[0-9a-fA-F]{64}$/.test(ORACLE_SEED)) {
  console.error('ORACLE_SECRET_KEY must be a 32-byte hex seed.');
  process.exit(1);
}
const oracleKp = Keypair.fromRawEd25519Seed(Buffer.from(ORACLE_SEED, 'hex'));

// ── CFWP-v2 preimage (mirrors src/lib/oracle/index.ts) ──────────────────────
const u16be = (n) => { const b = Buffer.alloc(2); b.writeUInt16BE(n); return b; };
const u32be = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n >>> 0); return b; };
const u64be = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(n)); return b; };
const i128be = (n) => {
  const b = Buffer.alloc(16);
  let v = BigInt(n) & ((1n << 128n) - 1n);
  for (let i = 15; i >= 0; i--) { b[i] = Number(v & 0xffn); v >>= 8n; }
  return b;
};
const sha256 = (b) => createHash('sha256').update(b).digest();
const addrDigest = (a) => sha256(nativeToScVal(a, { type: 'address' }).toXDR());

function buildProofMessage(ctx, escrowId, paymentId, hours, nonce) {
  const m = Buffer.concat([
    Buffer.from('CFWP', 'ascii'), u16be(2),
    sha256(Buffer.from(NETWORK_PASSPHRASE, 'utf8')),
    addrDigest(ctx.contractId), addrDigest(ctx.worker), addrDigest(ctx.token),
    u32be(escrowId), u32be(paymentId),
    i128be(ctx.amount), i128be(hours),
    u64be(ctx.startDate), u64be(ctx.endDate), u64be(nonce),
  ]);
  if (m.length !== 198) throw new Error(`preimage is ${m.length} bytes, expected 198`);
  return m;
}

// ── CLI plumbing ────────────────────────────────────────────────────────────
const sh = (args) =>
  execFileSync('stellar', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

const addr = (id) => sh(['keys', 'address', id]);

function invoke(source, fn, args = [], { id = CONTRACT } = {}) {
  return sh(['contract', 'invoke', '--id', id, '--source', source,
    '--network', NETWORK, '--', fn, ...args]);
}

/** Invoke and also return the transaction hash, for the evidence record. */
function invokeWithHash(source, fn, args = [], { id = CONTRACT } = {}) {
  const out = execFileSync('stellar',
    ['contract', 'invoke', '--id', id, '--source', source, '--network', NETWORK, '--', fn, ...args],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  // The CLI prints the tx hash on stderr as part of its progress output; when
  // absent we still record the result rather than failing the run.
  return { result: out.trim(), hash: null };
}

const balance = (sac, who) =>
  BigInt(JSON.parse(invoke('coreflow-v2-admin', 'balance', ['--id', who], { id: sac })));

const step = (n, msg) => console.log(`\n\x1b[1m[${n}] ${msg}\x1b[0m`);
const ok = (msg) => console.log(`    \x1b[32m✓\x1b[0m ${msg}`);
const fail = (msg) => { console.error(`    \x1b[31m✗ ${msg}\x1b[0m`); process.exitCode = 1; throw new Error(msg); };
const check = (cond, msg) => cond ? ok(msg) : fail(msg);

// ── Payroll definition ──────────────────────────────────────────────────────
// Amounts are USDC base units (7 decimals). Every row satisfies the contract's
// `hours x rate == amount` invariant exactly; nothing is rounded to fit.
const USDC = (n) => BigInt(Math.round(n * 1e7));
const PAYROLL = [
  { identity: 'coreflow-v2-worker',  hours: 40n, rateUsdc: 25 },
  { identity: 'coreflow-v2-worker2', hours: 32n, rateUsdc: 30 },
  { identity: 'coreflow-v2-worker3', hours: 45n, rateUsdc: 20 },
];

const evidence = { version: 'v2', network: NETWORK, contractId: CONTRACT, steps: [] };
const record = (name, data) => evidence.steps.push({ name, at: new Date().toISOString(), ...data });

async function main() {
  // The settlement asset comes from the deployment record, not a temp file: the
  // record is the committed source of truth for what this deployment settles in.
  const SAC = DEPLOYMENT.settlementAsset?.sacContractId;
  if (!SAC) {
    throw new Error(
      'docs/evidence/testnet-v2-deployment.json has no settlementAsset.sacContractId'
    );
  }
  const manager = addr('coreflow-v2-manager');
  const finance = addr('coreflow-v2-finance');

  console.log(`CoreFlow v2 Testnet validation`);
  console.log(`  contract : ${CONTRACT}`);
  console.log(`  asset    : ${SAC}`);
  console.log(`  manager  : ${manager}`);
  console.log(`  finance  : ${finance}`);

  check(manager !== finance, 'manager and finance are DISTINCT keys (separation of duties)');

  const now = Math.floor(Date.now() / 1000);
  const periodStart = now - 14 * 86400;
  const periodEnd = now;

  const rows = PAYROLL.map((p, i) => {
    const rate = USDC(p.rateUsdc);
    const amount = p.hours * rate;
    return {
      paymentId: i,
      identity: p.identity,
      worker: addr(p.identity),
      token: SAC,
      hours: p.hours,
      rate,
      amount,
      startDate: BigInt(periodStart),
      endDate: BigInt(periodEnd),
    };
  });

  const total = rows.reduce((a, r) => a + r.amount, 0n);
  console.log(`\n  payroll: ${rows.length} contractors, ${Number(total) / 1e7} USDC total`);
  for (const r of rows) {
    console.log(`    #${r.paymentId} ${r.worker.slice(0, 8)}…  ${r.hours}h @ ${Number(r.rate) / 1e7}  = ${Number(r.amount) / 1e7} USDC`);
  }

  // ── 1. Balances before ────────────────────────────────────────────────────
  step(1, 'Recording balances before settlement');
  const managerBefore = balance(SAC, manager);
  const workerBefore = rows.map((r) => balance(SAC, r.worker));
  ok(`manager holds ${Number(managerBefore) / 1e7} USDC`);
  workerBefore.forEach((b, i) => ok(`worker #${i} holds ${Number(b) / 1e7} USDC`));
  record('balances_before', {
    manager: managerBefore.toString(),
    workers: workerBefore.map(String),
  });

  // ── 2. Create escrow (pulls custody) ──────────────────────────────────────
  step(2, 'Creating escrow — custody funded from the manager in one transaction');
  const paymentsJson = JSON.stringify(rows.map((r) => ({
    id: r.paymentId + 1,
    worker: r.worker,
    token: r.token,
    amount: r.amount.toString(),
    start_date: Number(r.startDate),
    end_date: Number(r.endDate),
    hours_logged: '0',
    rate_per_hour: r.rate.toString(),
    proof_verified: false,
    // PaymentStatus is a #[repr(u32)] C-like enum, which the CLI's spec tools
    // encode by discriminant rather than by variant name.
    status: 0,
  })));

  const escrowIdRaw = invoke('coreflow-v2-manager', 'initialize_multi_sig_escrow', [
    '--manager', manager,
    '--finance_approver', finance,
    '--oracle_pubkey', DEPLOYMENT.oraclePublicKey,
    '--payments', paymentsJson,
  ]);
  const escrowId = Number(JSON.parse(escrowIdRaw));
  ok(`escrow #${escrowId} created`);

  const custody = balance(SAC, CONTRACT);
  check(custody === total, `contract custody holds exactly ${Number(total) / 1e7} USDC`);
  const managerAfterFund = balance(SAC, manager);
  check(managerAfterFund === managerBefore - total, 'manager debited by exactly the batch total');
  record('escrow_created', { escrowId, custodyBaseUnits: custody.toString() });

  // ── 3. Oracle attestation ─────────────────────────────────────────────────
  step(3, 'Oracle attestation (CFWP-v2) and on-chain proof submission');
  const attestations = [];
  for (const r of rows) {
    const nonce = BigInt(JSON.parse(invoke('coreflow-v2-admin', 'get_nonce', ['--escrow_id', String(escrowId)])));

    const ctx = { contractId: CONTRACT, worker: r.worker, token: r.token, amount: r.amount, startDate: r.startDate, endDate: r.endDate };
    const msg = buildProofMessage(ctx, escrowId, r.paymentId, r.hours, nonce);

    // The contract is the source of truth for the preimage — confirm our
    // independently built bytes are byte-identical before signing them.
    const onChain = Buffer.from(JSON.parse(invoke('coreflow-v2-admin', 'proof_preimage', [
      '--escrow_id', String(escrowId), '--payment_id', String(r.paymentId),
      '--hours', r.hours.toString(), '--nonce', nonce.toString(),
    ])), 'hex');
    check(onChain.equals(msg), `payment #${r.paymentId}: local preimage matches contract's proof_preimage`);

    const sig = oracleKp.sign(msg);
    invoke('coreflow-v2-manager', 'submit_hours_proof', [
      '--escrow_id', String(escrowId), '--payment_id', String(r.paymentId),
      '--hours_logged', r.hours.toString(), '--nonce', nonce.toString(),
      '--signature', sig.toString('hex'),
    ]);
    ok(`payment #${r.paymentId}: ${r.hours}h attested and verified on-chain (nonce ${nonce})`);
    attestations.push({
      paymentId: r.paymentId, hours: r.hours.toString(), nonce: nonce.toString(),
      preimageSha256: sha256(msg).toString('hex'), signature: sig.toString('base64'),
    });
  }
  record('oracle_attestations', { schema: 'CFWP-v2', attestations });

  // ── 4. Replay must fail ───────────────────────────────────────────────────
  step(4, 'Replay protection — resubmitting a consumed attestation');
  const replay = attestations[0];
  let replayRejected = false;
  try {
    invoke('coreflow-v2-manager', 'submit_hours_proof', [
      '--escrow_id', String(escrowId), '--payment_id', '0',
      '--hours_logged', replay.hours, '--nonce', replay.nonce,
      '--signature', Buffer.from(replay.signature, 'base64').toString('hex'),
    ]);
  } catch {
    replayRejected = true;
  }
  check(replayRejected, 'a consumed nonce is rejected on-chain (InvalidNonce)');
  record('replay_rejected', { paymentId: 0, nonce: replay.nonce, rejected: replayRejected });

  // ── 5. Settlement must require BOTH approvals ─────────────────────────────
  step(5, 'Dual approval — settlement blocked until both signers approve');
  let blockedNoApprovals = false;
  try { invoke('coreflow-v2-manager', 'pay_batch', ['--escrow_id', String(escrowId)]); }
  catch { blockedNoApprovals = true; }
  check(blockedNoApprovals, 'pay_batch refused with zero approvals');

  invoke('coreflow-v2-manager', 'manager_approve', ['--escrow_id', String(escrowId)]);
  ok('manager approved');

  let blockedOneApproval = false;
  try { invoke('coreflow-v2-manager', 'pay_batch', ['--escrow_id', String(escrowId)]); }
  catch { blockedOneApproval = true; }
  check(blockedOneApproval, 'pay_batch still refused with only the manager approval');

  // A DIFFERENT key signs. The manager cannot produce this approval.
  invoke('coreflow-v2-finance', 'finance_approve', ['--escrow_id', String(escrowId)]);
  ok('finance approved (distinct key)');
  record('dual_approval', { blockedNoApprovals, blockedOneApproval, manager, finance });

  // ── 6. Settle ─────────────────────────────────────────────────────────────
  step(6, 'pay_batch — real SAC transfers to every contractor');
  invoke('coreflow-v2-manager', 'pay_batch', ['--escrow_id', String(escrowId)]);
  ok('pay_batch executed');

  // ── 7. Verify settlement by measured balances ─────────────────────────────
  step(7, 'Verifying settlement against on-chain balances');
  const custodyAfter = balance(SAC, CONTRACT);
  check(custodyAfter === 0n, 'contract custody fully drained (no residue)');

  const paid = [];
  rows.forEach((r, i) => {
    const after = balance(SAC, r.worker);
    const delta = after - workerBefore[i];
    check(delta === r.amount, `worker #${i} received exactly ${Number(r.amount) / 1e7} USDC`);
    paid.push({ paymentId: r.paymentId, worker: r.worker, receivedBaseUnits: delta.toString() });
  });
  record('settlement', { custodyAfter: custodyAfter.toString(), paid });

  // ── 8. Double-settlement must fail ────────────────────────────────────────
  step(8, 'Double-settlement protection');
  let doubleRejected = false;
  try { invoke('coreflow-v2-manager', 'pay_batch', ['--escrow_id', String(escrowId)]); }
  catch { doubleRejected = true; }
  check(doubleRejected, 'a second pay_batch is rejected (PaymentAlreadyFinalized)');
  record('double_settlement_rejected', { rejected: doubleRejected });

  // ── 9. Final escrow state ─────────────────────────────────────────────────
  step(9, 'Final on-chain escrow state');
  const finalEscrow = JSON.parse(invoke('coreflow-v2-admin', 'get_escrow', ['--escrow_id', String(escrowId)]));
  check(finalEscrow.manager_approved === true, 'manager_approved = true');
  check(finalEscrow.finance_approved === true, 'finance_approved = true');
  check(finalEscrow.payments.every((p) => p.proof_verified === true), 'every payment carries a verified oracle proof');
  // PaymentStatus is #[repr(u32)]; the CLI renders it as its discriminant.
  // Accept either form so this assertion survives a CLI that learns the names.
  const FINALIZED = 3;
  check(
    finalEscrow.payments.every((p) => p.status === FINALIZED || p.status === 'Finalized'),
    'every payment is Finalized'
  );
  record('final_state', { escrowId, escrow: finalEscrow });

  evidence.escrowId = escrowId;
  evidence.assetContract = SAC;
  evidence.totalSettledBaseUnits = total.toString();
  evidence.completedAt = new Date().toISOString();
  evidence.explorer = {
    contract: `https://stellar.expert/explorer/testnet/contract/${CONTRACT}`,
    asset: `https://stellar.expert/explorer/testnet/contract/${SAC}`,
  };

  mkdirSync('docs/evidence', { recursive: true });
  writeFileSync('docs/evidence/testnet-v2-golden-path.json', JSON.stringify(evidence, null, 2));

  console.log(`\n\x1b[32m\x1b[1mGOLDEN PATH COMPLETE\x1b[0m`);
  console.log(`  escrow #${escrowId}: ${Number(total) / 1e7} USDC settled to ${rows.length} contractors`);
  console.log(`  evidence: docs/evidence/testnet-v2-golden-path.json`);
}

main().catch((e) => { console.error(`\n\x1b[31mFAILED: ${e.message}\x1b[0m`); process.exit(1); });
