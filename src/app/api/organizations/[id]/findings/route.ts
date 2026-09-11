/**
 * GET /api/organizations/:id/findings — reconciliation findings for this tenant.
 *
 * Tenant-scoped like everything else. Findings name payments, amounts and
 * recipients, so a cross-tenant leak here would disclose another organization's
 * payroll.
 */

import { NextRequest, NextResponse } from 'next/server';
import { FindingStatus, FindingSeverity } from '@prisma/client';
import prisma from '@/lib/db/prisma';
import { withTenant } from '@/lib/tenancy/http';
import { formatAmountWithSeparators } from '@/lib/money';
import { txUrl } from '@/lib/explorer';

const SEVERITY_ORDER: FindingSeverity[] = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'] as FindingSeverity[];

export async function GET(request: NextRequest, { params }: { params: { id: string } }) {
  return withTenant(
    request,
    { permission: 'reconciliation:read', parseBody: false },
    async ({ ctx }) => {
      if (ctx.orgId !== params.id) {
        return NextResponse.json({ error: 'Organization not found.' }, { status: 404 });
      }

      const url = new URL(request.url);
      const statusParam = url.searchParams.get('status');
      const severityParam = url.searchParams.get('severity');
      const limit = Math.min(
        Math.max(parseInt(url.searchParams.get('limit') || '50', 10) || 50, 1),
        200
      );

      if (statusParam && !(Object.values(FindingStatus) as string[]).includes(statusParam)) {
        return NextResponse.json({ error: `Unknown status "${statusParam}".` }, { status: 400 });
      }
      if (severityParam && !(Object.values(FindingSeverity) as string[]).includes(severityParam)) {
        return NextResponse.json({ error: `Unknown severity "${severityParam}".` }, { status: 400 });
      }

      const findings = await prisma.reconciliationFinding.findMany({
        where: {
          orgId: ctx.orgId,
          // Unresolved by default: a findings queue defaults to "what still needs
          // attention", not to a historical archive.
          ...(statusParam
            ? { status: statusParam as FindingStatus }
            : { status: { not: FindingStatus.RESOLVED } }),
          ...(severityParam ? { severity: severityParam as FindingSeverity } : {}),
        },
        orderBy: [{ severity: 'asc' }, { detectedAt: 'asc' }],
        take: limit,
        include: {
          payment: {
            select: {
              id: true, recipientAddress: true, amountBaseUnits: true,
              assetDecimals: true, assetCode: true, state: true,
              batch: { select: { id: true, reference: true } },
            },
          },
          run: { select: { correlationId: true, startedAt: true } },
        },
      });

      // Severity enum order is alphabetical in Prisma, not by urgency.
      const ordered = [...findings].sort(
        (a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity)
      );

      return NextResponse.json({
        findings: ordered.map((f) => ({
          id: f.id,
          kind: f.kind,
          status: f.status,
          severity: f.severity,
          detail: f.detail,
          /** What to actually do. A finding without this is a puzzle. */
          remediation: f.remediation,
          dbState: f.dbState,
          chainState: f.chainState,
          escrowOnChainId: f.escrowOnChainId,
          paymentIndex: f.paymentIndex,
          transaction: f.txHash
            ? { hash: f.txHash, explorerUrl: txUrl(f.txHash) }
            : null,
          payment: f.payment
            ? {
                id: f.payment.id,
                recipient: f.payment.recipientAddress,
                amount: formatAmountWithSeparators(
                  f.payment.amountBaseUnits,
                  f.payment.assetDecimals
                ),
                assetCode: f.payment.assetCode,
                state: f.payment.state,
                batch: f.payment.batch,
              }
            : null,
          detectedAt: f.detectedAt.toISOString(),
          lastObservedAt: f.lastObservedAt.toISOString(),
          observationCount: f.observationCount,
          acknowledgedBy: f.acknowledgedBy,
          acknowledgedAt: f.acknowledgedAt?.toISOString() ?? null,
          resolvedBy: f.resolvedBy,
          resolvedAt: f.resolvedAt?.toISOString() ?? null,
          resolution: f.resolution,
          detectedByRun: f.run?.correlationId ?? null,
        })),
      });
    }
  );
}
