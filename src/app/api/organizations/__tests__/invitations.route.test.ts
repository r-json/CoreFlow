// @vitest-environment node
/**
 * Org-scoped invitation route tests.
 *
 * Replaces the previous platform-admin invitation tests: that endpoint had no
 * organization scope, so "is this admin allowed to revoke this invitation" had no
 * answer beyond "they are an admin somewhere".
 *
 * The intent of the old tests is preserved (401 unauthenticated, 403 wrong role,
 * 404 missing, success path) and extended with the cases that only exist once
 * tenancy does: cross-tenant revocation, and role escalation via invitation.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OrgRole, MembershipStatus } from '@prisma/client';

// Defined inside the factory: vi.mock is hoisted above any top-level variable.
vi.mock('@/lib/db/prisma', () => {
  const prisma: any = {
    orgMember: { findUnique: vi.fn(), findMany: vi.fn() },
    organization: { findUnique: vi.fn() },
    invitation: { findMany: vi.fn(), findFirst: vi.fn(), upsert: vi.fn(), update: vi.fn() },
    auditEvent: { create: vi.fn() },
  };
  prisma.$transaction = vi.fn(async (fn: any) => fn(prisma));
  return { default: prisma };
});
vi.mock('@/lib/auth', () => ({ getUserFromRequest: vi.fn() }));

import { GET, POST } from '../[id]/invitations/route';
import { DELETE } from '../[id]/invitations/[invitationId]/route';
import { getUserFromRequest } from '@/lib/auth';
import prismaDefault from '@/lib/db/prisma';

const prismaMock = prismaDefault as any;

const mockUser = getUserFromRequest as unknown as ReturnType<typeof vi.fn>;
const ORG = 'orgA';

function signedInAs(role: OrgRole, userId = 'u1', orgId = ORG) {
  mockUser.mockResolvedValue({ userId, walletAddress: 'G' + 'A'.repeat(55), role: 'EMPLOYEE' });
  prismaMock.orgMember.findUnique.mockResolvedValue({
    orgId, userId, role, status: MembershipStatus.ACTIVE,
    org: { id: orgId, name: 'Org A', slug: 'org-a' },
    user: { walletAddress: 'G' + 'A'.repeat(55) },
  });
  prismaMock.orgMember.findMany.mockResolvedValue([{ orgId, role }]);
}

function req(body?: unknown, orgId = ORG) {
  return new Request(`http://localhost/api/organizations/${orgId}/invitations`, {
    method: body ? 'POST' : 'GET',
    headers: { 'Content-Type': 'application/json', 'x-organization-id': orgId },
    ...(body ? { body: JSON.stringify(body) } : {}),
  }) as any;
}

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.invitation.findMany.mockResolvedValue([]);
  prismaMock.organization.findUnique.mockResolvedValue({ id: ORG, name: 'Org A', slug: 'org-a' });
});

describe('POST /api/organizations/:id/invitations', () => {
  it('401 when unauthenticated', async () => {
    mockUser.mockResolvedValue(null);
    const res = await POST(req({ email: 'a@b.com', orgRole: 'VIEWER' }), { params: { id: ORG } });
    expect(res.status).toBe(401);
  });

  it('403 for a role that cannot invite', async () => {
    signedInAs(OrgRole.VIEWER);
    const res = await POST(req({ email: 'a@b.com', orgRole: 'VIEWER' }), { params: { id: ORG } });
    expect(res.status).toBe(403);
  });

  it('creates an invitation and returns the token exactly once', async () => {
    signedInAs(OrgRole.ADMIN);
    prismaMock.invitation.upsert.mockResolvedValue({
      id: 'inv1', email: 'a@b.com', orgRole: OrgRole.MANAGER, expiresAt: new Date(),
    });

    const res = await POST(req({ email: 'A@B.com', orgRole: 'MANAGER' }), { params: { id: ORG } });
    const body = await res.json();

    expect(res.status).toBe(201);
    expect(body.token).toBeTruthy();
    expect(body.acceptUrl).toContain(body.token);

    // Only the HASH is persisted — a database dump must not yield live tokens.
    const stored = prismaMock.invitation.upsert.mock.calls[0][0];
    expect(stored.create.tokenHash).toBeTruthy();
    expect(stored.create.tokenHash).not.toBe(body.token);
    expect(JSON.stringify(stored)).not.toContain(body.token);
    // Email normalized, so re-inviting the same person is recognised as such.
    expect(stored.where.orgId_email.email).toBe('a@b.com');
  });

  it('refuses an ADMIN inviting an OWNER', async () => {
    // Otherwise an admin can hand themselves, or an accomplice, the organization.
    signedInAs(OrgRole.ADMIN);
    const res = await POST(req({ email: 'a@b.com', orgRole: 'OWNER' }), { params: { id: ORG } });
    const body = await res.json();

    expect(res.status).toBe(403);
    expect(body.code).toBe('ROLE_ESCALATION_REFUSED');
    expect(prismaMock.invitation.upsert).not.toHaveBeenCalled();
  });

  it('refuses an invitation naming a different organization than the caller’s', async () => {
    signedInAs(OrgRole.ADMIN, 'u1', ORG);
    const res = await POST(req({ email: 'a@b.com', orgRole: 'VIEWER' }, ORG), {
      params: { id: 'orgB' },
    });
    expect(res.status).toBe(404);
    expect(prismaMock.invitation.upsert).not.toHaveBeenCalled();
  });

  it('rejects a malformed email and an unknown role', async () => {
    signedInAs(OrgRole.ADMIN);
    expect((await POST(req({ email: 'nope', orgRole: 'VIEWER' }), { params: { id: ORG } })).status).toBe(400);
    expect((await POST(req({ email: 'a@b.com', orgRole: 'GOD' }), { params: { id: ORG } })).status).toBe(400);
  });
});

describe('GET /api/organizations/:id/invitations', () => {
  it('never returns the token hash', async () => {
    signedInAs(OrgRole.ADMIN);
    prismaMock.invitation.findMany.mockResolvedValue([{
      id: 'inv1', email: 'a@b.com', orgRole: OrgRole.VIEWER,
      expiresAt: new Date(Date.now() + 86400000), usedAt: null, revokedAt: null,
      invitedBy: 'GX', createdAt: new Date(),
    }]);

    const body = await (await GET(req(), { params: { id: ORG } })).json();

    expect(body.invitations[0].status).toBe('PENDING');
    expect(JSON.stringify(body)).not.toContain('tokenHash');
  });

  it('labels expired, accepted and revoked invitations distinctly', async () => {
    signedInAs(OrgRole.ADMIN);
    prismaMock.invitation.findMany.mockResolvedValue([
      { id: '1', email: 'a@b.com', orgRole: 'VIEWER', expiresAt: new Date(Date.now() - 1000), usedAt: null, revokedAt: null, createdAt: new Date() },
      { id: '2', email: 'c@b.com', orgRole: 'VIEWER', expiresAt: new Date(Date.now() + 1000), usedAt: new Date(), revokedAt: null, createdAt: new Date() },
      { id: '3', email: 'd@b.com', orgRole: 'VIEWER', expiresAt: new Date(Date.now() + 1000), usedAt: null, revokedAt: new Date(), createdAt: new Date() },
    ]);

    const body = await (await GET(req(), { params: { id: ORG } })).json();
    expect(body.invitations.map((i: any) => i.status)).toEqual(['EXPIRED', 'ACCEPTED', 'REVOKED']);
  });

  it('tells the caller which roles they may invite', async () => {
    signedInAs(OrgRole.ADMIN);
    const body = await (await GET(req(), { params: { id: ORG } })).json();
    expect(body.assignableRoles).not.toContain(OrgRole.OWNER);
    expect(body.assignableRoles).toContain(OrgRole.MANAGER);
  });
});

describe('DELETE /api/organizations/:id/invitations/:invitationId', () => {
  const delReq = (orgId = ORG) =>
    new Request(`http://localhost/api/organizations/${orgId}/invitations/inv1`, {
      method: 'DELETE',
      headers: { 'x-organization-id': orgId },
    }) as any;

  it('401 when unauthenticated', async () => {
    mockUser.mockResolvedValue(null);
    const res = await DELETE(delReq(), { params: { id: ORG, invitationId: 'inv1' } });
    expect(res.status).toBe(401);
  });

  it('403 for a role that cannot invite', async () => {
    signedInAs(OrgRole.VIEWER);
    const res = await DELETE(delReq(), { params: { id: ORG, invitationId: 'inv1' } });
    expect(res.status).toBe(403);
  });

  it('404 when the invitation does not exist in this organization', async () => {
    signedInAs(OrgRole.ADMIN);
    prismaMock.invitation.findFirst.mockResolvedValue(null);
    const res = await DELETE(delReq(), { params: { id: ORG, invitationId: 'inv1' } });
    expect(res.status).toBe(404);
  });

  it('revokes rather than deletes, preserving the record', async () => {
    // Deleting would erase that someone was ever invited — the first thing an
    // access review asks for.
    signedInAs(OrgRole.ADMIN);
    prismaMock.invitation.findFirst.mockResolvedValue({
      id: 'inv1', orgId: ORG, email: 'a@b.com', usedAt: null,
    });

    const res = await DELETE(delReq(), { params: { id: ORG, invitationId: 'inv1' } });

    expect(res.status).toBe(200);
    expect(prismaMock.invitation.update).toHaveBeenCalled();
    expect(prismaMock.invitation.update.mock.calls[0][0].data.revokedAt).toBeInstanceOf(Date);
    expect(prismaMock.auditEvent.create).toHaveBeenCalled();
  });

  it('refuses to revoke an already-accepted invitation', async () => {
    signedInAs(OrgRole.ADMIN);
    prismaMock.invitation.findFirst.mockResolvedValue({
      id: 'inv1', orgId: ORG, email: 'a@b.com', usedAt: new Date(),
    });
    const res = await DELETE(delReq(), { params: { id: ORG, invitationId: 'inv1' } });
    const body = await res.json();
    expect(res.status).toBe(409);
    expect(body.code).toBe('ALREADY_ACCEPTED');
  });

  it('refuses a cross-tenant revocation', async () => {
    signedInAs(OrgRole.ADMIN, 'u1', ORG);
    const res = await DELETE(delReq(ORG), { params: { id: 'orgB', invitationId: 'inv1' } });
    expect(res.status).toBe(404);
    expect(prismaMock.invitation.update).not.toHaveBeenCalled();
  });
});
