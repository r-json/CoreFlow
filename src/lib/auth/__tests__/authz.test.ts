// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Role } from '@prisma/client';

vi.mock('@stellar/stellar-sdk', () => ({ Keypair: { fromPublicKey: vi.fn() } }));
vi.mock('@/lib/auth/jwt', () => ({
  signJwt: vi.fn(),
  verifyJwt: vi.fn(),
  JWT_EXPIRY_SECONDS: 86400,
}));
vi.mock('@/lib/db/prisma', () => {
  const mockPrisma = { user: { upsert: vi.fn(), update: vi.fn() } };
  return { default: mockPrisma };
});

import { isAdmin, isEmployee, upsertUser } from '@/lib/auth';
import prisma from '@/lib/db/prisma';

const mockPrisma = prisma as any;

describe('RBAC authorization guards', () => {
  it('isAdmin returns true for ADMIN role', () => {
    expect(isAdmin({ walletAddress: 'G1', userId: 'u1', role: Role.ADMIN })).toBe(true);
  });

  it('isAdmin returns false for EMPLOYEE role', () => {
    expect(isAdmin({ walletAddress: 'G2', userId: 'u2', role: Role.EMPLOYEE })).toBe(false);
  });

  it('isEmployee returns true for EMPLOYEE role', () => {
    expect(isEmployee({ walletAddress: 'G2', userId: 'u2', role: Role.EMPLOYEE })).toBe(true);
  });

  it('rejects null payload', () => {
    expect(isAdmin(null)).toBe(false);
    expect(isEmployee(null)).toBe(false);
  });
});

describe('upsertUser admin bootstrap', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.ADMIN_WALLETS;
  });
  afterEach(() => {
    delete process.env.ADMIN_WALLETS;
  });

  it('promotes an allowlisted wallet to admin', async () => {
    process.env.ADMIN_WALLETS = 'GADMIN, GOTHER';
    mockPrisma.user.upsert.mockResolvedValue({ walletAddress: 'GADMIN', role: Role.EMPLOYEE });
    mockPrisma.user.update.mockResolvedValue({ walletAddress: 'GADMIN', role: Role.ADMIN });

    const user = await upsertUser('GADMIN');
    expect(user.role).toBe(Role.ADMIN);
    expect(mockPrisma.user.update).toHaveBeenCalledWith({
      where: { walletAddress: 'GADMIN' },
      data: { role: Role.ADMIN },
    });
  });

  it('does not promote a non-allowlisted wallet', async () => {
    mockPrisma.user.upsert.mockResolvedValue({ walletAddress: 'GUSER', role: Role.EMPLOYEE });

    const user = await upsertUser('GUSER');
    expect(user.role).toBe(Role.EMPLOYEE);
    expect(mockPrisma.user.update).not.toHaveBeenCalled();
  });

  it('does not re-promote an existing admin', async () => {
    process.env.ADMIN_WALLETS = 'GADMIN';
    mockPrisma.user.upsert.mockResolvedValue({ walletAddress: 'GADMIN', role: Role.ADMIN });

    const user = await upsertUser('GADMIN');
    expect(user.role).toBe(Role.ADMIN);
    expect(mockPrisma.user.update).not.toHaveBeenCalled();
  });
});
