/**
 * One error shape for every route, and one place that decides what a caller is
 * allowed to learn.
 *
 * Two rules drive the design:
 *
 * 1. NOTHING INTERNAL CROSSES THE BOUNDARY. A Prisma error names constraints,
 *    columns and ids; a stack trace names file paths; an RPC error can carry a
 *    URL with credentials. All of it is logged and none of it is returned.
 *
 * 2. A MISS DOES NOT CONFIRM EXISTENCE. A payment in another organization must be
 *    indistinguishable from one that never existed, or the 403/404 split becomes
 *    an enumeration oracle for a competitor's payroll. 403 is therefore only for
 *    resources the caller already demonstrably knows about — typically their own
 *    organization, where the question is permission rather than visibility.
 */

import { NextResponse } from 'next/server';

/**
 * Status taxonomy. Each has one meaning, so a client can branch on it.
 *
 * | Status | Meaning                                                        |
 * |--------|----------------------------------------------------------------|
 * | 400    | The request itself is malformed — bad JSON, wrong content type  |
 * | 401    | Not authenticated                                              |
 * | 403    | Authenticated, known resource, insufficient permission         |
 * | 404    | Not found OR not visible to this tenant. Deliberately the same  |
 * | 409    | Understood and well-formed, but conflicts with current state    |
 * | 422    | Well-formed request whose CONTENT fails domain validation       |
 * | 429    | Rate limited                                                   |
 * | 500    | Unexpected server failure. Never carries detail                 |
 * | 503    | A dependency (database, RPC) is unavailable                     |
 */
export type ApiErrorStatus = 400 | 401 | 403 | 404 | 409 | 422 | 429 | 500 | 503;

export type ApiErrorCode =
  // 400
  | 'MALFORMED_REQUEST'
  | 'UNSUPPORTED_CONTENT_TYPE'
  | 'PAYLOAD_TOO_LARGE'
  // 401 / 403 / 404
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  // 409
  | 'STATE_CONFLICT'
  | 'REFERENCE_TAKEN'
  | 'REFERENCE_EXHAUSTED'
  | 'IDEMPOTENCY_KEY_REUSED'
  | 'DUPLICATE_APPROVAL'
  | 'APPROVER_NOT_DISTINCT'
  // 422
  | 'VALIDATION_FAILED'
  | 'CSV_INVALID'
  | 'ASSET_NOT_SETTLEABLE'
  | 'SETTLEMENT_ASSET_UNCONFIGURED'
  // 429 / 500 / 503
  | 'RATE_LIMITED'
  | 'INTERNAL_ERROR'
  | 'DEPENDENCY_UNAVAILABLE';

export interface ApiErrorBody {
  error: string;
  code: ApiErrorCode;
  /**
   * Structured, caller-actionable specifics — field paths, row numbers. Only
   * ever data the caller supplied, echoed back so they can fix it. Never server
   * state, and never populated for 500.
   */
  details?: unknown;
}

/**
 * A failure a route is deliberately reporting.
 *
 * Thrown rather than returned where it is raised deep in a helper; `toResponse`
 * renders it. Anything NOT an ApiError reaching the boundary is, by definition,
 * unanticipated, and becomes an opaque 500.
 */
export class ApiError extends Error {
  constructor(
    readonly status: ApiErrorStatus,
    readonly code: ApiErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** The JSON envelope. Shared with the existing `{ error, code }` routes. */
export function errorResponse(
  status: ApiErrorStatus,
  code: ApiErrorCode,
  message: string,
  details?: unknown,
): NextResponse<ApiErrorBody> {
  return NextResponse.json(
    { error: message, code, ...(details === undefined ? {} : { details }) },
    { status },
  );
}

export function apiErrorResponse(e: ApiError): NextResponse<ApiErrorBody> {
  return errorResponse(e.status, e.code, e.message, e.details);
}

/**
 * A resource that is absent, or that belongs to another tenant.
 *
 * One message for both, on purpose. "You may not access batch X" tells the caller
 * batch X exists.
 */
export function notFound(what: string): NextResponse<ApiErrorBody> {
  return errorResponse(404, 'NOT_FOUND', `${what} not found.`);
}

/**
 * The last line before the client.
 *
 * Logs the real failure server-side and returns an opaque 500. Deliberately has
 * no "include details in development" switch: a conditional that reveals
 * internals is one misconfigured environment variable away from revealing them
 * in production.
 */
export function internalError(context: string, e: unknown): NextResponse<ApiErrorBody> {
  const message = e instanceof Error ? e.message : String(e);
  console.error(`[${context}] ${message}`);
  return errorResponse(
    500,
    'INTERNAL_ERROR',
    'The request could not be completed. If this persists, contact support with the time of the request.',
  );
}

/**
 * Render any thrown value as a response.
 *
 * ApiError keeps its status and detail; everything else becomes an opaque 500.
 * Unknown failure modes therefore fail CLOSED — silent about their cause — rather
 * than leaking whatever a library happened to put in `.message`.
 */
export function handleRouteError(context: string, e: unknown): NextResponse<ApiErrorBody> {
  if (e instanceof ApiError) return apiErrorResponse(e);
  return internalError(context, e);
}

/**
 * Reject a body that is not JSON before trying to read it.
 *
 * A form post or an uploaded file reaching a JSON route is a client mistake worth
 * naming, not something to coerce into `{}` and then report as a missing field.
 */
export function assertJsonContentType(request: Request): void {
  const header = request.headers.get('content-type') ?? '';
  const type = header.split(';')[0].trim().toLowerCase();
  if (type !== 'application/json') {
    throw new ApiError(
      400,
      'UNSUPPORTED_CONTENT_TYPE',
      `This endpoint accepts application/json. Received ${type || '(none)'}.`,
    );
  }
}

/**
 * Refuse an oversized body up front, using the declared length.
 *
 * Advisory only — Content-Length can lie or be absent — so the real limit is
 * still enforced after parsing. This exists to reject the honest 50 MB upload
 * before it is buffered, not to be a security boundary.
 */
export function assertDeclaredSizeWithin(request: Request, maxBytes: number): void {
  const declared = Number(request.headers.get('content-length') ?? '');
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new ApiError(
      400,
      'PAYLOAD_TOO_LARGE',
      `Request body is ${Math.round(declared / 1024)} KB; the limit is ${Math.round(maxBytes / 1024)} KB.`,
    );
  }
}
