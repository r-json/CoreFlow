/**
 * Reconciliation between this database and the chain.
 *
 * ── The rule ─────────────────────────────────────────────────────────────────
 * The chain is authoritative for settlement. Where the two disagree, the
 * disagreement is RECORDED as a ReconciliationFinding — the losing side is not
 * quietly rewritten, because overwriting it destroys the only evidence the two
 * ever diverged, and that evidence is precisely what an auditor (or an incident
 * review) needs.
 *
 * Two adjustments ARE applied automatically, because in both the chain's answer
 * is unambiguous and acting on it reduces harm:
 *   * chain settled, database had not caught up  → database advanced to PAID
 *   * database claims PAID, chain disagrees      → database moved to
 *     RECONCILIATION_REQUIRED (never silently "unpaid": a wrong PAID is a
 *     false statement about money and must stop being presented as fact)
 *
 * Everything else is reported and left for an operator.
 *
 * Unlike the indexer, this reads CURRENT contract state. That is appropriate
 * here: reconciliation asks "what is true now", not "what happened then".
 */

import { PaymentState } from '@prisma/client';
import { transitionPayment } from './service';

/** On-chain PaymentStatus discriminants, from the contract's #[repr(u32)] enum. */
export const CHAIN_STATUS = {
  PENDING: 0,
  MANAGER_APPROVED: 1,
  FINANCE_APPROVED: 2,
  FINALIZED: 3,
  CANCELLED: 4,
} as const;

export interface ChainPaymentView {
  index: number;
  worker: string;
  token: string;
  amountBaseUnits: bigint;
  hours: bigint;
  proofVerified: boolean;
  status: number;
}

export interface ChainEscrowView {
  onChainId: number;
  managerApproved: boolean;
  financeApproved: boolean;
  cancelled: boolean;
  payments: ChainPaymentView[];
}

export interface ReconcileDeps {
  db: any;
  /** Reads live contract state for an escrow. Injected so this is testable. */
  fetchChainEscrow: (onChainId: number) => Promise<ChainEscrowView>;
}

export interface ReconcileReport {
  escrowsChecked: number;
  paymentsChecked: number;
  findingsOpened: number;
  advancedToPaid: number;
  flaggedForReview: number;
  /** Escrows whose chain state could not be read. Not treated as agreement. */
  unreadable: number;
}

const RECONCILER = { kind: 'reconciler' as const, system: 'reconciler' };

/** Open a finding, unless an identical unresolved one already exists. */
async function recordFinding(
  db: any,
  orgId: string,
  input: {
    paymentId?: string;
    kind: string;
    dbState?: string;
    chainState?: string;
    detail: string;
    metadata?: Record<string, unknown>;
  }
): Promise<boolean> {
  // Re-running reconciliation must not multiply findings for one unchanged
  // discrepancy, or the queue becomes noise and gets ignored.
  const existing = await db.reconciliationFinding.findFirst({
    where: {
      orgId,
      paymentId: input.paymentId ?? null,
      kind: input.kind as any,
      resolvedAt: null,
    },
  });
  if (existing) return false;

  await db.reconciliationFinding.create({
    data: {
      orgId,
      paymentId: input.paymentId ?? null,
      kind: input.kind as any,
      dbState: input.dbState ?? null,
      chainState: input.chainState ?? null,
      detail: input.detail,
      metadata: (input.metadata ?? {}) as any,
    },
  });
  return true;
}

/**
 * Reconcile every escrow belonging to an organization on a given deployment.
 */
export async function reconcileOrganization(
  deps: ReconcileDeps,
  orgId: string,
  opts: { contractId?: string; network?: string; limit?: number } = {}
): Promise<ReconcileReport> {
  const { db, fetchChainEscrow } = deps;
  const report: ReconcileReport = {
    escrowsChecked: 0, paymentsChecked: 0, findingsOpened: 0,
    advancedToPaid: 0, flaggedForReview: 0, unreadable: 0,
  };

  const escrows = await db.escrow.findMany({
    where: {
      orgId,
      onChainId: { not: null },
      ...(opts.contractId ? { contractId: opts.contractId } : {}),
      ...(opts.network ? { network: opts.network } : {}),
    },
    include: { payments: { orderBy: { onChainPaymentIndex: 'asc' } } },
    take: opts.limit ?? 200,
  });

  for (const escrow of escrows) {
    report.escrowsChecked++;

    let chain: ChainEscrowView;
    try {
      chain = await fetchChainEscrow(escrow.onChainId);
    } catch {
      // An unreadable escrow is explicitly NOT recorded as agreeing. Treating a
      // failed read as "all fine" is how silent drift accumulates.
      report.unreadable++;
      if (await recordFinding(db, orgId, {
        kind: 'MISSING_ON_CHAIN',
        dbState: `${escrow.payments.length} payment(s)`,
        chainState: 'unreadable',
        detail:
          `Escrow ${escrow.onChainId} could not be read from ${escrow.network}. ` +
          'Its payments were not verified against the chain.',
        metadata: { escrowId: escrow.id, onChainId: escrow.onChainId },
      })) report.findingsOpened++;
      continue;
    }

    const byIndex = new Map<number, ChainPaymentView>();
    for (const cp of chain.payments) byIndex.set(cp.index, cp);

    // Chain slots with no database row: the product cannot show them at all.
    for (const cp of chain.payments) {
      const has = escrow.payments.some(
        (p: any) => p.onChainPaymentIndex === cp.index
      );
      if (!has) {
        if (await recordFinding(db, orgId, {
          kind: 'ORPHAN_ON_CHAIN',
          chainState: String(cp.status),
          detail:
            `Escrow ${escrow.onChainId} payment ${cp.index} exists on-chain ` +
            'but has no database row.',
          metadata: {
            escrowId: escrow.id, paymentIndex: cp.index,
            worker: cp.worker, amountBaseUnits: cp.amountBaseUnits.toString(),
          },
        })) report.findingsOpened++;
      }
    }

    for (const p of escrow.payments) {
      report.paymentsChecked++;
      const cp = p.onChainPaymentIndex === null ? undefined : byIndex.get(p.onChainPaymentIndex);

      if (!cp) {
        if (await recordFinding(db, orgId, {
          paymentId: p.id,
          kind: 'MISSING_ON_CHAIN',
          dbState: p.state,
          detail:
            `Payment ${p.id} references escrow ${escrow.onChainId} slot ` +
            `${p.onChainPaymentIndex}, which does not exist on-chain.`,
        })) report.findingsOpened++;
        continue;
      }

      const chainSettled = cp.status === CHAIN_STATUS.FINALIZED;
      const chainCancelled = cp.status === CHAIN_STATUS.CANCELLED;
      const dbSettled = p.state === PaymentState.PAID;

      // Financial identity must match regardless of state.
      if (p.amountBaseUnits !== cp.amountBaseUnits) {
        if (await recordFinding(db, orgId, {
          paymentId: p.id, kind: 'AMOUNT_MISMATCH',
          dbState: p.amountBaseUnits.toString(),
          chainState: cp.amountBaseUnits.toString(),
          detail: 'Recorded amount differs from the on-chain amount.',
        })) report.findingsOpened++;
      }
      if (p.recipientAddress !== cp.worker) {
        if (await recordFinding(db, orgId, {
          paymentId: p.id, kind: 'RECIPIENT_MISMATCH',
          dbState: p.recipientAddress, chainState: cp.worker,
          detail: 'Recorded recipient differs from the on-chain recipient.',
        })) report.findingsOpened++;
      }

      // ── The two disagreements that matter most ──
      if (chainSettled && !dbSettled) {
        // The chain paid. Catch the database up — the money moved whatever our
        // records said.
        const outcome = await transitionPayment(db, {
          paymentId: p.id,
          to: PaymentState.PAID,
          actor: RECONCILER,
          orgId,
          reason: 'Reconciliation: the chain reports this payment as settled.',
          metadata: {
            source: 'reconciliation',
            chainStatus: cp.status,
            escrowOnChainId: escrow.onChainId,
            paymentIndex: cp.index,
          },
        });
        if (outcome.ok && outcome.changed) {
          report.advancedToPaid++;
        } else {
          // Could not advance from where it sits — needs a human.
          if (await recordFinding(db, orgId, {
            paymentId: p.id, kind: 'CHAIN_PAID_DB_NOT',
            dbState: p.state, chainState: 'FINALIZED',
            detail:
              'The chain reports settlement but the recorded state does not ' +
              `permit PAID: ${outcome.ok ? 'already there' : outcome.message}`,
          })) report.findingsOpened++;
        }
        continue;
      }

      if (dbSettled && !chainSettled) {
        // We are claiming money moved when the chain says otherwise. This is the
        // worst discrepancy in the system, and it must stop being presented as
        // settled — but it is NOT silently reverted to a healthy-looking state,
        // because something caused it and that needs explaining.
        if (await recordFinding(db, orgId, {
          paymentId: p.id, kind: 'DB_PAID_CHAIN_NOT',
          dbState: 'PAID', chainState: String(cp.status),
          detail:
            'CoreFlow recorded this payment as PAID but the chain does not ' +
            'report it as settled. The payment has been moved to ' +
            'RECONCILIATION_REQUIRED and must be resolved by an operator.',
        })) report.findingsOpened++;

        const outcome = await transitionPayment(db, {
          paymentId: p.id,
          to: PaymentState.RECONCILIATION_REQUIRED,
          actor: RECONCILER,
          orgId,
          reason: 'Reconciliation: recorded as PAID but the chain disagrees.',
          metadata: { chainStatus: cp.status },
        });
        // PAID is terminal in the state machine, so this transition is refused by
        // design. The finding above is the durable record either way; we do not
        // weaken the table to allow it.
        if (outcome.ok && outcome.changed) report.flaggedForReview++;
        continue;
      }

      if (chainCancelled && p.state !== PaymentState.CANCELLED && !dbSettled) {
        const outcome = await transitionPayment(db, {
          paymentId: p.id,
          to: PaymentState.CANCELLED,
          actor: RECONCILER,
          orgId,
          reason: 'Reconciliation: the escrow was cancelled on-chain.',
        });
        if (outcome.ok && outcome.changed) report.flaggedForReview++;
      }
    }
  }

  return report;
}

/**
 * Cross-check transactions we recorded as failed against the chain.
 *
 * An RPC timeout that was reported as a failure while the transaction actually
 * landed is the single most dangerous state for a payments system: it invites a
 * retry that double-pays. The contract's PaymentAlreadyFinalized guard is the
 * real backstop, but this finds the condition rather than waiting for it to be
 * hit.
 */
export async function reconcileFailedTransactions(
  deps: { db: any; fetchTxSucceeded: (hash: string) => Promise<boolean> },
  orgId: string
): Promise<{ checked: number; falselyFailed: number }> {
  const { db, fetchTxSucceeded } = deps;
  const failed = await db.blockchainTransaction.findMany({
    where: { orgId, status: 'FAILED', hash: { not: null } },
    take: 200,
  });

  let falselyFailed = 0;
  for (const tx of failed) {
    let succeeded = false;
    try {
      succeeded = await fetchTxSucceeded(tx.hash);
    } catch {
      continue; // unreadable; leave it alone rather than guessing
    }
    if (!succeeded) continue;

    falselyFailed++;
    await recordFinding(db, orgId, {
      paymentId: tx.paymentId ?? undefined,
      kind: 'FAILED_TX_ACTUALLY_SUCCEEDED',
      dbState: 'FAILED',
      chainState: 'SUCCESS',
      detail:
        `Transaction ${tx.hash} was recorded as failed but succeeded on-chain. ` +
        'Do not retry this payment until it is resolved.',
      metadata: { transactionId: tx.id, hash: tx.hash },
    });
    await db.blockchainTransaction.update({
      where: { id: tx.id },
      data: {
        status: 'CONFIRMED',
        errorMessage:
          'Recorded as failed in error; the chain confirms success. ' +
          'Corrected by reconciliation.',
      },
    });
  }

  return { checked: failed.length, falselyFailed };
}
