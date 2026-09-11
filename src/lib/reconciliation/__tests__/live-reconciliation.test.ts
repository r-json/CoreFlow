// @vitest-environment node
/**
 * Live reconciliation validation against the deployed v2 Testnet contract.
 *
 * OPT-IN (COREFLOW_LIVE_TESTNET=1): needs real Soroban RPC and real Postgres.
 *
 * Covers, on real chain data:
 *   1. successful reconciliation of a settled multi-payee batch
 *   2. repeated runs are idempotent
 *   3. interrupted indexing, then reconciliation recovers the projection
 *   4. an unattributed escrow is reported, never auto-attached
 *   5. a DATABASE_AHEAD mismatch is detected and NOT reverted
 *
 * Case 5 uses a synthetic payment inside a throwaway test organization, pointing
 * at a real escrow slot that was never settled. Nothing is written through a
 * production settlement path, and the organization is deleted afterwards.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  PaymentState, OrgRole, MembershipStatus,
  FindingKind, FindingSeverity, FindingStatus, RunStatus,
} from '@prisma/client';

const LIVE = process.env.COREFLOW_LIVE_TESTNET === '1';
const SLUG = 'live-reconcile-test';

describe.skipIf(!LIVE)('reconciliation — live v2 Testnet', () => {
  let prisma: any;
  let verifier: any;
  let orgId: string;
  let contractId: string;
  let network: string;
  let settledEscrowOnChainId: number;

  beforeAll(async () => {
    prisma = (await import('@/lib/db/prisma')).default;
    const { createRpcVerifier } = await import('../chain-verifier');
    const { STELLAR_CONFIG } = await import('@/lib/config');
    verifier = createRpcVerifier();
    contractId = STELLAR_CONFIG.contract.id;
    network = STELLAR_CONFIG.contract.network;

    const org = await prisma.organization.upsert({
      where: { slug: SLUG },
      create: { name: 'Live Reconciliation Test', slug: SLUG },
      update: {},
    });
    orgId = org.id;
    const user = await prisma.user.upsert({
      where: { walletAddress: 'GLIVERECON' },
      create: { walletAddress: 'GLIVERECON' },
      update: {},
    });
    await prisma.orgMember.upsert({
      where: { orgId_userId: { orgId, userId: user.id } },
      create: { orgId, userId: user.id, role: OrgRole.OWNER, status: MembershipStatus.ACTIVE },
      update: { status: MembershipStatus.ACTIVE },
    });
  });

  afterAll(async () => {
    if (prisma && orgId) {
      await prisma.organization.delete({ where: { id: orgId } }).catch(() => {});
    }
  });

  it('indexes a settled batch, then reconciles it as AGREED', async () => {
    const { runIndexerFromRpc } = await import('@/lib/indexer/run');
    const { runReconciliation } = await import('../scheduler');

    // Fresh read of the whole retained window.
    await prisma.chainEvent.deleteMany({});
    await prisma.indexerCursor.deleteMany({});

    // Discover a settled escrow from the log, then claim it for the test tenant.
    const firstPass = await runIndexerFromRpc();
    console.log('INDEX PASS 1:', JSON.stringify(firstPass));

    const paidEvent = await prisma.chainEvent.findFirst({
      where: { type: 'payment_paid' },
      orderBy: { ledger: 'desc' },
    });
    expect(paidEvent, 'expected a settled escrow in the retained log').toBeTruthy();
    settledEscrowOnChainId = paidEvent.escrowOnChainId;

    await prisma.escrow.create({
      data: {
        orgId, onChainId: settledEscrowOnChainId, contractId, network,
        managerAddress: 'GLIVERECON', financeApproverAddress: 'GLIVEFIN',
        assetDecimals: 7,
      },
    });

    const secondPass = await runIndexerFromRpc();
    console.log('INDEX PASS 2 (after claim):', JSON.stringify(secondPass));

    const payments = await prisma.payment.findMany({
      where: { orgId }, orderBy: { onChainPaymentIndex: 'asc' },
    });
    expect(payments.length).toBeGreaterThanOrEqual(3);
    expect(payments.every((p: any) => p.state === PaymentState.PAID)).toBe(true);

    // Reconcile: the TOKEN's own transfer events must corroborate every payment.
    const run = await runReconciliation(prisma, orgId, {
      verifier, contractId, network, maxEscrows: 10,
    });
    if ('skipped' in run) throw new Error('unexpected skip');
    console.log('RECONCILE:', JSON.stringify(run));

    expect(run.status).toBe(RunStatus.COMPLETED);
    expect(run.paymentsExamined).toBeGreaterThanOrEqual(3);
    expect(run.agreed).toBeGreaterThanOrEqual(3);
    expect(run.databaseAhead).toBe(0);
    expect(run.mismatched).toBe(0);

    const findings = await prisma.reconciliationFinding.findMany({ where: { orgId } });
    console.log(`findings: ${findings.length}`);
    for (const f of findings) console.log(`  ${f.severity} ${f.kind}: ${f.detail}`);
    // Any finding other than an unattributed-escrow report would be a real problem.
    const unexpected = findings.filter(
      (f: any) => f.kind !== FindingKind.UNKNOWN_ON_CHAIN_OBJECT
    );
    expect(unexpected).toHaveLength(0);
  }, 600_000);

  it('is idempotent across repeated runs', async () => {
    const { runReconciliation } = await import('../scheduler');

    const before = await prisma.reconciliationFinding.count({ where: { orgId } });
    const run = await runReconciliation(prisma, orgId, {
      verifier, contractId, network, maxEscrows: 10,
    });
    if ('skipped' in run) throw new Error('unexpected skip');

    expect(run.correctionsApplied).toBe(0);
    expect(await prisma.reconciliationFinding.count({ where: { orgId } })).toBe(before);

    // Two runs exist, both completed: the lock was released, not leaked.
    const runs = await prisma.reconciliationRun.findMany({ where: { orgId } });
    expect(runs.length).toBeGreaterThanOrEqual(2);
    expect(runs.every((r: any) => r.status === RunStatus.COMPLETED)).toBe(true);
  }, 300_000);

  it('recovers a projection left behind by an interrupted indexer', async () => {
    const { runReconciliation } = await import('../scheduler');

    // Simulate the indexer having missed the settlement events: roll one payment
    // back to CONFIRMING, as if confirmation was never observed.
    const target = await prisma.payment.findFirst({
      where: { orgId, state: PaymentState.PAID },
      orderBy: { onChainPaymentIndex: 'asc' },
    });
    expect(target).toBeTruthy();
    await prisma.payment.update({
      where: { id: target.id },
      data: { state: PaymentState.CONFIRMING, settledAt: null, settlementTxHash: null },
    });

    const run = await runReconciliation(prisma, orgId, {
      verifier, contractId, network, maxEscrows: 10,
    });
    if ('skipped' in run) throw new Error('unexpected skip');
    console.log('RECOVERY RUN:', JSON.stringify(run));

    expect(run.chainAhead).toBe(1);
    expect(run.correctionsApplied).toBe(1);

    const recovered = await prisma.payment.findUnique({ where: { id: target.id } });
    expect(recovered.state).toBe(PaymentState.PAID);
    // Evidence, not a guess: the hash comes from the observed SAC transfer.
    expect(recovered.settlementTxHash).toBeTruthy();
    expect(recovered.settledAt).toBeTruthy();

    const audit = await prisma.auditEvent.findFirst({
      where: { paymentId: target.id, newState: PaymentState.PAID },
      orderBy: { createdAt: 'desc' },
    });
    expect(audit.actorSystem).toBe('reconciler');
    expect((audit.metadata as any).verifiedBy).toBe('sac-transfer-event');
  }, 300_000);

  it('reports an unattributed escrow without attaching it to any tenant', async () => {
    const { reportUnattributedEscrows } = await import('../reconciler');

    const unattributed = await prisma.chainEvent.count({
      where: { attributed: false, contractId, network },
    });
    expect(unattributed, 'expected unattributed events from other escrows').toBeGreaterThan(0);

    const run = await prisma.reconciliationRun.create({
      data: {
        orgId, correlationId: `rec_live_${Date.now()}`, scope: 'orphan-check',
        status: RunStatus.RUNNING, contractId, network,
      },
    });
    const r = await reportUnattributedEscrows(prisma, orgId, {
      id: run.id, correlationId: run.correlationId,
    }, { contractId, network });

    expect(r.unknown).toBeGreaterThan(0);
    const f = await prisma.reconciliationFinding.findFirst({
      where: { orgId, kind: FindingKind.UNKNOWN_ON_CHAIN_OBJECT },
    });
    expect(f).toBeTruthy();
    expect(f.severity).toBe(FindingSeverity.LOW);
    expect(f.remediation).toMatch(/will not guess an owner/i);

    // Nothing was attached: no escrow row was created for the unknown id.
    const claimed = await prisma.escrow.count({
      where: { orgId, onChainId: f.escrowOnChainId },
    });
    expect(claimed).toBe(0);

    await prisma.reconciliationRun.update({
      where: { id: run.id }, data: { status: RunStatus.COMPLETED, completedAt: new Date() },
    });
  }, 300_000);

  it('detects a DATABASE_AHEAD mismatch and does NOT revert it', async () => {
    const { runReconciliation } = await import('../scheduler');

    // A synthetic payment in the throwaway test organization, pointing at a real
    // escrow slot that was never settled. Written directly, NOT through any
    // settlement path, and labelled so it cannot be mistaken for real payroll.
    const escrow = await prisma.escrow.findFirst({ where: { orgId } });
    const batch = await prisma.payrollBatch.findFirst({ where: { orgId } });
    const fakeIndex = 97;

    const synthetic = await prisma.payment.create({
      data: {
        orgId,
        batchId: batch.id,
        escrowId: escrow.id,
        recipientAddress: 'GSYNTHETICTESTRECIPIENT' + 'X'.repeat(33),
        onChainPaymentIndex: fakeIndex,
        assetContractId: escrow.tokenAddress,
        assetDecimals: 7,
        amountBaseUnits: 12_345_000_000n,
        rateBaseUnits: 1n,
        hours: 12_345_000_000n,
        // The mismatch under test: claims settled, chain has no such payment.
        state: PaymentState.PAID,
        settledAt: new Date(),
        settlementTxHash: 'SYNTHETIC_TEST_HASH_NOT_A_REAL_TRANSACTION',
        stateReason: 'SYNTHETIC TEST ROW — reconciliation mismatch validation',
      },
    });

    const run = await runReconciliation(prisma, orgId, {
      verifier, contractId, network, maxEscrows: 10,
    });
    if ('skipped' in run) throw new Error('unexpected skip');
    console.log('MISMATCH RUN:', JSON.stringify(run));

    // The slot does not exist on-chain, so this surfaces as MISSING_ON_CHAIN.
    const f = await prisma.reconciliationFinding.findFirst({
      where: { orgId, paymentId: synthetic.id, status: { not: FindingStatus.RESOLVED } },
    });
    expect(f, 'expected a finding for the synthetic payment').toBeTruthy();
    console.log(`  detected: ${f.severity} ${f.kind} — ${f.detail}`);
    expect([
      FindingKind.MISSING_ON_CHAIN,
      FindingKind.DB_PAID_CHAIN_NOT,
    ]).toContain(f.kind);
    expect(f.remediation).toBeTruthy();

    // PAID was NOT reverted: the finding is the record, and a terminal financial
    // state is never rewritten to make the database look tidy.
    const after = await prisma.payment.findUnique({ where: { id: synthetic.id } });
    expect(after.state).toBe(PaymentState.PAID);
    expect(after.settlementTxHash).toBe('SYNTHETIC_TEST_HASH_NOT_A_REAL_TRANSACTION');

    // And the real payments were unaffected by the synthetic one.
    const real = await prisma.payment.findMany({
      where: { orgId, onChainPaymentIndex: { lt: 10 } },
    });
    expect(real.every((p: any) => p.state === PaymentState.PAID)).toBe(true);
  }, 300_000);
});
