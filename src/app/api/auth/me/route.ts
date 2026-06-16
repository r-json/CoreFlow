/**
 * GET /api/auth/me
 *
 * Returns the currently authenticated user's wallet address and role.
 * The frontend calls this on mount to restore session state after a page refresh.
 *
 * Returns 401 if the session cookie is missing, invalid, or revoked.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getUserFromRequest } from '@/lib/auth';

export async function GET(request: NextRequest) {
  try {
    const user = await getUserFromRequest(request);

    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    return NextResponse.json(
      {
        user: {
          walletAddress: user.walletAddress,
          role: user.role,
        },
      },
      { status: 200 }
    );
  } catch (error) {
    console.error('[auth/me] Error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
