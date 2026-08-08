/**
 * GET /api/auth/profile
 *
 * Returns the full profile of the currently authenticated user.
 * This is similar to /api/auth/me but returns additional details
 * like account creation date and last update.
 *
 * Returns 401 if the session cookie is missing, invalid, or revoked.
 */

import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/db/prisma';
import { getUserFromRequest } from '@/lib/auth';

export async function GET(request: NextRequest) {
  try {
    const user = await getUserFromRequest(request);

    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Fetch the full user profile from the database
    const userProfile = await prisma.user.findUnique({
      where: { id: user.userId },
      select: {
        id: true,
        walletAddress: true,
        role: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    if (!userProfile) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 });
    }

    return NextResponse.json(
      {
        user: {
          id: userProfile.id,
          walletAddress: userProfile.walletAddress,
          role: userProfile.role,
          createdAt: userProfile.createdAt.toISOString(),
          updatedAt: userProfile.updatedAt.toISOString(),
        },
      },
      { status: 200 }
    );
  } catch (error) {
    console.error('[auth/profile] Error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}