// @vitest-environment node
/**
 * Live two-tenant isolation test against the deployed v2 Testnet contract.
 *
 * OPT-IN (COREFLOW_LIVE_TESTNET=1): needs real Soroban RPC and real Postgres.
 *
 * What it proves, on real chain data:
 *   1. An escrow with no tenant mapping is NOT projected — the indexer does not
 *      invent an owner.
 *   2. Once organization A claims it, its payments appear under A, and the history
 *      that arrived before the claim is replayed rather than lost.
 *   3. Organization B cannot see any of it, by id or by on-chain id.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PaymentState, OrgRole, MembershipStatus } from '@prisma/client';

const LIVE = process.env.COREFLOW_LIVE_TESTNET === '1';

const A_SLUG = 'live-test-org-a';
const B_SLUG = 'live-test-org-b';

describe.skipIf(!LIVE)('multi-tenancy — live v2 Testnet', () => {
  let prisma: any;
  let orgA: string;
  let orgB: string;
  let escrowOnChainId: number;

  beforeAll(async () => {
    prisma = (await import('@/lib/db/prisma')).default;

    // Two tenants, each with an owner.
    const a = await prisma.organization.upsert({
      where: { slug: A_SLUG }, create: { name: 'Live Test A', slug: A_SLUG }, update: {},
    });
    const b = await prisma.organization.upsert({
      where: { slug: B_SLUG }, create: { name: 'Live Test B', slug: B_SLUG }, update: {},
    });
    orgA = a.id; orgB = b.id;

    const ua = await prisma.user.upsert({
      where: { walletAddress: 'GLIVEA' }, create: { walletAddress: 'GLIVEA' }, update: {},
    });
    const ub = await prisma.user.upsert({
      where: { walletAddress: 'GLIVEB' }, create: { walletAddress: 'GLIVEB' }, update: {},
    });
    for (const [org, user] of [[orgA, ua.id], [orgB, ub.id]] as const) {
      await prisma.orgMember.upsert({
        where: { orgId_userId: { orgId: org, userId: user } },
        create: { orgId: org, userId: user, role: OrgRole.OWNER, status: MembershipStatus.ACTIVE },
        update: { status: MembershipStatus.ACTIVE },
      });
    }
  });

  afterAll(async () => {
    // Leave the database as found: these tenants exist only for the test.
    if (!prisma) return;
    for (const org of [orgA, orgB].filter(Boolean)) {
      await prisma.organization.delete({ where: { id: org } }).catch(() => {});
    }
  });

  it('does not project an escrow with no tenant mapping', async () => {
    const { runIndexerFromRpc } = await import('@/lib/indexer/run');

    // Start from scratch so the whole history is re-read.
    await prisma.chainEvent.deleteMany({});
    await prisma.indexerCursor.deleteMany({});

    const result = await runIndexerFromRpc();
    console.log('PASS 1 (no mapping):', JSON.stringify(result));

    // Real escrows exist on chain and none are claimed, so everything is
    // unattributed and nothing is projected.
    expect(result.unattributed).toBeGreaterThan(0);
    expect(result.paymentsCreated).toBe(0);

    const projected = await prisma.payment.count({ where: { orgId: { in: [orgA, orgB] } } });
    expect(projected).toBe(0);

    // And the indexer invented no organization of its own.
    const invented = await prisma.organization.count({
      where: { slug: { startsWith: 'chain-' } },
    });
    expect(invented).toBe(0);

    // The unattributed events were recorded, not dropped.
    expect(await prisma.chainEvent.count({ where: { attributed: false } })).toBeGreaterThan(0);
  }, 300_000);

  it('projects the escrow under org A once A claims it, replaying earlier events', async () => {
    const { runIndexerFromRpc } = await import('@/lib/indexer/run');
    const { STELLAR_CONFIG } = await import('@/lib/config');

    // Find a settled multi-payee escrow from the recorded events.
    const paidEvent = await prisma.chainEvent.findFirst({
      where: { type: 'payment_paid' },
      orderBy: { ledger: 'desc' },
    });
    expect(paidEvent, 'expected a settled escrow in the chain log').toBeTruthy();
    escrowOnChainId = paidEvent.escrowOnChainId;

    // Org A claims it. (The HTTP route additionally verifies the caller is the
    // on-chain manager; here the mapping is written directly, which is what a
    // successful claim produces.)
    await prisma.escrow.create({
      data: {
        orgId: orgA,
        onChainId: escrowOnChainId,
        contractId: STELLAR_CONFIG.contract.id,
        network: STELLAR_CONFIG.contract.network,
        managerAddress: 'GLIVEA',
        financeApproverAddress: 'GLIVEF',
        assetDecimals: 7,
      },
    });

    const result = await runIndexerFromRpc();
    console.log('PASS 2 (after claim):', JSON.stringify(result));

    const payments = await prisma.payment.findMany({
      where: { orgId: orgA },
      orderBy: { onChainPaymentIndex: 'asc' },
    });
    for (const p of payments) {
      console.log(
        `  org A  idx=${p.onChainPaymentIndex} ${p.recipientAddress.slice(0, 10)}… ` +
        `amount=${p.amountBaseUnits} state=${p.state}`
      );
    }

    // The history that arrived BEFORE the claim was replayed.
    expect(payments.length).toBeGreaterThanOrEqual(3);
    expect(payments.every((p: any) => p.state === PaymentState.PAID)).toBe(true);
    expect(new Set(payments.map((p: any) => p.recipientAddress)).size).toBe(payments.length);
  }, 300_000);

  it('shows org B nothing belonging to org A', async () => {
    const { findPayment, findEscrowByOnChainId, resolveTenant } =
      await import('@/lib/tenancy/resolve');

    const ub = await prisma.user.findUnique({ where: { walletAddress: 'GLIVEB' } });
    const tenantB = await resolveTenant(prisma, ub.id, orgB);
    expect(tenantB.ok).toBe(true);
    if (!tenantB.ok) return;

    // B's own scoped queries return nothing.
    expect(await prisma.payment.count({ where: { orgId: orgB } })).toBe(0);

    // Every one of A's payments is a 404 to B, by id.
    const aPayments = await prisma.payment.findMany({ where: { orgId: orgA }, select: { id: true } });
    expect(aPayments.length).toBeGreaterThan(0);
    for (const { id } of aPayments) {
      const r = await findPayment(prisma, tenantB.value, id);
      expect(r.ok, `org B must not read payment ${id}`).toBe(false);
      if (!r.ok) expect(r.status).toBe(404);
    }

    // And by on-chain id — the identifier B would most plausibly guess.
    const byChain = await findEscrowByOnChainId(prisma, tenantB.value, escrowOnChainId);
    expect(byChain.ok).toBe(false);
    if (!byChain.ok) expect(byChain.status).toBe(404);
  }, 120_000);
});
