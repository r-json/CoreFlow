/**
 * GET /api/health/ready — readiness probe. Verifies the DB is reachable so load
 * balancers / uptime checks can distinguish "up" from "able to serve".
 */

import { NextResponse } from 'next/server';
import prisma from '@/lib/db/prisma';
import { captureError } from '@/lib/observability';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return NextResponse.json(
      { status: 'ready', checks: { db: 'ok' }, time: new Date().toISOString() },
      { status: 200 }
    );
  } catch (error) {
    captureError(error, { probe: 'readiness', check: 'db' });
    return NextResponse.json(
      { status: 'degraded', checks: { db: 'fail' }, time: new Date().toISOString() },
      { status: 503 }
    );
  }
}
