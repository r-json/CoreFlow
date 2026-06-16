/**
 * Tests for the auth challenge creation logic.
 * Prisma and stellar-sdk are mocked so tests run instantly without any DB or network.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildChallengeString, CHALLENGE_PREFIX } from '@/lib/auth';

// ── Mock Prisma ──────────────────────────────────────────────────────────────
vi.mock('@/lib/db/prisma', () => {
  const mockPrisma = {
    authChallenge: {
      findFirst: vi.fn(),
      create: vi.fn(),
    },
  };
  return { default: mockPrisma };
});

// ── Mock nanoid ──────────────────────────────────────────────────────────────
vi.mock('nanoid', () => ({
  nanoid: vi.fn(() => 'test-nonce-1234567890123456789012'),
}));

// Import after mocks are set up
import { createChallenge } from '@/lib/auth';
import prisma from '@/lib/db/prisma';

const mockPrisma = prisma as any;

describe('createChallenge', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('creates a new challenge and returns the correct format', async () => {
    // No existing challenge
    mockPrisma.authChallenge.findFirst.mockResolvedValue(null);
    mockPrisma.authChallenge.create.mockResolvedValue({
      id: 'test-id',
      walletAddress: 'GABC123',
      nonce: 'test-nonce-1234567890123456789012',
      expiresAt: new Date(Date.now() + 300_000),
      used: false,
      createdAt: new Date(),
    });

    const challenge = await createChallenge('GABC123');

    expect(challenge).toBe(`${CHALLENGE_PREFIX}:GABC123:test-nonce-1234567890123456789012`);
    expect(mockPrisma.authChallenge.create).toHaveBeenCalledOnce();
  });

  it('returns existing challenge if one is still active (idempotent)', async () => {
    const existingNonce = 'existing-nonce-12345678901234567890';
    mockPrisma.authChallenge.findFirst.mockResolvedValue({
      id: 'existing-id',
      walletAddress: 'GABC123',
      nonce: existingNonce,
      expiresAt: new Date(Date.now() + 200_000),
      used: false,
      createdAt: new Date(),
    });

    const challenge = await createChallenge('GABC123');

    // Should return existing challenge, NOT create a new one
    expect(challenge).toBe(`${CHALLENGE_PREFIX}:GABC123:${existingNonce}`);
    expect(mockPrisma.authChallenge.create).not.toHaveBeenCalled();
  });
});

describe('buildChallengeString', () => {
  it('produces a deterministic string with the correct prefix', () => {
    const result = buildChallengeString('GTEST123', 'nonce-abc');
    expect(result).toBe('CoreFlow:auth:GTEST123:nonce-abc');
    expect(result.startsWith(CHALLENGE_PREFIX)).toBe(true);
  });

  it('embeds the wallet address so cross-wallet replay is impossible', () => {
    const challenge1 = buildChallengeString('GWALLET1', 'same-nonce');
    const challenge2 = buildChallengeString('GWALLET2', 'same-nonce');
    expect(challenge1).not.toBe(challenge2);
  });
});
