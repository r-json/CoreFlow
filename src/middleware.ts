/**
 * Next.js Edge Middleware for CoreFlow.
 *
 * Protects all /api/escrows/* and /api/hours routes by checking for
 * an authenticated session cookie.
 *
 * Public routes (no auth required):
 *   - /api/auth/* (sign-in flow itself)
 *   - Everything else (landing page, dashboard static assets)
 *
 * Note: We do a lightweight JWT check here (no DB call) for performance.
 * The full DB revocation check happens inside each API route via getUserFromRequest().
 * This layered approach means:
 *   - Middleware: fast, edge-compatible, rejects clearly invalid/missing tokens
 *   - Route handlers: full DB check for revocation
 */

import { NextRequest, NextResponse } from 'next/server';
import { jwtVerify } from 'jose';

const PROTECTED_API_PREFIXES = ['/api/escrows', '/api/hours', '/api/admin', '/api/oracle/attest'];

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  const isProtected = PROTECTED_API_PREFIXES.some((prefix) => pathname.startsWith(prefix));

  if (!isProtected) {
    return NextResponse.next();
  }

  const token = request.cookies.get('cf_session')?.value;

  if (!token) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let payload: any;
  try {
    const secret = new TextEncoder().encode(process.env.AUTH_SECRET ?? '');
    const result = await jwtVerify(token, secret);
    payload = result.payload;
  } catch {
    payload = null;
  }

  if (!payload) {
    // Token is malformed or expired — clear the stale cookie
    const response = NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    response.cookies.set('cf_session', '', { maxAge: 0, path: '/' });
    return response;
  }

  // Forward identity headers to route handlers so they don't need to re-parse
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-user-wallet', payload.walletAddress);
  requestHeaders.set('x-user-role', payload.role);
  requestHeaders.set('x-user-id', payload.userId);

  return NextResponse.next({ request: { headers: requestHeaders } });
}

export const config = {
  matcher: [
    '/api/escrows/:path*',
    '/api/hours/:path*',
    '/api/admin/:path*',
    '/api/oracle/attest',
  ],
};
