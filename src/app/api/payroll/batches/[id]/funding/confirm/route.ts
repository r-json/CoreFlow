/**
 * POST /api/payroll/batches/:id/funding/confirm
 *
 * Independent chain verification. Four outcomes, deliberately never collapsed:
 *
 *   CONFIRMED     the chain agrees with the frozen plan, payment by payment, and a
 *                 transfer of the exact total reached custody in that transaction
 *   FAILED        the chain says the transaction failed; nothing moved
 *   UNVERIFIABLE  the chain could not be read. NOT a failure — an RPC outage does
 *                 not prove anything about the transaction
 *   MISMATCH      we read the chain and it disagrees with the plan. The escrow is
 *                 NOT adopted, and a CRITICAL finding preserves the evidence
 *
 * Safe to call repeatedly: a confirmed attempt replays its answer.
 */

import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/db/prisma';
import { withTenant, denialResponse } from '@/lib/tenancy/http';
import { findBatch } from '@/lib/tenancy/resolve';
import { assertJsonContentType, errorResponse, handleRouteError } from '@/lib/api/errors';
import { confirmFunding } from '@/lib/funding/service';
import { createRpcVerifier } from '@/lib/reconciliation/chain-verifier';
import { fundingConfirmRequest, zodIssues } from '@/lib/payroll/schemas';

/** Reading the chain can be slow; this must not be cut short mid-verification. */
export const maxDuration = 120;

export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  try {
    assertJsonContentType(request);
  } catch (e) {
    return handleRouteError('funding.confirm.POST', e);
  }

  return withTenant(request, { permission: 'escrow:create' }, async ({ ctx, body }) => {
    const parsed = fundingConfirmRequest.safeParse(body ?? {});
    if (!parsed.success) {
      return errorResponse(400, 'MALFORMED_REQUEST', 'The request could not be read.', {
        errors: zodIssues(parsed.error),
      });
    }

    try {
      const found = await findBatch(prisma, ctx, params.id, undefined);
      if (!found.ok) return denialResponse(found);

      const result = await confirmFunding(prisma, ctx, createRpcVerifier(), {
        attemptId: parsed.data.attemptId,
        onChainEscrowId: parsed.data.onChainEscrowId,
        batchId: found.value.id,
      });

      // 200 for every outcome: the verification REQUEST succeeded, and the body
      // says what the chain showed. A 4xx would conflate "we could not check" with
      // "your request was wrong".
      return NextResponse.json(result);
    } catch (e) {
      return handleRouteError('funding.confirm.POST', e);
    }
  });
}
