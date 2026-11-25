/**
 * POST /api/payroll/batches/:id/funding/abandon
 *
 * Closes an attempt that did not reach the network — a declined signature, a
 * simulation failure — so the batch is not blocked forever.
 *
 * Narrowly defined on purpose. It never asserts that an on-chain escrow does not
 * exist: payments return to DRAFT only when NOTHING was submitted. Once a
 * transaction hash exists the money may have moved, and manufacturing a "not
 * funded" state would invite funding a second escrow.
 */

import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/db/prisma';
import { withTenant, denialResponse } from '@/lib/tenancy/http';
import { findBatch } from '@/lib/tenancy/resolve';
import { assertJsonContentType, errorResponse, handleRouteError } from '@/lib/api/errors';
import { failFundingIntent } from '@/lib/funding/service';
import { fundingAbandonRequest, zodIssues } from '@/lib/payroll/schemas';

export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  try {
    assertJsonContentType(request);
  } catch (e) {
    return handleRouteError('funding.abandon.POST', e);
  }

  return withTenant(request, { permission: 'escrow:create' }, async ({ ctx, body }) => {
    const parsed = fundingAbandonRequest.safeParse(body ?? {});
    if (!parsed.success) {
      return errorResponse(400, 'MALFORMED_REQUEST', 'The request could not be read.', {
        errors: zodIssues(parsed.error),
      });
    }

    try {
      const found = await findBatch(prisma, ctx, params.id, undefined);
      if (!found.ok) return denialResponse(found);

      const attempt = await failFundingIntent(prisma, ctx, {
        attemptId: parsed.data.attemptId,
        reason: parsed.data.reason,
        userRejected: parsed.data.userRejected,
        batchId: found.value.id,
      });
      return NextResponse.json({ attempt });
    } catch (e) {
      return handleRouteError('funding.abandon.POST', e);
    }
  });
}
