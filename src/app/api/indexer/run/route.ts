/**
 * GET /api/indexer/run
 *
 * Triggers one indexer pass. Intended to be called by Vercel Cron (which sends
 * `Authorization: Bearer $CRON_SECRET`) or manually with `?secret=INDEXER_SECRET`.
 * Not session-protected — this is a machine endpoint guarded by a shared secret.
 */

import { NextRequest, NextResponse } from 'next/server';
import { STELLAR_CONFIG } from '@/lib/config';
import { runIndexerFromRpc } from '@/lib/indexer/run';
import { captureError } from '@/lib/observability';
import { logger } from '@/lib/logger';

function isAuthorized(req: NextRequest): boolean {
  const secret = process.env.INDEXER_SECRET || process.env.CRON_SECRET;
  if (!secret) return false;
  // Only accept the secret via Authorization header — never query strings,
  // which leak into server access logs, proxy caches, and browser history.
  const header = req.headers.get('authorization');
  return header === `Bearer ${secret}`;
}

export async function GET(req: NextRequest) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (!STELLAR_CONFIG.contract.id) {
    return NextResponse.json({ ok: true, skipped: 'no contract configured' }, { status: 200 });
  }

  try {
    const result = await runIndexerFromRpc();
    logger.info('indexer_run', { ...result });
    return NextResponse.json({ ok: true, ...result }, { status: 200 });
  } catch (error) {
    captureError(error, { route: 'indexer/run' });
    return NextResponse.json({ error: 'Indexer run failed' }, { status: 500 });
  }
}
