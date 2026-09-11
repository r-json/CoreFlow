/**
 * POST /api/payroll/batches/validate — check a CSV without creating anything
 *
 * A dry run, and safe to call repeatedly. It writes NOTHING: no batch, no
 * payment, no approval, no transaction, no state change. That is the whole point
 * — an uploader must be able to see every problem in a file and fix them before
 * any record exists.
 *
 * Returns 200 with `valid: false` for an invalid file. The CALL succeeded; the
 * file is the thing that is wrong, and a reviewer refreshing a preview is not
 * making failing requests. Creation, by contrast, rejects an invalid file with
 * 422 — there the content being wrong does mean the request cannot be honoured.
 *
 * Distinct from POST /api/payroll/batches/:id/validate, which re-checks an
 * EXISTING draft against current configuration.
 */

import { NextRequest, NextResponse } from 'next/server';
import { withTenant } from '@/lib/tenancy/http';
import {
  assertDeclaredSizeWithin,
  assertJsonContentType,
  errorResponse,
  handleRouteError,
} from '@/lib/api/errors';
import { rateLimit, clientIp } from '@/lib/ratelimit';
import { validateCsv } from '@/lib/payroll/api';
import { validateCsvRequest, zodIssues } from '@/lib/payroll/schemas';
import { MAX_CSV_BYTES } from '@/lib/payroll/csv';

const MAX_REQUEST_BYTES = MAX_CSV_BYTES + 64 * 1024;

/**
 * Looser than creation's limit: a preview is meant to be called as an uploader
 * iterates on a file, and throttling that would push them toward guessing.
 */
const VALIDATE_LIMIT = 60;
const VALIDATE_WINDOW_MS = 60_000;

export async function POST(request: NextRequest) {
  try {
    assertJsonContentType(request);
    assertDeclaredSizeWithin(request, MAX_REQUEST_BYTES);
  } catch (e) {
    return handleRouteError('payroll.validate.POST', e);
  }

  const limit = rateLimit(
    `payroll:validate:${clientIp(request)}`,
    VALIDATE_LIMIT,
    VALIDATE_WINDOW_MS,
  );
  if (!limit.ok) {
    return NextResponse.json(
      {
        error: `Too many validation requests. Try again in ${limit.retryAfter} seconds.`,
        code: 'RATE_LIMITED',
      },
      { status: 429, headers: { 'Retry-After': String(limit.retryAfter) } },
    );
  }

  // `payroll:create` rather than `payroll:read`: this is the preflight for
  // creating a payroll, so the people entitled to run it are the ones entitled
  // to create one.
  return withTenant(request, { permission: 'payroll:create' }, async ({ body }) => {
    const parsed = validateCsvRequest.safeParse(body ?? {});
    if (!parsed.success) {
      return errorResponse(400, 'MALFORMED_REQUEST', 'The request could not be read.', {
        errors: zodIssues(parsed.error),
      });
    }

    try {
      const { report } = validateCsv(parsed.data.csv, {
        rejectDuplicateRecipients: parsed.data.rejectDuplicateRecipients,
      });
      return NextResponse.json(report, { status: 200 });
    } catch (e) {
      return handleRouteError('payroll.validate.POST', e);
    }
  });
}
