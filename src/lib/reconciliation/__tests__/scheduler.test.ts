// @vitest-environment node
/**
 * Scheduler tests: locking, heartbeats, run records, health.
 *
 * The lock is also enforced by a PostgreSQL partial unique index
 * (`ReconciliationRun_one_running_per_org`), verified directly against the
 * database — see docs/evidence/REVIEWER_EVIDENCE.md. These tests cover the
 * application half: reclaiming an abandoned lock, and always closing out a run
 * record even when the pass throws.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { RunStatus, FindingSeverity, FindingStatus, FindingKind, PaymentState } from '@prisma/client';
import { createFakeDb, type FakeDb } from '@/lib/payments/__tests__/fake-db';
import {
  startRun, heartbeat, runReconciliation, reconciliationHealth,
  STALE_RUN_AFTER_MS,
} from '../scheduler';
import type { ChainVerifier } from '../chain-verifier';

const ORG = 'orgA';
let db: FakeDb;

const okVerifier: ChainVerifier = {
  async latestLedger() { return { ok: true, value: 100 }; },
  async readEscrow() { return { ok: false, error: { kind: 'NOT_FOUND', reason: 'none' } }; },
  async readTransfers() { return { ok: true, value: [] }; },
  async readTransactionSucceeded() { return { ok: true, value: false }; },
};

const runs = () => db.__tables.reconciliationRun.rows;

beforeEach(() => {
  db = createFakeDb();
  db.__tables.organization.rows.push({ id: ORG, name: 'A', slug: 'a' });
});

describe('lock acquisition', () => {
  it('starts a run and records a correlation id', async () => {
    const r = await startRun(db, ORG, 'organization');
    expect(r.started).toBe(true);
    if (r.started) {
      expect(r.correlationId).toMatch(/^rec_/);
      expect(runs()[0].status).toBe(RunStatus.RUNNING);
    }
  });

  it('refuses a second run while one is live', async () => {
    await startRun(db, ORG, 'organization');
    const second = await startRun(db, ORG, 'organization');
    expect(second.started).toBe(false);
    if (!second.started) expect(second.reason).toBe('ALREADY_RUNNING');
    expect(runs().filter((r) => r.status === RunStatus.RUNNING)).toHaveLength(1);
  });

  it('allows a run once the previous completed', async () => {
    const first = await startRun(db, ORG, 'organization');
    if (first.started) {
      runs().find((r) => r.id === first.runId)!.status = RunStatus.COMPLETED;
    }
    expect((await startRun(db, ORG, 'organization')).started).toBe(true);
  });

  it('does not block a different organization', async () => {
    db.__tables.organization.rows.push({ id: 'orgB', name: 'B', slug: 'b' });
    await startRun(db, ORG, 'organization');
    expect((await startRun(db, 'orgB', 'organization')).started).toBe(true);
  });
});

describe('stale lock reclaim', () => {
  it('reclaims a lock whose holder stopped reporting', async () => {
    // Otherwise one crashed worker blocks reconciliation forever, and the absence
    // of findings reads as health.
    const first = await startRun(db, ORG, 'organization');
    expect(first.started).toBe(true);
    const row = runs()[0];
    row.heartbeatAt = new Date(Date.now() - STALE_RUN_AFTER_MS - 1000);

    const second = await startRun(db, ORG, 'organization');

    expect(second.started).toBe(true);
    // The dead run is marked STALE, not deleted: that a run died is evidence.
    expect(row.status).toBe(RunStatus.STALE);
    expect(row.errorMessage).toMatch(/stopped reporting a heartbeat/i);
    expect(row.completedAt).toBeTruthy();
  });

  it('does not steal a lock from a run that is still reporting', async () => {
    const first = await startRun(db, ORG, 'organization');
    if (first.started) await heartbeat(db, first.runId);
    const second = await startRun(db, ORG, 'organization');
    expect(second.started).toBe(false);
  });

  it('refreshes the heartbeat only for RUNNING runs', async () => {
    const r = await startRun(db, ORG, 'organization');
    if (!r.started) throw new Error('expected start');
    runs()[0].status = RunStatus.COMPLETED;
    const before = runs()[0].heartbeatAt;
    await heartbeat(db, r.runId);
    expect(runs()[0].heartbeatAt).toBe(before);
  });
});

describe('run lifecycle', () => {
  it('completes the run record with counters', async () => {
    const result = await runReconciliation(db, ORG, { verifier: okVerifier });
    expect('runId' in result).toBe(true);
    if (!('runId' in result)) return;
    expect(result.status).toBe(RunStatus.COMPLETED);
    const row = runs()[0];
    expect(row.status).toBe(RunStatus.COMPLETED);
    expect(row.completedAt).toBeTruthy();
  });

  it('skips rather than overlapping when a run is in progress', async () => {
    await startRun(db, ORG, 'organization');
    const result = await runReconciliation(db, ORG, { verifier: okVerifier });
    expect('skipped' in result).toBe(true);
    if ('skipped' in result) expect(result.reason).toBe('ALREADY_RUNNING');
  });

  it('closes out the run as FAILED when the pass throws', async () => {
    // A run that simply stops existing is indistinguishable from one that never
    // started, and "no findings" would then read as health.
    const exploding: ChainVerifier = {
      ...okVerifier,
      async readEscrow() { throw new Error('rpc exploded'); },
    };
    db.__tables.escrow.rows.push({
      id: 'e1', orgId: ORG, onChainId: 1, contractId: 'C', network: 'testnet',
      managerAddress: 'GM', financeApproverAddress: 'GF', assetDecimals: 7,
      createdAt: new Date(),
    });

    const result = await runReconciliation(db, ORG, { verifier: exploding });

    if (!('runId' in result)) throw new Error('expected a run');
    expect(result.status).toBe(RunStatus.FAILED);
    expect(result.errorMessage).toMatch(/rpc exploded/);
    const row = runs()[0];
    expect(row.status).toBe(RunStatus.FAILED);
    expect(row.completedAt).toBeTruthy();
    expect(row.errorMessage).toMatch(/rpc exploded/);
  });

  it('releases the lock after a failure so the next run can proceed', async () => {
    const exploding: ChainVerifier = {
      ...okVerifier,
      async readEscrow() { throw new Error('boom'); },
    };
    db.__tables.escrow.rows.push({
      id: 'e1', orgId: ORG, onChainId: 1, contractId: 'C', network: 'testnet',
      managerAddress: 'GM', financeApproverAddress: 'GF', assetDecimals: 7,
      createdAt: new Date(),
    });
    await runReconciliation(db, ORG, { verifier: exploding });
    const next = await runReconciliation(db, ORG, { verifier: okVerifier });
    expect('runId' in next).toBe(true);
  });

  it('threads one correlation id through the whole run', async () => {
    const result = await runReconciliation(db, ORG, { verifier: okVerifier });
    if (!('runId' in result)) throw new Error('expected a run');
    expect(runs()[0].correlationId).toBe(result.correlationId);
  });
});

describe('health reporting', () => {
  function seedFinding(overrides: Record<string, unknown> = {}) {
    db.__tables.reconciliationFinding.rows.push({
      id: `f${db.__tables.reconciliationFinding.rows.length}`,
      orgId: ORG, kind: FindingKind.DB_PAID_CHAIN_NOT,
      status: FindingStatus.OPEN, severity: FindingSeverity.CRITICAL,
      detectedAt: new Date(), lastObservedAt: new Date(), observationCount: 1,
      ...overrides,
    });
  }

  it('reports degraded when reconciliation has never run', async () => {
    // Silence is not health.
    const h = await reconciliationHealth(db, ORG);
    expect(h.lastRun).toBeNull();
    expect(h.degraded).toBe(true);
    expect(h.degradedReason).toMatch(/never run/i);
  });

  it('reports degraded after a failed run', async () => {
    await runReconciliation(db, ORG, {
      verifier: { ...okVerifier, async readEscrow() { throw new Error('x'); } },
    });
    db.__tables.escrow.rows.push({
      id: 'e1', orgId: ORG, onChainId: 1, contractId: 'C', network: 'testnet',
      managerAddress: 'GM', financeApproverAddress: 'GF', assetDecimals: 7, createdAt: new Date(),
    });
    runs()[0].status = RunStatus.FAILED;
    runs()[0].errorMessage = 'x';

    const h = await reconciliationHealth(db, ORG);
    expect(h.degraded).toBe(true);
    expect(h.degradedReason).toMatch(/failed/i);
  });

  it('reports degraded when a run appears to have stopped responding', async () => {
    await startRun(db, ORG, 'organization');
    runs()[0].heartbeatAt = new Date(Date.now() - STALE_RUN_AFTER_MS - 1);
    const h = await reconciliationHealth(db, ORG);
    expect(h.degraded).toBe(true);
    expect(h.degradedReason).toMatch(/stopped responding/i);
  });

  it('is not degraded after a clean completed run', async () => {
    await runReconciliation(db, ORG, { verifier: okVerifier });
    const h = await reconciliationHealth(db, ORG);
    expect(h.degraded).toBe(false);
    expect(h.lastRun?.status).toBe(RunStatus.COMPLETED);
  });

  it('counts open and critical findings separately', async () => {
    seedFinding();
    seedFinding({ severity: FindingSeverity.MEDIUM, kind: FindingKind.CHAIN_PAID_DB_NOT });
    seedFinding({ status: FindingStatus.RESOLVED, resolvedAt: new Date() });

    const h = await reconciliationHealth(db, ORG);
    expect(h.openFindings).toBe(2);
    expect(h.criticalFindings).toBe(1);
  });

  it('reports how long the oldest unresolved finding has been open', async () => {
    seedFinding({ detectedAt: new Date(Date.now() - 5 * 3_600_000) });
    const h = await reconciliationHealth(db, ORG);
    expect(h.oldestUnresolvedHours).toBeGreaterThanOrEqual(4);
  });

  it('does not count another organization’s findings', async () => {
    db.__tables.organization.rows.push({ id: 'orgB', name: 'B', slug: 'b' });
    db.__tables.reconciliationFinding.rows.push({
      id: 'fB', orgId: 'orgB', kind: FindingKind.DB_PAID_CHAIN_NOT,
      status: FindingStatus.OPEN, severity: FindingSeverity.CRITICAL,
      detectedAt: new Date(), lastObservedAt: new Date(), observationCount: 1,
    });
    const h = await reconciliationHealth(db, ORG);
    expect(h.openFindings).toBe(0);
    expect(h.criticalFindings).toBe(0);
  });
});
