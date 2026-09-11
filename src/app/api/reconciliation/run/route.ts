/**
 * POST /api/reconciliation/run — the scheduled reconciliation trigger.
 *
 * ── Why this is not a user endpoint ──────────────────────────────────────────
 * This runs across organizations, so it cannot be authorized by organization
 * membership. It is protected by a shared secret the way the indexer trigger is,
 * and is intended for a platform scheduler (Vercel Cron) — not for people.
 * Operators trigger a single-organization run through
 * `POST /api/organizations/:id/reconciliation`, which IS membership-scoped.
 *
 * Each organization is reconciled in its own run, with its own lock. One tenant's
 * RPC trouble must not stop another's reconciliation from happening.
 */

import { NextRequest, NextResponse } from 'next/server';
import { timingSafeEqual, createHash } from 'crypto';
import prisma from '@/lib/db/prisma';
import { STELLAR_CONFIG } from '@/lib/config';
import { runReconciliation } from '@/lib/reconciliation/scheduler';
import { rateLimit, clientIp } from '@/lib/ratelimit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
/** Reconciliation is RPC-bound; give it room without running unbounded. */
export const maxDuration = 300;

const MIN_SECRET_LENGTH = 16;

function secretsMatch(provided: string, expected: string): boolean {
  const a = createHash('sha256').update(provided).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

export async function POST(request: NextRequest) {
  // Vercel Cron sends `Authorization: Bearer $CRON_SECRET`.
  const expected = process.env.CRON_SECRET || process.env.INDEXER_SECRET || '';
  if (!expected || expected.trim().length < MIN_SECRET_LENGTH) {
    // A short or absent secret is not protection. Refuse to expose the endpoint
    // rather than running on a guessable credential.
    return NextResponse.json({ error: 'Not available' }, { status: 404 });
  }

  const rl = rateLimit(`reconcile-trigger:${clientIp(request)}`, 10, 60_000);
  if (!rl.ok) return NextResponse.json({ error: 'Not available' }, { status: 404 });

  const header = request.headers.get('authorization') ?? '';
  const bearer = header.startsWith('Bearer ') ? header.slice(7) : '';
  const provided = bearer || request.headers.get('x-cron-secret') || '';
  if (!provided || !secretsMatch(provided, expected)) {
    return NextResponse.json({ error: 'Not available' }, { status: 404 });
  }

  const url = new URL(request.url);
  const onlyOrg = url.searchParams.get('orgId');
  const maxEscrows = Math.min(
    Math.max(parseInt(url.searchParams.get('maxEscrows') || '50', 10) || 50, 1),
    500
  );

  const orgs = await prisma.organization.findMany({
    where: onlyOrg ? { id: onlyOrg } : {},
    select: { id: true, slug: true },
    // Bounded: a platform-wide sweep must not grow without limit as tenants are
    // added. The scheduler runs again shortly; unfinished tenants are picked up
    // by the next tick rather than making one invocation unbounded.
    take: 50,
  });

  const results: unknown[] = [];
  for (const org of orgs) {
    try {
      const r = await runReconciliation(prisma, org.id, {
        contractId: STELLAR_CONFIG.contract.id || undefined,
        network: STELLAR_CONFIG.contract.network,
        maxEscrows,
      });
      results.push({ orgId: org.id, slug: org.slug, ...r });
    } catch (e: any) {
      // One tenant's failure must not abort the sweep.
      console.error(`[reconcile] org ${org.id} failed: ${e?.message}`);
      results.push({ orgId: org.id, slug: org.slug, error: e?.message ?? 'failed' });
    }
  }

  return NextResponse.json({ organizations: orgs.length, results });
}
