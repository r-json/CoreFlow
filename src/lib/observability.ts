/**
 * Error-tracking seam. Normalizes any thrown value and logs it structurally.
 * If SENTRY_DSN is configured, wire @sentry/nextjs here (a deploy-time step) —
 * call sites don't change. Keeping the seam in one place means we can adopt a
 * provider without touching every route.
 */

import { logger } from './logger';

export interface ErrorContext {
  [key: string]: unknown;
}

export function normalizeError(error: unknown) {
  if (error instanceof Error) {
    return { name: error.name, message: error.message, stack: error.stack };
  }
  return { name: 'NonError', message: String(error) };
}

export function captureError(error: unknown, context: ErrorContext = {}): void {
  const err = normalizeError(error);
  logger.error('captured_error', { err, ...context });

  // if (process.env.SENTRY_DSN) Sentry.captureException(error, { extra: context });
}
