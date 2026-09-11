/**
 * GET /api/payroll/batches/:id — one batch, with its payments
 *
 * The batch's standing is DERIVED from its payments on every read. There is no
 * stored status column to disagree with the rows it summarizes.
 */

import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/db/prisma';
import { withTenant, denialResponse } from '@/lib/tenancy/http';
import { findBatch } from '@/lib/tenancy/resolve';
import { handleRouteError } from '@/lib/api/errors';
import { presentBatch } from '@/lib/payroll/api';

export async function GET(request: NextRequest, { params }: { params: { id: string } }) {
  return withTenant(request, { permission: 'payroll:read', parseBody: false }, async ({ ctx }) => {
    try {
      // Tenant-scoped lookup. A batch in another organization returns the same
      // 404 as one that does not exist, so an id cannot be probed for existence.
      const found = await findBatch(prisma, ctx, params.id, {
        payments: {
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          include: {
            approvals: {
              select: { role: true, decision: true, actorAddress: true, createdAt: true },
            },
          },
        },
      });
      if (!found.ok) return denialResponse(found);

      return NextResponse.json({ batch: presentBatch(found.value) });
    } catch (e) {
      return handleRouteError('payroll.batch.GET', e);
    }
  });
}
