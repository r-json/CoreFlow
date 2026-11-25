/**
 * Payment transition service.
 *
 * Every state change in the system goes through `transitionPayment`. That is the
 * point: a single chokepoint means the transition table, the audit trail, and
 * the concurrency guard cannot be bypassed by a route handler that forgot one of
 * them. Routes express business ACTIONS (approve, settle, retry); this decides
 * the resulting state.
 */

import { PaymentState, Prisma } from '@prisma/client';
import {
  checkTransition,
  describeState,
  type Actor,
  type TransitionErrorCode,
} from './state-machine';

export interface TransitionRequest {
  paymentId: string;
  to: PaymentState;
  actor: Actor;
  /** Tenant scope. A transition is only ever applied within one organization. */
  orgId: string;
  /** Operator-readable explanation, stored on the payment for failure states. */
  reason?: string;
  txHash?: string;
  /** Extra context recorded on the audit event. */
  metadata?: Prisma.InputJsonValue;
  /** Set alongside PAID. */
  settledAt?: Date;
}

export type TransitionOutcome =
  | { ok: true; previousState: PaymentState; newState: PaymentState; changed: true }
  | { ok: true; previousState: PaymentState; newState: PaymentState; changed: false; note: string }
  | {
      ok: false;
      status: 404 | 409 | 403;
      code: TransitionErrorCode | 'NOT_FOUND' | 'CONCURRENT_MODIFICATION';
      message: string;
    };

/**
 * Apply a state transition, atomically, with an audit record.
 *
 * Concurrency: the update is a compare-and-swap on the CURRENT state
 * (`where: { id, state: from }`). Two approvals racing, or an indexer running
 * while a user acts, would otherwise both read the same prior state and both
 * write — losing one transition and its audit entry. If the swap matches zero
 * rows, someone else moved the payment first and we report that rather than
 * overwriting their work.
 *
 * Idempotency: re-requesting a transition that has ALREADY been applied returns
 * `changed: false` instead of an error. An indexer re-processing an event, or a
 * user double-clicking approve, is a duplicate — not a failure.
 */
export async function transitionPayment(
  db: any,
  req: TransitionRequest
): Promise<TransitionOutcome> {
  // Opens its own transaction. Callers ALREADY inside one must use
  // `applyTransition` instead: Prisma's interactive transaction client has no
  // `$transaction` method, so nesting throws at runtime.
  return db.$transaction((tx: any) => applyTransition(tx, req));
}

/**
 * The transition itself, assuming an ambient transaction.
 *
 * Separated from {@link transitionPayment} because the indexer applies a whole
 * event — state change, audit record and the ChainEvent marker — inside ONE
 * transaction, so a crash cannot leave half an event applied. It therefore has a
 * `tx` in hand already and must not try to open another.
 */
export async function applyTransition(
  db: any,
  req: TransitionRequest
): Promise<TransitionOutcome> {
  const payment = await db.payment.findFirst({
    where: { id: req.paymentId, orgId: req.orgId },
    select: { id: true, state: true, orgId: true, batchId: true, escrowId: true },
  });

  if (!payment) {
    return { ok: false, status: 404, code: 'NOT_FOUND', message: 'Payment not found.' };
  }

  // Already there: a duplicate request, not an error. Reported distinctly so
  // callers can tell "nothing to do" from "we just did it".
  if (payment.state === req.to) {
    return {
      ok: true,
      previousState: payment.state,
      newState: req.to,
      changed: false,
      note: `Payment was already ${req.to}.`,
    };
  }

  const check = checkTransition(payment.state, req.to, req.actor);
  if (!check.ok) {
    // A role or actor problem is a 403; anything else is a state conflict.
    const status =
      check.code === 'ROLE_NOT_PERMITTED' ||
      check.code === 'ACTOR_NOT_PERMITTED' ||
      check.code === 'ROLE_REQUIRED'
        ? 403
        : 409;
    return { ok: false, status, code: check.code, message: check.message };
  }

  const now = new Date();

  {
    const tx = db;
    // Compare-and-swap: only applies if nobody changed the state since we read.
    const updated = await tx.payment.updateMany({
      where: { id: payment.id, orgId: req.orgId, state: payment.state },
      data: {
        state: req.to,
        stateUpdatedAt: now,
        stateReason: req.reason ?? null,
        ...(req.txHash ? { settlementTxHash: req.txHash } : {}),
        ...(req.to === PaymentState.PAID
          ? { settledAt: req.settledAt ?? now }
          : {}),
      },
    });

    if (updated.count === 0) {
      return {
        ok: false as const,
        status: 409 as const,
        code: 'CONCURRENT_MODIFICATION' as const,
        message:
          'The payment changed state while this request was in flight. ' +
          'Re-read it and try again.',
      };
    }

    await tx.auditEvent.create({
      data: {
        orgId: req.orgId,
        type: 'payment.state.changed',
        actorAddress: req.actor.address ?? null,
        actorSystem: req.actor.kind === 'user' ? null : req.actor.system ?? req.actor.kind,
        paymentId: payment.id,
        batchId: payment.batchId,
        escrowId: payment.escrowId,
        previousState: payment.state,
        newState: req.to,
        txHash: req.txHash ?? null,
        metadata: {
          actorKind: req.actor.kind,
          ...(req.actor.role ? { actorRole: req.actor.role } : {}),
          transitionReason: check.transition.reason,
          ...(req.reason ? { operatorReason: req.reason } : {}),
          ...(req.metadata && typeof req.metadata === 'object' ? req.metadata : {}),
        } as Prisma.InputJsonValue,
      },
    });

    return {
      ok: true as const,
      previousState: payment.state,
      newState: req.to,
      changed: true as const,
    };
  }
}

/**
 * Record an audit event that is not itself a state transition (an approval being
 * requested, a reconciliation finding opened, a batch uploaded).
 */
export async function recordAuditEvent(
  db: any,
  input: {
    orgId: string;
    type: string;
    actor?: Actor;
    paymentId?: string;
    batchId?: string;
    escrowId?: string;
    txHash?: string;
    metadata?: Prisma.InputJsonValue;
  }
): Promise<void> {
  await db.auditEvent.create({
    data: {
      orgId: input.orgId,
      type: input.type,
      actorAddress: input.actor?.address ?? null,
      actorSystem:
        input.actor && input.actor.kind !== 'user'
          ? input.actor.system ?? input.actor.kind
          : null,
      paymentId: input.paymentId ?? null,
      batchId: input.batchId ?? null,
      escrowId: input.escrowId ?? null,
      txHash: input.txHash ?? null,
      metadata: input.metadata ?? undefined,
    },
  });
}

/**
 * Derive a batch's standing from its payments.
 *
 * Computed, never stored. A persisted rollup is a second copy of mutable truth
 * and will eventually disagree with the payments it claims to summarize — and
 * when it does, it is the copy people have already acted on.
 */
export interface BatchRollup {
  total: number;
  byState: Record<string, number>;
  totalAmountBaseUnits: bigint;
  paidAmountBaseUnits: bigint;
  needsAttention: number;
  /** The least-advanced meaningful state, for a single-line summary. */
  headline: string;
}

const PROGRESS_ORDER: readonly PaymentState[] = [
  PaymentState.DRAFT,
  PaymentState.VALIDATING,
  PaymentState.AWAITING_ORACLE,
  PaymentState.ORACLE_VERIFIED,
  PaymentState.AWAITING_MANAGER,
  PaymentState.AWAITING_FINANCE,
  PaymentState.READY_TO_SETTLE,
  PaymentState.SUBMITTING,
  PaymentState.CONFIRMING,
  PaymentState.PAID,
];

export function rollupBatch(
  payments: readonly { state: PaymentState; amountBaseUnits: bigint }[]
): BatchRollup {
  const byState: Record<string, number> = {};
  let totalAmount = 0n;
  let paidAmount = 0n;
  let needsAttention = 0;

  for (const p of payments) {
    byState[p.state] = (byState[p.state] ?? 0) + 1;
    totalAmount += p.amountBaseUnits;
    if (p.state === PaymentState.PAID) paidAmount += p.amountBaseUnits;
    if (describeState(p.state).needsAttention) needsAttention++;
  }

  // A batch containing anything broken is reported as broken. Summarising by the
  // most common state would let a failure hide inside a mostly-healthy batch,
  // which is precisely the one a finance team needs to see.
  const states = payments.map((p) => p.state);
  const BROKEN_STATES: readonly PaymentState[] = [
    PaymentState.RECONCILIATION_REQUIRED,
    PaymentState.SETTLEMENT_FAILED,
    PaymentState.SUBMISSION_FAILED,
    PaymentState.EXPIRED,
  ];
  const broken = states.find((s) => BROKEN_STATES.includes(s));

  let headline: string;
  if (payments.length === 0) {
    headline = 'Empty';
  } else if (broken) {
    headline = describeState(broken).label;
  } else {
    const least = PROGRESS_ORDER.find((s) => states.includes(s));
    headline = least ? describeState(least).label : describeState(states[0]).label;
  }

  return {
    total: payments.length,
    byState,
    totalAmountBaseUnits: totalAmount,
    paidAmountBaseUnits: paidAmount,
    needsAttention,
    headline,
  };
}
