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
    auditLog: { create: vi.fn() },
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

  it('returns mapped escrows for an authenticated user', async () => {
    mockGetUser.mockResolvedValue({ walletAddress: 'GU', role: 'viewer' });
    mockPrisma.escrow.findMany.mockResolvedValue([
      {
        id: 1, onChainId: 7, workerPubKey: 'GWORKERADDRESSLONG', amountCents: 420000,
        rateCents: 25000, currency: 'USDC', status: 'ready', managerApproved: true,
        financeApproved: true, createdAt: new Date(), timeLogs: [{ hoursLogged: 40 }],
      },
    ]);
    const res = await GET(new Request('http://localhost/api/escrows') as any);
    const data = await res.json();
    expect(res.status).toBe(200);
    expect(data.escrows[0].id).toBe(7);
    expect(data.escrows[0].hoursLogged).toBe('40');
    expect(data.escrows[0].manager_approved).toBe(true);
  });
});

describe('POST /api/escrows', () => {
  beforeEach(() => vi.clearAllMocks());

  it('401 when unauthenticated', async () => {
    mockGetUser.mockResolvedValue(null);
    const res = await POST(jsonReq({ workerPubKey: 'G', amountCents: 1, rateCents: 1 }));
    expect(res.status).toBe(401);
  });

  it('403 for a viewer (insufficient role)', async () => {
    mockGetUser.mockResolvedValue({ walletAddress: 'GU', role: 'viewer' });
    const res = await POST(jsonReq({ workerPubKey: 'G', amountCents: 100, rateCents: 10 }));
    expect(res.status).toBe(403);
  });

  it('400 on invalid body (negative amount)', async () => {
    mockGetUser.mockResolvedValue({ walletAddress: 'GM', role: 'manager' });
    const res = await POST(jsonReq({ workerPubKey: 'G', amountCents: -5, rateCents: 10 }));
    expect(res.status).toBe(400);
  });

  it('201 for a manager with a valid body (and writes an audit log)', async () => {
    mockGetUser.mockResolvedValue({ walletAddress: 'GM', role: 'manager' });
    mockPrisma.escrow.create.mockResolvedValue({ id: 1, onChainId: null });
    const res = await POST(jsonReq({ workerPubKey: 'GWORKER', amountCents: 4200, rateCents: 250 }));
    expect(res.status).toBe(201);
    expect(mockPrisma.escrow.create).toHaveBeenCalled();
    expect(mockPrisma.auditLog.create).toHaveBeenCalled();
  });

  it('admin is allowed (role short-circuit)', async () => {
    mockGetUser.mockResolvedValue({ walletAddress: 'GA', role: 'admin' });
    mockPrisma.escrow.create.mockResolvedValue({ id: 2, onChainId: 9 });
    const res = await POST(jsonReq({ workerPubKey: 'GWORKER', amountCents: 4200, rateCents: 250 }));
    expect(res.status).toBe(201);
  });
});
