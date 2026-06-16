/**
 * GET /api/health — liveness probe. Cheap, no dependencies. Returns 200 while
 * the process is up. Use /api/health/ready for dependency (DB) readiness.
 */

import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

export async function GET() {
  return NextResponse.json(
    {
      status: 'ok',
      service: 'coreflow',
      time: new Date().toISOString(),
    },
    { status: 200 }
  );
}
