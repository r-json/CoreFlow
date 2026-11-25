/**
 * POST /api/payroll/batches/:id/validate — re-check an existing draft
 *
 * Configuration can move under a batch: a payroll reviewed on Monday and funded
 * on Wednesday may have been denominated in an asset this deployment no longer
 * settles. This catches that before a wallet is opened.
 *
 * Read-only. It reports, and changes nothing — no state transition, no approval,
 * no transaction. Safe to call repeatedly.
 */

import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/db/prisma';
import { withTenant, denialResponse } from '@/lib/tenancy/http';
import { findBatch } from '@/lib/tenancy/resolve';
import { errorResponse, handleRouteError } from '@/lib/api/errors';
import { revalidateBatch } from '@/lib/payroll/api';
import { revalidateBatchRequest, zodIssues } from '@/lib/payroll/schemas';

export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  return withTenant(request, { permission: 'payroll:read' }, async ({ ctx, body }) => {
    const parsed = revalidateBatchRequest.safeParse(body ?? {});
    if (!parsed.success) {
      return errorResponse(400, 'MALFORMED_REQUEST', 'The request could not be read.', {
        errors: zodIssues(parsed.error),
      });
    }

    try {
      const found = await findBatch(prisma, ctx, params.id, {
        payments: {
          select: {
            recipientAddress: true,
            assetCode: true,
            assetDecimals: true,
            amountBaseUnits: true,
            rateBaseUnits: true,
            hours: true,
          },
        },
      });
      if (!found.ok) return denialResponse(found);

      const report = await revalidateBatch(prisma, ctx, {
        id: found.value.id,
        reference: found.value.reference,
        payments: found.value.payments,
      });
      return NextResponse.json(report, { status: 200 });
    } catch (e) {
      return handleRouteError('payroll.batch.validate.POST', e);
    }
  });
}
