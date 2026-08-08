/**
 * GET /api/admin/audit-logs
 *
 * Lists audit log entries for the Admin Audit Log viewer.
 * Supports optional filtering by action type and pagination.
 *
 * Restricted to ADMIN role only.
 */

import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/db/prisma';
import { getUserFromRequest, isAdmin } from '@/lib/auth';

export async function GET(request: NextRequest) {
  const user = await getUserFromRequest(request);
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (!isAdmin(user)) {
    return NextResponse.json(
      { error: 'Forbidden: ADMIN role required' },
      { status: 403 }
    );
  }

  try {
    const { searchParams } = new URL(request.url);
    const limit = Math.min(parseInt(searchParams.get('limit') || '50', 10), 200);
    const cursor = searchParams.get('cursor');
    const action = searchParams.get('action');

    const whereClause: any = {};
    if (action) {
      whereClause.action = action;
    }

    if (cursor) {
      whereClause.id = { lt: cursor };
    }

    const logs = await prisma.auditLog.findMany({
      where: whereClause,
      take: limit + 1,
      orderBy: { createdAt: 'desc' },
    });

    const hasNextPage = logs.length > limit;
    const items = hasNextPage ? logs.slice(0, limit) : logs;
    const nextCursor = hasNextPage ? items[items.length - 1].id : null;

    // Parse metadata JSON for each log entry
    const mappedLogs = items.map((log) => ({
      id: log.id,
      action: log.action,
      actor: log.actor,
      target: log.target,
      metadata: log.metadata ? JSON.parse(log.metadata) : null,
      createdAt: log.createdAt.toISOString(),
    }));

    return NextResponse.json(
      {
        logs: mappedLogs,
        pagination: {
          hasNextPage,
          nextCursor,
        },
      },
      { status: 200 }
    );
  } catch (error) {
    console.error('[admin/audit-logs] GET error:', error);
    return NextResponse.json(
      { error: 'Failed to fetch audit logs' },
      { status: 500 }
    );
  }
}