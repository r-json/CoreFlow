/**
 * Core authentication logic for CoreFlow.
 *
 * Challenge-response flow:
 *  1. Client calls POST /api/auth/challenge with { walletAddress }
 *  2. Server stores a 5-minute nonce in AuthChallenge table and returns a challenge string
 *  3. Client signs the challenge string with Freighter (Ed25519)
 *  4. Client calls POST /api/auth/verify with { walletAddress, signature }
 *  5. Server verifies Ed25519 signature against stored challenge
 *  6. Server upserts a User row, creates a Session row, issues JWT in HttpOnly cookie
 *
 * Security properties:
 *  - Nonces are 32-byte cryptographically random (via nanoid alphabet)
 *  - Challenges expire in 5 minutes
 *  - Challenges are one-time-use (used=true after first verify)
 *  - Sessions are stored in DB — can be revoked server-side at logout
 *  - JWT is HS256 signed with AUTH_SECRET — never in localStorage
 */

import { nanoid } from 'nanoid';
import { Keypair } from '@stellar/stellar-sdk';
import prisma from '@/lib/db/prisma';
import { signJwt, verifyJwt, JWT_EXPIRY_SECONDS, type AuthPayload } from './jwt';
import type { NextRequest } from 'next/server';

export const CHALLENGE_TTL_SECONDS = 60 * 5; // 5 minutes
export const CHALLENGE_PREFIX = 'CoreFlow:auth';

/**
 * Builds the deterministic challenge string the client must sign.
 * Format: "CoreFlow:auth:<walletAddress>:<nonce>"
 * The wallet address is embedded so a signature from one address
 * cannot be replayed for a different address.
 */
export function buildChallengeString(walletAddress: string, nonce: string): string {
  return `${CHALLENGE_PREFIX}:${walletAddress}:${nonce}`;
}

/**
 * Creates a new auth challenge for a wallet address.
 * If an unexpired, unused challenge already exists, it is returned as-is
 * (idempotent — prevents nonce flooding attacks).
 */
export async function createChallenge(walletAddress: string): Promise<string> {
  // Return existing active challenge if one exists (prevent nonce flooding)
  const existing = await prisma.authChallenge.findFirst({
    where: {
      walletAddress,
      used: false,
      expiresAt: { gt: new Date() },
    },
    orderBy: { createdAt: 'desc' },
  });

  if (existing) {
    return buildChallengeString(walletAddress, existing.nonce);
  }

  const nonce = nanoid(32);
  const expiresAt = new Date(Date.now() + CHALLENGE_TTL_SECONDS * 1000);

  await prisma.authChallenge.create({
    data: { walletAddress, nonce, expiresAt },
  });

  return buildChallengeString(walletAddress, nonce);
}

/**
 * Verifies a Freighter Ed25519 signature against the stored challenge.
 *
 * Returns true only when ALL conditions hold:
 *  - A matching challenge exists for this wallet address
 *  - The challenge has not expired
 *  - The challenge has not been used before
 *  - The Ed25519 signature is mathematically valid
 *
 * The challenge is marked `used=true` immediately — even if subsequent
 * steps fail — so a partial failure cannot be retried with the same nonce.
 */
export async function verifyChallenge(
  walletAddress: string,
  signature: string
): Promise<boolean> {
  // Find the most recent active challenge for this wallet
  const challenge = await prisma.authChallenge.findFirst({
    where: {
      walletAddress,
      used: false,
      expiresAt: { gt: new Date() },
    },
    orderBy: { createdAt: 'desc' },
  });

  if (!challenge) return false;

  // Mark as used BEFORE verifying — prevents timing-based replay
  // Use updateMany to atomically check used: false and prevent race conditions
  const updateResult = await prisma.authChallenge.updateMany({
    where: { id: challenge.id, used: false },
    data: { used: true },
  });

  if (updateResult.count === 0) {
    return false; // Already used by a concurrent request
  }

  const challengeString = buildChallengeString(walletAddress, challenge.nonce);

  try {
    // Freighter signs the raw UTF-8 bytes of the challenge string
    const keypair = Keypair.fromPublicKey(walletAddress);
    const signatureBuffer = Buffer.from(signature, 'base64');
    const messageBuffer = Buffer.from(challengeString, 'utf-8');
    return keypair.verify(messageBuffer, signatureBuffer);
  } catch {
    // Invalid public key format or malformed signature
    return false;
  }
}

export const ROLES = ['admin', 'manager', 'finance', 'worker', 'viewer'] as const;
export type Role = (typeof ROLES)[number];

/** Wallet addresses (comma-separated) that are bootstrapped to `admin` on login. */
function adminAllowlist(): string[] {
  return (process.env.ADMIN_WALLETS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** True if the payload's role is in the allowed set. `admin` is allowed everywhere. */
export function hasRole(payload: { role: string } | null | undefined, allowed: Role[]): boolean {
  if (!payload) return false;
  if (payload.role === 'admin') return true;
  return (allowed as string[]).includes(payload.role);
}

/**
 * Upserts a User in the database (creates on first login, no-op on repeat),
 * then bootstraps configured admin wallets to the `admin` role. This is the
 * only zero-touch path to a privileged role; all other grants go through the
 * admin role-management endpoint.
 */
export async function upsertUser(walletAddress: string) {
  const user = await prisma.user.upsert({
    where: { walletAddress },
    create: { walletAddress, role: 'viewer' },
    update: {}, // Never downgrade an existing role on login
  });

  if (adminAllowlist().includes(walletAddress) && user.role !== 'admin') {
    return prisma.user.update({ where: { walletAddress }, data: { role: 'admin' } });
  }
  return user;
}

/**
 * Creates a JWT and persists the session to the database.
 * The database row enables server-side revocation at logout.
 */
export async function createSession(user: { id: string; walletAddress: string; role: string }) {
  const token = await signJwt({
    userId: user.id,
    walletAddress: user.walletAddress,
    role: user.role,
  });

  const expiresAt = new Date(Date.now() + JWT_EXPIRY_SECONDS * 1000);

  await prisma.session.create({
    data: { userId: user.id, token, expiresAt },
  });

  return token;
}

/**
 * Validates a JWT token AND checks the session exists in the database.
 * The DB check enables session revocation — a JWT that is cryptographically
 * valid but has been logged out will return null here.
 *
 * Returns null if: token is missing, expired, invalid, or revoked.
 */
export async function getSession(token: string | undefined): Promise<AuthPayload | null> {
  if (!token) return null;

  const payload = await verifyJwt(token);
  if (!payload) return null;

  // Check the session row still exists (revocation check) and pull the CURRENT
  // role/wallet from the DB — the JWT role claim can be stale for up to 24h
  // after a promotion/demotion, so it must not be trusted for authorization.
  const session = await prisma.session.findUnique({
    where: { token },
    select: {
      expiresAt: true,
      user: { select: { role: true, walletAddress: true } },
    },
  });

  if (!session || session.expiresAt < new Date()) return null;

  return {
    ...payload,
    role: session.user.role,
    walletAddress: session.user.walletAddress,
  };
}

/**
 * Deletes the session row from the database (server-side logout).
 * The JWT itself will remain cryptographically valid until expiry —
 * that is acceptable because the DB check in getSession() will reject it.
 */
export async function deleteSession(token: string): Promise<void> {
  await prisma.session.deleteMany({ where: { token } });
}

/**
 * Extracts the session token from the request cookie and validates it.
 * Used as a middleware helper in API routes.
 *
 * Returns null if unauthenticated.
 */
export async function getUserFromRequest(req: NextRequest): Promise<AuthPayload | null> {
  const token = req.cookies.get('cf_session')?.value;
  return getSession(token);
}

export const SESSION_COOKIE_NAME = 'cf_session';
export const SESSION_COOKIE_OPTIONS = {
  httpOnly: true,
  sameSite: 'strict' as const,
  secure: process.env.NODE_ENV === 'production',
  path: '/',
  maxAge: JWT_EXPIRY_SECONDS,
};
