// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Real hasRole, mocked getUserFromRequest.
vi.mock('@/lib/auth', async (orig) => {
  const actual = await orig<typeof import('@/lib/auth')>();
  return { ...actual, getUserFromRequest: vi.fn() };
});

vi.mock('@/lib/db/prisma', () => {
  const prisma = {
    escrow: { findMany: vi.fn(), create: vi.fn() },
    orgMember: { findMany: vi.fn(), findUnique: vi.fn(), findFirst: vi.fn() },
    payrollBatch: { create: vi.fn() },
    payment: { create: vi.fn() },
    auditLog: { create: vi.fn() },
    // The route writes escrow + batch + payment atomically.
    $transaction: vi.fn(async (fn: any) => fn(prisma)),
  };
  return { default: prisma };
});

import { GET, POST } from '../escrows/route';
import { getUserFromRequest } from '@/lib/auth';
import prisma from '@/lib/db/prisma';

const mockGetUser = getUserFromRequest as unknown as ReturnType<typeof vi.fn>;
const mockPrisma = prisma as any;

function jsonReq(body: unknown) {
  return new Request('http://localhost/api/escrows', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }) as any;
}

describe('GET /api/escrows', () => {
  beforeEach(() => vi.clearAllMocks());

  it('401 when unauthenticated', async () => {
    mockGetUser.mockResolvedValue(null);
    const res = await GET(new Request('http://localhost/api/escrows') as any);
    expect(res.status).toBe(401);
  });

  it('returns nothing for a user who belongs to no organization', async () => {
    // Previously a platform ADMIN with no membership saw EVERY tenant's escrows.
    mockGetUser.mockResolvedValue({ userId: 'u1', walletAddress: 'GU', role: 'ADMIN' });
    mockPrisma.orgMember.findMany.mockResolvedValue([]);

    const body = await (await GET(new Request('http://localhost/api/escrows') as any)).json();

    expect(body.escrows).toEqual([]);
    expect(mockPrisma.escrow.findMany).not.toHaveBeenCalled();
  });

  it('scopes the query to the caller’s organizations', async () => {
    mockGetUser.mockResolvedValue({ userId: 'u1', walletAddress: 'GU', role: 'ADMIN' });
    mockPrisma.orgMember.findMany.mockResolvedValue([
      { orgId: 'orgA', role: 'OWNER' },
      { orgId: 'orgC', role: 'VIEWER' },
    ]);
    mockPrisma.escrow.findMany.mockResolvedValue([]);

    await GET(new Request('http://localhost/api/escrows') as any);

    const where = mockPrisma.escrow.findMany.mock.calls[0][0].where;
    // Every branch of the query names an organization the caller belongs to.
    const orgFilters = JSON.stringify(where);
    expect(orgFilters).toContain('orgA');
    expect(orgFilters).toContain('orgC');
    expect(orgFilters).not.toContain('orgB');
  });

  it('restricts a WORKER to escrows that pay them', async () => {
    // A WORKER holds no organization-wide read: otherwise any contractor could
    // enumerate the whole payroll.
    mockGetUser.mockResolvedValue({ userId: 'u1', walletAddress: 'GME', role: 'EMPLOYEE' });
    mockPrisma.orgMember.findMany.mockResolvedValue([{ orgId: 'orgA', role: 'WORKER' }]);
    mockPrisma.escrow.findMany.mockResolvedValue([]);

    await GET(new Request('http://localhost/api/escrows') as any);

    const where = JSON.stringify(mockPrisma.escrow.findMany.mock.calls[0][0].where);
    expect(where).toContain('recipientAddress');
    expect(where).toContain('GME');
  });

  it('returns mapped escrows for an authenticated user', async () => {
    mockGetUser.mockResolvedValue({ userId: 'u1', walletAddress: 'GU', role: 'EMPLOYEE' });
    mockPrisma.orgMember.findMany.mockResolvedValue([{ orgId: 'orgA', role: 'OWNER' }]);
    // A THREE-payee escrow: the response must carry three payments, not one.
    // Collapsing them into a single row was the defect this phase removed.
    mockPrisma.escrow.findMany.mockResolvedValue([
      {
        id: 'esc_1', onChainId: 7, contractId: 'CCONTRACT', network: 'testnet',
        assetDecimals: 7, managerApproved: true, financeApproved: true,
        cancelled: false, createdAt: new Date(),
        payments: [
          {
            id: 'p0', recipientAddress: 'GWORKER1', onChainPaymentIndex: 0,
            amountBaseUnits: 10_000_000_000n, rateBaseUnits: 250_000_000n, hours: 40n,
            assetDecimals: 7, assetCode: 'USDC', state: 'PAID',
            settlementTxHash: 'HASH0', settledAt: new Date(),
          },
          {
            id: 'p1', recipientAddress: 'GWORKER2', onChainPaymentIndex: 1,
            amountBaseUnits: 9_600_000_000n, rateBaseUnits: 300_000_000n, hours: 32n,
            assetDecimals: 7, assetCode: 'USDC', state: 'AWAITING_FINANCE',
            settlementTxHash: null, settledAt: null,
          },
          {
            id: 'p2', recipientAddress: 'GWORKER3', onChainPaymentIndex: 2,
            amountBaseUnits: 9_000_000_000n, rateBaseUnits: 200_000_000n, hours: 45n,
            assetDecimals: 7, assetCode: 'USDC', state: 'SETTLEMENT_FAILED',
            settlementTxHash: 'HASH2', settledAt: null,
          },
        ],
      },
    ]);
    const res = await GET(new Request('http://localhost/api/escrows') as any);
    const data = await res.json();
    expect(res.status).toBe(200);
    expect(data.escrows[0].id).toBe(7);
    expect(data.escrows[0].manager_approved).toBe(true);

    // THE REGRESSION GUARD: three payees must surface as three payments, each
    // with its own recipient and amount.
    expect(data.escrows[0].paymentCount).toBe(3);
    expect(data.escrows[0].payments).toHaveLength(3);
    expect(data.escrows[0].payments.map((p: any) => p.recipient))
      .toEqual(['GWORKER1', 'GWORKER2', 'GWORKER3']);
    expect(data.escrows[0].payments.map((p: any) => p.amount))
      .toEqual(['1,000.00', '960.00', '900.00']);

    // Aggregates are derived from the payments, not stored.
    expect(data.escrows[0].amount).toBe('2,860.00');
    expect(data.escrows[0].hoursLogged).toBe('117'); // 40 + 32 + 45

    // A batch containing a failure reports as failed, rather than letting one
    // broken payment hide inside a mostly-paid batch.
    expect(data.escrows[0].status).toBe('Settlement failed');

    // Per-payment states are distinct and human-readable, never "Processing".
    expect(data.escrows[0].payments.map((p: any) => p.stateLabel))
      .toEqual(['Paid', 'Awaiting finance approval', 'Settlement failed']);
  });
});

describe('POST /api/escrows', () => {
  beforeEach(() => vi.clearAllMocks());

  it('401 when unauthenticated', async () => {
    mockGetUser.mockResolvedValue(null);
    const res = await POST(jsonReq({ workerPubKey: 'G', amountBaseUnits: '1', rateBaseUnits: '1' }));
    expect(res.status).toBe(401);
  });

  it('403 for an employee (insufficient role)', async () => {
    mockGetUser.mockResolvedValue({ walletAddress: 'GU', role: 'EMPLOYEE' });
    const res = await POST(jsonReq({ workerPubKey: 'G', amountBaseUnits: '100', rateBaseUnits: '10' }));
    expect(res.status).toBe(403);
  });

  it('400 on invalid body (negative amount)', async () => {
    mockGetUser.mockResolvedValue({ walletAddress: 'GA', role: 'ADMIN' });
    const res = await POST(jsonReq({ workerPubKey: 'G', amountBaseUnits: '-5', rateBaseUnits: '10' }));
    expect(res.status).toBe(400);
  });

  it('201 for an admin with a valid body (and writes an audit log)', async () => {
    mockGetUser.mockResolvedValue({ walletAddress: 'GA', role: 'ADMIN' });
    mockPrisma.orgMember.findFirst.mockResolvedValue({ orgId: 'org_1' });
    mockPrisma.escrow.create.mockResolvedValue({
      id: 'esc_1',
      onChainId: null,
      totalAmountBaseUnits: 42_000_000_000n,
    });
    mockPrisma.payrollBatch.create.mockResolvedValue({ id: 'bat_1', reference: 'ESC-00000-esc_1' });
    mockPrisma.payment.create.mockResolvedValue({
      id: 'pay_1',
      state: 'VALIDATING',
      amountBaseUnits: 42_000_000_000n,
    });
    const res = await POST(jsonReq({
      workerPubKey: 'GWORKER', amountBaseUnits: '42000000000', rateBaseUnits: '2500000000',
    }));
    expect(res.status).toBe(201);
    expect(mockPrisma.escrow.create).toHaveBeenCalled();
    expect(mockPrisma.auditLog.create).toHaveBeenCalled();

    // BigInt columns must leave the API as strings: JSON.stringify throws on
    // bigint outright, so an un-serialized amount is a 500, not a rounding bug.
    const body = await res.json();
    expect(body.escrow.totalAmountBaseUnits).toBe('42000000000');
    expect(body.payment.amountBaseUnits).toBe('42000000000');

    // The value written to the DB is a bigint, not a lossy Number.
    expect(mockPrisma.escrow.create.mock.calls[0][0].data.totalAmountBaseUnits)
      .toBe(42_000_000_000n);

    // A recorded escrow creates its Payment row — the escrow is not itself the
    // payment.
    expect(mockPrisma.payment.create).toHaveBeenCalled();
    const paymentData = mockPrisma.payment.create.mock.calls[0][0].data;
    expect(paymentData.amountBaseUnits).toBe(42_000_000_000n);
    expect(paymentData.onChainPaymentIndex).toBe(0);
    // Nothing here asserts settlement: the indexer owns that.
    expect(paymentData.state).toBe('VALIDATING');
  });
});
