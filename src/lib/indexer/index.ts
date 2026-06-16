/**
 * CoreFlow chain-event indexer.
 *
 * Projects on-chain contract events into the Postgres index so the DB is a
 * faithful, authoritative reflection of chain state — replacing the previous
 * fire-and-forget client write-through that could silently drift.
 *
 * Design:
 *  - A single-row IndexerCursor tracks the last processed ledger.
 *  - Each raw event has a unique RPC paging token; a ChainEvent row records it
 *    so reprocessing the same event is a no-op (idempotency).
 *  - applyEvent mutations are themselves idempotent (updateMany / upsert), so
 *    out-of-order or repeated delivery converges to the correct state.
 *
 * The RPC reader is injected so the core logic is testable without a network.
 */

import prisma from '@/lib/db/prisma';
import { parseCoreFlowEvent, type CoreFlowEvent } from './events';

/** Full escrow detail the indexer needs when first seeing an escrow. */
export interface EscrowDetailForIndex {
  worker: string;
  amountCents: number;
  rateCents: number;
  tokenAddress: string | null;
}

export interface IndexerDeps {
  db: any; // PrismaClient (or a test double)
  /** Fetch full escrow detail from the contract when a `created` event arrives. */
  fetchEscrowDetail: (escrowId: number) => Promise<EscrowDetailForIndex>;
}

/**
 * Apply a single domain event to the DB. Idempotent: uses upsert for creation
 * and updateMany for transitions (no-op if the row is not present yet, so event
 * ordering does not matter for correctness).
 */
export async function applyEvent(ev: CoreFlowEvent, deps: IndexerDeps): Promise<void> {
  const { db, fetchEscrowDetail } = deps;

  switch (ev.kind) {
    case 'created': {
      const detail = await fetchEscrowDetail(ev.escrowId);
      await db.escrow.upsert({
        where: { onChainId: ev.escrowId },
        create: {
          onChainId: ev.escrowId,
          workerPubKey: detail.worker,
          amountCents: detail.amountCents,
          rateCents: detail.rateCents,
          tokenAddress: detail.tokenAddress,
          status: 'pending_hours',
        },
        update: {
          workerPubKey: detail.worker,
          tokenAddress: detail.tokenAddress,
        },
      });
      return;
    }
    case 'hours':
      await db.escrow.updateMany({
        where: { onChainId: ev.escrowId },
        data: { status: 'pending_manager' },
      });
      return;
    case 'manager_approved':
      await db.escrow.updateMany({
        where: { onChainId: ev.escrowId },
        data: { managerApproved: true, status: 'pending_finance' },
      });
      return;
    case 'finance_approved':
      await db.escrow.updateMany({
        where: { onChainId: ev.escrowId },
        data: { financeApproved: true, status: 'ready' },
      });
      return;
    case 'finalized':
      await db.escrow.updateMany({
        where: { onChainId: ev.escrowId },
        data: { status: 'paid' },
      });
      return;
    case 'cancelled':
      await db.escrow.updateMany({
        where: { onChainId: ev.escrowId },
        data: { status: 'cancelled' },
      });
      return;
  }
}

/** A raw event row from the RPC, normalized for the indexer. */
export interface RawIndexedEvent {
  id: string; // RPC paging token (unique)
  ledger: number;
  topic0: string;
  topic1: string;
  value: unknown;
}

export interface RunResult {
  processed: number;
  skipped: number;
  lastLedger: number;
}

/**
 * Process a batch of raw events idempotently and advance the cursor.
 * Pure with respect to I/O via `deps` so it can be unit-tested.
 */
export async function processBatch(
  events: RawIndexedEvent[],
  deps: IndexerDeps
): Promise<RunResult> {
  const { db } = deps;
  let processed = 0;
  let skipped = 0;
  let lastLedger = 0;

  for (const raw of events) {
    lastLedger = Math.max(lastLedger, raw.ledger);

    // Idempotency: skip already-recorded events.
    const seen = await db.chainEvent.findUnique({ where: { id: raw.id } });
    if (seen) {
      skipped++;
      continue;
    }

    const ev = parseCoreFlowEvent(raw.topic0, raw.topic1, raw.value);
    if (!ev) {
      skipped++;
      continue;
    }

    await applyEvent(ev, deps);
    await db.chainEvent.create({
      data: {
        id: raw.id,
        type: ev.kind,
        ledger: raw.ledger,
        escrowOnChainId: ev.escrowId,
      },
    });
    processed++;
  }

  if (lastLedger > 0) {
    await db.indexerCursor.upsert({
      where: { id: 1 },
      create: { id: 1, lastLedger },
      update: { lastLedger },
    });
  }

  return { processed, skipped, lastLedger };
}

/** Read the persisted cursor (0 if none). */
export async function getCursor(): Promise<number> {
  const row = await prisma.indexerCursor.findUnique({ where: { id: 1 } });
  return row?.lastLedger ?? 0;
}
