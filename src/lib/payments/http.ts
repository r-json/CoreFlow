/**
 * Shared HTTP plumbing for payment action routes.
 *
 * Each action gets its own route (POST /api/payments/:id/approve, …) rather than
 * one endpoint taking a status. The requirement is that users trigger business
 * actions and the SERVER decides the resulting state; a single
 * `PATCH {status: 'PAID'}` would invert that.
 */

import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/db/prisma';
import { getUserFromRequest } from '@/lib/auth';
import { resolveMembership } from './authz';
import type { ActionContext, ActionResult } from './actions';

/** Where the caller's organization comes from, in precedence order. */
async function resolveOrgId(
  request: NextRequest,
  body: any,
  userId: string
): Promise<string | null> {
  const explicit =
    request.headers.get('x-organization-id') ??
    body?.orgId ??
    new URL(request.url).searchParams.get('orgId');
  if (explicit) return String(explicit);

  // Fall back to the caller's sole membership. Ambiguity is NOT resolved by
  // guessing: a user in several organizations must say which one, or a payment
  // could be acted on in the wrong tenant's name.
  const memberships = await prisma.orgMember.findMany({
    where: { userId },
    select: { orgId: true },
    take: 2,
  });
  return memberships.length === 1 ? memberships[0].orgId : null;
}

export async function runPaymentAction(
  request: NextRequest,
  paymentId: string,
  action: (ctx: ActionContext) => Promise<ActionResult>
): Promise<NextResponse> {
  const user = await getUserFromRequest(request);
  if (!user) {
    return NextResponse.json({ error: 'Authentication required.' }, { status: 401 });
  }

  const body = await request.json().catch(() => ({}));

  const orgId = await resolveOrgId(request, body, user.userId);
  if (!orgId) {
    return NextResponse.json(
      {
        error:
          'Specify the organization for this action via the X-Organization-Id ' +
          'header — you belong to more than one, or to none.',
      },
      { status: 400 }
    );
  }

  const membership = await resolveMembership(prisma, user.userId, orgId);
  if (!membership.ok) {
    return NextResponse.json({ error: membership.message }, { status: membership.status });
  }

  try {
    const result = await action({
      db: prisma,
      membership: membership.value,
      paymentId,
      idempotencyKey:
        request.headers.get('idempotency-key') ?? body?.idempotencyKey ?? undefined,
      reason: body?.reason,
    });

    if (!result.ok) {
      return NextResponse.json(
        { error: result.message, ...(result.code ? { code: result.code } : {}) },
        { status: result.status }
      );
    }
    return NextResponse.json(result.body, { status: result.status });
  } catch (e: any) {
    console.error('[payment action] failed:', e?.message);
    return NextResponse.json(
      { error: 'The action could not be completed.' },
      { status: 500 }
    );
  }
}
