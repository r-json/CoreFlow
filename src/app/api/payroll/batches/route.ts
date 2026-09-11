/**
 * POST /api/payroll/batches — create a draft batch from an uploaded CSV
 * GET  /api/payroll/batches — list this organization's batches
 *
 * Creation produces one DRAFT Payment per valid CSV row. It does NOT touch the
 * chain, fund custody, or advance any payment toward settlement: a draft is a
 * reviewable intention, and every step after it is a separate, explicit action.
 *
 * The route decodes and renders. Every rule lives in the domain services it calls.
 */

import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/db/prisma';
import { withTenant, denialResponse } from '@/lib/tenancy/http';
import { assertProjectInTenant } from '@/lib/tenancy/resolve';
import {
  assertDeclaredSizeWithin,
  assertJsonContentType,
  errorResponse,
  handleRouteError,
} from '@/lib/api/errors';
import { rateLimit, clientIp } from '@/lib/ratelimit';
import { createBatch } from '@/lib/payroll/api';
import { createBatchRequest, listBatchesQuery, zodIssues } from '@/lib/payroll/schemas';
import { MAX_CSV_BYTES } from '@/lib/payroll/csv';
import { rollupBatch } from '@/lib/payments/service';
import { formatAmountWithSeparators } from '@/lib/money';

/** The JSON envelope around a 1 MB file, plus headroom for escaping. */
const MAX_REQUEST_BYTES = MAX_CSV_BYTES + 64 * 1024;

/**
 * Parsing a megabyte of caller-chosen text is the expensive part of this route,
 * so the brake is applied before the body is read rather than after.
 */
const UPLOAD_LIMIT = 20;
const UPLOAD_WINDOW_MS = 60_000;

export async function POST(request: NextRequest) {
  try {
    assertJsonContentType(request);
    assertDeclaredSizeWithin(request, MAX_REQUEST_BYTES);
  } catch (e) {
    return handleRouteError('payroll.batches.POST', e);
  }

  const limit = rateLimit(`payroll:create:${clientIp(request)}`, UPLOAD_LIMIT, UPLOAD_WINDOW_MS);
  if (!limit.ok) {
    return NextResponse.json(
      {
        error: `Too many payroll uploads. Try again in ${limit.retryAfter} seconds.`,
        code: 'RATE_LIMITED',
      },
      { status: 429, headers: { 'Retry-After': String(limit.retryAfter) } },
    );
  }

  return withTenant(
    request,
    { permission: 'payroll:create' },
    async ({ ctx, body, idempotencyKey }) => {
      const parsed = createBatchRequest.safeParse(body ?? {});
      if (!parsed.success) {
        return errorResponse(400, 'MALFORMED_REQUEST', 'The request could not be read.', {
          errors: zodIssues(parsed.error),
        });
      }
      const input = parsed.data;

      // A project id is an id, not a grant. Resolved within the tenant, so naming
      // another organization's project is a non-enumerating miss.
      const projectDenial = await assertProjectInTenant(prisma, ctx, input.projectId);
      if (projectDenial) return denialResponse(projectDenial);

      try {
        const outcome = await createBatch(prisma, ctx, {
          csv: input.csv,
          filename: input.filename ?? null,
          reference: input.reference ?? null,
          projectId: input.projectId ?? null,
          rejectDuplicateRecipients: input.rejectDuplicateRecipients,
          // Header wins over body: the header is the HTTP-level retry key a proxy
          // or client library will reuse automatically.
          idempotencyKey: idempotencyKey ?? input.idempotencyKey ?? null,
        });

        // 201 only when something was actually created. A replayed retry returns
        // 200, so a client can tell "I made this" from "this already existed".
        return NextResponse.json(outcome, { status: outcome.created ? 201 : 200 });
      } catch (e) {
        return handleRouteError('payroll.batches.POST', e);
      }
    },
  );
}

export async function GET(request: NextRequest) {
  return withTenant(request, { permission: 'payroll:read', parseBody: false }, async ({ ctx }) => {
    const query = listBatchesQuery.safeParse(
      Object.fromEntries(new URL(request.url).searchParams.entries()),
    );
    if (!query.success) {
      return errorResponse(400, 'MALFORMED_REQUEST', 'The query could not be read.', {
        errors: zodIssues(query.error),
      });
    }
    const { limit = 25, cursor, projectId } = query.data;

    try {
      const rows = await prisma.payrollBatch.findMany({
        // orgId is part of the QUERY, not a check afterwards: another tenant's
        // batch is indistinguishable from one that does not exist.
        where: { orgId: ctx.orgId, ...(projectId ? { projectId } : {}) },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: limit + 1,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        include: {
          payments: { select: { state: true, amountBaseUnits: true, assetCode: true, assetDecimals: true } },
        },
      });

      const page = rows.slice(0, limit);
      return NextResponse.json({
        batches: page.map((b) => {
          const standing = rollupBatch(b.payments);
          const decimals = b.payments[0]?.assetDecimals ?? 7;
          return {
            id: b.id,
            reference: b.reference,
            projectId: b.projectId,
            createdAt: b.createdAt.toISOString(),
            periodStart: b.periodStart?.toISOString() ?? null,
            periodEnd: b.periodEnd?.toISOString() ?? null,
            paymentCount: b.payments.length,
            asset: b.payments[0]?.assetCode ?? null,
            total: formatAmountWithSeparators(standing.totalAmountBaseUnits, decimals),
            totalBaseUnits: standing.totalAmountBaseUnits.toString(),
            // Derived on read. There is no stored status column to drift.
            headline: standing.headline,
            needsAttention: standing.needsAttention,
            source: { filename: b.sourceFilename, rowsSeen: b.sourceRowCount },
          };
        }),
        nextCursor: rows.length > limit ? page[page.length - 1].id : null,
      });
    } catch (e) {
      return handleRouteError('payroll.batches.GET', e);
    }
  });
}
