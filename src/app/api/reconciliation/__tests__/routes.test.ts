// @vitest-environment node
/**
 * Reconciliation route tests.
 *
 * Two security properties dominate: the cross-organization cron trigger must not
 * be reachable without the shared secret, and resolving a finding must not be a
 * way to alter financial state or to dismiss a discrepancy silently.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { OrgRole, MembershipStatus, FindingStatus, FindingSeverity, FindingKind } from '@prisma/client';

vi.mock('@/lib/db/prisma', () => {
  const prisma: any = {
    organization: { findMany: vi.fn() },
    orgMember: { findUnique: vi.fn(), findMany: vi.fn() },
    reconciliationFinding: { findFirst: vi.fn(), findMany: vi.fn(), update: vi.fn(), groupBy: vi.fn() },
    reconciliationRun: { findFirst: vi.fn(), findMany: vi.fn() },
    auditEvent: { create: vi.fn() },
  };
  prisma.$transaction = vi.fn(async (fn: any) => fn(prisma));
  return { default: prisma };
});
vi.mock('@/lib/auth', () => ({ getUserFromRequest: vi.fn() }));
vi.mock('@/lib/reconciliation/scheduler', () => ({
  runReconciliation: vi.fn(async () => ({
    runId: 'r1', correlationId: 'rec_x', status: 'COMPLETED',
    escrowsExamined: 1, paymentsExamined: 3, agreed: 3, mismatched: 0,
    unreadable: 0, chainAhead: 0, databaseAhead: 0,
    findingsOpened: 0, correctionsApplied: 0,
  })),
  reconciliationHealth: vi.fn(async () => ({
    lastRun: null, openFindings: 0, criticalFindings: 0,
    oldestUnresolvedHours: null, degraded: true,
    degradedReason: 'Reconciliation has never run for this organization.',
  })),
}));
vi.mock('@/lib/explorer', () => ({ txUrl: (h: string) => `https://explorer/tx/${h}` }));

import { POST as cronRun } from '../run/route';
import { PATCH as patchFinding } from '../../organizations/[id]/findings/[findingId]/route';
import { GET as listFindings } from '../../organizations/[id]/findings/route';
import { getUserFromRequest } from '@/lib/auth';
import { runReconciliation } from '@/lib/reconciliation/scheduler';
import prismaDefault from '@/lib/db/prisma';

const prismaMock = prismaDefault as any;
const mockUser = getUserFromRequest as unknown as ReturnType<typeof vi.fn>;
const ORG = 'orgA';
const SECRET = 'a-sufficiently-long-cron-secret';

function signedInAs(role: OrgRole, orgId = ORG) {
  mockUser.mockResolvedValue({ userId: 'u1', walletAddress: 'G' + 'A'.repeat(55), role: 'EMPLOYEE' });
  prismaMock.orgMember.findUnique.mockResolvedValue({
    orgId, userId: 'u1', role, status: MembershipStatus.ACTIVE,
    org: { id: orgId, name: 'Org A', slug: 'org-a' },
    user: { walletAddress: 'G' + 'A'.repeat(55) },
  });
  prismaMock.orgMember.findMany.mockResolvedValue([{ orgId, role }]);
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.CRON_SECRET = SECRET;
  prismaMock.reconciliationFinding.findMany.mockResolvedValue([]);
  prismaMock.reconciliationFinding.groupBy.mockResolvedValue([]);
  prismaMock.organization.findMany.mockResolvedValue([{ id: ORG, slug: 'org-a' }]);
});
afterEach(() => {
  delete process.env.CRON_SECRET;
  delete process.env.INDEXER_SECRET;
});

describe('POST /api/reconciliation/run — the scheduled trigger', () => {
  const req = (auth?: string) =>
    new Request('http://localhost/api/reconciliation/run', {
      method: 'POST',
      headers: { 'x-forwarded-for': '203.0.113.5', ...(auth ? { authorization: auth } : {}) },
    }) as any;

  it('runs for every organization with the correct secret', async () => {
    const res = await cronRun(req(`Bearer ${SECRET}`));
    expect(res.status).toBe(200);
    expect(runReconciliation).toHaveBeenCalledTimes(1);
  });

  it('404s without the secret, revealing nothing about the endpoint', async () => {
    const res = await cronRun(req());
    expect(res.status).toBe(404);
    expect(runReconciliation).not.toHaveBeenCalled();
  });

  it('404s with a wrong secret', async () => {
    const res = await cronRun(req('Bearer not-the-secret-at-all-really'));
    expect(res.status).toBe(404);
    expect(runReconciliation).not.toHaveBeenCalled();
  });

  it('404s when no secret is configured', async () => {
    delete process.env.CRON_SECRET;
    const res = await cronRun(req('Bearer anything'));
    expect(res.status).toBe(404);
  });

  it('refuses to run behind a secret too short to resist guessing', async () => {
    // A short secret reads as protection while providing none.
    process.env.CRON_SECRET = 'short';
    const res = await cronRun(req('Bearer short'));
    expect(res.status).toBe(404);
    expect(runReconciliation).not.toHaveBeenCalled();
  });

  it('continues the sweep when one organization fails', async () => {
    // One tenant's RPC trouble must not stop another's reconciliation.
    prismaMock.organization.findMany.mockResolvedValue([
      { id: 'o1', slug: 's1' }, { id: 'o2', slug: 's2' },
    ]);
    (runReconciliation as any)
      .mockRejectedValueOnce(new Error('rpc down for o1'))
      .mockResolvedValueOnce({ runId: 'r2', correlationId: 'c2', status: 'COMPLETED' });

    const res = await cronRun(req(`Bearer ${SECRET}`));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.results).toHaveLength(2);
    expect(body.results[0].error).toMatch(/rpc down/);
    expect(body.results[1].status).toBe('COMPLETED');
  });
});

describe('PATCH finding lifecycle', () => {
  const req = (body: unknown, orgId = ORG) =>
    new Request(`http://localhost/api/organizations/${orgId}/findings/f1`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'x-organization-id': orgId },
      body: JSON.stringify(body),
    }) as any;

  const openFinding = {
    id: 'f1', orgId: ORG, status: FindingStatus.OPEN,
    severity: FindingSeverity.CRITICAL, kind: FindingKind.DB_PAID_CHAIN_NOT,
    paymentId: 'pay1', txHash: 'HASH',
  };

  it('401s when unauthenticated', async () => {
    mockUser.mockResolvedValue(null);
    const res = await patchFinding(req({ status: 'ACKNOWLEDGED' }), { params: { id: ORG, findingId: 'f1' } });
    expect(res.status).toBe(401);
  });

  it('403s a role that cannot resolve findings', async () => {
    signedInAs(OrgRole.VIEWER);
    const res = await patchFinding(req({ status: 'ACKNOWLEDGED' }), { params: { id: ORG, findingId: 'f1' } });
    expect(res.status).toBe(403);
  });

  it('404s a finding belonging to another organization', async () => {
    signedInAs(OrgRole.OWNER);
    prismaMock.reconciliationFinding.findFirst.mockResolvedValue(null);
    const res = await patchFinding(req({ status: 'ACKNOWLEDGED' }), { params: { id: ORG, findingId: 'f1' } });
    expect(res.status).toBe(404);
    expect(prismaMock.reconciliationFinding.update).not.toHaveBeenCalled();
  });

  it('acknowledges a finding and records who did it', async () => {
    signedInAs(OrgRole.OWNER);
    prismaMock.reconciliationFinding.findFirst.mockResolvedValue(openFinding);
    prismaMock.reconciliationFinding.update.mockResolvedValue({
      ...openFinding, status: FindingStatus.ACKNOWLEDGED, acknowledgedBy: 'G' + 'A'.repeat(55),
    });

    const res = await patchFinding(req({ status: 'ACKNOWLEDGED' }), { params: { id: ORG, findingId: 'f1' } });

    expect(res.status).toBe(200);
    const data = prismaMock.reconciliationFinding.update.mock.calls[0][0].data;
    expect(data.acknowledgedBy).toBe('G' + 'A'.repeat(55));
    expect(prismaMock.auditEvent.create).toHaveBeenCalled();
  });

  it('refuses to resolve without a substantive explanation', async () => {
    // A "mark resolved" button with no reason turns the queue into a dismiss
    // button, and the next reader during an incident learns nothing.
    signedInAs(OrgRole.OWNER);
    prismaMock.reconciliationFinding.findFirst.mockResolvedValue(openFinding);

    for (const resolution of [undefined, '', 'ok', 'fixed']) {
      const res = await patchFinding(
        req({ status: 'RESOLVED', resolution }),
        { params: { id: ORG, findingId: 'f1' } }
      );
      const body = await res.json();
      expect(res.status).toBe(400);
      expect(body.code).toBe('RESOLUTION_REASON_REQUIRED');
    }
    expect(prismaMock.reconciliationFinding.update).not.toHaveBeenCalled();
  });

  it('resolves with an explanation, recording actor and reason', async () => {
    signedInAs(OrgRole.OWNER);
    prismaMock.reconciliationFinding.findFirst.mockResolvedValue(openFinding);
    prismaMock.reconciliationFinding.update.mockResolvedValue({
      ...openFinding, status: FindingStatus.RESOLVED,
    });

    const reason = 'Confirmed on the explorer that tx HASH settled; indexer had lagged.';
    const res = await patchFinding(
      req({ status: 'RESOLVED', resolution: reason }),
      { params: { id: ORG, findingId: 'f1' } }
    );

    expect(res.status).toBe(200);
    const data = prismaMock.reconciliationFinding.update.mock.calls[0][0].data;
    expect(data.resolution).toBe(reason);
    expect(data.resolvedBy).toBe('G' + 'A'.repeat(55));
    const audit = prismaMock.auditEvent.create.mock.calls[0][0].data;
    expect(audit.type).toBe('reconciliation.finding.resolved');
    expect(audit.metadata.resolution).toBe(reason);
  });

  it('refuses an invalid lifecycle move', async () => {
    signedInAs(OrgRole.OWNER);
    prismaMock.reconciliationFinding.findFirst.mockResolvedValue({
      ...openFinding, status: FindingStatus.RESOLVED,
    });
    const res = await patchFinding(
      req({ status: 'OPEN' }),
      { params: { id: ORG, findingId: 'f1' } }
    );
    const body = await res.json();
    expect(res.status).toBe(409);
    expect(body.code).toBe('INVALID_FINDING_TRANSITION');
  });

  it('cannot alter payment state, amount or transaction hash', async () => {
    // Resolving records a judgement ABOUT a discrepancy; it must not be a channel
    // for writing financial fields.
    signedInAs(OrgRole.OWNER);
    prismaMock.reconciliationFinding.findFirst.mockResolvedValue(openFinding);
    prismaMock.reconciliationFinding.update.mockResolvedValue({
      ...openFinding, status: FindingStatus.RESOLVED,
    });

    await patchFinding(
      req({
        status: 'RESOLVED',
        resolution: 'Investigated and confirmed settled on chain.',
        // All of these are attempts to smuggle financial mutations through.
        paymentState: 'PAID',
        amountBaseUnits: '999999',
        txHash: 'FORGED_HASH',
        severity: 'LOW',
        orgId: 'orgB',
      }),
      { params: { id: ORG, findingId: 'f1' } }
    );

    const data = prismaMock.reconciliationFinding.update.mock.calls[0][0].data;
    // Only lifecycle fields were written.
    expect(Object.keys(data).sort()).toEqual(['resolution', 'resolvedAt', 'resolvedBy', 'status']);
    expect(data.txHash).toBeUndefined();
    expect(data.severity).toBeUndefined();
  });
});

describe('GET findings', () => {
  const req = (qs = '') =>
    new Request(`http://localhost/api/organizations/${ORG}/findings${qs}`, {
      headers: { 'x-organization-id': ORG },
    }) as any;

  it('403s a role without reconciliation read access', async () => {
    signedInAs(OrgRole.WORKER);
    const res = await listFindings(req(), { params: { id: ORG } });
    expect(res.status).toBe(403);
  });

  it('scopes the query to the caller’s organization', async () => {
    signedInAs(OrgRole.OWNER);
    await listFindings(req(), { params: { id: ORG } });
    const where = prismaMock.reconciliationFinding.findMany.mock.calls[0][0].where;
    expect(where.orgId).toBe(ORG);
  });

  it('defaults to unresolved findings', async () => {
    signedInAs(OrgRole.OWNER);
    await listFindings(req(), { params: { id: ORG } });
    const where = prismaMock.reconciliationFinding.findMany.mock.calls[0][0].where;
    expect(where.status).toEqual({ not: FindingStatus.RESOLVED });
  });

  it('rejects an unknown status filter', async () => {
    signedInAs(OrgRole.OWNER);
    const res = await listFindings(req('?status=NONSENSE'), { params: { id: ORG } });
    expect(res.status).toBe(400);
  });

  it('404s when the path organization differs from the resolved membership', async () => {
    signedInAs(OrgRole.OWNER, ORG);
    const res = await listFindings(req(), { params: { id: 'orgB' } });
    expect(res.status).toBe(404);
  });

  it('surfaces remediation and an explorer link', async () => {
    signedInAs(OrgRole.OWNER);
    prismaMock.reconciliationFinding.findMany.mockResolvedValue([{
      id: 'f1', kind: FindingKind.DB_PAID_CHAIN_NOT, status: FindingStatus.OPEN,
      severity: FindingSeverity.CRITICAL, detail: 'mismatch',
      remediation: 'Do not rely on the payment record.',
      dbState: 'PAID', chainState: 'no settlement', txHash: 'HASH',
      escrowOnChainId: 3, paymentIndex: 0,
      detectedAt: new Date(), lastObservedAt: new Date(), observationCount: 2,
      acknowledgedBy: null, acknowledgedAt: null,
      resolvedBy: null, resolvedAt: null, resolution: null,
      payment: {
        id: 'pay1', recipientAddress: 'GW', amountBaseUnits: 10_000_000_000n,
        assetDecimals: 7, assetCode: 'USDC', state: 'PAID',
        batch: { id: 'b1', reference: 'CF-00001' },
      },
      run: { correlationId: 'rec_1', startedAt: new Date() },
    }]);

    const body = await (await listFindings(req(), { params: { id: ORG } })).json();
    const f = body.findings[0];
    expect(f.remediation).toMatch(/Do not rely/);
    expect(f.transaction.explorerUrl).toBe('https://explorer/tx/HASH');
    expect(f.payment.amount).toBe('1,000.00');
    expect(f.observationCount).toBe(2);
  });
});
