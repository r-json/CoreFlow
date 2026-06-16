/**
 * Tests for the auth verification logic (verifyChallenge).
 * Keypair, Prisma, and nanoid are all mocked.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock stellar-sdk ─────────────────────────────────────────────────────────
const mockVerify = vi.fn();
vi.mock('@stellar/stellar-sdk', () => ({
  Keypair: {
    fromPublicKey: vi.fn(() => ({ verify: mockVerify })),
  },
}));

// ── Mock Prisma ──────────────────────────────────────────────────────────────
vi.mock('@/lib/db/prisma', () => {
  const mockPrisma = {
    authChallenge: {
      findFirst: vi.fn(),
      updateMany: vi.fn(),
    },
    user: {
      upsert: vi.fn(),
    },
    session: {
      create: vi.fn(),
    },
  };
  return { default: mockPrisma };
});

vi.mock('@/lib/auth/jwt', () => ({
  signJwt: vi.fn(() => Promise.resolve('mock.jwt.token')),
  verifyJwt: vi.fn(),
  JWT_EXPIRY_SECONDS: 86400,
}));

import { verifyChallenge, upsertUser, createSession } from '@/lib/auth';
import prisma from '@/lib/db/prisma';

const mockPrisma = prisma as any;

const ACTIVE_CHALLENGE = {
  id: 'challenge-id',
  walletAddress: 'GTEST123',
  nonce: 'test-nonce',
  expiresAt: new Date(Date.now() + 300_000),
  used: false,
  createdAt: new Date(),
};

describe('verifyChallenge', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPrisma.authChallenge.updateMany.mockResolvedValue({ count: 1 });
  });

  it('returns true for a valid signature against an active challenge', async () => {
    mockPrisma.authChallenge.findFirst.mockResolvedValue(ACTIVE_CHALLENGE);
    mockVerify.mockReturnValue(true);

    const result = await verifyChallenge('GTEST123', btoa('valid-sig'));
    expect(result).toBe(true);
    // Challenge must be marked used
    expect(mockPrisma.authChallenge.updateMany).toHaveBeenCalledWith({
      where: { id: ACTIVE_CHALLENGE.id, used: false },
      data: { used: true },
    });
  });

  it('returns false when no active challenge exists (expired or missing)', async () => {
    mockPrisma.authChallenge.findFirst.mockResolvedValue(null);

    const result = await verifyChallenge('GTEST123', btoa('any-sig'));
    expect(result).toBe(false);
    // Should NOT attempt to mark used if no challenge found
    expect(mockPrisma.authChallenge.updateMany).not.toHaveBeenCalled();
  });

  it('returns false when another request already marked it used (race condition)', async () => {
    mockPrisma.authChallenge.findFirst.mockResolvedValue(ACTIVE_CHALLENGE);
    mockPrisma.authChallenge.updateMany.mockResolvedValue({ count: 0 }); // simulate race

    const result = await verifyChallenge('GTEST123', btoa('any-sig'));
    expect(result).toBe(false);
  });

  it('returns false when signature verification fails', async () => {
    mockPrisma.authChallenge.findFirst.mockResolvedValue(ACTIVE_CHALLENGE);
    mockVerify.mockReturnValue(false);

    const result = await verifyChallenge('GTEST123', btoa('bad-sig'));
    expect(result).toBe(false);
    // Challenge is still marked used to prevent retry with same nonce
    expect(mockPrisma.authChallenge.updateMany).toHaveBeenCalledOnce();
  });

  it('returns false and marks challenge used even if Keypair.fromPublicKey throws', async () => {
    mockPrisma.authChallenge.findFirst.mockResolvedValue(ACTIVE_CHALLENGE);
    // Simulate malformed public key
    const { Keypair } = await import('@stellar/stellar-sdk');
    vi.mocked(Keypair.fromPublicKey).mockImplementationOnce(() => {
      throw new Error('Invalid key');
    });

    const result = await verifyChallenge('INVALID', btoa('any'));
    expect(result).toBe(false);
    expect(mockPrisma.authChallenge.updateMany).toHaveBeenCalledOnce();
  });
});

describe('upsertUser', () => {
  it('calls prisma.user.upsert with correct shape', async () => {
    mockPrisma.user.upsert.mockResolvedValue({
      id: 'user-1',
      walletAddress: 'GTEST123',
      role: 'viewer',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const user = await upsertUser('GTEST123');
    expect(user.walletAddress).toBe('GTEST123');
    // update must be empty — never downgrade role on login
    expect(mockPrisma.user.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ update: {} })
    );
  });
});

describe('createSession', () => {
  it('creates a session row and returns the JWT token', async () => {
    mockPrisma.session.create.mockResolvedValue({});
    const user = { id: 'user-1', walletAddress: 'GTEST123', role: 'viewer' };
    const token = await createSession(user);
    expect(token).toBe('mock.jwt.token');
    expect(mockPrisma.session.create).toHaveBeenCalledOnce();
  });
});
