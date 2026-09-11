/**
 * POST /api/payroll/batches/:id/funding/submitted
 *
 * Records that a signed transaction reached the network. It does NOT mark the
 * escrow funded: a submitted transaction is not a settled one, and the only thing
 * that establishes funding is reading the chain back.
 */

import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/db/prisma';
import { withTenant, denialResponse } from '@/lib/tenancy/http';
import { findBatch } from '@/lib/tenancy/resolve';
import { assertJsonContentType, errorResponse, handleRouteError } from '@/lib/api/errors';
import { recordFundingSubmitted } from '@/lib/funding/service';
import { fundingSubmittedRequest, zodIssues } from '@/lib/payroll/schemas';

export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  try {
    assertJsonContentType(request);
  } catch (e) {
    return handleRouteError('funding.submitted.POST', e);
  }

  return withTenant(request, { permission: 'escrow:create' }, async ({ ctx, body }) => {
    const parsed = fundingSubmittedRequest.safeParse(body ?? {});
    if (!parsed.success) {
      return errorResponse(400, 'MALFORMED_REQUEST', 'The request could not be read.', {
        errors: zodIssues(parsed.error),
      });
    }

    try {
      // The batch is resolved within the tenant first, so an attempt id from another
      // organization cannot be reached by naming it.
      const found = await findBatch(prisma, ctx, params.id, undefined);
      if (!found.ok) return denialResponse(found);

      const attempt = await recordFundingSubmitted(prisma, ctx, {
        attemptId: parsed.data.attemptId,
        transactionHash: parsed.data.transactionHash,
        batchId: found.value.id,
      });
      return NextResponse.json({ attempt });
    } catch (e) {
      return handleRouteError('funding.submitted.POST', e);
    }
  });
}
