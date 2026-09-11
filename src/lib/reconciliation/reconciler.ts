/**
 * Reconciliation: an independent correctness check on the projection.
 *
 * ── Authority ────────────────────────────────────────────────────────────────
 * The chain is authoritative for settlement. This database is authoritative for
 * workflow, tenancy and presentation. Where they disagree, the disagreement is
 * RECORDED; the losing side is not quietly rewritten, because overwriting it
 * destroys the only evidence the two ever diverged.
 *
 * ── Two corrections, and only two ────────────────────────────────────────────
 * CHAIN_AHEAD   chain proves settlement, projection is behind → advance to PAID.
 *               The money moved regardless of what we recorded.
 * CANCELLED     chain reports the escrow cancelled → mark cancelled.
 *
 * Everything else is reported and left alone. In particular DATABASE_AHEAD — a
 * payment we call PAID that the chain does not support — is NEVER reverted. PAID
 * is terminal in the state machine and stays so; the finding is the durable record
 * and the state machine is not weakened to permit an exit. A system that silently
 * un-pays a payment to look tidy has destroyed the evidence of its own worst bug.
 *
 * ── Independence ─────────────────────────────────────────────────────────────
 * Verification comes from `chain-verifier.ts`, which reads the TOKEN contract's
 * own transfer events and contract storage — not CoreFlow's events and not the
 * indexer's parser. See that file's header.
 */

import { PaymentState, FindingKind, FindingSeverity, FindingStatus, RunStatus } from '@prisma/client';
import { applyTransition } from '@/lib/payments/service';
import {
  CHAIN_STATUS,
  matchSettlementTransfer,
  findAmountMismatchedTransfers,
  countDuplicateSettlementsInSameTransaction,
  inferSettlementTransaction,
  type ChainVerifier,
  type ObservedTransfer,
} from './chain-verifier';

const RECONCILER = { kind: 'reconciler' as const, system: 'reconciler' };

/** Per-object outcome, for run counters. */
export type Outcome =
  | 'AGREED'
  | 'CHAIN_AHEAD'
  | 'DATABASE_AHEAD'
  | 'CHAIN_UNREADABLE'
  | 'MISMATCHED'
  | 'UNKNOWN_ON_CHAIN_OBJECT'
  | 'ORPHANED_DATABASE_OBJECT';

export interface ReconcileOptions {
  contractId?: string;
  network?: string;
  /** Cap on escrows examined in one run, so a run is bounded. */
  maxEscrows?: number;
  /** Oldest ledger to search for transfers. Bounds RPC work. */
  fromLedger?: number;
}

export interface RunSummary {
  runId: string;
  correlationId: string;
  status: RunStatus;
  escrowsExamined: number;
  paymentsExamined: number;
  agreed: number;
  mismatched: number;
  unreadable: number;
  chainAhead: number;
  databaseAhead: number;
  findingsOpened: number;
  correctionsApplied: number;
  errorMessage?: string;
}

/** Severity and remediation per finding kind, declared once. */
const FINDING_POLICY: Record<
  FindingKind,
  { severity: FindingSeverity; remediation: string }
> = {
  [FindingKind.DB_PAID_CHAIN_NOT]: {
    severity: FindingSeverity.CRITICAL,
    remediation:
      'CoreFlow is presenting this payment as settled and the chain does not ' +
      'support that. Do not rely on the payment record. Verify the transaction ' +
      'on the explorer, then either confirm settlement or treat the payment as ' +
      'unsettled and re-issue it.',
  },
  [FindingKind.FAILED_TX_ACTUALLY_SUCCEEDED]: {
    severity: FindingSeverity.CRITICAL,
    remediation:
      'A transaction recorded as failed actually succeeded. DO NOT RETRY this ' +
      'payment — doing so would pay twice. Confirm the settlement and correct the ' +
      'record instead.',
  },
  [FindingKind.AMOUNT_MISMATCH]: {
    severity: FindingSeverity.HIGH,
    remediation:
      'The amount that moved on-chain differs from the recorded amount. Establish ' +
      'which is correct from the transaction, then correct the payroll record and ' +
      'settle or recover the difference.',
  },
  [FindingKind.RECIPIENT_MISMATCH]: {
    severity: FindingSeverity.HIGH,
    remediation:
      'Funds reached a different address than recorded. Confirm the intended ' +
      'recipient before any further payment to this worker.',
  },
  [FindingKind.ASSET_MISMATCH]: {
    severity: FindingSeverity.HIGH,
    remediation: 'The settled asset differs from the recorded asset. Verify the transaction.',
  },
  [FindingKind.DUPLICATE_PAYMENT_EVENT]: {
    severity: FindingSeverity.HIGH,
    remediation:
      'More asset transfers were observed than this payment expects. Check whether ' +
      'the worker was paid twice before issuing anything further.',
  },
  [FindingKind.MISSING_PAYMENT_EVENT]: {
    severity: FindingSeverity.HIGH,
    remediation:
      'The contract reports this payment settled but no matching asset transfer ' +
      'was observed. Confirm on the explorer whether funds moved.',
  },
  [FindingKind.CHAIN_PAID_DB_NOT]: {
    severity: FindingSeverity.MEDIUM,
    remediation:
      'The chain settled this payment and the projection had not caught up. ' +
      'Usually self-correcting; if it persists, check the indexer is running.',
  },
  [FindingKind.MISSING_ON_CHAIN]: {
    severity: FindingSeverity.MEDIUM,
    remediation:
      'A recorded payment has no on-chain slot. Confirm the escrow was created ' +
      'as expected, then correct or remove the record.',
  },
  [FindingKind.ORPHAN_ON_CHAIN]: {
    severity: FindingSeverity.MEDIUM,
    remediation:
      'An on-chain payment has no database row. Re-run the indexer; if it stays ' +
      'orphaned, the escrow may have been created outside CoreFlow.',
  },
  [FindingKind.UNKNOWN_ON_CHAIN_OBJECT]: {
    severity: FindingSeverity.LOW,
    remediation:
      'An on-chain escrow belongs to no organization. CoreFlow will not guess an ' +
      'owner. If it is yours, claim it via the escrow claim endpoint using the ' +
      'wallet that created it.',
  },
  [FindingKind.CHAIN_UNREADABLE]: {
    severity: FindingSeverity.LOW,
    remediation:
      'Chain state could not be read, so nothing was verified. This is NOT a ' +
      'mismatch. It clears on the next successful run; investigate RPC health if ' +
      'it persists.',
  },
  [FindingKind.OTHER]: {
    severity: FindingSeverity.MEDIUM,
    remediation:
      'This discrepancy does not match any known category, so no automated ' +
      'guidance applies. Compare the payment record against the transaction on ' +
      'the explorer and escalate to engineering with the finding id — an ' +
      'unclassified finding usually means the taxonomy needs a new entry.',
  },
};

export function policyFor(kind: FindingKind) {
  return FINDING_POLICY[kind] ?? FINDING_POLICY[FindingKind.OTHER];
}

/**
 * Record a finding, or re-observe an existing unresolved one.
 *
 * Re-observing updates `lastObservedAt` and increments a counter rather than
 * inserting a duplicate. A queue that grows by one row per run per problem becomes
 * noise, and a noisy queue gets ignored — which is the same as having none.
 */
async function upsertFinding(
  db: any,
  input: {
    orgId: string;
    runId: string;
    kind: FindingKind;
    paymentId?: string | null;
    dbState?: string | null;
    chainState?: string | null;
    detail: string;
    txHash?: string | null;
    escrowOnChainId?: number | null;
    paymentIndex?: number | null;
    metadata?: Record<string, unknown>;
  }
): Promise<{ opened: boolean }> {
  const policy = policyFor(input.kind);

  // The identity of a finding is (kind, payment, escrow, SLOT). Omitting the slot
  // made every orphaned payment in one escrow collapse into a single finding, so a
  // batch with three unprojected payees reported one problem instead of three.
  const existing = await db.reconciliationFinding.findFirst({
    where: {
      orgId: input.orgId,
      kind: input.kind,
      paymentId: input.paymentId ?? null,
      escrowOnChainId: input.escrowOnChainId ?? null,
      paymentIndex: input.paymentIndex ?? null,
      status: { not: FindingStatus.RESOLVED },
    },
  });

  if (existing) {
    await db.reconciliationFinding.update({
      where: { id: existing.id },
      data: {
        runId: input.runId,
        lastObservedAt: new Date(),
        observationCount: { increment: 1 },
        // Evidence is refreshed; the operator's acknowledgement is not reset,
        // or acknowledging a persistent finding would be impossible.
        dbState: input.dbState ?? existing.dbState,
        chainState: input.chainState ?? existing.chainState,
        detail: input.detail,
      },
    });
    return { opened: false };
  }

  await db.reconciliationFinding.create({
    data: {
      orgId: input.orgId,
      runId: input.runId,
      kind: input.kind,
      status: FindingStatus.OPEN,
      severity: policy.severity,
      remediation: policy.remediation,
      paymentId: input.paymentId ?? null,
      dbState: input.dbState ?? null,
      chainState: input.chainState ?? null,
      detail: input.detail,
      txHash: input.txHash ?? null,
      escrowOnChainId: input.escrowOnChainId ?? null,
      paymentIndex: input.paymentIndex ?? null,
      // Set explicitly rather than leaning on the column default: this counter is
      // incremented by `upsertFinding`, and code that mutates a value should not
      // also depend on something else to initialise it.
      observationCount: 1,
      lastObservedAt: new Date(),
      metadata: (input.metadata ?? {}) as any,
    },
  });
  return { opened: true };
}

/**
 * Reconcile one organization.
 *
 * Scope is bounded (`maxEscrows`) so a run cannot grow unboundedly with the
 * tenant, and the run record is updated with a heartbeat so a crashed worker's
 * lock can be reclaimed rather than blocking reconciliation forever.
 */
export async function reconcileOrganization(
  db: any,
  verifier: ChainVerifier,
  orgId: string,
  run: { id: string; correlationId: string },
  opts: ReconcileOptions = {}
): Promise<Omit<RunSummary, 'runId' | 'correlationId' | 'status'>> {
  const tally = {
    escrowsExamined: 0, paymentsExamined: 0,
    agreed: 0, mismatched: 0, unreadable: 0,
    chainAhead: 0, databaseAhead: 0,
    findingsOpened: 0, correctionsApplied: 0,
  };

  const log = (msg: string) => console.info(`[reconcile ${run.correlationId}] ${msg}`);

  const escrows = await db.escrow.findMany({
    where: {
      orgId,
      onChainId: { not: null },
      ...(opts.contractId ? { contractId: opts.contractId } : {}),
      ...(opts.network ? { network: opts.network } : {}),
    },
    include: { payments: { orderBy: { onChainPaymentIndex: 'asc' } } },
    orderBy: { createdAt: 'desc' },
    take: opts.maxEscrows ?? 100,
  });

  /** Transfer events per asset, fetched once per run and reused. */
  const transferCache = new Map<string, ObservedTransfer[] | null>();
  async function transfersFor(assetContractId: string): Promise<ObservedTransfer[] | null> {
    if (transferCache.has(assetContractId)) return transferCache.get(assetContractId)!;
    const res = await verifier.readTransfers(assetContractId, { fromLedger: opts.fromLedger });
    const value = res.ok ? res.value : null;
    transferCache.set(assetContractId, value);
    if (!res.ok) log(`transfers unreadable for ${assetContractId}: ${res.error.reason}`);
    return value;
  }

  for (const escrow of escrows) {
    tally.escrowsExamined++;

    const chain = await verifier.readEscrow(escrow.onChainId);

    if (!chain.ok) {
      // Could not check. Explicitly NOT agreement, and explicitly not a mismatch.
      tally.unreadable++;
      const kind =
        chain.error.kind === 'NOT_FOUND'
          ? FindingKind.MISSING_ON_CHAIN
          : FindingKind.CHAIN_UNREADABLE;
      const r = await upsertFinding(db, {
        orgId, runId: run.id, kind,
        escrowOnChainId: escrow.onChainId,
        dbState: `${escrow.payments.length} payment(s) recorded`,
        chainState: chain.error.kind === 'NOT_FOUND' ? 'escrow absent' : 'unreadable',
        detail:
          chain.error.kind === 'NOT_FOUND'
            ? `Escrow ${escrow.onChainId} does not exist on ${escrow.network}.`
            : `Escrow ${escrow.onChainId} could not be read: ${chain.error.reason}. ` +
              'Nothing was verified for its payments.',
        metadata: { escrowId: escrow.id, reason: chain.error.reason },
      });
      if (r.opened) tally.findingsOpened++;
      continue;
    }

    const byIndex = new Map(chain.value.payments.map((p) => [p.index, p]));

    // On-chain slots with no database row: invisible in the product.
    for (const cp of chain.value.payments) {
      if (escrow.payments.some((p: any) => p.onChainPaymentIndex === cp.index)) continue;
      const r = await upsertFinding(db, {
        orgId, runId: run.id, kind: FindingKind.ORPHAN_ON_CHAIN,
        escrowOnChainId: escrow.onChainId, paymentIndex: cp.index,
        chainState: `status=${cp.status}`,
        detail:
          `Escrow ${escrow.onChainId} payment ${cp.index} exists on-chain but has ` +
          'no database row.',
        metadata: { worker: cp.worker, amountBaseUnits: cp.amountBaseUnits.toString() },
      });
      if (r.opened) tally.findingsOpened++;
      tally.mismatched++;
    }

    for (const p of escrow.payments) {
      tally.paymentsExamined++;
      const cp = p.onChainPaymentIndex === null ? undefined : byIndex.get(p.onChainPaymentIndex);

      if (!cp) {
        const r = await upsertFinding(db, {
          orgId, runId: run.id, kind: FindingKind.MISSING_ON_CHAIN,
          paymentId: p.id, escrowOnChainId: escrow.onChainId,
          paymentIndex: p.onChainPaymentIndex,
          dbState: p.state,
          detail:
            `Payment references escrow ${escrow.onChainId} slot ` +
            `${p.onChainPaymentIndex}, which does not exist on-chain.`,
        });
        if (r.opened) tally.findingsOpened++;
        tally.mismatched++;
        continue;
      }

      // ── Identity checks, independent of state ──
      let identityMismatch = false;
      if (p.recipientAddress !== cp.worker) {
        const r = await upsertFinding(db, {
          orgId, runId: run.id, kind: FindingKind.RECIPIENT_MISMATCH,
          paymentId: p.id, escrowOnChainId: escrow.onChainId, paymentIndex: cp.index,
          dbState: p.recipientAddress, chainState: cp.worker,
          detail: 'Recorded recipient differs from the on-chain recipient.',
        });
        if (r.opened) tally.findingsOpened++;
        identityMismatch = true;
      }
      if (p.amountBaseUnits !== cp.amountBaseUnits) {
        const r = await upsertFinding(db, {
          orgId, runId: run.id, kind: FindingKind.AMOUNT_MISMATCH,
          paymentId: p.id, escrowOnChainId: escrow.onChainId, paymentIndex: cp.index,
          dbState: p.amountBaseUnits.toString(), chainState: cp.amountBaseUnits.toString(),
          detail: 'Recorded amount differs from the on-chain amount.',
        });
        if (r.opened) tally.findingsOpened++;
        identityMismatch = true;
      }
      if (p.assetContractId && p.assetContractId !== cp.token) {
        const r = await upsertFinding(db, {
          orgId, runId: run.id, kind: FindingKind.ASSET_MISMATCH,
          paymentId: p.id, escrowOnChainId: escrow.onChainId, paymentIndex: cp.index,
          dbState: p.assetContractId, chainState: cp.token,
          detail: 'Recorded asset differs from the on-chain asset.',
        });
        if (r.opened) tally.findingsOpened++;
        identityMismatch = true;
      }
      if (identityMismatch) tally.mismatched++;

      const chainSettled = cp.status === CHAIN_STATUS.FINALIZED;
      const chainCancelled = cp.status === CHAIN_STATUS.CANCELLED;
      const dbSettled = p.state === PaymentState.PAID;

      // ── The independent transfer check ──
      // Only meaningful where one side claims settlement. Asking "did value move"
      // for a payment nobody claims settled would produce noise.
      let transferVerdict: 'CONFIRMED' | 'ABSENT' | 'UNREADABLE' | 'NOT_APPLICABLE' =
        'NOT_APPLICABLE';
      let settlementTx: string | null = p.settlementTxHash ?? null;

      if (chainSettled || dbSettled) {
        const asset = p.assetContractId ?? cp.token;
        const transfers = await transfersFor(asset);

        if (transfers === null) {
          transferVerdict = 'UNREADABLE';
        } else {
          // Scope the search to ONE transaction. The tuple (escrow contract,
          // recipient, asset, amount) repeats every pay period, so an unscoped
          // match finds one transfer per historical settlement and looks like a
          // duplicate payment that never happened.
          const txScope =
            p.settlementTxHash ??
            inferSettlementTransaction(
              transfers,
              escrow.contractId,
              chain.value.payments.map((q) => ({
                recipient: q.worker,
                amountBaseUnits: q.amountBaseUnits,
                assetContractId: q.token,
              }))
            );

          const expectation = {
            escrowContractId: escrow.contractId,
            recipient: cp.worker,
            assetContractId: asset,
            amountBaseUnits: cp.amountBaseUnits,
            txHash: txScope,
          };
          const matched = matchSettlementTransfer(transfers, expectation);
          const dup = countDuplicateSettlementsInSameTransaction(matched);

          if (dup.duplicated) {
            // Two transfers for one payee inside ONE pay_batch: the genuine
            // double-payment condition.
            transferVerdict = 'CONFIRMED';
            settlementTx = dup.txHash ?? matched[0]?.txHash ?? settlementTx;
            const r = await upsertFinding(db, {
              orgId, runId: run.id, kind: FindingKind.DUPLICATE_PAYMENT_EVENT,
              paymentId: p.id, escrowOnChainId: escrow.onChainId, paymentIndex: cp.index,
              chainState: `${dup.count} transfers in transaction ${dup.txHash}`,
              txHash: dup.txHash ?? null,
              detail:
                `${dup.count} asset transfers for this payee were observed inside a ` +
                'single settlement transaction. The worker may have been paid twice.',
            });
            if (r.opened) tally.findingsOpened++;
            tally.mismatched++;
          } else if (matched.length >= 1) {
            transferVerdict = 'CONFIRMED';
            settlementTx = matched[0].txHash ?? settlementTx;
          } else {
            transferVerdict = 'ABSENT';
            // A transfer of the wrong amount is a different, louder fact than none.
            const wrongAmount = findAmountMismatchedTransfers(transfers, expectation);
            if (wrongAmount.length > 0) {
              const r = await upsertFinding(db, {
                orgId, runId: run.id, kind: FindingKind.AMOUNT_MISMATCH,
                paymentId: p.id, escrowOnChainId: escrow.onChainId, paymentIndex: cp.index,
                dbState: cp.amountBaseUnits.toString(),
                chainState: wrongAmount.map((t) => t.amountBaseUnits.toString()).join(', '),
                txHash: wrongAmount[0].txHash ?? null,
                detail:
                  'Asset moved to this recipient, but not in the expected amount.',
              });
              if (r.opened) tally.findingsOpened++;
              tally.mismatched++;
            }
          }
        }
      }

      // ── Outcome ──
      if (chainSettled && !dbSettled) {
        if (transferVerdict === 'UNREADABLE') {
          // The contract says settled, but the movement could not be independently
          // confirmed. Advancing on contract state alone would undo the point of
          // having an independent check.
          tally.unreadable++;
          const r = await upsertFinding(db, {
            orgId, runId: run.id, kind: FindingKind.CHAIN_UNREADABLE,
            paymentId: p.id, escrowOnChainId: escrow.onChainId, paymentIndex: cp.index,
            dbState: p.state, chainState: 'contract reports FINALIZED',
            detail:
              'The contract reports settlement, but asset transfers could not be ' +
              'read to confirm it. The projection was NOT advanced.',
          });
          if (r.opened) tally.findingsOpened++;
          continue;
        }

        if (transferVerdict === 'ABSENT') {
          tally.mismatched++;
          const r = await upsertFinding(db, {
            orgId, runId: run.id, kind: FindingKind.MISSING_PAYMENT_EVENT,
            paymentId: p.id, escrowOnChainId: escrow.onChainId, paymentIndex: cp.index,
            dbState: p.state, chainState: 'contract reports FINALIZED, no transfer observed',
            detail:
              'The contract reports this payment settled, but no matching asset ' +
              'transfer was observed. The projection was NOT advanced.',
          });
          if (r.opened) tally.findingsOpened++;
          continue;
        }

        // Confirmed by the token's own events: catch the projection up.
        const outcome = await applyTransition(db, {
          paymentId: p.id,
          to: PaymentState.PAID,
          actor: RECONCILER,
          orgId,
          reason: 'Reconciliation: settlement independently confirmed on-chain.',
          txHash: settlementTx ?? undefined,
          metadata: {
            source: 'reconciliation',
            correlationId: run.correlationId,
            verifiedBy: 'sac-transfer-event',
            escrowOnChainId: escrow.onChainId,
            paymentIndex: cp.index,
          },
        });
        if (outcome.ok && outcome.changed) {
          tally.chainAhead++;
          tally.correctionsApplied++;
          log(`payment ${p.id}: CHAIN_AHEAD corrected to PAID`);
        } else {
          const r = await upsertFinding(db, {
            orgId, runId: run.id, kind: FindingKind.CHAIN_PAID_DB_NOT,
            paymentId: p.id, escrowOnChainId: escrow.onChainId, paymentIndex: cp.index,
            dbState: p.state, chainState: 'FINALIZED (transfer confirmed)',
            detail:
              'Settlement is confirmed on-chain but the recorded state does not ' +
              `permit PAID: ${outcome.ok ? 'already there' : outcome.message}`,
          });
          if (r.opened) tally.findingsOpened++;
          tally.mismatched++;
        }
        continue;
      }

      if (dbSettled && !chainSettled) {
        // The worst finding in the system: we are telling a finance team that
        // money moved when the chain does not agree. Never reverted — see header.
        tally.databaseAhead++;
        const r = await upsertFinding(db, {
          orgId, runId: run.id, kind: FindingKind.DB_PAID_CHAIN_NOT,
          paymentId: p.id, escrowOnChainId: escrow.onChainId, paymentIndex: cp.index,
          dbState: 'PAID',
          chainState: `contract status=${cp.status}, transfer=${transferVerdict}`,
          txHash: p.settlementTxHash,
          detail:
            'CoreFlow records this payment as PAID but the chain does not report ' +
            'it as settled. The payment state was NOT changed; PAID is terminal ' +
            'and this finding is the durable record.',
          metadata: { transferVerdict },
        });
        if (r.opened) tally.findingsOpened++;
        continue;
      }

      if (dbSettled && chainSettled) {
        if (transferVerdict === 'CONFIRMED') {
          // Only count as agreed if NOTHING about this payment disagreed. An
          // identity mismatch earlier in this loop already counted it as
          // mismatched; counting it again here would let a run report
          // "3 of 3 agreed" for a batch with two wrong amounts.
          if (!identityMismatch) tally.agreed++;
        } else if (transferVerdict === 'UNREADABLE') {
          tally.unreadable++;
        } else {
          // Both sides claim settled, yet no asset movement was observed.
          tally.mismatched++;
          const r = await upsertFinding(db, {
            orgId, runId: run.id, kind: FindingKind.MISSING_PAYMENT_EVENT,
            paymentId: p.id, escrowOnChainId: escrow.onChainId, paymentIndex: cp.index,
            dbState: 'PAID', chainState: 'FINALIZED, no transfer observed',
            txHash: p.settlementTxHash,
            detail:
              'Both CoreFlow and the contract report this payment settled, but no ' +
              'matching asset transfer was observed.',
          });
          if (r.opened) tally.findingsOpened++;
        }
        continue;
      }

      if (chainCancelled && p.state !== PaymentState.CANCELLED) {
        const outcome = await applyTransition(db, {
          paymentId: p.id,
          to: PaymentState.CANCELLED,
          actor: RECONCILER,
          orgId,
          reason: 'Reconciliation: the escrow was cancelled on-chain.',
          metadata: { source: 'reconciliation', correlationId: run.correlationId },
        });
        if (outcome.ok && outcome.changed) tally.correctionsApplied++;
        continue;
      }

      if (!identityMismatch) tally.agreed++;
    }
  }

  return tally;
}

/**
 * Cross-check transactions recorded as failed against the chain.
 *
 * An RPC timeout reported as a failure, while the transaction actually landed, is
 * the most dangerous state in a payments system: it invites a retry that pays
 * twice. The contract's `PaymentAlreadyFinalized` guard is the real backstop, but
 * this finds the condition instead of waiting for someone to hit it.
 */
export async function reconcileFailedTransactions(
  db: any,
  verifier: ChainVerifier,
  orgId: string,
  run: { id: string; correlationId: string }
): Promise<{ checked: number; falselyFailed: number; findingsOpened: number }> {
  const failed = await db.blockchainTransaction.findMany({
    where: { orgId, status: 'FAILED', hash: { not: null } },
    take: 200,
  });

  let falselyFailed = 0;
  let findingsOpened = 0;

  for (const tx of failed) {
    const res = await verifier.readTransactionSucceeded(tx.hash);
    // Unreadable or forgotten by the node: leave it alone rather than guessing.
    if (!res.ok || !res.value) continue;

    falselyFailed++;
    const r = await upsertFinding(db, {
      orgId, runId: run.id, kind: FindingKind.FAILED_TX_ACTUALLY_SUCCEEDED,
      paymentId: tx.paymentId,
      txHash: tx.hash,
      dbState: 'FAILED', chainState: 'SUCCESS',
      detail:
        `Transaction ${tx.hash} was recorded as failed but succeeded on-chain. ` +
        'Do not retry this payment.',
      metadata: { transactionId: tx.id },
    });
    if (r.opened) findingsOpened++;

    await db.blockchainTransaction.update({
      where: { id: tx.id },
      data: {
        status: 'CONFIRMED',
        errorMessage:
          'Recorded as failed in error; the chain confirms success. Corrected by ' +
          'reconciliation.',
      },
    });
  }

  return { checked: failed.length, falselyFailed, findingsOpened };
}

/**
 * Report on-chain escrows belonging to no organization.
 *
 * Preserves the P2 #2 decision: CoreFlow never invents a tenant for a discovered
 * escrow. These are reported so they are investigable, and claimable through the
 * controlled workflow, rather than silently attached to whichever organization was
 * convenient.
 */
export async function reportUnattributedEscrows(
  db: any,
  orgId: string,
  run: { id: string; correlationId: string },
  opts: { contractId: string; network: string }
): Promise<{ unknown: number; findingsOpened: number }> {
  const rows = await db.chainEvent.findMany({
    where: {
      attributed: false,
      contractId: opts.contractId,
      network: opts.network,
      escrowOnChainId: { not: null },
    },
    distinct: ['escrowOnChainId'],
    take: 100,
  });

  let findingsOpened = 0;
  for (const row of rows) {
    const r = await upsertFinding(db, {
      orgId, runId: run.id, kind: FindingKind.UNKNOWN_ON_CHAIN_OBJECT,
      escrowOnChainId: row.escrowOnChainId,
      chainState: 'exists on-chain, unattributed',
      detail:
        `Escrow ${row.escrowOnChainId} exists on ${opts.network} but belongs to no ` +
        'CoreFlow organization. It has not been attached to any tenant.',
      metadata: { contractId: opts.contractId, firstSeenLedger: row.ledger },
    });
    if (r.opened) findingsOpened++;
  }
  return { unknown: rows.length, findingsOpened };
}
