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
import { presentBatch, presentActivity, presentFindings } from '@/lib/payroll/api';

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

      // The activity timeline and any findings, both tenant-scoped by the same
      // organization filter the batch itself was resolved with.
      const [events, findings] = await Promise.all([
        prisma.auditEvent.findMany({
          where: { orgId: ctx.orgId, batchId: found.value.id },
          orderBy: [{ createdAt: 'asc' }],
          take: 200,
        }),
        prisma.reconciliationFinding.findMany({
          where: {
            orgId: ctx.orgId,
            status: { not: 'RESOLVED' },
            paymentId: { in: found.value.payments.map((p: { id: string }) => p.id) },
          },
          orderBy: [{ detectedAt: 'desc' }],
          take: 50,
        }),
      ]);

      return NextResponse.json({
        batch: presentBatch(found.value),
        activity: presentActivity(events),
        findings: presentFindings(findings),
      });
    } catch (e) {
      return handleRouteError('payroll.batch.GET', e);
    }
  });
}
