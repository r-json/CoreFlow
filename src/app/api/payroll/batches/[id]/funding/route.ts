/**
 * GET /api/payroll/batches/:id/funding — may this batch be funded, and with what?
 *
 * Read-only, and safe to poll. Returns every blocker at once, plus the exact plan
 * when the batch is fundable — which is the disclosure the signer is entitled to
 * see before a wallet opens.
 */

import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/db/prisma';
import { withTenant, denialResponse } from '@/lib/tenancy/http';
import { findBatch } from '@/lib/tenancy/resolve';
import { handleRouteError } from '@/lib/api/errors';
import { getFundingState } from '@/lib/funding/service';

export async function GET(request: NextRequest, { params }: { params: { id: string } }) {
  return withTenant(request, { permission: 'escrow:read', parseBody: false }, async ({ ctx }) => {
    try {
      const found = await findBatch(prisma, ctx, params.id, undefined);
      if (!found.ok) return denialResponse(found);

      const state = await getFundingState(prisma, ctx, {
        id: found.value.id,
        reference: found.value.reference,
      });
      return NextResponse.json(state);
    } catch (e) {
      return handleRouteError('funding.GET', e);
    }
  });
}
