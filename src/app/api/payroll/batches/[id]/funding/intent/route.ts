/**
 * POST /api/payroll/batches/:id/funding/intent
 *
 * Opens the funding intent and freezes the plan, BEFORE any wallet is shown.
 *
 * This is the anti-double-funding boundary. `initialize_multi_sig_escrow` creates
 * the escrow and moves custody in one atomic invocation and offers no idempotency,
 * so a second submission would fund a second escrow. The unique index on the
 * attempt's idempotency key is what prevents that — not a disabled button, not
 * client state. A second call while an attempt is open returns THAT attempt.
 */

import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/db/prisma';
import { withTenant, denialResponse } from '@/lib/tenancy/http';
import { findBatch } from '@/lib/tenancy/resolve';
import { assertJsonContentType, errorResponse, handleRouteError } from '@/lib/api/errors';
import { openFundingIntent } from '@/lib/funding/service';
import { fundingIntentRequest, zodIssues } from '@/lib/payroll/schemas';

export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  try {
    assertJsonContentType(request);
  } catch (e) {
    return handleRouteError('funding.intent.POST', e);
  }

  return withTenant(request, { permission: 'escrow:create' }, async ({ ctx, body }) => {
    const parsed = fundingIntentRequest.safeParse(body ?? {});
    if (!parsed.success) {
      return errorResponse(400, 'MALFORMED_REQUEST', 'The request could not be read.', {
        errors: zodIssues(parsed.error),
      });
    }

    try {
      const found = await findBatch(prisma, ctx, params.id, undefined);
      if (!found.ok) return denialResponse(found);

      const result = await openFundingIntent(prisma, ctx, {
        id: found.value.id,
        reference: found.value.reference,
      });

      // 201 only when an attempt was actually opened. A recovered attempt returns
      // 200, so a client can tell "I started this" from "this was already open".
      return NextResponse.json(result, { status: result.created ? 201 : 200 });
    } catch (e) {
      return handleRouteError('funding.intent.POST', e);
    }
  });
}
