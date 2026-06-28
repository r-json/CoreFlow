/**
 * JWT utilities for CoreFlow authentication.
 *
 * Uses `jose` because it works natively in the Next.js Edge Runtime
 * (no Node.js `crypto` module required), has zero sub-dependencies,
 * and is actively audited.
 *
 * Algorithm: HS256 (HMAC-SHA256) — suitable for symmetric secrets.
 * Expiry: 24 hours — short enough to limit blast radius.
 */

import { SignJWT, jwtVerify, type JWTPayload } from 'jose';

export interface AuthPayload extends JWTPayload {
  userId: string;
  walletAddress: string;
  role: string;
}

/**
 * Returns the signing key derived from AUTH_SECRET.
 * Throws clearly if the env var is missing so misconfiguration is caught at startup.
 */
function getSecret(): Uint8Array {
  const secret = process.env.AUTH_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error(
      'AUTH_SECRET environment variable is missing or too short (minimum 32 characters).'
    );
  }
  return new TextEncoder().encode(secret);
}

export const JWT_EXPIRY_SECONDS = 60 * 60 * 24; // 24 hours

/**
 * Signs a JWT containing the user identity payload.
 */
export async function signJwt(payload: Omit<AuthPayload, keyof JWTPayload>): Promise<string> {
  return new SignJWT(payload as Record<string, unknown>)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(`${JWT_EXPIRY_SECONDS}s`)
    .sign(getSecret());
}

/**
 * Verifies and decodes a JWT. Returns null if invalid or expired.
 * Never throws — callers check the null return.
 */
export async function verifyJwt(token: string): Promise<AuthPayload | null> {
  try {
    const { payload } = await jwtVerify(token, getSecret());
    return payload as AuthPayload;
  } catch {
    return null;
  }
}
