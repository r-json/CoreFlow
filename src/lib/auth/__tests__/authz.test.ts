// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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

import { hasRole, upsertUser } from '@/lib/auth';
import prisma from '@/lib/db/prisma';

const mockPrisma = prisma as any;

describe('hasRole', () => {
  it('admin passes any check (short-circuit)', () => {
    expect(hasRole({ role: 'admin' }, [])).toBe(true);
    expect(hasRole({ role: 'admin' }, ['manager'])).toBe(true);
  });

  it('matches explicitly listed roles', () => {
    expect(hasRole({ role: 'manager' }, ['manager', 'finance'])).toBe(true);
    expect(hasRole({ role: 'finance' }, ['manager', 'finance'])).toBe(true);
    expect(hasRole({ role: 'viewer' }, ['manager'])).toBe(false);
  });

  it('rejects a null/undefined payload', () => {
    expect(hasRole(null, ['manager'])).toBe(false);
    expect(hasRole(undefined, ['manager'])).toBe(false);
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
    mockPrisma.user.upsert.mockResolvedValue({ walletAddress: 'GADMIN', role: 'viewer' });
    mockPrisma.user.update.mockResolvedValue({ walletAddress: 'GADMIN', role: 'admin' });

    const user = await upsertUser('GADMIN');
    expect(user.role).toBe('admin');
    expect(mockPrisma.user.update).toHaveBeenCalledWith({
      where: { walletAddress: 'GADMIN' },
      data: { role: 'admin' },
    });
  });

  it('does not promote a non-allowlisted wallet', async () => {
    mockPrisma.user.upsert.mockResolvedValue({ walletAddress: 'GUSER', role: 'viewer' });

    const user = await upsertUser('GUSER');
    expect(user.role).toBe('viewer');
    expect(mockPrisma.user.update).not.toHaveBeenCalled();
  });

  it('does not re-promote an existing admin', async () => {
    process.env.ADMIN_WALLETS = 'GADMIN';
    mockPrisma.user.upsert.mockResolvedValue({ walletAddress: 'GADMIN', role: 'admin' });

    const user = await upsertUser('GADMIN');
    expect(user.role).toBe('admin');
    expect(mockPrisma.user.update).not.toHaveBeenCalled();
  });
});
