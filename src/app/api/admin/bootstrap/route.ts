/**
 * POST /api/admin/bootstrap — create the very first ADMIN.
 *
 * This endpoint is deliberately exempt from session auth (there is no admin yet
 * to authenticate as), which makes BOOTSTRAP_SECRET the only thing standing
 * between an anonymous caller and full platform control. It is therefore
 * hardened three ways:
 *
 *  1. RATE LIMITED per client IP. Without a brake, the secret is simply
 *     brute-forceable at network speed — an unlimited oracle for guessing.
 *  2. CONSTANT-TIME comparison. `!==` on strings short-circuits at the first
 *     differing byte, which leaks the length of a correct prefix.
 *  3. MINIMUM LENGTH. A short secret is guessable regardless of the above, so
 *     the endpoint refuses to operate rather than offering false assurance.
 *
 * Every outcome returns the same 404 body, so a caller cannot distinguish "the
 * endpoint is disabled" from "your secret was wrong" from "you are rate
 * limited" — none of those should be observable.
 */

import { NextRequest } from 'next/server';
import { createHash, timingSafeEqual } from 'crypto';
import { ApiResponse } from '@/lib/api-response';
import prisma from '@/lib/db/prisma';
import { Role } from '@prisma/client';
import { audit } from '@/lib/audit';
import { rateLimit, clientIp } from '@/lib/ratelimit';

/** Shortest secret this endpoint will accept. */
const MIN_SECRET_LENGTH = 32;

/** Attempts allowed per IP per window. */
const BOOTSTRAP_ATTEMPT_LIMIT = 5;
const BOOTSTRAP_WINDOW_MS = 60 * 60 * 1000; // 1 hour

/**
 * Compare two secrets without leaking where they diverge.
 *
 * Both sides are hashed to a fixed length first: `timingSafeEqual` throws on
 * length mismatch, and catching that would reintroduce exactly the length
 * oracle this is meant to remove.
 */
function secretsMatch(provided: string, expected: string): boolean {
  const a = createHash('sha256').update(provided).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

export async function POST(req: NextRequest) {
  const secret = process.env.BOOTSTRAP_SECRET;

  // Security guard: If BOOTSTRAP_SECRET is unset or empty, disable this endpoint completely with 404
  if (!secret || secret.trim() === '') {
    return ApiResponse.notFound('Endpoint not available');
  }

  // A secret too short to resist guessing is worse than no endpoint: it reads
  // as protection while providing none.
  if (secret.trim().length < MIN_SECRET_LENGTH) {
    console.error(
      `[Bootstrap] BOOTSTRAP_SECRET is shorter than ${MIN_SECRET_LENGTH} characters; endpoint disabled.`
    );
    return ApiResponse.notFound('Endpoint not available');
  }

  // Rate limit BEFORE comparing, so failed guesses consume the budget.
  const rl = rateLimit(`bootstrap:${clientIp(req)}`, BOOTSTRAP_ATTEMPT_LIMIT, BOOTSTRAP_WINDOW_MS);
  if (!rl.ok) {
    await audit('admin.bootstrap.throttled', {
      actor: clientIp(req),
      metadata: { retryAfter: rl.retryAfter },
    });
    return ApiResponse.notFound('Endpoint not available');
  }

  try {
    const body = await req.json().catch(() => ({}));
    const requestSecret = req.headers.get('x-bootstrap-secret') || body.bootstrapSecret;

    if (typeof requestSecret !== 'string' || !secretsMatch(requestSecret, secret)) {
      await audit('admin.bootstrap.denied', {
        actor: clientIp(req),
        metadata: { reason: 'invalid bootstrap secret' },
      });
      return ApiResponse.notFound('Endpoint not available');
    }

    // Determine target wallet address
    let targetWallet = body.walletAddress;
    if (!targetWallet) {
      const defaultWallets = (process.env.ADMIN_WALLETS || process.env.ADMIN_WALLET_ADDRESS || '')
        .split(',')
        .map((w) => w.trim())
        .filter(Boolean);
      targetWallet = defaultWallets[0];
    }

    if (!targetWallet) {
      return ApiResponse.error('No target walletAddress provided or configured in ADMIN_WALLETS', 400);
    }

    const user = await prisma.user.upsert({
      where: { walletAddress: targetWallet },
      create: {
        walletAddress: targetWallet,
        role: Role.ADMIN,
      },
      update: {
        role: Role.ADMIN,
      },
    });

    await audit('admin.bootstrap', {
      actor: targetWallet,
      target: targetWallet,
      metadata: { message: 'Admin bootstrapped via /api/admin/bootstrap' },
    });

    console.log(`[Bootstrap] Successfully promoted/created ADMIN wallet: ${targetWallet}`);

    return ApiResponse.success({
      message: 'Admin wallet bootstrapped successfully',
      user: {
        id: user.id,
        walletAddress: user.walletAddress,
        role: user.role,
      },
    });
  } catch (err: any) {
    console.error('[Bootstrap Error]', err);
    return ApiResponse.serverError(err?.message || 'Failed to bootstrap admin');
  }
}
