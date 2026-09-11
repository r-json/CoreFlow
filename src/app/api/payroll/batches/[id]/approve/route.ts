/**
 * POST /api/payroll/batches/:id/approve — record the caller's approval
 *
 * The request does NOT say which role is approving. That is derived from the
 * caller's membership, because a body-supplied role would let one manager send
 * `{"role":"FINANCE"}` and satisfy both halves of the dual-approval gate alone —
 * exactly what the contract refuses with SignersNotDistinct.
 *
 * Nor does the request name a destination state. This records an off-chain
 * approval DECISION; the authoritative approval is the on-chain signature the
 * indexer observes. Recording a decision here does not settle anything, and
 * cannot.
 *
 * Per-payment outcomes are reported individually: "11 approved, 1 needs
 * attention" is the normal result of a real batch.
 */

import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/db/prisma';
import { withTenant, denialResponse } from '@/lib/tenancy/http';
import { findBatch, requireAnyPermission } from '@/lib/tenancy/resolve';
import { errorResponse, handleRouteError } from '@/lib/api/errors';
import { approveBatch } from '@/lib/payroll/api';
import { approveBatchRequest, zodIssues } from '@/lib/payroll/schemas';

export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  // No `permission` here: either half of the gate is a legitimate approver, and
  // gating on one would reject the other. The central helper checks for either,
  // and the caller's ROLE still decides which half they exercise.
  return withTenant(request, {}, async ({ ctx, body, idempotencyKey }) => {
    const denied = requireAnyPermission(ctx, [
      'payment:approve:manager',
      'payment:approve:finance',
    ]);
    if (denied) return denialResponse(denied);

    const parsed = approveBatchRequest.safeParse(body ?? {});
    if (!parsed.success) {
      return errorResponse(400, 'MALFORMED_REQUEST', 'The request could not be read.', {
        errors: zodIssues(parsed.error),
      });
    }

    try {
      const found = await findBatch(prisma, ctx, params.id, {
        payments: { select: { id: true, state: true } },
      });
      if (!found.ok) return denialResponse(found);

      const outcome = await approveBatch(
        prisma,
        ctx,
        { id: found.value.id, payments: found.value.payments },
        {
          paymentIds: parsed.data.paymentIds,
          reason: parsed.data.reason,
          idempotencyKey: idempotencyKey ?? parsed.data.idempotencyKey,
        },
      );

      // 200 even when some payments failed: the batch-level request succeeded and
      // the body reports each outcome. A blanket 4xx would discard the approvals
      // that were legitimately recorded.
      return NextResponse.json(outcome, { status: 200 });
    } catch (e) {
      return handleRouteError('payroll.batch.approve.POST', e);
    }
  });
}
