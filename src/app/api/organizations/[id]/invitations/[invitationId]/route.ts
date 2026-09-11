/**
 * DELETE /api/organizations/:id/invitations/:invitationId — revoke an invitation.
 *
 * Revocation is recorded (`revokedAt`), not deleted. Deleting it would erase the
 * fact that someone was once invited, which is exactly what an access review
 * needs to see. `revokedAt` is kept distinct from `usedAt` so "withdrawn" is never
 * mistaken for "accepted".
 */

import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/db/prisma';
import { withTenant } from '@/lib/tenancy/http';
import { writeMembershipAudit } from '@/lib/tenancy/membership';

export async function DELETE(
  request: NextRequest,
  { params }: { params: { id: string; invitationId: string } }
) {
  return withTenant(request, { permission: 'member:invite', parseBody: false }, async ({ ctx }) => {
    if (ctx.orgId !== params.id) {
      return NextResponse.json({ error: 'Organization not found.' }, { status: 404 });
    }

    // Scoped by organization: an invitation id from another tenant is a 404, not
    // a revocation of their invitation.
    const invitation = await prisma.invitation.findFirst({
      where: { id: params.invitationId, orgId: ctx.orgId },
    });
    if (!invitation) {
      return NextResponse.json({ error: 'Invitation not found.' }, { status: 404 });
    }
    if (invitation.usedAt) {
      return NextResponse.json(
        {
          error:
            'That invitation has already been accepted. Suspend or remove the ' +
            'member instead.',
          code: 'ALREADY_ACCEPTED',
        },
        { status: 409 }
      );
    }

    await prisma.$transaction(async (tx) => {
      await tx.invitation.update({
        where: { id: invitation.id },
        data: { revokedAt: new Date(), revokedBy: ctx.walletAddress },
      });
      await writeMembershipAudit(tx, {
        orgId: ctx.orgId,
        type: 'invitation.revoked',
        actorAddress: ctx.walletAddress,
        metadata: { invitationId: invitation.id, email: invitation.email },
      });
    });

    return NextResponse.json({ revoked: true });
  });
}
