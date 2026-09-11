/**
 * Chain → database projection.
 *
 * ── Authority ────────────────────────────────────────────────────────────────
 * The contract's event log is the authority for settlement. This module is the
 * ONLY writer permitted to move a payment to PAID, and it does so only on a
 * `payment/paid` event — which the contract emits per payee, after that payee's
 * SAC transfer succeeded.
 *
 * ── Properties this is built for ─────────────────────────────────────────────
 * IDEMPOTENT    Every event is keyed by its RPC paging token; a re-seen token is
 *               skipped. Payment rows are keyed by (escrowId, paymentIndex), so
 *               replaying a settlement cannot create a second payment.
 * RESTARTABLE   The cursor is per (contract, network) and advances only after the
 *               events in a batch are committed.
 * DETERMINISTIC The projection reads only the event payload, never current
 *               contract state. Re-indexing from ledger zero produces the same
 *               rows.
 * PARTIAL-SAFE  Each event is applied in its own transaction together with its
 *               ChainEvent marker, so an interrupted batch leaves a prefix
 *               applied and resumes from exactly there — never half an event.
 * RECONCILING   A disagreement between log and database is recorded as a
 *               ReconciliationFinding rather than silently overwritten.
 *
 * ── The defect this replaces ─────────────────────────────────────────────────
 * The previous projection stored one worker and one amount per Escrow, so a
 * three-payee settlement collapsed into a single row carrying the first payee's
 * figures. The other two payments simply did not exist in the product.
 */

import { PaymentState } from '@prisma/client';
import { parseCoreFlowEvent, type CoreFlowEvent } from './events';
import { applyTransition } from '@/lib/payments/service';

/** A raw event row from the RPC, normalized for the indexer. */
export interface RawIndexedEvent {
  /** RPC paging token — globally unique, and the basis of ingest idempotency. */
  id: string;
  ledger: number;
  topic0: string;
  topic1: string;
  value: unknown;
  txHash?: string;
}

export interface IndexerContext {
  contractId: string;
  network: string;
  /** Default asset decimals when an event does not carry them. */
  assetDecimals?: number;
}

/**
 * How an on-chain escrow maps to a CoreFlow organization.
 *
 * ── The rule ─────────────────────────────────────────────────────────────────
 * The chain knows nothing about organizations. The ONLY authoritative mapping is
 * an `Escrow` row that the application itself created — written when a member of
 * a known organization submitted the creation transaction, or when an operator
 * explicitly claimed an escrow into their workspace.
 *
 * The indexer therefore never invents a tenant. An escrow it has no mapping for
 * is recorded as UNATTRIBUTED and left for a human, because the alternative —
 * attaching it to whichever organization seems likely — would silently place one
 * party's payroll, recipients and amounts inside another's workspace. That is a
 * data breach produced by a convenience default.
 *
 * Escrows created outside the app (CLI, validation scripts, another client) are
 * consequently invisible until claimed. That is the intended trade.
 */
export type TenantResolution =
  | { attributed: true; orgId: string; escrowId: string }
  | { attributed: false; reason: string };

async function resolveEscrowTenant(
  tx: any,
  ctx: IndexerContext,
  escrowOnChainId: number
): Promise<TenantResolution> {
  const escrow = await tx.escrow.findFirst({
    where: {
      onChainId: escrowOnChainId,
      // Scoped to the deployment: escrow ids are assigned per contract, so id 3
      // exists on Testnet v2 AND on Mainnet v1, owned by different tenants.
      contractId: ctx.contractId,
      network: ctx.network,
    },
    select: { id: true, orgId: true },
  });

  if (escrow) {
    return { attributed: true, orgId: escrow.orgId, escrowId: escrow.id };
  }
  return {
    attributed: false,
    reason:
      `Escrow ${escrowOnChainId} on ${ctx.network} (${ctx.contractId.slice(0, 8)}…) ` +
      'has no CoreFlow record, so it cannot be attributed to an organization. ' +
      'An operator must claim it.',
  };
}

export interface IndexerDeps {
  db: any;
  ctx: IndexerContext;
}

export interface RunResult {
  processed: number;
  skipped: number;
  lastLedger: number;
  paymentsCreated: number;
  paymentsPaid: number;
  findings: number;
  /** Events recorded but NOT projected, because no tenant mapping exists. */
  unattributed: number;
}

const INDEXER_ACTOR = { kind: 'indexer' as const, system: 'indexer' };

/** Stable, deterministic reference for a batch auto-created by the indexer. */
function escrowBatchReference(escrowId: number): string {
  return `CHAIN-${String(escrowId).padStart(5, '0')}`;
}

/**
 * Ensure the Escrow row exists. Deterministic id derived from the deployment and
 * on-chain id, so replaying `created` cannot produce a second escrow.
 */
async function ensureEscrow(
  tx: any,
  ctx: IndexerContext,
  orgId: string,
  escrowId: number,
  patch: Record<string, unknown> = {}
): Promise<any> {
  const existing = await tx.escrow.findUnique({ where: { onChainId: escrowId } });
  if (existing) {
    if (Object.keys(patch).length > 0) {
      return tx.escrow.update({ where: { id: existing.id }, data: patch });
    }
    return existing;
  }

  return tx.escrow.create({
    data: {
      orgId,
      onChainId: escrowId,
      contractId: ctx.contractId,
      network: ctx.network,
      // Addresses are filled in by the `created` event; an escrow discovered
      // mid-stream (indexing started after creation) carries empty strings until
      // a reconciliation pass fills them, rather than inventing values.
      managerAddress: (patch.managerAddress as string) ?? '',
      financeApproverAddress: '',
      assetDecimals: ctx.assetDecimals ?? 7,
      ...patch,
    },
  });
}

/** Ensure a PayrollBatch exists to hold an escrow's payments. */
async function ensureBatch(tx: any, orgId: string, escrowId: number): Promise<any> {
  const reference = escrowBatchReference(escrowId);
  const existing = await tx.payrollBatch.findUnique({
    where: { orgId_reference: { orgId, reference } },
  });
  if (existing) return existing;
  return tx.payrollBatch.create({
    data: { orgId, reference, sourceFilename: null },
  });
}

/** Ensure a Worker row exists for a payee wallet. */
async function ensureWorker(tx: any, orgId: string, wallet: string): Promise<any> {
  const existing = await tx.worker.findUnique({
    where: { orgId_walletAddress: { orgId, walletAddress: wallet } },
  });
  if (existing) return existing;
  return tx.worker.create({ data: { orgId, walletAddress: wallet } });
}

/**
 * Open a reconciliation finding.
 *
 * Findings are recorded, not corrected in place. Overwriting the losing side of a
 * disagreement destroys the only evidence the two ever diverged — which is
 * exactly what an auditor needs.
 */
async function openFinding(
  tx: any,
  orgId: string,
  input: {
    paymentId?: string;
    kind: string;
    dbState?: string;
    chainState?: string;
    detail: string;
    metadata?: Record<string, unknown>;
  }
): Promise<void> {
  await tx.reconciliationFinding.create({
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
}

export interface ApplyResult {
  paymentsCreated: number;
  paymentsPaid: number;
  findings: number;
  /** False when no organization could be resolved for the event's escrow. */
  attributed: boolean;
  unattributedReason?: string;
}

/**
 * Apply one domain event inside an existing transaction.
 *
 * Takes `tx` rather than a client so the caller can commit the event's effects
 * and its ChainEvent marker together — the property that makes a crash mid-batch
 * resumable rather than ambiguous.
 */
export async function applyEvent(
  tx: any,
  ctx: IndexerContext,
  ev: CoreFlowEvent,
  meta: { txHash?: string; ledger: number }
): Promise<ApplyResult> {
  const out: ApplyResult = { paymentsCreated: 0, paymentsPaid: 0, findings: 0, attributed: true };

  // Resolve the owning organization from the application's own record. An event
  // for an escrow we have no mapping for is recorded and skipped — never guessed
  // onto a tenant.
  const tenant = await resolveEscrowTenant(tx, ctx, ev.escrowId);
  if (!tenant.attributed) {
    out.attributed = false;
    out.unattributedReason = tenant.reason;
    return out;
  }
  const orgId = tenant.orgId;

  switch (ev.kind) {
    case 'created': {
      await ensureEscrow(tx, ctx, orgId, ev.escrowId, {
        managerAddress: ev.manager,
        totalAmountBaseUnits: ev.totalAmount,
      });
      await ensureBatch(tx, orgId, ev.escrowId);
      return out;
    }

    /**
     * THE FIX. One Payment row per on-chain payment slot, carrying that slot's
     * own recipient, asset, amount, rate and period.
     */
    case 'payment_added': {
      const escrow = await ensureEscrow(tx, ctx, orgId, ev.escrowId);
      const batch = await ensureBatch(tx, orgId, ev.escrowId);
      const worker = await ensureWorker(tx, orgId, ev.worker);

      const existing = await tx.payment.findUnique({
        where: {
          escrowId_onChainPaymentIndex: {
            escrowId: escrow.id,
            onChainPaymentIndex: ev.paymentIndex,
          },
        },
      });

      if (existing) {
        // Replay. The financial identity of a payment is immutable, so a
        // re-delivered event that disagrees is a discrepancy to surface, not an
        // update to apply.
        if (
          existing.amountBaseUnits !== ev.amountBaseUnits ||
          existing.recipientAddress !== ev.worker
        ) {
          await openFinding(tx, orgId, {
            paymentId: existing.id,
            kind: 'AMOUNT_MISMATCH',
            dbState: `${existing.recipientAddress}:${existing.amountBaseUnits}`,
            chainState: `${ev.worker}:${ev.amountBaseUnits}`,
            detail:
              'A replayed payment/add event disagrees with the stored payment. ' +
              'The stored row was NOT overwritten.',
            metadata: { escrowId: ev.escrowId, paymentIndex: ev.paymentIndex },
          });
          out.findings++;
        }
        return out;
      }

      const hours =
        ev.rateBaseUnits > 0n ? ev.amountBaseUnits / ev.rateBaseUnits : 0n;

      await tx.payment.create({
        data: {
          orgId,
          batchId: batch.id,
          escrowId: escrow.id,
          workerId: worker.id,
          recipientAddress: ev.worker,
          onChainPaymentIndex: ev.paymentIndex,
          assetContractId: ev.token,
          assetDecimals: ctx.assetDecimals ?? escrow.assetDecimals ?? 7,
          amountBaseUnits: ev.amountBaseUnits,
          rateBaseUnits: ev.rateBaseUnits,
          hours,
          periodStart: ev.periodStart > 0n ? new Date(Number(ev.periodStart) * 1000) : null,
          periodEnd: ev.periodEnd > 0n ? new Date(Number(ev.periodEnd) * 1000) : null,
          // Funded on-chain, awaiting an attestation.
          state: PaymentState.AWAITING_ORACLE,
          stateUpdatedAt: new Date(),
        },
      });
      out.paymentsCreated++;

      await tx.auditEvent.create({
        data: {
          orgId,
          type: 'payment.indexed',
          actorSystem: 'indexer',
          escrowId: escrow.id,
          batchId: batch.id,
          newState: PaymentState.AWAITING_ORACLE,
          txHash: meta.txHash ?? null,
          metadata: {
            escrowOnChainId: ev.escrowId,
            paymentIndex: ev.paymentIndex,
            ledger: meta.ledger,
          } as any,
        },
      });
      return out;
    }

    case 'hours': {
      const escrow = await tx.escrow.findUnique({ where: { onChainId: ev.escrowId } });
      if (!escrow) return out;
      const payment = await tx.payment.findUnique({
        where: {
          escrowId_onChainPaymentIndex: {
            escrowId: escrow.id,
            onChainPaymentIndex: ev.paymentIndex,
          },
        },
      });
      if (!payment) return out;

      // The contract accepted an Ed25519 attestation for this payment — the only
      // thing that makes ORACLE_VERIFIED true.
      await tx.payment.updateMany({
        where: { id: payment.id, state: PaymentState.AWAITING_ORACLE },
        data: {
          state: PaymentState.ORACLE_VERIFIED,
          stateUpdatedAt: new Date(),
          hours: ev.hours,
        },
      });
      await tx.auditEvent.create({
        data: {
          orgId,
          type: 'payment.oracle.verified',
          actorSystem: 'indexer',
          paymentId: payment.id,
          escrowId: escrow.id,
          previousState: payment.state,
          newState: PaymentState.ORACLE_VERIFIED,
          txHash: meta.txHash ?? null,
          metadata: { hours: ev.hours.toString(), ledger: meta.ledger } as any,
        },
      });
      return out;
    }

    case 'manager_approved':
    case 'finance_approved': {
      const isManager = ev.kind === 'manager_approved';
      const escrow = await tx.escrow.findUnique({ where: { onChainId: ev.escrowId } });
      if (!escrow) return out;

      await tx.escrow.update({
        where: { id: escrow.id },
        data: isManager ? { managerApproved: true } : { financeApproved: true },
      });

      // Approval is per-escrow on-chain; it advances every payment in that escrow
      // that is waiting on this specific approver.
      const waitingOn = isManager
        ? PaymentState.AWAITING_MANAGER
        : PaymentState.AWAITING_FINANCE;
      const nextState = isManager
        ? PaymentState.AWAITING_FINANCE
        : PaymentState.READY_TO_SETTLE;

      // ORACLE_VERIFIED payments enter the approval chain first.
      await tx.payment.updateMany({
        where: { escrowId: escrow.id, state: PaymentState.ORACLE_VERIFIED },
        data: { state: PaymentState.AWAITING_MANAGER, stateUpdatedAt: new Date() },
      });

      const affected = await tx.payment.findMany({
        where: { escrowId: escrow.id, state: waitingOn },
        select: { id: true },
      });
      await tx.payment.updateMany({
        where: { escrowId: escrow.id, state: waitingOn },
        data: { state: nextState, stateUpdatedAt: new Date() },
      });

      for (const p of affected) {
        await tx.auditEvent.create({
          data: {
            orgId,
            type: isManager ? 'approval.manager.observed' : 'approval.finance.observed',
            actorSystem: 'indexer',
            paymentId: p.id,
            escrowId: escrow.id,
            previousState: waitingOn,
            newState: nextState,
            txHash: meta.txHash ?? null,
            metadata: { ledger: meta.ledger } as any,
          },
        });
      }
      return out;
    }

    /** Chain-confirmed settlement for ONE payee. The only path to PAID. */
    case 'payment_paid': {
      const escrow = await tx.escrow.findUnique({ where: { onChainId: ev.escrowId } });
      if (!escrow) return out;

      const payment = await tx.payment.findUnique({
        where: {
          escrowId_onChainPaymentIndex: {
            escrowId: escrow.id,
            onChainPaymentIndex: ev.paymentIndex,
          },
        },
      });

      if (!payment) {
        // The chain settled a payment this database has no row for.
        await openFinding(tx, orgId, {
          kind: 'ORPHAN_ON_CHAIN',
          chainState: 'PAID',
          detail:
            `Escrow ${ev.escrowId} payment ${ev.paymentIndex} settled on-chain ` +
            'but has no database row. Indexing likely started after creation.',
          metadata: {
            escrowOnChainId: ev.escrowId,
            paymentIndex: ev.paymentIndex,
            worker: ev.worker,
            amountBaseUnits: ev.amountBaseUnits.toString(),
          },
        });
        out.findings++;
        return out;
      }

      // The chain says this much moved. If our record disagrees, record it and
      // still mark PAID — the transfer happened either way, and the amount
      // discrepancy is a separate fact that needs a human.
      if (payment.amountBaseUnits !== ev.amountBaseUnits) {
        await openFinding(tx, orgId, {
          paymentId: payment.id,
          kind: 'AMOUNT_MISMATCH',
          dbState: payment.amountBaseUnits.toString(),
          chainState: ev.amountBaseUnits.toString(),
          detail: 'Settled amount differs from the recorded payment amount.',
        });
        out.findings++;
      }
      if (payment.recipientAddress !== ev.worker) {
        await openFinding(tx, orgId, {
          paymentId: payment.id,
          kind: 'RECIPIENT_MISMATCH',
          dbState: payment.recipientAddress,
          chainState: ev.worker,
          detail: 'Settled recipient differs from the recorded recipient.',
        });
        out.findings++;
      }

      if (payment.state === PaymentState.PAID) return out; // replay

      // Routed through the state machine so the transition table and the audit
      // trail apply to chain-driven changes exactly as they do to user actions.
      const result = await applyTransition(tx, {
        paymentId: payment.id,
        to: PaymentState.PAID,
        actor: INDEXER_ACTOR,
        orgId,
        txHash: meta.txHash,
        metadata: {
          ledger: meta.ledger,
          escrowOnChainId: ev.escrowId,
          paymentIndex: ev.paymentIndex,
          settledAmountBaseUnits: ev.amountBaseUnits.toString(),
          hours: ev.hours.toString(),
        },
      });

      if (result.ok && result.changed) {
        out.paymentsPaid++;
      } else if (!result.ok) {
        // The log says paid; the state machine would not allow it from where the
        // payment currently sits. The log wins on fact, but the inconsistency is
        // real and must be visible.
        await openFinding(tx, orgId, {
          paymentId: payment.id,
          kind: 'CHAIN_PAID_DB_NOT',
          dbState: payment.state,
          chainState: 'PAID',
          detail:
            `Chain settled this payment but the recorded state (${payment.state}) ` +
            `does not permit PAID: ${result.message}`,
        });
        out.findings++;
      }
      return out;
    }

    case 'payment_cancelled': {
      const escrow = await tx.escrow.findUnique({ where: { onChainId: ev.escrowId } });
      if (!escrow) return out;
      const payment = await tx.payment.findUnique({
        where: {
          escrowId_onChainPaymentIndex: {
            escrowId: escrow.id,
            onChainPaymentIndex: ev.paymentIndex,
          },
        },
      });
      if (!payment) return out;
      if (payment.state === PaymentState.PAID) {
        // Cancelling something already settled is contradictory.
        await openFinding(tx, orgId, {
          paymentId: payment.id,
          kind: 'DB_PAID_CHAIN_NOT',
          dbState: 'PAID',
          chainState: 'CANCELLED',
          detail: 'A cancellation event arrived for a payment recorded as PAID.',
        });
        out.findings++;
        return out;
      }
      await applyTransition(tx, {
        paymentId: payment.id,
        to: PaymentState.CANCELLED,
        actor: INDEXER_ACTOR,
        orgId,
        reason: 'Escrow cancelled on-chain; custody refunded.',
        txHash: meta.txHash,
        metadata: { ledger: meta.ledger },
      });
      return out;
    }

    case 'cancelled': {
      const escrow = await tx.escrow.findUnique({ where: { onChainId: ev.escrowId } });
      if (!escrow) return out;
      await tx.escrow.update({ where: { id: escrow.id }, data: { cancelled: true } });
      return out;
    }

    case 'oracle_rotated': {
      const escrow = await tx.escrow.findUnique({ where: { onChainId: ev.escrowId } });
      if (!escrow) return out;
      await tx.escrow.update({
        where: { id: escrow.id },
        data: { oracleRotations: ev.rotations },
      });
      // Rotation revokes every verified proof on that escrow, so the payments
      // must go back to awaiting a fresh attestation.
      await tx.payment.updateMany({
        where: {
          escrowId: escrow.id,
          state: {
            in: [
              PaymentState.ORACLE_VERIFIED,
              PaymentState.AWAITING_MANAGER,
              PaymentState.AWAITING_FINANCE,
              PaymentState.READY_TO_SETTLE,
            ],
          },
        },
        data: {
          state: PaymentState.AWAITING_ORACLE,
          stateUpdatedAt: new Date(),
          stateReason: 'Oracle key rotated on-chain; prior attestations revoked.',
        },
      });
      return out;
    }

    /**
     * Escrow-level settlement summary. Deliberately does NOT set any payment to
     * PAID — that is what the per-payment events are for. It is used only to
     * detect payments the aggregate says settled but which never produced a
     * per-payment event.
     */
    case 'finalized': {
      const escrow = await tx.escrow.findUnique({ where: { onChainId: ev.escrowId } });
      if (!escrow) return out;
      const unpaid = await tx.payment.count({
        where: { escrowId: escrow.id, state: { not: PaymentState.PAID } },
      });
      if (unpaid > 0) {
        await openFinding(tx, orgId, {
          kind: 'CHAIN_PAID_DB_NOT',
          chainState: `finalized count=${ev.count}`,
          detail:
            `Escrow ${ev.escrowId} reported ${ev.count} settled payments on-chain, ` +
            `but ${unpaid} database payment(s) are not PAID.`,
          metadata: { escrowOnChainId: ev.escrowId, totalAmount: ev.totalAmount.toString() },
        });
        out.findings++;
      }
      return out;
    }
  }
}

/** Read the cursor for a deployment. */
export async function getCursor(db: any, ctx: IndexerContext): Promise<number> {
  const row = await db.indexerCursor.findUnique({
    where: { contractId_network: { contractId: ctx.contractId, network: ctx.network } },
  });
  return row?.lastLedger ?? 0;
}

async function setCursor(db: any, ctx: IndexerContext, ledger: number): Promise<void> {
  await db.indexerCursor.upsert({
    where: { contractId_network: { contractId: ctx.contractId, network: ctx.network } },
    create: { contractId: ctx.contractId, network: ctx.network, lastLedger: ledger },
    update: { lastLedger: ledger },
  });
}

/**
 * Process a batch of raw events and advance the cursor.
 *
 * Each event is committed together with its ChainEvent marker in ONE transaction.
 * A crash therefore leaves a prefix of the batch applied, with the markers to
 * prove which — so the next run resumes at the right place instead of either
 * re-applying or skipping work.
 *
 * The cursor advances only after the loop, and only to the highest ledger whose
 * events all committed.
 */
export async function processBatch(
  events: RawIndexedEvent[],
  deps: IndexerDeps
): Promise<RunResult> {
  const { db, ctx } = deps;
  const result: RunResult = {
    processed: 0, skipped: 0, lastLedger: 0,
    paymentsCreated: 0, paymentsPaid: 0, findings: 0, unattributed: 0,
  };

  // Deterministic order: by ledger, then by paging token. RPC ordering is not
  // something to rely on when a projection's correctness depends on sequence.
  const ordered = [...events].sort(
    (a, b) => a.ledger - b.ledger || a.id.localeCompare(b.id)
  );

  let committedLedger = 0;

  for (const raw of ordered) {
    const parsed = parseCoreFlowEvent(raw.topic0, raw.topic1, raw.value);

    try {
      const applied = await db.$transaction(async (tx: any) => {
        // Idempotency barrier inside the transaction: a concurrent worker that
        // already recorded this token makes the unique constraint reject us,
        // rather than both applying the same event.
        //
        // An UNATTRIBUTED event is deliberately NOT treated as done. It was
        // recorded so it is visible, but nothing was projected — so once an
        // operator claims the escrow, the next run must be able to apply it.
        // Skipping it permanently would mean a claimed escrow silently missing
        // all the history that arrived before the claim.
        const seen = await tx.chainEvent.findUnique({ where: { id: raw.id } });
        if (seen && seen.attributed !== false) return null;

        const effect = parsed
          ? await applyEvent(tx, ctx, parsed, { txHash: raw.txHash, ledger: raw.ledger })
          : { paymentsCreated: 0, paymentsPaid: 0, findings: 0, attributed: true };

        // Upsert, because an unattributed event may be revisited after a claim.
        await tx.chainEvent.upsert({
          where: { id: raw.id },
          update: {
            attributed: effect.attributed,
            processedAt: new Date(),
          },
          create: {
            id: raw.id,
            contractId: ctx.contractId,
            network: ctx.network,
            type: parsed ? parsed.kind : `unknown:${raw.topic0}:${raw.topic1}`,
            ledger: raw.ledger,
            txHash: raw.txHash ?? null,
            escrowOnChainId: parsed && 'escrowId' in parsed ? parsed.escrowId : null,
            paymentIndex:
              parsed && 'paymentIndex' in parsed ? parsed.paymentIndex : null,
            // The decoded payload is stored so a projection bug can be fixed by
            // replaying this log rather than re-reading the chain.
            payload: serializePayload(parsed),
            // Recorded either way. An unattributable event is kept so it can be
            // replayed once an operator claims the escrow, rather than lost.
            attributed: effect.attributed,
          },
        });

        return effect;
      });

      if (applied === null) {
        result.skipped++;
      } else {
        result.processed++;
        result.paymentsCreated += applied.paymentsCreated;
        result.paymentsPaid += applied.paymentsPaid;
        result.findings += applied.findings;
        if (!applied.attributed) {
          result.unattributed++;
          console.warn(`[indexer] unattributed event: ${applied.unattributedReason}`);
        }
      }
      committedLedger = Math.max(committedLedger, raw.ledger);
    } catch (e: any) {
      // A duplicate key on ChainEvent means another worker won the race — not an
      // error worth halting for.
      if (e?.code === 'P2002') {
        result.skipped++;
        committedLedger = Math.max(committedLedger, raw.ledger);
        continue;
      }
      // Anything else: stop. Advancing past an event we failed to apply would
      // lose it permanently, which for a payments ledger is worse than stalling.
      result.lastLedger = committedLedger;
      if (committedLedger > 0) await setCursor(db, ctx, committedLedger);
      throw e;
    }
  }

  result.lastLedger = committedLedger;
  if (committedLedger > 0) await setCursor(db, ctx, committedLedger);
  return result;
}

/**
 * Re-apply stored events that could not be attributed when first seen.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * The cursor advances past every ledger the indexer has read, including ledgers
 * whose events had no tenant mapping. After an operator claims an escrow, those
 * ledgers are behind the cursor and will never be fetched again — so without a
 * replay path a claimed escrow would silently be missing all the history that
 * arrived before the claim.
 *
 * This is the reason `ChainEvent.payload` stores the DECODED event: the projection
 * can be rebuilt from the log rather than re-read from the chain. Re-reading would
 * also work but is not equivalent — the chain returns current state, while the log
 * returns what happened.
 *
 * Idempotent: an event that attributes successfully is flagged and not revisited;
 * one that still cannot be attributed stays pending.
 */
export async function replayUnattributed(
  db: any,
  ctx: IndexerContext,
  opts: { limit?: number } = {}
): Promise<{ examined: number; applied: number; stillUnattributed: number; paymentsCreated: number; paymentsPaid: number }> {
  const pending = await db.chainEvent.findMany({
    where: { attributed: false, contractId: ctx.contractId, network: ctx.network },
    // Chronological, so a payment is created before it is marked paid.
    orderBy: [{ ledger: 'asc' }, { id: 'asc' }],
    take: opts.limit ?? 1000,
  });

  const out = { examined: pending.length, applied: 0, stillUnattributed: 0, paymentsCreated: 0, paymentsPaid: 0 };

  for (const row of pending) {
    const ev = deserializePayload(row.payload);
    if (!ev) {
      // Unparseable or an unknown event type: nothing to project, so it is not
      // "pending" in any useful sense.
      await db.chainEvent.update({ where: { id: row.id }, data: { attributed: true } });
      continue;
    }

    try {
      const effect = await db.$transaction(async (tx: any) => {
        const applied = await applyEvent(tx, ctx, ev, {
          txHash: row.txHash ?? undefined,
          ledger: row.ledger,
        });
        await tx.chainEvent.update({
          where: { id: row.id },
          data: { attributed: applied.attributed, processedAt: new Date() },
        });
        return applied;
      });

      if (effect.attributed) {
        out.applied++;
        out.paymentsCreated += effect.paymentsCreated;
        out.paymentsPaid += effect.paymentsPaid;
      } else {
        out.stillUnattributed++;
      }
    } catch (e: any) {
      // One bad event must not block the rest of the backlog.
      console.error(`[indexer] replay failed for ${row.id}: ${e?.message}`);
      out.stillUnattributed++;
    }
  }

  return out;
}

/** Rebuild a typed event from a stored payload, reversing serializePayload. */
function deserializePayload(payload: any): CoreFlowEvent | null {
  if (!payload || typeof payload !== 'object' || !payload.kind) return null;

  // These fields were stringified on the way in because JSON has no bigint.
  const BIGINT_FIELDS = [
    'totalAmount', 'amountBaseUnits', 'rateBaseUnits',
    'periodStart', 'periodEnd', 'hours',
  ];
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(payload)) {
    out[k] = BIGINT_FIELDS.includes(k) && typeof v === 'string' ? BigInt(v) : v;
  }
  return out as unknown as CoreFlowEvent;
}

/** JSON-safe payload: bigint is not serializable, so it is stored as a string. */
function serializePayload(parsed: CoreFlowEvent | null): any {
  if (!parsed) return null;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(parsed)) {
    out[k] = typeof v === 'bigint' ? v.toString() : v;
  }
  return out;
}
