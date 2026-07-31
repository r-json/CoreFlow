// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/auth', async (orig) => {
  const actual = await orig<typeof import('@/lib/auth')>();
  return { ...actual, getUserFromRequest: vi.fn() };
});

vi.mock('@/lib/db/prisma', () => {
  const prisma = {
    user: { findMany: vi.fn(), upsert: vi.fn() },
    auditLog: { create: vi.fn() },
  };
  return { default: prisma };
});

import { GET, POST } from '../admin/roles/route';
import { getUserFromRequest } from '@/lib/auth';
import prisma from '@/lib/db/prisma';

const mockGetUser = getUserFromRequest as unknown as ReturnType<typeof vi.fn>;
const mockPrisma = prisma as any;

const VALID_WALLET = 'G' + 'A'.repeat(55);

function postReq(body: unknown) {
  return new Request('http://localhost/api/admin/roles', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }) as any;
}

describe('admin role management authz', () => {
  beforeEach(() => vi.clearAllMocks());

  it('GET 403 for a non-admin', async () => {
    mockGetUser.mockResolvedValue({ walletAddress: 'GM', role: 'EMPLOYEE' });
    const res = await GET(new Request('http://localhost/api/admin/roles') as any);
    expect(res.status).toBe(403);
  });

  it('GET lists users for an admin', async () => {
    mockGetUser.mockResolvedValue({ walletAddress: 'GA', role: 'ADMIN' });
    mockPrisma.user.findMany.mockResolvedValue([{ walletAddress: 'GU', role: 'EMPLOYEE', createdAt: new Date() }]);
    const res = await GET(new Request('http://localhost/api/admin/roles') as any);
    expect(res.status).toBe(200);
    expect((await res.json()).users).toHaveLength(1);
  });

  it('POST 403 for a non-admin', async () => {
    mockGetUser.mockResolvedValue({ walletAddress: 'GM', role: 'EMPLOYEE' });
    const res = await POST(postReq({ walletAddress: VALID_WALLET, role: 'ADMIN' }));
    expect(res.status).toBe(403);
  });

  it('POST 400 for an invalid role', async () => {
    mockGetUser.mockResolvedValue({ walletAddress: 'GA', role: 'ADMIN' });
    const res = await POST(postReq({ walletAddress: VALID_WALLET, role: 'SUPERUSER' }));
    expect(res.status).toBe(400);
  });

  it('POST grants a role for an admin and audits it', async () => {
    mockGetUser.mockResolvedValue({ walletAddress: 'GA', role: 'ADMIN' });
    mockPrisma.user.upsert.mockResolvedValue({ walletAddress: VALID_WALLET, role: 'ADMIN' });
    const res = await POST(postReq({ walletAddress: VALID_WALLET, role: 'ADMIN' }));
    expect(res.status).toBe(200);
    expect((await res.json()).user.role).toBe('ADMIN');
    expect(mockPrisma.auditLog.create).toHaveBeenCalled();
  });
});
