/**
 * GET /api/admin/audit-logs — the caller's organization's audit trail.
 *
 * ── What changed and why ─────────────────────────────────────────────────────
 * This read the global, tenant-less `AuditLog` table, so any platform admin saw
 * every organization's activity: who approved what, for how much, for whom. An
 * audit trail is among the most sensitive data in the product — it names the
 * people holding approval authority — so it is now scoped to the caller's own
 * organization and served from the tenant-owned `AuditEvent` model.
 *
 * Legacy `AuditLog` rows are NOT exposed here. They predate organizations and
 * cannot be attributed to one; surfacing them to whichever tenant happened to ask
 * would be the leak this endpoint just closed.
 */

import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/db/prisma';
import { withTenant } from '@/lib/tenancy/http';

const MAX_LIMIT = 200;

export async function GET(request: NextRequest) {
  return withTenant(request, { permission: 'audit:read', parseBody: false }, async ({ ctx }) => {
    const url = new URL(request.url);
    const limit = Math.min(
      Math.max(parseInt(url.searchParams.get('limit') || '50', 10) || 50, 1),
      MAX_LIMIT
    );
    const type = url.searchParams.get('type');
    const actor = url.searchParams.get('actor');
    const cursor = url.searchParams.get('cursor');

    const events = await prisma.auditEvent.findMany({
      where: {
        // Scope is part of the query, never a check afterwards.
        orgId: ctx.orgId,
        ...(type ? { type } : {}),
        ...(actor ? { actorAddress: actor } : {}),
        ...(cursor ? { createdAt: { lt: new Date(cursor) } } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: limit + 1,
      select: {
        id: true, type: true, actorAddress: true, actorSystem: true,
        paymentId: true, batchId: true, escrowId: true,
        previousState: true, newState: true, txHash: true,
        metadata: true, createdAt: true,
      },
    });

    const hasMore = events.length > limit;
    const page = hasMore ? events.slice(0, limit) : events;

    return NextResponse.json({
      organization: { id: ctx.orgId, name: ctx.orgName },
      logs: page.map((e) => ({
        id: e.id,
        action: e.type,
        // A machine actor is labelled as such, so an automated transition is
        // never read as a person's decision.
        actor: e.actorAddress ?? e.actorSystem ?? 'system',
        actorIsSystem: !e.actorAddress,
        paymentId: e.paymentId,
        batchId: e.batchId,
        escrowId: e.escrowId,
        previousState: e.previousState,
        newState: e.newState,
        txHash: e.txHash,
        metadata: e.metadata,
        createdAt: e.createdAt.toISOString(),
      })),
      nextCursor: hasMore ? page[page.length - 1].createdAt.toISOString() : null,
    });
  });
}
