/**
 * PATCH  /api/organizations/:id/members/:memberId — change role or status
 * DELETE /api/organizations/:id/members/:memberId — remove from the organization
 *
 * Business actions, not a generic field setter: the accepted inputs are a `role`
 * to grant and a `status` transition, each validated against the membership state
 * machine and the delegation rules. A caller cannot write arbitrary columns.
 *
 * Three refusals are enforced here because each is a plausible mistake:
 *   - granting a role above your own, or one you may not exercise
 *   - changing your OWN role or status
 *   - removing or suspending the last active administrator
 */

import { NextRequest, NextResponse } from 'next/server';
import { OrgRole, MembershipStatus } from '@prisma/client';
import prisma from '@/lib/db/prisma';
import { withTenant, denialResponse } from '@/lib/tenancy/http';
import { can } from '@/lib/tenancy/rbac';
import {
  checkRoleAssignment, checkNotSelf, checkNotLastAdministrator,
  canTransitionMembership, membershipTransitionsFrom, writeMembershipAudit,
} from '@/lib/tenancy/membership';

async function loadMember(orgId: string, memberId: string) {
  // Scoped by organization: a member id from another tenant is a 404.
  return prisma.orgMember.findFirst({ where: { id: memberId, orgId } });
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: { id: string; memberId: string } }
) {
  return withTenant(request, {}, async ({ ctx, body }) => {
    if (ctx.orgId !== params.id) {
      return NextResponse.json({ error: 'Organization not found.' }, { status: 404 });
    }

    const member = await loadMember(ctx.orgId, params.memberId);
    if (!member) {
      return NextResponse.json({ error: 'Member not found.' }, { status: 404 });
    }

    const selfDenial = checkNotSelf(ctx, member.userId);
    if (selfDenial) return denialResponse(selfDenial);

    const wantsRole = body?.role as OrgRole | undefined;
    const wantsStatus = body?.status as MembershipStatus | undefined;

    if (!wantsRole && !wantsStatus) {
      return NextResponse.json(
        { error: 'Provide a `role` to grant or a `status` transition.' },
        { status: 400 }
      );
    }

    // ── Role change ──────────────────────────────────────────────────────────
    if (wantsRole) {
      if (!(Object.values(OrgRole) as string[]).includes(wantsRole)) {
        return NextResponse.json({ error: `Unknown role "${wantsRole}".` }, { status: 400 });
      }
      const denied = checkRoleAssignment(ctx, wantsRole);
      if (denied) return denialResponse(denied);

      // Demoting the last administrator strands the organization just as surely
      // as removing them.
      if (member.role !== wantsRole) {
        const lastAdmin = await checkNotLastAdministrator(prisma, ctx.orgId, member);
        if (lastAdmin && !['OWNER', 'ADMIN'].includes(wantsRole)) {
          return denialResponse(lastAdmin);
        }
      }
    }

    // ── Status change ────────────────────────────────────────────────────────
    if (wantsStatus) {
      if (!(Object.values(MembershipStatus) as string[]).includes(wantsStatus)) {
        return NextResponse.json({ error: `Unknown status "${wantsStatus}".` }, { status: 400 });
      }
      if (!canTransitionMembership(member.status, wantsStatus)) {
        return NextResponse.json(
          {
            error:
              `A ${member.status} membership cannot become ${wantsStatus}. ` +
              `Valid next states: ${membershipTransitionsFrom(member.status).join(', ') || 'none'}.`,
            code: 'INVALID_MEMBERSHIP_TRANSITION',
          },
          { status: 409 }
        );
      }
      const suspendGuard = requiresAdminCover(wantsStatus)
        ? await checkNotLastAdministrator(prisma, ctx.orgId, member)
        : null;
      if (suspendGuard) return denialResponse(suspendGuard);

      const permission = wantsStatus === MembershipStatus.REMOVED ? 'member:remove' : 'member:suspend';
      if (!can(ctx.role, permission)) {
        return NextResponse.json(
          { error: `Your role (${ctx.role}) cannot perform this action.`, code: 'PERMISSION_DENIED' },
          { status: 403 }
        );
      }
    }

    const now = new Date();
    const updated = await prisma.$transaction(async (tx) => {
      const row = await tx.orgMember.update({
        where: { id: member.id },
        data: {
          ...(wantsRole ? { role: wantsRole } : {}),
          ...(wantsStatus
            ? {
                status: wantsStatus,
                ...(wantsStatus === MembershipStatus.ACTIVE
                  ? { activatedAt: now, suspendedAt: null }
                  : {}),
                ...(wantsStatus === MembershipStatus.SUSPENDED ? { suspendedAt: now } : {}),
                ...(wantsStatus === MembershipStatus.REMOVED ? { removedAt: now } : {}),
              }
            : {}),
        },
      });

      if (wantsRole && wantsRole !== member.role) {
        await writeMembershipAudit(tx, {
          orgId: ctx.orgId,
          type: 'member.role.changed',
          actorAddress: ctx.walletAddress,
          targetUserId: member.userId,
          metadata: { from: member.role, to: wantsRole, memberId: member.id },
        });
      }
      if (wantsStatus && wantsStatus !== member.status) {
        await writeMembershipAudit(tx, {
          orgId: ctx.orgId,
          type: `member.${String(wantsStatus).toLowerCase()}`,
          actorAddress: ctx.walletAddress,
          targetUserId: member.userId,
          metadata: { from: member.status, to: wantsStatus, memberId: member.id },
        });
      }
      return row;
    });

    return NextResponse.json({
      member: { id: updated.id, role: updated.role, status: updated.status },
    });
  });
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: { id: string; memberId: string } }
) {
  return withTenant(request, { permission: 'member:remove', parseBody: false }, async ({ ctx }) => {
    if (ctx.orgId !== params.id) {
      return NextResponse.json({ error: 'Organization not found.' }, { status: 404 });
    }

    const member = await loadMember(ctx.orgId, params.memberId);
    if (!member) {
      return NextResponse.json({ error: 'Member not found.' }, { status: 404 });
    }

    const selfDenial = checkNotSelf(ctx, member.userId);
    if (selfDenial) return denialResponse(selfDenial);

    const lastAdmin = await checkNotLastAdministrator(prisma, ctx.orgId, member);
    if (lastAdmin) return denialResponse(lastAdmin);

    if (!canTransitionMembership(member.status, MembershipStatus.REMOVED)) {
      return NextResponse.json(
        { error: 'That membership is already removed.', code: 'INVALID_MEMBERSHIP_TRANSITION' },
        { status: 409 }
      );
    }

    await prisma.$transaction(async (tx) => {
      // Soft removal. Hard-deleting the row would erase who held approval
      // authority and when — the first thing an access review asks for.
      await tx.orgMember.update({
        where: { id: member.id },
        data: { status: MembershipStatus.REMOVED, removedAt: new Date() },
      });
      await writeMembershipAudit(tx, {
        orgId: ctx.orgId,
        type: 'member.removed',
        actorAddress: ctx.walletAddress,
        targetUserId: member.userId,
        metadata: { role: member.role, memberId: member.id },
      });
    });

    return NextResponse.json({ removed: true });
  });
}

/** SUSPENDED and REMOVED both reduce the pool of usable administrators. */
function requiresAdminCover(status: MembershipStatus): boolean {
  return status === MembershipStatus.SUSPENDED || status === MembershipStatus.REMOVED;
}
