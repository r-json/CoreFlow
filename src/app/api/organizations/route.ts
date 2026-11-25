/**
 * GET  /api/organizations — the caller's workspaces
 * POST /api/organizations — create one, becoming its first OWNER
 *
 * Creation is the only place a user may grant themselves a privileged role, and
 * it is safe precisely because the organization does not exist yet: there is no
 * existing tenant whose authority is being escalated. Every later grant goes
 * through the delegation rules in tenancy/rbac.
 */

import { NextRequest, NextResponse } from 'next/server';
import { OrgRole, MembershipStatus } from '@prisma/client';
import prisma from '@/lib/db/prisma';
import { getUserFromRequest } from '@/lib/auth';
import { listTenants } from '@/lib/tenancy/resolve';
import { permissionsFor } from '@/lib/tenancy/rbac';
import { writeMembershipAudit } from '@/lib/tenancy/membership';

/** Lowercase, hyphenated, no leading/trailing hyphen. */
function slugify(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\p{Letter}\p{Number}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

export async function GET(request: NextRequest) {
  const user = await getUserFromRequest(request);
  if (!user) {
    return NextResponse.json({ error: 'Authentication required.' }, { status: 401 });
  }

  const orgs = await listTenants(prisma, user.userId);
  return NextResponse.json({
    organizations: orgs.map((o) => ({
      ...o,
      // The UI renders from permissions, never the reverse. Shipping them here
      // keeps the client from re-deriving the rules and drifting from the server.
      permissions: permissionsFor(o.role),
    })),
  });
}

export async function POST(request: NextRequest) {
  const user = await getUserFromRequest(request);
  if (!user) {
    return NextResponse.json({ error: 'Authentication required.' }, { status: 401 });
  }

  const body = await request.json().catch(() => ({}));
  const name = String(body?.name ?? '').trim();

  if (name.length < 2 || name.length > 80) {
    return NextResponse.json(
      { error: 'Organization name must be between 2 and 80 characters.' },
      { status: 400 }
    );
  }

  const base = slugify(name);
  if (!base) {
    return NextResponse.json(
      { error: 'Organization name must contain at least one letter or number.' },
      { status: 400 }
    );
  }

  try {
    const result = await prisma.$transaction(async (tx) => {
      // Slugs are public-ish identifiers, so a collision gets a suffix rather
      // than revealing that some other tenant already took the name.
      let slug = base;
      for (let i = 2; i < 50; i++) {
        const taken = await tx.organization.findUnique({ where: { slug } });
        if (!taken) break;
        slug = `${base}-${i}`;
      }

      const org = await tx.organization.create({ data: { name, slug } });

      const member = await tx.orgMember.create({
        data: {
          orgId: org.id,
          userId: user.userId,
          role: OrgRole.OWNER,
          status: MembershipStatus.ACTIVE,
          activatedAt: new Date(),
        },
      });

      await writeMembershipAudit(tx, {
        orgId: org.id,
        type: 'organization.created',
        actorAddress: user.walletAddress,
        targetUserId: user.userId,
        metadata: { name, slug, role: OrgRole.OWNER },
      });

      return { org, member };
    });

    return NextResponse.json(
      {
        organization: {
          id: result.org.id,
          name: result.org.name,
          slug: result.org.slug,
        },
        role: result.member.role,
        permissions: permissionsFor(result.member.role),
      },
      { status: 201 }
    );
  } catch (e: any) {
    console.error('[organizations] create failed:', e?.message);
    return NextResponse.json(
      { error: 'The organization could not be created.' },
      { status: 500 }
    );
  }
}
