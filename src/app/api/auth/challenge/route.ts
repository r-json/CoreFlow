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

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => null);
    const walletAddress = body?.walletAddress;

    if (!walletAddress || typeof walletAddress !== 'string') {
      return NextResponse.json({ error: 'walletAddress is required' }, { status: 400 });
    }

    // Basic Stellar address format check (G... or C... 56 chars)
    if (!/^[GC][A-Z2-7]{55}$/.test(walletAddress)) {
      return NextResponse.json({ error: 'Invalid Stellar wallet address' }, { status: 400 });
    }

    const challenge = await createChallenge(walletAddress);

    return NextResponse.json({ challenge }, { status: 200 });
  } catch (error) {
    console.error('[auth/challenge] Error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
