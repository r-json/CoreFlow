/**
 * POST /api/auth/challenge
 *
 * Step 1 of the sign-in flow. Client provides their Stellar wallet address;
 * server returns a challenge string they must sign with Freighter.
 *
 * Rate limiting: The createChallenge() helper is idempotent — repeated calls
 * for the same wallet within the 5-minute TTL return the same challenge,
 * preventing nonce flooding attacks.
 */

import { NextResponse } from 'next/server';
import { createChallenge } from '@/lib/auth';
import { parseBody, challengeSchema } from '@/lib/validation/schemas';
import { rateLimit, clientIp } from '@/lib/ratelimit';

export async function POST(request: Request) {
  const rl = rateLimit(`challenge:${clientIp(request)}`, 20, 60_000);
  if (!rl.ok) {
    return NextResponse.json(
      { error: 'Too many requests' },
      { status: 429, headers: { 'Retry-After': String(rl.retryAfter) } }
    );
  }

  try {
    const body = await request.json().catch(() => null);
    const parsed = parseBody(challengeSchema, body);
    if (!parsed.ok) {
      return NextResponse.json({ error: parsed.error }, { status: 400 });
    }

    const challenge = await createChallenge(parsed.data.walletAddress);
    return NextResponse.json({ challenge }, { status: 200 });
  } catch (error) {
    console.error('[auth/challenge] Error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
