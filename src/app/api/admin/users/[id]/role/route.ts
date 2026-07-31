/**
 * PATCH /api/admin/users/[id]/role
 *
 * Allows an ADMIN to update a user's role (ADMIN <-> EMPLOYEE) by user ID.
 * Audit logs the role modification.
 */

import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/db/prisma';
import { getUserFromRequest, isAdmin, Role } from '@/lib/auth';
import { audit } from '@/lib/audit';
import { z } from 'zod';
import { parseBody } from '@/lib/validation/schemas';

const updateRoleSchema = z.object({
  role: z.enum(['ADMIN', 'EMPLOYEE']),
});

export async function PATCH(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const adminUser = await getUserFromRequest(request);
  if (!adminUser) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (!isAdmin(adminUser)) {
    return NextResponse.json({ error: 'Forbidden: ADMIN role required' }, { status: 403 });
  }

  try {
    const userId = params.id;
    const body = await request.json().catch(() => null);
    const parsed = parseBody(updateRoleSchema, body);
    if (!parsed.ok) {
      return NextResponse.json({ error: parsed.error }, { status: 400 });
    }
    const { role } = parsed.data;

    const targetUser = await prisma.user.findUnique({ where: { id: userId } });
    if (!targetUser) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 });
    }

    const updatedUser = await prisma.user.update({
      where: { id: userId },
      data: { role: role as Role },
      select: { id: true, walletAddress: true, role: true, createdAt: true },
    });

    await audit('role.update', {
      actor: adminUser.walletAddress,
      target: targetUser.walletAddress,
      metadata: { previousRole: targetUser.role, newRole: updatedUser.role },
    });

    return NextResponse.json({ user: updatedUser }, { status: 200 });
  } catch (error) {
    console.error('[admin/users/role] Error:', error);
    return NextResponse.json({ error: 'Failed to update user role' }, { status: 500 });
  }
}
