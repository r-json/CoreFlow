/**
 * GET /api/organizations/:id/members — the organization's roster.
 *
 * Scoped to the caller's own organization. A member list is sensitive: it names
 * who holds approval authority, which is the information an attacker wants before
 * choosing a target.
 */

import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/db/prisma';
import { withTenant } from '@/lib/tenancy/http';
import { assignableRoles } from '@/lib/tenancy/rbac';

export async function GET(request: NextRequest, { params }: { params: { id: string } }) {
  return withTenant(request, { permission: 'member:read', parseBody: false }, async ({ ctx }) => {
    if (ctx.orgId !== params.id) {
      return NextResponse.json({ error: 'Organization not found.' }, { status: 404 });
    }

    const members = await prisma.orgMember.findMany({
      where: { orgId: ctx.orgId },
      include: { user: { select: { id: true, walletAddress: true } } },
      orderBy: [{ role: 'asc' }, { createdAt: 'asc' }],
    });

    return NextResponse.json({
      members: members.map((m) => ({
        id: m.id,
        userId: m.userId,
        walletAddress: m.user.walletAddress,
        role: m.role,
        status: m.status,
        isYou: m.userId === ctx.userId,
        invitedAt: m.invitedAt,
        activatedAt: m.activatedAt,
        suspendedAt: m.suspendedAt,
        removedAt: m.removedAt,
      })),
      assignableRoles: assignableRoles(ctx.role),
    });
  });
}
