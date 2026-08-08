// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/auth', async (orig) => {
  const actual = await orig<typeof import('@/lib/auth')>();
  return { ...actual, getUserFromRequest: vi.fn() };
});

vi.mock('@/lib/db/prisma', () => {
  const prisma = {
    invitation: { findUnique: vi.fn(), delete: vi.fn() },
    auditLog: { create: vi.fn() },
  };
  return { default: prisma };
});

import { DELETE } from '../invitations/[token]/route';
import { getUserFromRequest } from '@/lib/auth';
import prisma from '@/lib/db/prisma';

const mockGetUser = getUserFromRequest as unknown as ReturnType<typeof vi.fn>;
const mockPrisma = prisma as any;

function deleteReq(token: string) {
  return new Request(`http://localhost/api/admin/invitations/${token}`, {
    method: 'DELETE',
  }) as any;
}

describe('DELETE /api/admin/invitations/[token]', () => {
  beforeEach(() => vi.clearAllMocks());

  it('401 when unauthenticated', async () => {
    mockGetUser.mockResolvedValue(null);
    const res = await DELETE(deleteReq('sometoken'), { params: { token: 'sometoken' } });
    expect(res.status).toBe(401);
  });

  it('403 for a non-admin', async () => {
    mockGetUser.mockResolvedValue({ walletAddress: 'GM', role: 'EMPLOYEE' });
    const res = await DELETE(deleteReq('sometoken'), { params: { token: 'sometoken' } });
    expect(res.status).toBe(403);
  });

  it('404 when invitation not found', async () => {
    mockGetUser.mockResolvedValue({ walletAddress: 'GA', role: 'ADMIN' });
    mockPrisma.invitation.findUnique.mockResolvedValue(null);
    const res = await DELETE(deleteReq('sometoken'), { params: { token: 'sometoken' } });
    expect(res.status).toBe(404);
  });

  it('200 and deletes invitation for an admin', async () => {
    mockGetUser.mockResolvedValue({ walletAddress: 'GA', role: 'ADMIN' });
    mockPrisma.invitation.findUnique.mockResolvedValue({
      id: 'inv-1',
      email: 'test@example.com',
      role: 'EMPLOYEE',
      token: 'sometoken',
    });
    mockPrisma.invitation.delete.mockResolvedValue({});

    const res = await DELETE(deleteReq('sometoken'), { params: { token: 'sometoken' } });
    expect(res.status).toBe(200);
    expect(mockPrisma.invitation.delete).toHaveBeenCalledWith({
      where: { token: 'sometoken' },
    });
    expect(mockPrisma.auditLog.create).toHaveBeenCalled();
  });
});