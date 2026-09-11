/**
 * Membership lifecycle and invitations.
 *
 * ── Why this file is cautious ────────────────────────────────────────────────
 * Membership is where privilege escalation lives. An invitation is a
 * client-reachable object that grants authority; a role change is a direct grant
 * of it. Three specific attacks are refused explicitly below, because each is a
 * plausible mistake rather than an exotic one:
 *
 *   1. Granting a role above your own (ADMIN minting an OWNER).
 *   2. Granting a role you are forbidden to exercise (MANAGER minting FINANCE,
 *      then approving their own payment with the second key).
 *   3. Removing the last administrator, leaving an organization nobody can run.
 *
 * Invitation tokens are stored HASHED. A database dump must not hand over working
 * invitations, and an invitation is a bearer credential for joining a tenant.
 */

import { randomBytes, createHash, timingSafeEqual } from 'crypto';
import { OrgRole, MembershipStatus } from '@prisma/client';
import { canAssignRole, isAdministrative, ADMINISTRATIVE_ROLES } from './rbac';
import { requirePermission, type TenantContext, type Denial, type Result } from './resolve';

export const INVITATION_TTL_DAYS = 7;
/** 32 bytes of CSPRNG output — not guessable, and not derived from any input. */
const TOKEN_BYTES = 32;

export function generateInvitationToken(): string {
  return randomBytes(TOKEN_BYTES).toString('base64url');
}

export function hashInvitationToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/**
 * Constant-time comparison of two token hashes.
 *
 * Both sides are already fixed-length hex digests, so length is not secret; the
 * comparison is constant-time anyway to avoid leaking how long a correct prefix
 * was, which with enough attempts narrows the search.
 */
export function tokenHashesMatch(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

// ── Membership state machine ─────────────────────────────────────────────────

const MEMBERSHIP_TRANSITIONS: Record<MembershipStatus, readonly MembershipStatus[]> = {
  [MembershipStatus.INVITED]: [MembershipStatus.ACTIVE, MembershipStatus.REMOVED],
  [MembershipStatus.ACTIVE]: [MembershipStatus.SUSPENDED, MembershipStatus.REMOVED],
  // Reinstatable: suspension is a temporary revocation, not a deletion.
  [MembershipStatus.SUSPENDED]: [MembershipStatus.ACTIVE, MembershipStatus.REMOVED],
  // Terminal. Re-admitting someone creates a NEW membership, so the history of
  // the previous one stays intact and attributable.
  [MembershipStatus.REMOVED]: [],
};

export function canTransitionMembership(
  from: MembershipStatus,
  to: MembershipStatus
): boolean {
  return (MEMBERSHIP_TRANSITIONS[from] ?? []).includes(to);
}

export function membershipTransitionsFrom(
  from: MembershipStatus
): readonly MembershipStatus[] {
  return MEMBERSHIP_TRANSITIONS[from] ?? [];
}

// ── Guards ───────────────────────────────────────────────────────────────────

/**
 * Refuse a grant the actor is not entitled to make.
 *
 * Checked as a pair: the actor needs the permission to assign roles AT ALL, and
 * separately the specific target role must be within their delegation. Holding
 * `member:role:assign` does not imply being able to grant every role.
 */
export function checkRoleAssignment(
  ctx: TenantContext,
  targetRole: OrgRole
): Denial | null {
  const denied = requirePermission(ctx, 'member:role:assign');
  if (denied) return denied;

  if (!canAssignRole(ctx.role, targetRole)) {
    return {
      ok: false,
      status: 403,
      message:
        `A ${ctx.role} cannot grant the ${targetRole} role. ` +
        'Roles can only be delegated at or below your own level.',
      code: 'ROLE_ESCALATION_REFUSED',
    };
  }
  return null;
}

/**
 * Refuse an action that would leave the organization with no administrator.
 *
 * Counts only ACTIVE administrative memberships. An organization whose sole owner
 * is suspended has nobody who can unsuspend them, which is unrecoverable without
 * operator intervention — so the transition is blocked before it happens rather
 * than repaired afterwards.
 */
export async function checkNotLastAdministrator(
  db: any,
  orgId: string,
  member: { id: string; role: OrgRole; status: MembershipStatus }
): Promise<Denial | null> {
  if (!isAdministrative(member.role)) return null;
  if (member.status !== MembershipStatus.ACTIVE) return null;

  const remaining = await db.orgMember.count({
    where: {
      orgId,
      status: MembershipStatus.ACTIVE,
      role: { in: ADMINISTRATIVE_ROLES as OrgRole[] },
      id: { not: member.id },
    },
  });

  if (remaining === 0) {
    return {
      ok: false,
      status: 409,
      message:
        'This is the organization’s last active administrator. Promote another ' +
        'member to OWNER or ADMIN first — otherwise nobody could manage the ' +
        'organization afterwards.',
      code: 'LAST_ADMINISTRATOR',
    };
  }
  return null;
}

/** Refuse self-targeted privilege changes. */
export function checkNotSelf(ctx: TenantContext, targetUserId: string): Denial | null {
  if (ctx.userId !== targetUserId) return null;
  return {
    ok: false,
    status: 409,
    message:
      'You cannot change your own role or membership status. Ask another ' +
      'administrator — self-assignment is how a limited role becomes an ' +
      'unlimited one.',
    code: 'SELF_TARGETED',
  };
}

// ── Invitation acceptance ────────────────────────────────────────────────────

export interface AcceptableInvitation {
  id: string;
  orgId: string;
  orgRole: OrgRole;
  email: string;
}

export type InvitationRejection =
  | 'NOT_FOUND'
  | 'EXPIRED'
  | 'ALREADY_USED'
  | 'REVOKED';

/**
 * Look up an invitation by its plaintext token and decide whether it is usable.
 *
 * Every rejection reason is returned to the CALLER as the same generic failure by
 * the route: distinguishing "expired" from "never existed" tells an attacker
 * which of their guesses were real tokens. The specific reason is kept here for
 * logging and for the audit trail.
 */
export async function resolveInvitation(
  db: any,
  token: string
): Promise<Result<AcceptableInvitation> & { reason?: InvitationRejection }> {
  const tokenHash = hashInvitationToken(token);

  const invitation = await db.invitation.findUnique({ where: { tokenHash } });

  if (!invitation) {
    return { ok: false, status: 404, message: 'Invitation not found.', reason: 'NOT_FOUND' };
  }
  // Defence in depth: the lookup was by unique hash, but comparing explicitly
  // means a future change to the lookup cannot quietly drop the check.
  if (!tokenHashesMatch(invitation.tokenHash, tokenHash)) {
    return { ok: false, status: 404, message: 'Invitation not found.', reason: 'NOT_FOUND' };
  }
  if (invitation.revokedAt) {
    return { ok: false, status: 404, message: 'Invitation not found.', reason: 'REVOKED' };
  }
  if (invitation.usedAt) {
    return { ok: false, status: 404, message: 'Invitation not found.', reason: 'ALREADY_USED' };
  }
  if (invitation.expiresAt.getTime() <= Date.now()) {
    return { ok: false, status: 404, message: 'Invitation not found.', reason: 'EXPIRED' };
  }

  return {
    ok: true,
    value: {
      id: invitation.id,
      orgId: invitation.orgId,
      orgRole: invitation.orgRole,
      email: invitation.email,
    },
  };
}

/**
 * Accept an invitation: mark it used and create or reactivate the membership.
 *
 * Single-use is enforced by a conditional update inside the transaction rather
 * than by the read above. Two requests racing with the same token would both pass
 * the read; only one can win `usedAt IS NULL`, so a token cannot mint two
 * memberships — or, worse, two memberships at two different roles.
 */
export async function acceptInvitation(
  db: any,
  token: string,
  user: { id: string; walletAddress: string }
): Promise<Result<{ orgId: string; role: OrgRole }>> {
  const resolved = await resolveInvitation(db, token);
  if (!resolved.ok) return resolved as Denial;
  const invitation = resolved.value;

  return db.$transaction(async (tx: any) => {
    const claimed = await tx.invitation.updateMany({
      where: { id: invitation.id, usedAt: null, revokedAt: null },
      data: { usedAt: new Date() },
    });
    if (claimed.count === 0) {
      return {
        ok: false as const,
        status: 404 as const,
        message: 'Invitation not found.',
      };
    }

    const existing = await tx.orgMember.findUnique({
      where: { orgId_userId: { orgId: invitation.orgId, userId: user.id } },
    });

    if (existing) {
      // Already a member. The invitation is consumed either way, but an existing
      // role is NOT overwritten: an invitation must not be usable to change the
      // standing of someone who already belongs, in either direction.
      if (existing.status === MembershipStatus.ACTIVE) {
        return {
          ok: true as const,
          value: { orgId: invitation.orgId, role: existing.role },
        };
      }
      if (existing.status === MembershipStatus.REMOVED) {
        return {
          ok: false as const,
          status: 403 as const,
          message:
            'Your membership of this organization was removed. An administrator ' +
            'must issue a new invitation.',
        };
      }
      const reactivated = await tx.orgMember.update({
        where: { id: existing.id },
        data: {
          status: MembershipStatus.ACTIVE,
          activatedAt: new Date(),
          suspendedAt: null,
        },
      });
      await writeMembershipAudit(tx, {
        orgId: invitation.orgId,
        type: 'member.reactivated',
        actorAddress: user.walletAddress,
        targetUserId: user.id,
        metadata: { invitationId: invitation.id, role: reactivated.role },
      });
      return { ok: true as const, value: { orgId: invitation.orgId, role: reactivated.role } };
    }

    const created = await tx.orgMember.create({
      data: {
        orgId: invitation.orgId,
        userId: user.id,
        // The role comes from the INVITATION, written by an authorized inviter —
        // never from the acceptance request.
        role: invitation.orgRole,
        status: MembershipStatus.ACTIVE,
        invitedAt: new Date(),
        activatedAt: new Date(),
      },
    });

    await writeMembershipAudit(tx, {
      orgId: invitation.orgId,
      type: 'invitation.accepted',
      actorAddress: user.walletAddress,
      targetUserId: user.id,
      metadata: { invitationId: invitation.id, role: created.role },
    });

    return { ok: true as const, value: { orgId: invitation.orgId, role: created.role } };
  });
}

/** Append a membership-related audit row. */
export async function writeMembershipAudit(
  db: any,
  input: {
    orgId: string;
    type: string;
    actorAddress?: string;
    actorSystem?: string;
    targetUserId?: string;
    metadata?: Record<string, unknown>;
  }
): Promise<void> {
  await db.auditEvent.create({
    data: {
      orgId: input.orgId,
      type: input.type,
      actorAddress: input.actorAddress ?? null,
      actorSystem: input.actorSystem ?? null,
      metadata: {
        ...(input.targetUserId ? { targetUserId: input.targetUserId } : {}),
        ...(input.metadata ?? {}),
      } as any,
    },
  });
}
