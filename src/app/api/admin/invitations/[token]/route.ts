/**
 * DELETE /api/admin/invitations/[token]
 *
 * Revokes an active invitation by its token. The invitation row is deleted
 * from the database so the onboarding link becomes immediately invalid.
 *
 * Restricted to ADMIN role only.
 */

import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/db/prisma';
import { getUserFromRequest, isAdmin } from '@/lib/auth';
import { audit } from '@/lib/audit';

export async function DELETE(
  request: NextRequest,
  { params }: { params: { token: string } }
) {
  const user = await getUserFromRequest(request);
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (!isAdmin(user)) {
    return NextResponse.json(
      { error: 'Forbidden: ADMIN role required' },
      { status: 403 }
    );
  }

  try {
    const invitation = await prisma.invitation.findUnique({
      where: { token: params.token },
    });

    if (!invitation) {
      return NextResponse.json(
        { error: 'Invitation not found' },
        { status: 404 }
      );
    }

    await prisma.invitation.delete({
      where: { token: params.token },
    });

    await audit('invitation.revoke', {
      actor: user.walletAddress,
      target: invitation.email,
      metadata: { token: params.token, role: invitation.role },
    });

    return NextResponse.json(
      { message: 'Invitation revoked successfully' },
      { status: 200 }
    );
  } catch (error) {
    console.error('[admin/invitations/token] DELETE error:', error);
    return NextResponse.json(
      { error: 'Failed to revoke invitation' },
      { status: 500 }
    );
  }
}