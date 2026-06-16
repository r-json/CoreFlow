// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import { parseCoreFlowEvent } from '../events';
import { processBatch, type RawIndexedEvent, type IndexerDeps } from '../index';

describe('parseCoreFlowEvent', () => {
  it('maps each contract topic pair to a domain event', () => {
    expect(parseCoreFlowEvent('escrow', 'created', [5n, 'GM', 13000n])).toEqual({
      kind: 'created',
      escrowId: 5,
    });
    expect(parseCoreFlowEvent('hours', 'submit', [5n, 0n, 40n])).toEqual({
      kind: 'hours',
      escrowId: 5,
      paymentId: 0,
      hours: 40,
    });
    expect(parseCoreFlowEvent('approve', 'manager', 5n)).toEqual({
      kind: 'manager_approved',
      escrowId: 5,
    });
    expect(parseCoreFlowEvent('approve', 'finance', 5n)).toEqual({
      kind: 'finance_approved',
      escrowId: 5,
    });
    expect(parseCoreFlowEvent('payment', 'final', [5n, 13000n, 1n])).toEqual({
      kind: 'finalized',
      escrowId: 5,
    });
    expect(parseCoreFlowEvent('escrow', 'cancel', 5n)).toEqual({
      kind: 'cancelled',
      escrowId: 5,
    });
  });

  it('returns null for unrelated events', () => {
    expect(parseCoreFlowEvent('transfer', 'token', [1n])).toBeNull();
  });
});

/** Minimal in-memory Prisma double for the indexer. */
function makeDb() {
  const escrows = new Map<number, Record<string, unknown>>();
  const chainEvents = new Map<string, unknown>();
  let cursor: { lastLedger: number } | null = null;

  return {
    escrow: {
      upsert: vi.fn(async ({ where, create, update }: any) => {
        const ex = escrows.get(where.onChainId);
        if (ex) Object.assign(ex, update);
        else escrows.set(where.onChainId, { ...create });
      }),
      updateMany: vi.fn(async ({ where, data }: any) => {
        const ex = escrows.get(where.onChainId);
        if (ex) Object.assign(ex, data);
        return { count: ex ? 1 : 0 };
      }),
    },
    chainEvent: {
      findUnique: vi.fn(async ({ where }: any) => chainEvents.get(where.id) ?? null),
      create: vi.fn(async ({ data }: any) => {
        chainEvents.set(data.id, data);
      }),
    },
    indexerCursor: {
      upsert: vi.fn(async ({ update }: any) => {
        cursor = { lastLedger: update.lastLedger };
      }),
    },
    _state: { escrows, chainEvents, getCursor: () => cursor },
  };
}

const fullLifecycle: RawIndexedEvent[] = [
  { id: 'e1', ledger: 10, topic0: 'escrow', topic1: 'created', value: [1n, 'GM', 13000n] },
  { id: 'e2', ledger: 11, topic0: 'hours', topic1: 'submit', value: [1n, 0n, 40n] },
  { id: 'e3', ledger: 12, topic0: 'approve', topic1: 'manager', value: 1n },
  { id: 'e4', ledger: 13, topic0: 'approve', topic1: 'finance', value: 1n },
  { id: 'e5', ledger: 14, topic0: 'payment', topic1: 'final', value: [1n, 13000n, 1n] },
];

function deps(db: ReturnType<typeof makeDb>): IndexerDeps {
  return {
    db,
    fetchEscrowDetail: vi.fn(async () => ({
      worker: 'GWORKER',
      amountCents: 13000,
      rateCents: 250,
      tokenAddress: 'CTOKEN',
    })),
  };
}

describe('processBatch', () => {
  it('projects a full lifecycle to the correct final state', async () => {
    const db = makeDb();
    const result = await processBatch(fullLifecycle, deps(db));

    expect(result.processed).toBe(5);
    expect(result.skipped).toBe(0);
    expect(result.lastLedger).toBe(14);

    const escrow = db._state.escrows.get(1)!;
    expect(escrow.status).toBe('paid');
    expect(escrow.managerApproved).toBe(true);
    expect(escrow.financeApproved).toBe(true);
    expect(escrow.workerPubKey).toBe('GWORKER');
    expect(db._state.getCursor()).toEqual({ lastLedger: 14 });
  });

  it('is idempotent — reprocessing the same batch is a no-op', async () => {
    const db = makeDb();
    await processBatch(fullLifecycle, deps(db));
    const escrowAfterFirst = { ...db._state.escrows.get(1) };

    const second = await processBatch(fullLifecycle, deps(db));
    expect(second.processed).toBe(0);
    expect(second.skipped).toBe(5);
    expect(db._state.escrows.get(1)).toEqual(escrowAfterFirst);
  });

  it('skips unrecognized events without recording them', async () => {
    const db = makeDb();
    const result = await processBatch(
      [{ id: 'x1', ledger: 9, topic0: 'transfer', topic1: 'token', value: [1n] }],
      deps(db)
    );
    expect(result.processed).toBe(0);
    expect(result.skipped).toBe(1);
    expect(db._state.chainEvents.size).toBe(0);
  });
});
