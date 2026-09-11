// @vitest-environment node
/**
 * LIVE Testnet funding validation.
 *
 * OPT-IN. Skipped unless COREFLOW_LIVE_TESTNET=1, because it submits a REAL
 * transaction to Stellar Testnet that moves REAL test USDC into escrow custody.
 *
 *   COREFLOW_LIVE_TESTNET=1 npx vitest run --config vitest.integration.config.ts \
 *     src/lib/funding/__tests__/live-funding.test.ts
 *
 * What it proves, and why it cannot be proved any other way: that the frozen plan,
 * the transaction the contract actually executed, the custody transfer the token
 * contract actually emitted, the indexer's projection and the reconciler's
 * independent verification all agree — on real infrastructure, in one run.
 *
 * Signing is done by the Stellar CLI using the project's own `coreflow-v2-manager`
 * identity. No secret is read, printed, or passed through this process.
 *
 * `initialize_multi_sig_escrow` is NOT idempotent: it creates an escrow and moves
 * custody atomically. So this test submits exactly one funding transaction and, if
 * anything becomes uncertain, asserts on the recovery path rather than submitting
 * another.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { OrgRole, MembershipStatus, PaymentState, TxStatus } from '@prisma/client';
import prisma from '@/lib/db/prisma';
import { assertLocalDatabase } from '@/lib/db/__tests__/helpers';
import { STELLAR_CONFIG } from '@/lib/config';
import { createBatch } from '@/lib/payroll/api';
import { approveBatch } from '@/lib/payroll/api';
import {
  openFundingIntent,
  recordFundingSubmitted,
  confirmFunding,
  getFundingState,
  readStoredPlan,
  planDigest,
} from '../service';
import { createRpcVerifier } from '@/lib/reconciliation/chain-verifier';
import { runIndexerFromRpc } from '@/lib/indexer/run';
import { runReconciliation } from '@/lib/reconciliation/scheduler';
import type { TenantContext } from '@/lib/tenancy/resolve';

const LIVE = process.env.COREFLOW_LIVE_TESTNET === '1';

/** The project's own Testnet identities. Names only — never secrets. */
const MANAGER_KEY = 'coreflow-v2-manager';
const NETWORK = 'testnet';

/** Three payments, deliberately tiny: 1.0 + 1.5 + 0.5 = 3.0 test USDC. */
const ROWS = [
  { key: 'coreflow-v2-worker', amount: '1', hours: 2, rate: '0.5' },
  { key: 'coreflow-v2-worker2', amount: '1.5', hours: 3, rate: '0.5' },
  { key: 'coreflow-v2-worker3', amount: '0.5', hours: 1, rate: '0.5' },
];
const EXPECTED_TOTAL = 30_000_000n; // 3.0 USDC at 7 decimals
const PERIOD = { start: '2026-09-01', end: '2026-09-15' };

function cli(args: string[]): string {
  const command = `stellar ${args.map((a) => `'${a.replace(/'/g, "'\\''")}'`).join(' ')} 2>&1`;
  try {
    return execFileSync('bash', ['-c', command], {
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024,
    });
  } catch (e: any) {
    // The CLI writes the contract's own error to stdout/stderr. Swallowing it turns
    // a diagnosable refusal into "Command failed", which is useless here.
    const output = `${e.stdout ?? ''}${e.stderr ?? ''}`.trim();
    throw new Error(`stellar CLI failed.\n${output}`);
  }
}

function addressOf(identity: string): string {
  return cli(['keys', 'address', identity]).trim();
}

const evidence: Record<string, unknown> = { version: 'v2', network: NETWORK, steps: [] };
function step(name: string, detail: Record<string, unknown>) {
  (evidence.steps as unknown[]).push({ step: name, ...detail, at: new Date().toISOString() });
}

let ctx: TenantContext;
let financeCtx: TenantContext;
let orgId: string;
let batchId: string;
let managerAddress: string;
let financeAddress: string;

beforeAll(async () => {
  if (!LIVE) return;
  // These tests TRUNCATE nothing, but they do write real records and spend real
  // test funds. Refuse outright unless the database is local.
  assertLocalDatabase();
  // A guard that refuses must say what it saw, or the operator is left guessing
  // which of several env sources put them on the wrong chain.
  const seen = {
    envNetwork: process.env.NEXT_PUBLIC_STELLAR_NETWORK ?? null,
    envContract: process.env.NEXT_PUBLIC_STELLAR_CONTRACT_ID ?? null,
    configNetwork: STELLAR_CONFIG.contract.network,
    configContract: STELLAR_CONFIG.contract.id || null,
    isMainnet: STELLAR_CONFIG.isMainnet(),
  };
  if (seen.isMainnet || seen.configNetwork !== 'testnet') {
    throw new Error(`refusing to run: not on Testnet. ${JSON.stringify(seen)}`);
  }
  if (!seen.envContract) {
    throw new Error(
      'refusing to run: NEXT_PUBLIC_STELLAR_CONTRACT_ID is not visible to this ' +
        `process, so the contract cannot be confirmed. ${JSON.stringify(seen)}`,
    );
  }

  await prisma.$connect();

  managerAddress = addressOf(MANAGER_KEY);
  financeAddress = addressOf('coreflow-v2-finance');
  expect(managerAddress).toMatch(/^G[A-Z2-7]{55}$/);
  expect(financeAddress).not.toBe(managerAddress);

  // A fresh organization per run, so this never disturbs earlier evidence.
  const slug = `live-funding-${Date.now()}`;
  const org = await prisma.organization.create({
    data: { name: 'Live Funding Run', slug },
    select: { id: true },
  });
  orgId = org.id;

  const manager = await prisma.user.upsert({
    where: { walletAddress: managerAddress },
    update: {},
    create: { walletAddress: managerAddress },
    select: { id: true },
  });
  const finance = await prisma.user.upsert({
    where: { walletAddress: financeAddress },
    update: {},
    create: { walletAddress: financeAddress },
    select: { id: true },
  });
  await prisma.orgMember.createMany({
    data: [
      { orgId, userId: manager.id, role: OrgRole.MANAGER, status: MembershipStatus.ACTIVE },
      { orgId, userId: finance.id, role: OrgRole.FINANCE, status: MembershipStatus.ACTIVE },
    ],
  });

  ctx = {
    orgId,
    orgName: 'Live Funding Run',
    orgSlug: slug,
    userId: manager.id,
    walletAddress: managerAddress,
    role: OrgRole.MANAGER,
  };
  financeCtx = { ...ctx, userId: finance.id, walletAddress: financeAddress, role: OrgRole.FINANCE };

  step('environment', {
    contractId: STELLAR_CONFIG.requireContractId(),
    assetContract: process.env.NEXT_PUBLIC_STELLAR_TOKEN_ID,
    orgId,
    managerAddress,
    financeAddress,
  });
}, 120_000);

afterAll(async () => {
  if (!LIVE) return;
  mkdirSync('docs/evidence', { recursive: true });
  writeFileSync(
    'docs/evidence/testnet-v2-live-funding.json',
    JSON.stringify(evidence, null, 2) + '\n',
  );
  await prisma.$disconnect();
});

describe.skipIf(!LIVE)('live Testnet funding', () => {
  it('creates a real payroll of three payments from a CSV', async () => {
    const csv = [
      'recipient,amount,asset,hours,rate,period_start,period_end',
      ...ROWS.map(
        (r) =>
          `${addressOf(r.key)},${r.amount},USDC,${r.hours},${r.rate},${PERIOD.start},${PERIOD.end}`,
      ),
    ].join('\n');

    const outcome = await createBatch(prisma, ctx, {
      csv,
      filename: 'live-funding-run.csv',
      idempotencyKey: `live-${Date.now()}`,
    });
    batchId = outcome.batch.id;

    expect(outcome.created).toBe(true);
    expect(outcome.batch.paymentCount).toBe(3);
    expect(outcome.batch.totalBaseUnits).toBe(EXPECTED_TOTAL.toString());

    const payments = await prisma.payment.findMany({
      where: { orgId, batchId },
      orderBy: [{ createdAt: 'asc' }],
    });
    expect(payments).toHaveLength(3);
    for (const [i, p] of payments.entries()) {
      expect(p.state).toBe(PaymentState.DRAFT);
      expect(p.assetCode).toBe('USDC');
      expect(p.hours * p.rateBaseUnits).toBe(p.amountBaseUnits);
      expect(p.periodStart?.toISOString().slice(0, 10)).toBe(PERIOD.start);
      expect(p.recipientAddress).toBe(addressOf(ROWS[i].key));
    }

    step('payroll.created', {
      batchId,
      reference: outcome.batch.reference,
      paymentIds: payments.map((p) => p.id),
      totalBaseUnits: outcome.batch.totalBaseUnits,
    });
  }, 120_000);

  it('records both halves of the approval gate as real Approval rows', async () => {
    const payments = await prisma.payment.findMany({
      where: { orgId, batchId },
      select: { id: true, state: true },
    });

    const asManager = await approveBatch(prisma, ctx, { id: batchId, payments });
    const asFinance = await approveBatch(prisma, financeCtx, { id: batchId, payments });

    expect(asManager.recorded).toBe(3);
    expect(asFinance.recorded).toBe(3);

    const approvals = await prisma.approval.findMany({ where: { orgId } });
    expect(approvals).toHaveLength(6);
    // Two distinct wallets, never one standing in for both.
    expect(new Set(approvals.map((a) => a.actorAddress)).size).toBe(2);

    step('approvals.recorded', {
      manager: asManager.approvalRole,
      finance: asFinance.approvalRole,
      approvalCount: approvals.length,
    });
  }, 120_000);

  it('freezes a funding plan that matches the payroll exactly', async () => {
    const result = await openFundingIntent(prisma, ctx, {
      id: batchId,
      reference: (await prisma.payrollBatch.findUniqueOrThrow({
        where: { id: batchId },
        select: { reference: true },
      })).reference,
    });

    expect(result.created).toBe(true);
    expect(result.plan.schedule).toHaveLength(3);
    expect(result.plan.totalBaseUnits).toBe(EXPECTED_TOTAL.toString());
    expect(result.plan.manager).toBe(managerAddress);
    expect(result.plan.financeApprover).toBe(financeAddress);

    const record = await prisma.blockchainTransaction.findFirstOrThrow({
      where: { orgId, batchId },
    });
    expect(record.status).toBe(TxStatus.AWAITING_SIGNATURE);
    expect(record.planDigest).toMatch(/^[0-9a-f]{64}$/);

    // The stored plan is intact and is what confirmation will compare against.
    const stored = readStoredPlan({ plan: record.plan, planDigest: record.planDigest });
    expect(planDigest(stored)).toBe(record.planDigest);
    expect(stored.rows.map((r) => r.amountBaseUnits)).toEqual(['10000000', '15000000', '5000000']);

    step('funding.intent', {
      attemptId: record.id,
      planDigest: record.planDigest,
      paymentCount: stored.rows.length,
    });
  }, 120_000);

  it('submits ONE real transaction that creates and funds the escrow', async () => {
    const record = await prisma.blockchainTransaction.findFirstOrThrow({
      where: { orgId, batchId },
    });
    const plan = readStoredPlan({ plan: record.plan, planDigest: record.planDigest });

    // Built from the STORED plan, in order, with no adjustment.
    const payments = plan.rows.map((r, i) => ({
      id: i + 1,
      worker: r.worker,
      token: r.token,
      amount: r.amountBaseUnits,
      start_date: r.startDate,
      end_date: r.endDate,
      hours_logged: '0',
      rate_per_hour: r.rateBaseUnits,
      proof_verified: false,
      status: 0,
    }));

    const out = cli([
      'contract', 'invoke', '--id', plan.contractId, '--source', MANAGER_KEY,
      '--network', NETWORK, '--',
      'initialize_multi_sig_escrow',
      '--manager', plan.manager,
      '--finance_approver', plan.financeApprover,
      '--oracle_pubkey', plan.oraclePublicKey,
      '--payments', JSON.stringify(payments),
    ]);

    const hash = out.match(/explorer\/testnet\/tx\/([0-9a-f]{64})/)?.[1] ?? null;
    const escrowId = Number((out.trim().split('\n').pop() || '').replace(/[^0-9]/g, ''));

    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(Number.isInteger(escrowId) && escrowId > 0).toBe(true);

    // Persist the hash before any confirmation is attempted.
    const attempt = await recordFundingSubmitted(prisma, ctx, {
      attemptId: record.id,
      transactionHash: hash!,
      batchId,
    });
    expect(attempt.status).toBe(TxStatus.SUBMITTED);
    expect(attempt.hash).toBe(hash);

    evidence.transactionHash = hash;
    evidence.escrowId = escrowId;
    step('funding.submitted', { transactionHash: hash, escrowId });
  }, 300_000);

  it('independently verifies the SAC custody transfer', async () => {
    const verifier = createRpcVerifier();
    const assetContract = process.env.NEXT_PUBLIC_STELLAR_TOKEN_ID!;
    const transfers = await verifier.readTransfers(assetContract, {});
    expect(transfers.ok).toBe(true);
    if (!transfers.ok) return;

    // The TOKEN contract's own event, not CoreFlow's claim about it.
    const custody = transfers.value.find(
      (t) => t.txHash === evidence.transactionHash && t.from === managerAddress,
    );
    expect(custody).toBeDefined();
    expect(custody!.to).toBe(STELLAR_CONFIG.requireContractId());
    expect(custody!.amountBaseUnits).toBe(EXPECTED_TOTAL);
    expect(custody!.assetContractId).toBe(assetContract);

    step('custody.verified', {
      from: custody!.from,
      to: custody!.to,
      amountBaseUnits: custody!.amountBaseUnits.toString(),
      assetContractId: custody!.assetContractId,
      ledger: custody!.ledger,
    });
  }, 180_000);

  it('confirms funding against the frozen plan', async () => {
    const record = await prisma.blockchainTransaction.findFirstOrThrow({
      where: { orgId, batchId },
    });

    const result = await confirmFunding(prisma, ctx, createRpcVerifier(), {
      attemptId: record.id,
      // Supplied so the server cross-checks it against what the transaction
      // actually created, rather than trusting it.
      onChainEscrowId: evidence.escrowId as number,
      batchId,
    });

    expect(result.outcome).toBe('CONFIRMED');
    if (result.outcome !== 'CONFIRMED') {
      // Never submit another transaction to "fix" this. Record and stop.
      step('funding.not_confirmed', { outcome: result.outcome, result });
      return;
    }

    const escrow = await prisma.escrow.findFirstOrThrow({
      where: { orgId, onChainId: result.escrow.onChainId },
    });
    expect(escrow.managerAddress).toBe(managerAddress);
    expect(escrow.financeApproverAddress).toBe(financeAddress);
    expect(escrow.totalAmountBaseUnits).toBe(EXPECTED_TOTAL);

    const payments = await prisma.payment.findMany({
      where: { orgId, batchId },
      orderBy: [{ onChainPaymentIndex: 'asc' }],
    });
    expect(payments.map((p) => p.onChainPaymentIndex)).toEqual([0, 1, 2]);
    expect(payments.every((p) => p.escrowId === escrow.id)).toBe(true);

    step('funding.confirmed', {
      escrowDbId: escrow.id,
      onChainId: escrow.onChainId,
      totalAmountBaseUnits: escrow.totalAmountBaseUnits.toString(),
    });
  }, 300_000);

  it('projects the escrow and its three payments through the real indexer', async () => {
    const result = await runIndexerFromRpc();

    const payments = await prisma.payment.findMany({ where: { orgId, batchId } });
    // Three payments, still three. The indexer recognised our rows rather than
    // inventing a parallel set.
    expect(payments).toHaveLength(3);
    expect(payments.every((p) => p.state === PaymentState.AWAITING_ORACLE)).toBe(true);

    const events = await prisma.chainEvent.findMany({
      where: { txHash: evidence.transactionHash as string },
    });
    expect(events.some((e) => e.type === 'created')).toBe(true);
    expect(events.filter((e) => e.type === 'payment_added')).toHaveLength(3);

    step('indexer', {
      created: events.filter((e) => e.type === 'created').length,
      paymentAdded: events.filter((e) => e.type === 'payment_added').length,
      paymentsInDb: payments.length,
      states: [...new Set(payments.map((p) => p.state))],
      result,
    });
  }, 300_000);

  it('is accepted by independent reconciliation with zero findings', async () => {
    const summary = await runReconciliation(prisma, orgId, {});
    expect('skipped' in summary).toBe(false);
    if ('skipped' in summary) return;

    expect(summary.mismatched).toBe(0);
    expect(summary.findingsOpened).toBe(0);

    const findings = await prisma.reconciliationFinding.findMany({ where: { orgId } });
    expect(findings).toHaveLength(0);

    step('reconciliation', {
      escrowsExamined: summary.escrowsExamined,
      paymentsExamined: summary.paymentsExamined,
      agreed: summary.agreed,
      mismatched: summary.mismatched,
      findingsOpened: summary.findingsOpened,
    });
  }, 300_000);

  it('refuses a second funding attempt, without submitting anything', async () => {
    const batch = await prisma.payrollBatch.findUniqueOrThrow({
      where: { id: batchId },
      select: { id: true, reference: true },
    });

    // The whole point of the off-chain boundary: the contract would happily create
    // a second escrow and move the money again.
    await expect(openFundingIntent(prisma, ctx, batch)).rejects.toMatchObject({ status: 409 });

    const state = await getFundingState(prisma, ctx, batch);
    expect(state.assessment.eligible).toBe(false);
    expect(state.assessment.blockers.some((b) => b.code === 'ALREADY_FUNDED')).toBe(true);
    expect(state.plan).toBeNull();

    const attempts = await prisma.blockchainTransaction.findMany({ where: { orgId, batchId } });
    expect(attempts).toHaveLength(1);
    expect(attempts[0].status).toBe(TxStatus.CONFIRMED);

    step('duplicate.refused', {
      attempts: attempts.length,
      blocker: 'ALREADY_FUNDED',
    });
  }, 120_000);

  it('is idempotent under re-confirmation and indexer replay', async () => {
    const record = await prisma.blockchainTransaction.findFirstOrThrow({
      where: { orgId, batchId },
    });

    const again = await confirmFunding(prisma, ctx, createRpcVerifier(), {
      attemptId: record.id,
      batchId,
    });
    expect(again.outcome).toBe('CONFIRMED');

    // Replay the indexer over the same ledger range.
    await runIndexerFromRpc();

    expect(await prisma.escrow.count({ where: { orgId } })).toBe(1);
    expect(await prisma.payment.count({ where: { orgId, batchId } })).toBe(3);
    expect(await prisma.blockchainTransaction.count({ where: { orgId, batchId } })).toBe(1);
    expect(
      await prisma.auditEvent.count({ where: { orgId, type: 'funding.confirmed' } }),
    ).toBe(1);

    const summary = await runReconciliation(prisma, orgId, {});
    if (!('skipped' in summary)) {
      expect(summary.mismatched).toBe(0);
      expect(summary.findingsOpened).toBe(0);
    }

    step('idempotency', {
      escrows: 1,
      payments: 3,
      attempts: 1,
      fundingConfirmedEvents: 1,
    });
  }, 300_000);
});
