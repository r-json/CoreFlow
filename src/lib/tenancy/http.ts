/**
 * HTTP plumbing for tenant-scoped routes.
 *
 * ── Where the organization comes from ────────────────────────────────────────
 * The client may NAME which of its organizations to act in (header, query or
 * body). It may never assert membership or role — those are read from the
 * database by `resolveTenant` on every request.
 *
 * When the caller belongs to exactly one organization, that one is used. When
 * they belong to several, the request must say which: guessing would let an
 * action be performed in the wrong tenant's name, and a payment approved in the
 * wrong organization is not a recoverable mistake.
 */

import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/db/prisma';
import { getUserFromRequest } from '@/lib/auth';
import { MembershipStatus } from '@prisma/client';
import { resolveTenant, requirePermission, type TenantContext, type Denial } from './resolve';
import type { Permission } from './rbac';

export const ORG_HEADER = 'x-organization-id';

export function denialResponse(d: Denial): NextResponse {
  return NextResponse.json(
    { error: d.message, ...(d.code ? { code: d.code } : {}) },
    { status: d.status }
  );
}

/** Read the requested organization from the request, without trusting it. */
export function requestedOrgId(request: NextRequest, body?: any): string | null {
  const fromHeader = request.headers.get(ORG_HEADER);
  if (fromHeader) return fromHeader;
  const fromQuery = new URL(request.url).searchParams.get('orgId');
  if (fromQuery) return fromQuery;
  if (body && typeof body.orgId === 'string') return body.orgId;
  return null;
}

export interface TenantRequest {
  ctx: TenantContext;
  body: any;
  /** Caller-supplied key for retry-safe financial mutations. */
  idempotencyKey?: string;
}

/**
 * Resolve authentication → membership → (optionally) permission, then run the
 * handler. Every tenant-scoped route goes through this, so no route can forget a
 * layer.
 */
export async function withTenant(
  request: NextRequest,
  opts: { permission?: Permission; parseBody?: boolean },
  handler: (req: TenantRequest) => Promise<NextResponse>
): Promise<NextResponse> {
  const user = await getUserFromRequest(request);
  if (!user) {
    return NextResponse.json({ error: 'Authentication required.' }, { status: 401 });
  }

  const body = opts.parseBody === false ? undefined : await request.json().catch(() => ({}));

  let orgId = requestedOrgId(request, body);
  if (!orgId) {
    // Sole membership is unambiguous; several is not.
    const memberships = await prisma.orgMember.findMany({
      where: { userId: user.userId, status: MembershipStatus.ACTIVE },
      select: { orgId: true },
      take: 2,
    });
    if (memberships.length === 1) {
      orgId = memberships[0].orgId;
    } else {
      return NextResponse.json(
        {
          error:
            memberships.length === 0
              ? 'You do not belong to any organization yet.'
              : `Specify the organization for this request via the ${ORG_HEADER} header.`,
          code: memberships.length === 0 ? 'NO_ORGANIZATION' : 'ORGANIZATION_REQUIRED',
        },
        { status: memberships.length === 0 ? 403 : 400 }
      );
    }
  }

  const tenant = await resolveTenant(prisma, user.userId, orgId);
  if (!tenant.ok) return denialResponse(tenant);

  if (opts.permission) {
    const denied = requirePermission(tenant.value, opts.permission);
    if (denied) return denialResponse(denied);
  }

  try {
    return await handler({
      ctx: tenant.value,
      body,
      idempotencyKey:
        request.headers.get('idempotency-key') ?? body?.idempotencyKey ?? undefined,
    });
  } catch (e: any) {
    // Never echo a database error: constraint names and column names describe the
    // schema, and a failed composite FK would reveal another tenant's id space.
    console.error('[tenant route] failed:', e?.message);
    return NextResponse.json(
      { error: 'The request could not be completed.' },
      { status: 500 }
    );
  }
}
