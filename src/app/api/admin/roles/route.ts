/**
 * Admin role management.
 *
 *   GET  /api/admin/roles  → list users + roles (admin only)
 *   POST /api/admin/roles  → set a user's role (admin only)
 *
 * This is the managed path to privileged roles. The very first admin is
 * bootstrapped via the ADMIN_WALLETS allowlist (see upsertUser); from there an
 * admin grants manager/finance/worker roles here. Role is read from the DB on
 * every request (see getSession), so a grant takes effect immediately.
 */

import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/db/prisma';
import { getUserFromRequest, hasRole, type Role } from '@/lib/auth';
import { parseBody, roleGrantSchema } from '@/lib/validation/schemas';
import { audit } from '@/lib/audit';

export async function GET(request: NextRequest) {
  const user = await getUserFromRequest(request);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (!hasRole(user, [])) {
    // hasRole(user, []) is true only for admin (admin short-circuits).
    return NextResponse.json({ error: 'Forbidden: admin only' }, { status: 403 });
  }

  const users = await prisma.user.findMany({
    select: { walletAddress: true, role: true, createdAt: true },
    orderBy: { createdAt: 'desc' },
    take: 200,
  });
  return NextResponse.json({ users }, { status: 200 });
}

export async function POST(request: NextRequest) {
  const user = await getUserFromRequest(request);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (!hasRole(user, [])) {
    return NextResponse.json({ error: 'Forbidden: admin only' }, { status: 403 });
  }

  try {
    const body = await request.json().catch(() => null);
    const parsed = parseBody(roleGrantSchema, body);
    if (!parsed.ok) {
      return NextResponse.json({ error: parsed.error }, { status: 400 });
    }
    const { walletAddress, role } = parsed.data;

    // Upsert so an admin can pre-assign a role before the user's first login.
    const updated = await prisma.user.upsert({
      where: { walletAddress },
      create: { walletAddress, role: role as Role },
      update: { role: role as Role },
    });

    await audit('role.grant', {
      actor: user.walletAddress,
      target: walletAddress,
      metadata: { role },
    });

    return NextResponse.json(
      { user: { walletAddress: updated.walletAddress, role: updated.role } },
      { status: 200 }
    );
  } catch (error) {
    console.error('[admin/roles] Error:', error);
    return NextResponse.json({ error: 'Failed to update role' }, { status: 500 });
  }
}
