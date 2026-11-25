/**
 * GET  /api/organizations/:id/reconciliation — operational health
 * POST /api/organizations/:id/reconciliation — trigger a run for this organization
 *
 * Membership-scoped. A run is a read-heavy operation that can also correct the
 * projection, so triggering it requires `reconciliation:resolve` rather than mere
 * read access.
 */

import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/db/prisma';
import { withTenant } from '@/lib/tenancy/http';
import { STELLAR_CONFIG } from '@/lib/config';
import { reconciliationHealth, runReconciliation } from '@/lib/reconciliation/scheduler';

export const maxDuration = 300;

export async function GET(request: NextRequest, { params }: { params: { id: string } }) {
  return withTenant(
    request,
    { permission: 'reconciliation:read', parseBody: false },
    async ({ ctx }) => {
      if (ctx.orgId !== params.id) {
        return NextResponse.json({ error: 'Organization not found.' }, { status: 404 });
      }

      const health = await reconciliationHealth(prisma, ctx.orgId);

      const recentRuns = await prisma.reconciliationRun.findMany({
        where: { orgId: ctx.orgId },
        orderBy: { startedAt: 'desc' },
        take: 10,
        select: {
          id: true, correlationId: true, status: true, scope: true,
          startedAt: true, completedAt: true,
          escrowsExamined: true, paymentsExamined: true,
          agreed: true, mismatched: true, unreadable: true,
          chainAhead: true, databaseAhead: true,
          findingsOpened: true, correctionsApplied: true, errorMessage: true,
        },
      });

      const bySeverity = await prisma.reconciliationFinding.groupBy({
        by: ['severity'],
        where: { orgId: ctx.orgId, status: { not: 'RESOLVED' } },
        _count: true,
      });

      return NextResponse.json({
        health,
        recentRuns,
        openBySeverity: Object.fromEntries(
          bySeverity.map((r: any) => [r.severity, r._count])
        ),
      });
    }
  );
}

export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  return withTenant(
    request,
    { permission: 'reconciliation:resolve' },
    async ({ ctx }) => {
      if (ctx.orgId !== params.id) {
        return NextResponse.json({ error: 'Organization not found.' }, { status: 404 });
      }

      const result = await runReconciliation(prisma, ctx.orgId, {
        contractId: STELLAR_CONFIG.contract.id || undefined,
        network: STELLAR_CONFIG.contract.network,
      });

      if ('skipped' in result) {
        return NextResponse.json(
          {
            skipped: true,
            reason: 'A reconciliation run is already in progress for this organization.',
            runId: result.runId,
          },
          { status: 409 }
        );
      }
      return NextResponse.json(result, { status: 200 });
    }
  );
}
