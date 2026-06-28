/**
 * POST /api/observability/report — sink for client-side error reports from the
 * React error boundaries. Rate-limited and best-effort; it only records, never
 * fails the caller in a way that matters.
 */

import { NextResponse } from 'next/server';
import { captureError } from '@/lib/observability';
import { rateLimit, clientIp } from '@/lib/ratelimit';

export async function POST(request: Request) {
  const rl = rateLimit(`report:${clientIp(request)}`, 30, 60_000);
  if (!rl.ok) {
    return NextResponse.json({ ok: false }, { status: 429 });
  }

  try {
    const body = await request.json().catch(() => ({}));
    const message = typeof body?.message === 'string' ? body.message.slice(0, 1000) : 'unknown';
    captureError(new Error(message), {
      source: 'client',
      digest: typeof body?.digest === 'string' ? body.digest : undefined,
      url: typeof body?.url === 'string' ? body.url.slice(0, 500) : undefined,
    });
  } catch {
    // swallow — reporting must never throw back to the client
  }
  return NextResponse.json({ ok: true }, { status: 202 });
}
