// @vitest-environment node
/**
 * Membership lifecycle and invitation security tests.
 *
 * Membership is where privilege escalation lives: an invitation is a
 * client-reachable object that grants authority. These tests probe the three
 * escalations that are plausible mistakes rather than exotic attacks —
 * granting above your level, granting a role you are forbidden to exercise, and
 * stranding an organization with no administrator.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { OrgRole, MembershipStatus } from '@prisma/client';
import { createFakeDb, type FakeDb } from '@/lib/payments/__tests__/fake-db';
import { resolveTenant, type TenantContext } from '../resolve';
import {
  generateInvitationToken, hashInvitationToken, tokenHashesMatch,
  canTransitionMembership, membershipTransitionsFrom,
  checkRoleAssignment, checkNotLastAdministrator, checkNotSelf,
  resolveInvitation, acceptInvitation,
  INVITATION_TTL_DAYS,
} from '../membership';

const A = 'orgA';
const B = 'orgB';
let db: FakeDb;

function addMember(
  org: string, userId: string, role: OrgRole, wallet: string,
  status: MembershipStatus = MembershipStatus.ACTIVE
) {
  if (!db.__tables.user.rows.some((u) => u.id === userId)) {
    db.__tables.user.rows.push({ id: userId, walletAddress: wallet, role: 'EMPLOYEE' });
  }
  db.__tables.orgMember.rows.push({
    id: `ogm_${org}_${userId}`, orgId: org, userId, role, status, createdAt: new Date(),
  });
}

function addInvitation(opts: {
  id?: string; orgId?: string; email?: string; orgRole?: OrgRole;
  token: string; expiresAt?: Date; usedAt?: Date | null; revokedAt?: Date | null;
}) {
  db.__tables.invitation.rows.push({
    id: opts.id ?? `inv_${opts.token.slice(0, 6)}`,
    orgId: opts.orgId ?? A,
    email: opts.email ?? 'invitee@example.com',
    orgRole: opts.orgRole ?? OrgRole.VIEWER,
    role: 'EMPLOYEE',
    tokenHash: hashInvitationToken(opts.token),
    expiresAt: opts.expiresAt ?? new Date(Date.now() + 86400_000),
    usedAt: opts.usedAt ?? null,
    revokedAt: opts.revokedAt ?? null,
    createdAt: new Date(),
  });
}

async function ctxFor(userId: string, org: string): Promise<TenantContext> {
  const r = await resolveTenant(db, userId, org);
  if (!r.ok) throw new Error(r.message);
  return r.value;
}

beforeEach(() => {
  db = createFakeDb();
  db.__tables.organization.rows.push(
    { id: A, name: 'A', slug: 'a' },
    { id: B, name: 'B', slug: 'b' }
  );
  addMember(A, 'u_owner', OrgRole.OWNER, 'GOWNER');
  addMember(A, 'u_admin', OrgRole.ADMIN, 'GADMIN');
  addMember(A, 'u_mgr', OrgRole.MANAGER, 'GMGR');
  addMember(B, 'u_b_owner', OrgRole.OWNER, 'GBOWNER');
});

describe('invitation tokens', () => {
  it('are long, random and unpredictable', () => {
    const a = generateInvitationToken();
    const b = generateInvitationToken();
    expect(a).not.toBe(b);
    // 32 bytes base64url ≈ 43 chars.
    expect(a.length).toBeGreaterThanOrEqual(40);
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('are stored hashed, never in plaintext', () => {
    const token = generateInvitationToken();
    addInvitation({ token });
    const row = db.__tables.invitation.rows[0];
    expect(row.tokenHash).not.toBe(token);
    expect(row.tokenHash).toHaveLength(64); // sha256 hex
    expect(JSON.stringify(row)).not.toContain(token);
  });

  it('compare hashes in constant time', () => {
    const h = hashInvitationToken('abc');
    expect(tokenHashesMatch(h, h)).toBe(true);
    expect(tokenHashesMatch(h, hashInvitationToken('abd'))).toBe(false);
    expect(tokenHashesMatch(h, 'short')).toBe(false);
  });
});

describe('invitation resolution', () => {
  it('accepts a valid token', async () => {
    const token = generateInvitationToken();
    addInvitation({ token, orgRole: OrgRole.FINANCE });
    const r = await resolveInvitation(db, token);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.orgId).toBe(A);
      expect(r.value.orgRole).toBe(OrgRole.FINANCE);
    }
  });

  it.each([
    ['expired', { expiresAt: new Date(Date.now() - 1000) }, 'EXPIRED'],
    ['already used', { usedAt: new Date() }, 'ALREADY_USED'],
    ['revoked', { revokedAt: new Date() }, 'REVOKED'],
  ] as const)('refuses an %s invitation', async (_label, overrides, reason) => {
    const token = generateInvitationToken();
    addInvitation({ token, ...overrides });
    const r = await resolveInvitation(db, token);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe(reason);
  });

  it('reports every rejection with an identical caller-visible message', async () => {
    // Distinguishing "expired" from "never existed" tells an attacker which of
    // their guesses were real tokens. The reason is kept for logs only.
    const cases = [
      { expiresAt: new Date(Date.now() - 1000) },
      { usedAt: new Date() },
      { revokedAt: new Date() },
    ];
    const messages = new Set<string>();
    for (const [i, overrides] of cases.entries()) {
      const token = generateInvitationToken();
      addInvitation({ token, id: `inv_${i}`, email: `e${i}@x.com`, ...overrides });
      const r = await resolveInvitation(db, token);
      if (!r.ok) messages.add(`${r.status}:${r.message}`);
    }
    const unknown = await resolveInvitation(db, generateInvitationToken());
    if (!unknown.ok) messages.add(`${unknown.status}:${unknown.message}`);
    expect(messages.size, [...messages].join(' | ')).toBe(1);
  });

  it('refuses a guessed token', async () => {
    addInvitation({ token: generateInvitationToken() });
    const r = await resolveInvitation(db, 'guessed-token-value');
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('NOT_FOUND');
  });
});

describe('invitation acceptance', () => {
  it('creates a membership at the role the INVITATION names', async () => {
    const token = generateInvitationToken();
    addInvitation({ token, orgRole: OrgRole.MANAGER });

    const r = await acceptInvitation(db, token, { id: 'u_new', walletAddress: 'GNEW' });

    expect(r.ok).toBe(true);
    const m = db.__tables.orgMember.rows.find((x) => x.userId === 'u_new');
    expect(m.orgId).toBe(A);
    expect(m.role).toBe(OrgRole.MANAGER);
    expect(m.status).toBe(MembershipStatus.ACTIVE);
  });

  it('is single-use', async () => {
    const token = generateInvitationToken();
    addInvitation({ token });
    await acceptInvitation(db, token, { id: 'u_new', walletAddress: 'GNEW' });
    const second = await acceptInvitation(db, token, { id: 'u_other', walletAddress: 'GOTHER' });

    expect(second.ok).toBe(false);
    expect(db.__tables.orgMember.rows.filter((m) => m.userId === 'u_other')).toHaveLength(0);
  });

  it('cannot mint two memberships when two requests race', async () => {
    // Both pass the read; only one can win `usedAt IS NULL`. Otherwise one token
    // yields two memberships — possibly at two different roles.
    const token = generateInvitationToken();
    addInvitation({ token, orgRole: OrgRole.ADMIN });

    const [a, b] = await Promise.all([
      acceptInvitation(db, token, { id: 'u_race1', walletAddress: 'G1' }),
      acceptInvitation(db, token, { id: 'u_race2', walletAddress: 'G2' }),
    ]);

    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
    const created = db.__tables.orgMember.rows.filter((m) =>
      ['u_race1', 'u_race2'].includes(m.userId)
    );
    expect(created).toHaveLength(1);
  });

  it('does not change the role of someone who already belongs', async () => {
    // An invitation must not be usable to alter an existing member's standing,
    // in either direction.
    const token = generateInvitationToken();
    addInvitation({ token, orgRole: OrgRole.OWNER });

    const r = await acceptInvitation(db, token, { id: 'u_mgr', walletAddress: 'GMGR' });

    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.role).toBe(OrgRole.MANAGER);
    expect(db.__tables.orgMember.rows.find((m) => m.userId === 'u_mgr').role)
      .toBe(OrgRole.MANAGER);
  });

  it('refuses to re-admit a REMOVED member', async () => {
    addMember(A, 'u_gone', OrgRole.VIEWER, 'GGONE', MembershipStatus.REMOVED);
    const token = generateInvitationToken();
    addInvitation({ token });

    const r = await acceptInvitation(db, token, { id: 'u_gone', walletAddress: 'GGONE' });

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(403);
  });

  it('reactivates a SUSPENDED member at their original role', async () => {
    addMember(A, 'u_susp', OrgRole.FINANCE, 'GSUSP', MembershipStatus.SUSPENDED);
    const token = generateInvitationToken();
    addInvitation({ token, orgRole: OrgRole.OWNER });

    const r = await acceptInvitation(db, token, { id: 'u_susp', walletAddress: 'GSUSP' });

    expect(r.ok).toBe(true);
    const m = db.__tables.orgMember.rows.find((x) => x.userId === 'u_susp');
    expect(m.status).toBe(MembershipStatus.ACTIVE);
    // Reinstatement is not a promotion opportunity.
    expect(m.role).toBe(OrgRole.FINANCE);
  });

  it('writes an audit event naming the organization and role', async () => {
    const token = generateInvitationToken();
    addInvitation({ token, orgRole: OrgRole.VIEWER });
    await acceptInvitation(db, token, { id: 'u_new', walletAddress: 'GNEW' });

    const e = db.__tables.auditEvent.rows.find((x) => x.type === 'invitation.accepted');
    expect(e.orgId).toBe(A);
    expect(e.actorAddress).toBe('GNEW');
    expect(e.metadata.role).toBe(OrgRole.VIEWER);
  });

  it('scopes acceptance to the invitation’s organization only', async () => {
    const token = generateInvitationToken();
    addInvitation({ token, orgId: B, orgRole: OrgRole.OWNER });

    await acceptInvitation(db, token, { id: 'u_new', walletAddress: 'GNEW' });

    const memberships = db.__tables.orgMember.rows.filter((m) => m.userId === 'u_new');
    expect(memberships).toHaveLength(1);
    expect(memberships[0].orgId).toBe(B);
  });
});

describe('role assignment', () => {
  it('lets an OWNER grant any role', async () => {
    const ctx = await ctxFor('u_owner', A);
    for (const role of Object.values(OrgRole)) {
      expect(checkRoleAssignment(ctx, role), role).toBeNull();
    }
  });

  it('refuses an ADMIN minting an OWNER', async () => {
    const ctx = await ctxFor('u_admin', A);
    const denial = checkRoleAssignment(ctx, OrgRole.OWNER);
    expect(denial?.status).toBe(403);
    expect(denial?.code).toBe('ROLE_ESCALATION_REFUSED');
  });

  it('refuses a MANAGER minting a FINANCE approver', async () => {
    // Otherwise a manager manufactures the second approval they are forbidden
    // from giving.
    const ctx = await ctxFor('u_mgr', A);
    expect(checkRoleAssignment(ctx, OrgRole.FINANCE)?.status).toBe(403);
  });

  it('refuses a MANAGER any assignment at all', async () => {
    const ctx = await ctxFor('u_mgr', A);
    for (const role of Object.values(OrgRole)) {
      expect(checkRoleAssignment(ctx, role), role).not.toBeNull();
    }
  });
});

describe('self-targeting', () => {
  it('refuses changing your own membership', async () => {
    // Self-assignment is how a limited role becomes an unlimited one.
    const ctx = await ctxFor('u_admin', A);
    const denial = checkNotSelf(ctx, 'u_admin');
    expect(denial?.status).toBe(409);
    expect(denial?.code).toBe('SELF_TARGETED');
  });

  it('permits changing someone else', async () => {
    const ctx = await ctxFor('u_admin', A);
    expect(checkNotSelf(ctx, 'u_mgr')).toBeNull();
  });
});

describe('last administrator protection', () => {
  it('refuses removing the only active administrator', async () => {
    db.__tables.orgMember.rows = db.__tables.orgMember.rows.filter(
      (m) => !(m.orgId === A && m.userId === 'u_admin')
    );
    const owner = db.__tables.orgMember.rows.find((m) => m.userId === 'u_owner');

    const denial = await checkNotLastAdministrator(db, A, owner);
    expect(denial?.status).toBe(409);
    expect(denial?.code).toBe('LAST_ADMINISTRATOR');
  });

  it('permits removal while another administrator remains', async () => {
    const owner = db.__tables.orgMember.rows.find((m) => m.userId === 'u_owner');
    expect(await checkNotLastAdministrator(db, A, owner)).toBeNull();
  });

  it('does not count a SUSPENDED administrator as cover', async () => {
    // An organization whose only other admin is suspended has nobody who can
    // unsuspend them.
    db.__tables.orgMember.rows.find((m) => m.userId === 'u_admin').status =
      MembershipStatus.SUSPENDED;
    const owner = db.__tables.orgMember.rows.find((m) => m.userId === 'u_owner');

    expect((await checkNotLastAdministrator(db, A, owner))?.code).toBe('LAST_ADMINISTRATOR');
  });

  it('does not count administrators in a DIFFERENT organization', async () => {
    // org B having an owner is irrelevant to org A's recoverability.
    db.__tables.orgMember.rows = db.__tables.orgMember.rows.filter(
      (m) => !(m.orgId === A && m.userId === 'u_admin')
    );
    const owner = db.__tables.orgMember.rows.find((m) => m.userId === 'u_owner');
    expect((await checkNotLastAdministrator(db, A, owner))?.code).toBe('LAST_ADMINISTRATOR');
  });

  it('ignores non-administrative roles', async () => {
    const mgr = db.__tables.orgMember.rows.find((m) => m.userId === 'u_mgr');
    expect(await checkNotLastAdministrator(db, A, mgr)).toBeNull();
  });
});

describe('membership state machine', () => {
  it.each([
    [MembershipStatus.INVITED, MembershipStatus.ACTIVE, true],
    [MembershipStatus.INVITED, MembershipStatus.REMOVED, true],
    [MembershipStatus.INVITED, MembershipStatus.SUSPENDED, false],
    [MembershipStatus.ACTIVE, MembershipStatus.SUSPENDED, true],
    [MembershipStatus.ACTIVE, MembershipStatus.REMOVED, true],
    [MembershipStatus.ACTIVE, MembershipStatus.INVITED, false],
    [MembershipStatus.SUSPENDED, MembershipStatus.ACTIVE, true],
    [MembershipStatus.SUSPENDED, MembershipStatus.REMOVED, true],
    [MembershipStatus.REMOVED, MembershipStatus.ACTIVE, false],
    [MembershipStatus.REMOVED, MembershipStatus.INVITED, false],
  ])('%s → %s is %s', (from, to, allowed) => {
    expect(canTransitionMembership(from, to)).toBe(allowed);
  });

  it('makes REMOVED terminal', () => {
    // Re-admitting creates a NEW membership, so the previous one's history stays
    // attributable.
    expect(membershipTransitionsFrom(MembershipStatus.REMOVED)).toHaveLength(0);
  });

  it('keeps SUSPENDED reinstatable', () => {
    expect(membershipTransitionsFrom(MembershipStatus.SUSPENDED))
      .toContain(MembershipStatus.ACTIVE);
  });
});

describe('configuration', () => {
  it('expires invitations within a week', () => {
    expect(INVITATION_TTL_DAYS).toBeLessThanOrEqual(7);
  });
});
