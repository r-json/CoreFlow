// @vitest-environment node
/**
 * Live indexer integration test against the deployed v2 Testnet contract.
 *
 * OPT-IN. Skipped unless COREFLOW_LIVE_TESTNET=1, because it needs both a
 * reachable Soroban RPC and a real Postgres. The standard suite stays hermetic;
 * keeping this in the repo means the chain→DB projection is verifiable rather
 * than asserted.
 *
 * THE CLAIM UNDER TEST: a three-payee settlement produces THREE Payment rows
 * with their own recipients and amounts. That is the defect P2 #1 existed to fix,
 * and proving it against real chain data is the acceptance gate.
 *
 *   set -a && . ./.env.testnet.local && set +a
 *   DATABASE_URL=postgresql://coreflow:coreflow@localhost:5433/coreflow \
 *   COREFLOW_LIVE_TESTNET=1 npx vitest run src/lib/indexer/__tests__/live-testnet.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PaymentState, OrgRole, MembershipStatus } from '@prisma/client';

const LIVE = process.env.COREFLOW_LIVE_TESTNET === '1';
const SLUG = 'live-indexer-test';

describe.skipIf(!LIVE)('indexer — live v2 Testnet', () => {
  let prisma: any;
  let orgId: string;

  /**
   * Self-contained tenant setup.
   *
   * Since P2 #2 the indexer refuses to invent an organization, so an escrow with no
   * mapping is recorded unattributed and nothing is projected. This test must
   * therefore create its own tenant and claim an escrow — relying on another
   * suite's leftover state would make it order-dependent and, worse, make it pass
   * for the wrong reason.
   */
  beforeAll(async () => {
    prisma = (await import('@/lib/db/prisma')).default;
    const org = await prisma.organization.upsert({
      where: { slug: SLUG }, create: { name: 'Live Indexer Test', slug: SLUG }, update: {},
    });
    orgId = org.id;
    const user = await prisma.user.upsert({
      where: { walletAddress: 'GLIVEINDEXER' },
      create: { walletAddress: 'GLIVEINDEXER' }, update: {},
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

  it('projects a multi-payee settlement into one Payment per payee', async () => {
    const { runIndexerFromRpc } = await import('@/lib/indexer/run');
    const { STELLAR_CONFIG } = await import('@/lib/config');

    // Read the retained window, discover a settled escrow, claim it, re-index.
    await prisma.chainEvent.deleteMany({});
    await prisma.indexerCursor.deleteMany({});
    const discovery = await runIndexerFromRpc();
    console.log('INDEXER discovery:', JSON.stringify(discovery));

    const paidEvent = await prisma.chainEvent.findFirst({
      where: { type: 'payment_paid' }, orderBy: { ledger: 'desc' },
    });
    expect(paidEvent, 'expected a settled escrow in the retained log').toBeTruthy();

    await prisma.escrow.create({
      data: {
        orgId, onChainId: paidEvent.escrowOnChainId,
        contractId: STELLAR_CONFIG.contract.id,
        network: STELLAR_CONFIG.contract.network,
        managerAddress: 'GLIVEINDEXER', financeApproverAddress: 'GLIVEFIN',
        assetDecimals: 7,
      },
    });

    const result = await runIndexerFromRpc();
    console.log('INDEXER:', JSON.stringify(result));

    // Find an escrow with more than one payment — the golden path settles three.
    const escrows = await prisma.escrow.findMany({
      where: { orgId },
      include: { payments: { orderBy: { onChainPaymentIndex: 'asc' } } },
      orderBy: { onChainId: 'desc' },
    });
    for (const e of escrows) {
      console.log(`escrow ${e.onChainId}: ${e.payments.length} payment(s)`);
      for (const p of e.payments) {
        console.log(
          `   idx=${p.onChainPaymentIndex} ${p.recipientAddress.slice(0, 10)}… ` +
          `amount=${p.amountBaseUnits} hours=${p.hours} state=${p.state}`
        );
      }
    }

    const multi = escrows.find((e) => e.payments.length > 1);
    expect(multi, 'expected an escrow with multiple payments').toBeDefined();

    const payments = multi!.payments;
    expect(payments.length).toBeGreaterThanOrEqual(3);

    // Each payment is its own financial record: distinct recipient, own amount.
    const recipients = payments.map((p) => p.recipientAddress);
    expect(new Set(recipients).size).toBe(recipients.length);

    const amounts = payments.map((p) => p.amountBaseUnits);
    expect(new Set(amounts.map(String)).size).toBeGreaterThan(1);

    // The golden path settles 1000 / 960 / 900 USDC at 7 decimals.
    expect(amounts.map(String).sort()).toEqual(
      ['10000000000', '9000000000', '9600000000'].sort()
    );

    // Settled, with chain-derived state.
    expect(payments.every((p) => p.state === PaymentState.PAID)).toBe(true);
    expect(payments.every((p) => p.settlementTxHash !== null)).toBe(true);
    expect(payments.every((p) => p.settledAt !== null)).toBe(true);

    // Money stays bigint at the asset's own precision.
    for (const p of payments) {
      expect(typeof p.amountBaseUnits).toBe('bigint');
      expect(p.assetDecimals).toBe(7);
    }

    // Per-payment audit history exists, attributed to the indexer.
    const audits = await prisma.auditEvent.findMany({
      where: { paymentId: { in: payments.map((p) => p.id) }, newState: PaymentState.PAID },
    });
    expect(audits.length).toBe(payments.length);
    expect(audits.every((a) => a.actorSystem === 'indexer')).toBe(true);

    // Re-running adds no duplicate events and no duplicate payments.
    const eventsBefore = await prisma.chainEvent.count();
    const paymentsBefore = await prisma.payment.count();
    await runIndexerFromRpc();
    expect(await prisma.chainEvent.count()).toBe(eventsBefore);
    expect(await prisma.payment.count()).toBe(paymentsBefore);
  }, 300_000);
});
