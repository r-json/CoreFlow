/**
 * GET  /api/organizations/:id/invitations — list pending invitations
 * POST /api/organizations/:id/invitations — invite someone
 *
 * The invited ROLE is validated against what the inviter may delegate. An
 * invitation is the easiest place to smuggle a privilege escalation: without that
 * check, an ADMIN could invite an OWNER and take the organization, or a MANAGER
 * could invite a FINANCE approver and manufacture the second signature they are
 * forbidden from giving.
 *
 * The plaintext token is returned ONCE, in the creation response. Only its hash is
 * stored, so it cannot be recovered later — a database dump must not hand over
 * working invitations.
 */

import { NextRequest, NextResponse } from 'next/server';
import { OrgRole } from '@prisma/client';
import prisma from '@/lib/db/prisma';
import { withTenant, denialResponse } from '@/lib/tenancy/http';
import { assignableRoles } from '@/lib/tenancy/rbac';
import {
  generateInvitationToken, hashInvitationToken,
  checkRoleAssignment, writeMembershipAudit, INVITATION_TTL_DAYS,
} from '@/lib/tenancy/membership';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function GET(request: NextRequest, { params }: { params: { id: string } }) {
  return withTenant(request, { permission: 'member:read', parseBody: false }, async ({ ctx }) => {
    if (ctx.orgId !== params.id) {
      // The path names one organization and the resolved membership another.
      return NextResponse.json({ error: 'Organization not found.' }, { status: 404 });
    }

    const invitations = await prisma.invitation.findMany({
      where: { orgId: ctx.orgId },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true, email: true, orgRole: true, expiresAt: true,
        usedAt: true, revokedAt: true, invitedBy: true, createdAt: true,
      },
    });

    return NextResponse.json({
      // tokenHash is deliberately absent: it is a credential, not metadata.
      invitations: invitations.map((i) => ({
        ...i,
        status: i.revokedAt ? 'REVOKED'
          : i.usedAt ? 'ACCEPTED'
          : i.expiresAt.getTime() <= Date.now() ? 'EXPIRED'
          : 'PENDING',
      })),
      /** What this caller may invite, so the UI need not re-derive the rules. */
      assignableRoles: assignableRoles(ctx.role),
    });
  });
}

export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  return withTenant(request, { permission: 'member:invite' }, async ({ ctx, body }) => {
    if (ctx.orgId !== params.id) {
      return NextResponse.json({ error: 'Organization not found.' }, { status: 404 });
    }

    const email = String(body?.email ?? '').trim().toLowerCase();
    if (!EMAIL.test(email)) {
      return NextResponse.json({ error: 'A valid email address is required.' }, { status: 400 });
    }

    const requested = body?.orgRole;
    if (!requested || !(Object.values(OrgRole) as string[]).includes(requested)) {
      return NextResponse.json(
        { error: `orgRole must be one of ${Object.values(OrgRole).join(', ')}.` },
        { status: 400 }
      );
    }
    const orgRole = requested as OrgRole;

    // The escalation guard.
    const denied = checkRoleAssignment(ctx, orgRole);
    if (denied) return denialResponse(denied);

    const token = generateInvitationToken();
    const tokenHash = hashInvitationToken(token);
    const expiresAt = new Date(Date.now() + INVITATION_TTL_DAYS * 86_400_000);

    try {
      const invitation = await prisma.$transaction(async (tx) => {
        // Re-inviting the same address replaces the outstanding invitation rather
        // than erroring, so a lost email is recoverable. The previous token stops
        // working, which is the point: two live tokens for one seat is one too
        // many.
        const created = await tx.invitation.upsert({
          where: { orgId_email: { orgId: ctx.orgId, email } },
          create: {
            orgId: ctx.orgId, email, orgRole, tokenHash, expiresAt,
            invitedBy: ctx.walletAddress,
          },
          update: {
            orgRole, tokenHash, expiresAt,
            usedAt: null, revokedAt: null, revokedBy: null,
            invitedBy: ctx.walletAddress,
          },
        });

        await writeMembershipAudit(tx, {
          orgId: ctx.orgId,
          type: 'invitation.sent',
          actorAddress: ctx.walletAddress,
          metadata: { email, orgRole, invitationId: created.id },
        });

        return created;
      });

      return NextResponse.json(
        {
          invitation: {
            id: invitation.id,
            email: invitation.email,
            orgRole: invitation.orgRole,
            expiresAt: invitation.expiresAt,
          },
          /** Shown once. Not recoverable — only the hash is stored. */
          token,
          acceptUrl: `/invite/${token}`,
        },
        { status: 201 }
      );
    } catch (e: any) {
      if (e?.code === 'P2002') {
        return NextResponse.json(
          { error: 'An invitation for that address already exists.' },
          { status: 409 }
        );
      }
      throw e;
    }
  });
}
