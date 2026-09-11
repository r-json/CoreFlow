/**
 * Reconciliation scheduling and run lifecycle.
 *
 * ── Why there is no job framework here ───────────────────────────────────────
 * CoreFlow deploys on Vercel, where there are no long-lived workers. Adding Redis
 * or a queue purely to own a cron tick would be infrastructure with no other
 * purpose, and one more thing that can be down. The lock lives in PostgreSQL,
 * which the application already depends on absolutely: if it is unavailable,
 * reconciliation could not run anyway.
 *
 * A run is therefore triggered externally (Vercel Cron, an operator, a test) and
 * this module guarantees the parts that matter: one run at a time per
 * organization, a heartbeat so a crashed holder does not block forever, and a
 * durable record of what each run examined.
 *
 * ── Overlap safety ───────────────────────────────────────────────────────────
 * Two concurrent runs over the same payments would both see the same
 * discrepancies and both try to correct them. The corrections are individually
 * idempotent — `applyTransition` is a compare-and-swap — so the danger is not a
 * double payment but duplicated findings and wasted RPC. The lock is a unique
 * partial index on (orgId) for RUNNING rows, so the database refuses the second
 * run rather than the application hoping it noticed.
 */

import { randomUUID } from 'crypto';
import { RunStatus } from '@prisma/client';
import { createRpcVerifier, type ChainVerifier } from './chain-verifier';
import {
  reconcileOrganization,
  reconcileFailedTransactions,
  reportUnattributedEscrows,
  type ReconcileOptions,
  type RunSummary,
} from './reconciler';

/**
 * A run whose heartbeat is older than this is considered abandoned and may be
 * taken over. Long enough that a slow-but-alive run is not stolen from; short
 * enough that a crash does not block reconciliation for an operational age.
 */
export const STALE_RUN_AFTER_MS = 10 * 60 * 1000; // 10 minutes

/** How often a running pass refreshes its heartbeat. */
export const HEARTBEAT_INTERVAL_MS = 30 * 1000;

export type StartResult =
  | { started: true; runId: string; correlationId: string }
  | { started: false; reason: 'ALREADY_RUNNING'; runId: string; startedAt: Date };

/**
 * Claim the reconciliation lock for an organization.
 *
 * Stale runs are marked STALE first, which both releases the lock and leaves a
 * record that a run died — silently reusing the lock would erase the evidence that
 * reconciliation has been failing.
 */
export async function startRun(
  db: any,
  orgId: string,
  scope: string,
  meta: { contractId?: string; network?: string } = {}
): Promise<StartResult> {
  const cutoff = new Date(Date.now() - STALE_RUN_AFTER_MS);

  const stale = await db.reconciliationRun.updateMany({
    where: { orgId, status: RunStatus.RUNNING, heartbeatAt: { lt: cutoff } },
    data: {
      status: RunStatus.STALE,
      completedAt: new Date(),
      errorMessage:
        'Abandoned: the worker stopped reporting a heartbeat. The lock was ' +
        'reclaimed by a later run.',
    },
  });
  if (stale.count > 0) {
    console.warn(`[reconcile] reclaimed ${stale.count} stale run lock(s) for ${orgId}`);
  }

  const active = await db.reconciliationRun.findFirst({
    where: { orgId, status: RunStatus.RUNNING },
    select: { id: true, startedAt: true },
  });
  if (active) {
    return {
      started: false,
      reason: 'ALREADY_RUNNING',
      runId: active.id,
      startedAt: active.startedAt,
    };
  }

  const correlationId = `rec_${randomUUID()}`;
  try {
    const run = await db.reconciliationRun.create({
      data: {
        orgId,
        correlationId,
        scope,
        contractId: meta.contractId ?? null,
        network: meta.network ?? null,
        status: RunStatus.RUNNING,
        // Set explicitly rather than relying on the column default: this value IS
        // the lock's liveness signal, and a lock should not depend on something
        // else to initialise the field that decides whether it is alive.
        startedAt: new Date(),
        heartbeatAt: new Date(),
      },
    });
    return { started: true, runId: run.id, correlationId };
  } catch (e: any) {
    // The unique partial index rejected us: another worker won the race between
    // the check above and this insert.
    if (e?.code === 'P2002') {
      const other = await db.reconciliationRun.findFirst({
        where: { orgId, status: RunStatus.RUNNING },
        select: { id: true, startedAt: true },
      });
      return {
        started: false,
        reason: 'ALREADY_RUNNING',
        runId: other?.id ?? 'unknown',
        startedAt: other?.startedAt ?? new Date(),
      };
    }
    throw e;
  }
}

export async function heartbeat(db: any, runId: string): Promise<void> {
  await db.reconciliationRun.updateMany({
    where: { id: runId, status: RunStatus.RUNNING },
    data: { heartbeatAt: new Date() },
  });
}

async function finishRun(
  db: any,
  runId: string,
  status: RunStatus,
  tally: Partial<RunSummary> & { errorMessage?: string }
): Promise<void> {
  await db.reconciliationRun.update({
    where: { id: runId },
    data: {
      status,
      completedAt: new Date(),
      heartbeatAt: new Date(),
      escrowsExamined: tally.escrowsExamined ?? 0,
      paymentsExamined: tally.paymentsExamined ?? 0,
      agreed: tally.agreed ?? 0,
      mismatched: tally.mismatched ?? 0,
      unreadable: tally.unreadable ?? 0,
      chainAhead: tally.chainAhead ?? 0,
      databaseAhead: tally.databaseAhead ?? 0,
      findingsOpened: tally.findingsOpened ?? 0,
      correctionsApplied: tally.correctionsApplied ?? 0,
      errorMessage: tally.errorMessage ?? null,
    },
  });
}

/**
 * Run a full reconciliation pass for one organization.
 *
 * A failure still completes the run record, marked FAILED with the error. A run
 * that simply stops existing is indistinguishable from one that never started, and
 * "no findings" would then read as health.
 */
export async function runReconciliation(
  db: any,
  orgId: string,
  opts: ReconcileOptions & { verifier?: ChainVerifier; scope?: string } = {}
): Promise<RunSummary | { skipped: true; reason: 'ALREADY_RUNNING'; runId: string }> {
  const verifier = opts.verifier ?? createRpcVerifier();
  const scope = opts.scope ?? 'organization';

  const claim = await startRun(db, orgId, scope, {
    contractId: opts.contractId,
    network: opts.network,
  });
  if (!claim.started) {
    console.info(`[reconcile] skipped ${orgId}: run ${claim.runId} already in progress`);
    return { skipped: true, reason: 'ALREADY_RUNNING', runId: claim.runId };
  }

  const run = { id: claim.runId, correlationId: claim.correlationId };
  const beat = setInterval(() => void heartbeat(db, run.id).catch(() => {}), HEARTBEAT_INTERVAL_MS);

  try {
    const tally = await reconcileOrganization(db, verifier, orgId, run, opts);

    const txCheck = await reconcileFailedTransactions(db, verifier, orgId, run);
    tally.findingsOpened += txCheck.findingsOpened;

    if (opts.contractId && opts.network) {
      const orphans = await reportUnattributedEscrows(db, orgId, run, {
        contractId: opts.contractId,
        network: opts.network,
      });
      tally.findingsOpened += orphans.findingsOpened;
    }

    await finishRun(db, run.id, RunStatus.COMPLETED, tally);

    console.info(
      `[reconcile ${run.correlationId}] completed: ` +
      `${tally.paymentsExamined} payments, ${tally.agreed} agreed, ` +
      `${tally.mismatched} mismatched, ${tally.unreadable} unreadable, ` +
      `${tally.findingsOpened} findings opened, ${tally.correctionsApplied} corrections`
    );

    return {
      runId: run.id,
      correlationId: run.correlationId,
      status: RunStatus.COMPLETED,
      ...tally,
    };
  } catch (e: any) {
    const message = e?.message ?? String(e);
    console.error(`[reconcile ${run.correlationId}] FAILED: ${message}`);
    await finishRun(db, run.id, RunStatus.FAILED, { errorMessage: message }).catch(() => {});
    return {
      runId: run.id,
      correlationId: run.correlationId,
      status: RunStatus.FAILED,
      escrowsExamined: 0, paymentsExamined: 0, agreed: 0, mismatched: 0,
      unreadable: 0, chainAhead: 0, databaseAhead: 0,
      findingsOpened: 0, correctionsApplied: 0,
      errorMessage: message,
    };
  } finally {
    clearInterval(beat);
  }
}

/** Operational health for one organization, for the reconciliation screen. */
export interface ReconciliationHealth {
  lastRun: {
    id: string;
    correlationId: string;
    status: RunStatus;
    startedAt: Date;
    completedAt: Date | null;
    paymentsExamined: number;
    agreed: number;
    mismatched: number;
    unreadable: number;
    findingsOpened: number;
    correctionsApplied: number;
    errorMessage: string | null;
  } | null;
  openFindings: number;
  criticalFindings: number;
  /** How long the oldest unresolved finding has been open, in hours. */
  oldestUnresolvedHours: number | null;
  /** True when the last run did not complete, or there has never been one. */
  degraded: boolean;
  degradedReason?: string;
}

export async function reconciliationHealth(
  db: any,
  orgId: string
): Promise<ReconciliationHealth> {
  const lastRun = await db.reconciliationRun.findFirst({
    where: { orgId },
    orderBy: { startedAt: 'desc' },
  });

  const [openFindings, criticalFindings, oldest] = await Promise.all([
    db.reconciliationFinding.count({ where: { orgId, status: { not: 'RESOLVED' } } }),
    db.reconciliationFinding.count({
      where: { orgId, status: { not: 'RESOLVED' }, severity: 'CRITICAL' },
    }),
    db.reconciliationFinding.findFirst({
      where: { orgId, status: { not: 'RESOLVED' } },
      orderBy: { detectedAt: 'asc' },
      select: { detectedAt: true },
    }),
  ]);

  let degraded = false;
  let degradedReason: string | undefined;

  if (!lastRun) {
    degraded = true;
    degradedReason = 'Reconciliation has never run for this organization.';
  } else if (lastRun.status === RunStatus.FAILED) {
    degraded = true;
    degradedReason = `The last reconciliation run failed: ${lastRun.errorMessage ?? 'unknown error'}`;
  } else if (lastRun.status === RunStatus.STALE) {
    degraded = true;
    degradedReason = 'The last reconciliation run was abandoned before finishing.';
  } else if (lastRun.status === RunStatus.RUNNING) {
    const age = Date.now() - new Date(lastRun.heartbeatAt).getTime();
    if (age > STALE_RUN_AFTER_MS) {
      degraded = true;
      degradedReason = 'A reconciliation run appears to have stopped responding.';
    }
  }

  return {
    lastRun: lastRun
      ? {
          id: lastRun.id,
          correlationId: lastRun.correlationId,
          status: lastRun.status,
          startedAt: lastRun.startedAt,
          completedAt: lastRun.completedAt,
          paymentsExamined: lastRun.paymentsExamined,
          agreed: lastRun.agreed,
          mismatched: lastRun.mismatched,
          unreadable: lastRun.unreadable,
          findingsOpened: lastRun.findingsOpened,
          correctionsApplied: lastRun.correctionsApplied,
          errorMessage: lastRun.errorMessage,
        }
      : null,
    openFindings,
    criticalFindings,
    oldestUnresolvedHours: oldest
      ? Math.floor((Date.now() - new Date(oldest.detectedAt).getTime()) / 3_600_000)
      : null,
    degraded,
    degradedReason,
  };
}
