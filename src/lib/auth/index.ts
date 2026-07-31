/**
 * Core authentication logic for CoreFlow.
 *
 * Challenge-response flow:
 *  1. Client calls POST /api/auth/challenge with { walletAddress }
 *  2. Server stores a 5-minute nonce in AuthChallenge table and returns a challenge string
 *  3. Client signs the challenge string with Freighter (Ed25519 / SEP-53)
 *  4. Client calls POST /api/auth/verify with { walletAddress, signature }
 *  5. Server verifies Ed25519 signature against SEP-53 hashed challenge
 *  6. Server upserts a User row, creates a Session row, issues JWT in HttpOnly cookie
 *
 * Security properties:
 *  - Nonces are 32-byte cryptographically random (via nanoid alphabet)
 *  - Challenges expire in 5 minutes
 *  - Challenges are one-time-use (used=true after first verify)
 *  - Sessions are stored in DB — can be revoked server-side at logout
 *  - JWT is HS256 signed with AUTH_SECRET — never in localStorage
 *  - Signature verification follows SEP-53 (prefixed + SHA-256 hashed)
 *
 * RBAC: Two roles — ADMIN (full access) and EMPLOYEE (view + submit hours only).
 * Roles are stored in PostgreSQL via a Prisma enum, not on the blockchain.
 * The wallet only proves identity; the database determines permissions.
 */

import { createHash } from 'crypto';
import { nanoid } from 'nanoid';
import { Keypair } from '@stellar/stellar-sdk';
import prisma from '@/lib/db/prisma';
import { signJwt, verifyJwt, JWT_EXPIRY_SECONDS, type AuthPayload } from './jwt';
import type { NextRequest } from 'next/server';
import { Role } from '@prisma/client';

/**
 * SEP-53 message signing prefix.
 * Freighter's signMessage prepends this to the raw message before
 * SHA-256 hashing and Ed25519 signing.
 */
const SEP53_PREFIX = 'Stellar Signed Message:\n';

export const CHALLENGE_TTL_SECONDS = 60 * 5; // 5 minutes
export const CHALLENGE_PREFIX = 'CoreFlow:auth';

/**
 * Re-export the Prisma Role enum for convenience throughout the codebase.
 */
export { Role };

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
    // SEP-53: Freighter prefixes the message with "Stellar Signed Message:\n",
    // concatenates the raw message bytes, SHA-256 hashes the result, and then
    // Ed25519-signs the 32-byte digest. We must reconstruct the same hash.
    const keypair = Keypair.fromPublicKey(walletAddress);
    const signatureBuffer = Buffer.from(signature, 'base64');

    const prefixedMessage = Buffer.concat([
      Buffer.from(SEP53_PREFIX, 'utf-8'),
      Buffer.from(challengeString, 'utf-8'),
    ]);
    const messageHash = createHash('sha256').update(prefixedMessage).digest();

    return keypair.verify(messageHash, signatureBuffer);
  } catch {
    // Invalid public key format or malformed signature
    return false;
  }
}

/** Wallet addresses (comma-separated) that are bootstrapped to ADMIN on login. */
function adminAllowlist(): string[] {
  const envWallets = [
    process.env.ADMIN_WALLETS || '',
    process.env.ADMIN_WALLET_ADDRESS || '',
  ].join(',');

  return envWallets
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * True if the user has ADMIN role.
 * ADMIN can do everything; EMPLOYEE is restricted.
 */
export function isAdmin(payload: { role: string } | null | undefined): boolean {
  if (!payload) return false;
  return payload.role === Role.ADMIN;
}

/**
 * True if the user has EMPLOYEE role (or ADMIN, who can also do employee things).
 */
export function isEmployee(payload: { role: string } | null | undefined): boolean {
  if (!payload) return false;
  return payload.role === Role.EMPLOYEE || payload.role === Role.ADMIN;
}

/**
 * Backward-compatible role check. `admin` always passes.
 * For the simplified ADMIN/EMPLOYEE model, the `allowed` array is checked
 * against the user's Prisma Role enum value.
 */
export function hasRole(payload: { role: string } | null | undefined, allowed: string[]): boolean {
  if (!payload) return false;
  if (payload.role === Role.ADMIN) return true;
  return allowed.includes(payload.role);
}

/**
 * Requires that the user has the ADMIN role. Returns a 403 response if not.
 * Use this as a guard in API route handlers.
 */
export function requireAdmin(user: { role: string } | null | undefined): Response | null {
  if (!user) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (!isAdmin(user)) {
    return Response.json(
      { error: 'Forbidden: this action requires the ADMIN role' },
      { status: 403 }
    );
  }
  return null; // Passes — caller proceeds
}

/**
 * Upserts a User in the database (creates on first login, no-op on repeat),
 * then bootstraps configured admin wallets to the ADMIN role. This is the
 * only zero-touch path to a privileged role; all other grants go through the
 * admin role-management endpoint.
 *
 * When a user connects their Freighter wallet, after the challenge-response
 * passes, the User table is checked for that public key. If no user exists,
 * one is created as EMPLOYEE by default. If the public key matches a seed
 * admin key (ADMIN_WALLETS env var), the role is set to ADMIN.
 */
export async function upsertUser(walletAddress: string) {
  const allowlist = adminAllowlist();
  const shouldBeAdmin = allowlist.includes(walletAddress);

  console.log(`[Auth] Upserting user for wallet: ${walletAddress}`);
  console.log(`[Auth] Configured Admin Allowlist: [${allowlist.join(', ')}]`);
  console.log(`[Auth] Admin Match Result: ${shouldBeAdmin}`);

  const user = await prisma.user.upsert({
    where: { walletAddress },
    create: {
      walletAddress,
      role: shouldBeAdmin ? Role.ADMIN : Role.EMPLOYEE,
    },
    update: {}, // Never downgrade an existing role on login
  });

  if (shouldBeAdmin && user.role !== Role.ADMIN) {
    console.log(`[Auth] Promoting existing user ${walletAddress} to ADMIN role based on allowlist.`);
    return prisma.user.update({ where: { walletAddress }, data: { role: Role.ADMIN } });
  }
  return user;
}

/**
 * Creates a JWT and persists the session to the database.
 * The database row enables server-side revocation at logout.
 */
export async function createSession(user: { id: string; walletAddress: string; role: Role }) {
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
