/**
 * POST /api/auth/logout
 *
 * Clears the session cookie and deletes the Session row from the database.
 * After this call, the JWT is rejected by getSession() even if it has not
 * expired cryptographically.
 */

import { NextRequest, NextResponse } from 'next/server';
import { deleteSession, SESSION_COOKIE_NAME } from '@/lib/auth';

export async function POST(request: NextRequest) {
  try {
    const token = request.cookies.get(SESSION_COOKIE_NAME)?.value;

    if (token) {
      // Non-blocking: even if DB delete fails, we still clear the cookie
      try {
        await deleteSession(token);
      } catch (e) {
        console.error('[auth/logout] DB delete failed (cookie still cleared):', e);
      }
    }

    const response = NextResponse.json({ ok: true }, { status: 200 });
    // Expire the cookie immediately
    response.cookies.set(SESSION_COOKIE_NAME, '', {
      httpOnly: true,
      sameSite: 'strict',
      secure: process.env.NODE_ENV === 'production',
      path: '/',
      maxAge: 0,
    });

    return response;
  } catch (error) {
    console.error('[auth/logout] Error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
