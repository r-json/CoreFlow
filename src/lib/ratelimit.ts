/**
 * Lightweight fixed-window rate limiter.
 *
 * In-memory and per-instance — sufficient for single-instance deployments and a
 * meaningful abuse brake on auth/oracle endpoints. For multi-instance scale,
 * swap the Map for a shared store (Upstash Redis / Vercel KV) behind the same
 * interface; callers don't change. Documented in docs/DEPLOYMENT.md.
 */

interface Bucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Bucket>();

export interface RateLimitResult {
  ok: boolean;
  remaining: number;
  retryAfter: number; // seconds until the window resets
}

const MAX_BUCKET_AGE_CHECK = 1000; // Run cleanup every N calls
let callsSinceCleanup = 0;

function cleanupExpiredBuckets() {
  const now = Date.now();
  for (const [key, bucket] of buckets) {
    if (now > bucket.resetAt) {
      buckets.delete(key);
    }
  }
}

export function rateLimit(key: string, limit: number, windowMs: number): RateLimitResult {
  // Periodic cleanup to prevent unbounded memory growth from unique keys
  callsSinceCleanup++;
  if (callsSinceCleanup >= MAX_BUCKET_AGE_CHECK) {
    callsSinceCleanup = 0;
    cleanupExpiredBuckets();
  }

  const now = Date.now();
  const bucket = buckets.get(key);

  if (!bucket || now > bucket.resetAt) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return { ok: true, remaining: limit - 1, retryAfter: 0 };
  }

  if (bucket.count >= limit) {
    return { ok: false, remaining: 0, retryAfter: Math.ceil((bucket.resetAt - now) / 1000) };
  }

  bucket.count++;
  return { ok: true, remaining: limit - bucket.count, retryAfter: 0 };
}

/** Best-effort client IP from proxy headers (Vercel sets x-forwarded-for). */
export function clientIp(req: Request): string {
  const xff = req.headers.get('x-forwarded-for');
  if (xff) return xff.split(',')[0].trim();
  return req.headers.get('x-real-ip') || 'unknown';
}

/** Test helper — clears all buckets and resets the cleanup counter. */
export function __resetRateLimiter() {
  buckets.clear();
  callsSinceCleanup = 0;
}
