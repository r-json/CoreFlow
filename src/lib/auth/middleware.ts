/**
 * Reusable RBAC middleware helpers for API route handlers.
 *
 * Usage in a route handler:
 *
 *   import { withAdminGuard, withAuthGuard } from '@/lib/auth/middleware';
 *
 *   export async function POST(request: NextRequest) {
 *     const guard = await withAdminGuard(request);
 *     if (guard.error) return guard.error;
 *     const user = guard.user;
 *     // ... admin-only logic
 *   }
 *
 * These helpers extract the session, check the role, and return either
 * the authenticated user or a pre-built error Response. This eliminates
 * boilerplate in route handlers and ensures consistent error envelopes.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getUserFromRequest, isAdmin } from '@/lib/auth';
import type { AuthPayload } from '@/lib/auth/jwt';
import { Role } from '@prisma/client';

type GuardSuccess = { user: AuthPayload; error: null };
type GuardFailure = { user: null; error: NextResponse };
type GuardResult = GuardSuccess | GuardFailure;

/**
 * Requires any authenticated user (ADMIN or EMPLOYEE).
 * Returns 401 if the user is not logged in.
 */
export async function withAuthGuard(request: NextRequest): Promise<GuardResult> {
  const user = await getUserFromRequest(request);
  if (!user) {
    return {
      user: null,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    };
  }
  return { user, error: null };
}

/**
 * Requires the ADMIN role specifically.
 * Returns 401 if not logged in, 403 if logged in but not ADMIN.
 */
export async function withAdminGuard(request: NextRequest): Promise<GuardResult> {
  const user = await getUserFromRequest(request);
  if (!user) {
    return {
      user: null,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    };
  }
  if (!isAdmin(user)) {
    return {
      user: null,
      error: NextResponse.json(
        { error: 'Forbidden: this action requires the ADMIN role' },
        { status: 403 }
      ),
    };
  }
  return { user, error: null };
}

/**
 * Requires that the user has one of the specified roles.
 * ADMIN always passes (admin can do everything).
 * Returns 401 if not logged in, 403 if role doesn't match.
 */
export async function withRoleGuard(
  request: NextRequest,
  allowedRoles: Role[]
): Promise<GuardResult> {
  const user = await getUserFromRequest(request);
  if (!user) {
    return {
      user: null,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    };
  }
  // ADMIN short-circuits — always allowed
  if (user.role === Role.ADMIN) {
    return { user, error: null };
  }
  if (!allowedRoles.includes(user.role as Role)) {
    return {
      user: null,
      error: NextResponse.json(
        { error: `Forbidden: requires one of [${allowedRoles.join(', ')}]` },
        { status: 403 }
      ),
    };
  }
  return { user, error: null };
}
