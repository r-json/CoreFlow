/**
 * POST /api/auth/verify
 *
 * Step 2 of the sign-in flow. Client provides their wallet address and the
 * Ed25519 signature of the challenge string. Server verifies the signature,
 * upserts the User record, creates a Session, and sets an HttpOnly JWT cookie.
 *
 * Cookie attributes:
 *  - HttpOnly: JS cannot read it → XSS-proof
 *  - SameSite=Strict: Cannot be sent cross-site → CSRF-proof
 *  - Secure: HTTPS-only in production
 *  - maxAge: 24 hours (matches JWT expiry)
 */

import { NextResponse } from 'next/server';
import { verifyChallenge, upsertUser, createSession, SESSION_COOKIE_OPTIONS, SESSION_COOKIE_NAME } from '@/lib/auth';
import { parseBody, verifySchema } from '@/lib/validation/schemas';
import { rateLimit, clientIp } from '@/lib/ratelimit';

export async function POST(request: Request) {
  const rl = rateLimit(`verify:${clientIp(request)}`, 10, 60_000);
  if (!rl.ok) {
    return NextResponse.json(
      { error: 'Too many requests' },
      { status: 429, headers: { 'Retry-After': String(rl.retryAfter) } }
    );
  }

  try {
    const body = await request.json().catch(() => null);
    const parsed = parseBody(verifySchema, body);
    if (!parsed.ok) {
      return NextResponse.json({ error: parsed.error }, { status: 400 });
    }
    const { walletAddress, signature } = parsed.data;

    const valid = await verifyChallenge(walletAddress, signature);

    if (!valid) {
      // Deliberately vague — don't hint whether nonce was expired vs. signature was wrong
      return NextResponse.json(
        { error: 'Authentication failed. Challenge may have expired or signature is invalid.' },
        { status: 401 }
      );
    }

    // Upsert user (creates on first login, no-ops on subsequent logins)
    const user = await upsertUser(walletAddress);

    // Issue JWT and persist session row for server-side revocability
    const token = await createSession(user);

    const response = NextResponse.json(
      {
        user: {
          walletAddress: user.walletAddress,
          role: user.role,
        },
      },
      { status: 200 }
    );

    response.cookies.set(SESSION_COOKIE_NAME, token, SESSION_COOKIE_OPTIONS);

    return response;
  } catch (error) {
    console.error('[auth/verify] Error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
