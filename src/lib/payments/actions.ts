/**
 * Business actions on payments.
 *
 * Routes expose ACTIONS — approve, reject, submit, cancel, retry, reconcile —
 * and this layer decides the resulting state. There is deliberately no
 * "set status to X" operation: letting a caller name the destination state makes
 * the state machine advisory, and the one state a caller would most like to name
 * is PAID.
 *
 * Idempotency is built in rather than bolted on. In payroll, a retried request
 * after a timeout must not produce a second payment, so every action that can
 * reach the chain is keyed and replays its original outcome.
 */

import { PaymentState, OrgRole, ApprovalDecision, TxKind, TxStatus } from '@prisma/client';
import { transitionPayment, recordAuditEvent, type TransitionOutcome } from './service';
import { actorFromMembership, findPaymentForMember, type Membership } from './authz';
import type { Actor } from './state-machine';

export interface ActionContext {
  db: any;
  membership: Membership;
  paymentId: string;
  /** Caller-supplied key, from the `Idempotency-Key` header. */
  idempotencyKey?: string;
  reason?: string;
}

export type ActionResult =
  | { ok: true; status: 200 | 201; body: Record<string, unknown> }
  | { ok: false; status: 400 | 401 | 403 | 404 | 409; message: string; code?: string };

function outcomeToResult(
  outcome: TransitionOutcome,
  extra: Record<string, unknown> = {}
): ActionResult {
  if (!outcome.ok) {
    return { ok: false, status: outcome.status, message: outcome.message, code: outcome.code };
  }
  return {
    ok: true,
    status: 200,
    body: {
      previousState: outcome.previousState,
      state: outcome.newState,
      // Distinguishes "we just did it" from "it was already done", so a client
      // retrying after a timeout is not told it changed something twice.
      changed: outcome.changed,
      ...(outcome.changed ? {} : { note: outcome.note }),
      ...extra,
    },
  };
}

/**
 * Approve a payment in the caller's own role.
 *
 * The ROLE IS NOT A PARAMETER. Taking it from the request body would let a
 * manager submit `{role: 'FINANCE'}` and satisfy both halves of the dual-approval
 * gate alone — the exact property the contract enforces with SignersNotDistinct.
 * It is derived from membership instead.
 *
 * This records an off-chain approval decision. The authoritative approval is the
 * on-chain signature, which the indexer observes; this is the workflow record of
 * who decided what, and it does not by itself advance a payment to settlement.
 */
export async function approvePayment(ctx: ActionContext): Promise<ActionResult> {
  const { db, membership } = ctx;

  const role = membership.role;
  if (role !== OrgRole.MANAGER && role !== OrgRole.FINANCE &&
      role !== OrgRole.OWNER && role !== OrgRole.ADMIN) {
    return { ok: false, status: 403, message: 'Your role cannot approve payments.' };
  }

  const found = await findPaymentForMember(db, membership, ctx.paymentId);
  if (!found.ok) return { ok: false, status: found.status, message: found.message };
  const payment = found.value;

  // Which half of the gate this caller is exercising, from their role alone.
  const approvalRole =
    role === OrgRole.FINANCE
      ? OrgRole.FINANCE
      : role === OrgRole.MANAGER
        ? OrgRole.MANAGER
        : // OWNER/ADMIN act for whichever approval the payment is waiting on, and
          // cannot supply both: the second call finds its role already recorded.
          payment.state === PaymentState.AWAITING_FINANCE
          ? OrgRole.FINANCE
          : OrgRole.MANAGER;

  const existing = await db.approval.findUnique({
    where: { paymentId_role: { paymentId: payment.id, role: approvalRole } },
  });
  if (existing) {
    return {
      ok: true,
      status: 200,
      body: {
        state: payment.state,
        changed: false,
        note: `${approvalRole} has already recorded a decision on this payment.`,
        decision: existing.decision,
      },
    };
  }

  // Separation of duties, enforced off-chain as well as on: the same wallet must
  // not hold both halves. The contract rejects it too, but failing here gives the
  // operator a readable reason instead of a trapped transaction.
  const other = await db.approval.findFirst({
    where: {
      paymentId: payment.id,
      role: approvalRole === OrgRole.MANAGER ? OrgRole.FINANCE : OrgRole.MANAGER,
    },
  });
  if (other && other.actorAddress === membership.walletAddress) {
    return {
      ok: false,
      status: 409,
      message:
        'You already recorded the other approval on this payment. CoreFlow ' +
        'requires two distinct approvers.',
    };
  }

  await db.approval.create({
    data: {
      // REQUIRED. Approval's parent relation is a composite foreign key on
      // (orgId, paymentId), so the tenant is part of the row's identity rather
      // than something to be reached by joining through the payment.
      orgId: membership.orgId,
      paymentId: payment.id,
      role: approvalRole,
      decision: ApprovalDecision.APPROVED,
      actorAddress: membership.walletAddress,
      reason: ctx.reason ?? null,
    },
  });

  await recordAuditEvent(db, {
    orgId: membership.orgId,
    type: 'approval.granted',
    actor: actorFromMembership(membership),
    paymentId: payment.id,
    batchId: payment.batchId,
    escrowId: payment.escrowId ?? undefined,
    metadata: { role: approvalRole, decision: 'APPROVED' },
  });

  return {
    ok: true,
    status: 201,
    body: {
      state: payment.state,
      changed: false,
      approvalRole,
      note:
        'Approval recorded. The payment advances when the corresponding on-chain ' +
        'signature is observed by the indexer.',
    },
  };
}

/** Decline a payment. Terminal. */
export async function rejectPayment(ctx: ActionContext): Promise<ActionResult> {
  const { db, membership } = ctx;
  if (!ctx.reason || ctx.reason.trim().length < 3) {
    // A rejection without a reason is unauditable: nobody downstream can tell
    // whether it was a data error, a dispute, or a mistake.
    return { ok: false, status: 400, message: 'A reason is required to reject a payment.' };
  }

  const found = await findPaymentForMember(db, membership, ctx.paymentId);
  if (!found.ok) return { ok: false, status: found.status, message: found.message };
  const payment = found.value;

  const outcome = await transitionPayment(db, {
    paymentId: payment.id,
    to: PaymentState.REJECTED,
    actor: actorFromMembership(membership),
    orgId: membership.orgId,
    reason: ctx.reason,
    metadata: { action: 'reject' },
  });

  if (outcome.ok && outcome.changed) {
    await db.approval.upsert({
      where: {
        paymentId_role: {
          paymentId: payment.id,
          role: membership.role === OrgRole.FINANCE ? OrgRole.FINANCE : OrgRole.MANAGER,
        },
      },
      create: {
        // REQUIRED, for the same reason as in approvePayment: the composite
        // foreign key makes the tenant part of the row's identity.
        orgId: membership.orgId,
        paymentId: payment.id,
        role: membership.role === OrgRole.FINANCE ? OrgRole.FINANCE : OrgRole.MANAGER,
        decision: ApprovalDecision.REJECTED,
        actorAddress: membership.walletAddress,
        reason: ctx.reason,
      },
      update: { decision: ApprovalDecision.REJECTED, reason: ctx.reason },
    });
  }

  return outcomeToResult(outcome);
}

/** Withdraw a payment before settlement. */
export async function cancelPayment(ctx: ActionContext): Promise<ActionResult> {
  const { db, membership } = ctx;
  const found = await findPaymentForMember(db, membership, ctx.paymentId);
  if (!found.ok) return { ok: false, status: found.status, message: found.message };

  return outcomeToResult(
    await transitionPayment(db, {
      paymentId: found.value.id,
      to: PaymentState.CANCELLED,
      actor: actorFromMembership(membership),
      orgId: membership.orgId,
      reason: ctx.reason ?? 'Cancelled by operator.',
      metadata: { action: 'cancel' },
    })
  );
}

/**
 * Begin settlement.
 *
 * Moves the payment to SUBMITTING and records a BlockchainTransaction attempt
 * keyed by the caller's idempotency key. SUBMITTING is explicitly NOT paid; the
 * indexer decides that later from the chain.
 *
 * A repeat request with the same key returns the ORIGINAL attempt rather than
 * starting a second one. That is the difference between a retried request and a
 * duplicated payment.
 */
export async function submitPaymentForSettlement(ctx: ActionContext): Promise<ActionResult> {
  const { db, membership } = ctx;

  if (!ctx.idempotencyKey) {
    return {
      ok: false,
      status: 400,
      message:
        'An Idempotency-Key header is required to submit a settlement, so a ' +
        'retried request cannot pay twice.',
    };
  }

  const found = await findPaymentForMember(db, membership, ctx.paymentId);
  if (!found.ok) return { ok: false, status: found.status, message: found.message };
  const payment = found.value;

  // Replay of a known key: hand back what happened the first time.
  const existing = await db.blockchainTransaction.findUnique({
    where: { idempotencyKey: ctx.idempotencyKey },
  });
  if (existing) {
    if (existing.paymentId !== payment.id) {
      return {
        ok: false,
        status: 409,
        message: 'That Idempotency-Key was already used for a different payment.',
      };
    }
    const current = await db.payment.findUnique({
      where: { id: payment.id },
      select: { state: true },
    });
    return {
      ok: true,
      status: 200,
      body: {
        state: current?.state ?? payment.state,
        changed: false,
        note: 'This settlement request was already accepted.',
        transaction: {
          id: existing.id,
          status: existing.status,
          hash: existing.hash,
          attempt: existing.attempt,
        },
      },
    };
  }

  const outcome = await transitionPayment(db, {
    paymentId: payment.id,
    to: PaymentState.SUBMITTING,
    actor: actorFromMembership(membership),
    orgId: membership.orgId,
    metadata: { action: 'submit', idempotencyKey: ctx.idempotencyKey },
  });
  if (!outcome.ok) {
    return { ok: false, status: outcome.status, message: outcome.message, code: outcome.code };
  }

  const priorAttempts = await db.blockchainTransaction.count({
    where: { paymentId: payment.id, kind: TxKind.PAY_BATCH },
  });

  const tx = await db.blockchainTransaction.create({
    data: {
      orgId: membership.orgId,
      paymentId: payment.id,
      escrowId: payment.escrowId,
      kind: TxKind.PAY_BATCH,
      status: TxStatus.PREPARING,
      idempotencyKey: ctx.idempotencyKey,
      attempt: priorAttempts + 1,
      contractId: payment.assetContractId ?? null,
    },
  });

  return outcomeToResult(outcome, {
    transaction: { id: tx.id, status: tx.status, attempt: tx.attempt },
  });
}

/**
 * Retry a payment whose submission never reached the chain.
 *
 * Only valid from SUBMISSION_FAILED. A payment in SETTLEMENT_FAILED reached the
 * chain, and what it did there must be established by reconciliation before
 * anything is resubmitted — so this refuses, with an explanation, rather than
 * silently doing something riskier than the caller asked for.
 */
export async function retryPayment(ctx: ActionContext): Promise<ActionResult> {
  const { db, membership } = ctx;
  const found = await findPaymentForMember(db, membership, ctx.paymentId);
  if (!found.ok) return { ok: false, status: found.status, message: found.message };
  const payment = found.value;

  if (payment.state === PaymentState.SETTLEMENT_FAILED) {
    return {
      ok: false,
      status: 409,
      message:
        'This transaction reached Stellar and failed there. Run reconciliation ' +
        'to establish what the chain actually did before retrying.',
      code: 'RECONCILIATION_FIRST',
    };
  }

  return outcomeToResult(
    await transitionPayment(db, {
      paymentId: payment.id,
      to: PaymentState.READY_TO_SETTLE,
      actor: actorFromMembership(membership),
      orgId: membership.orgId,
      reason: ctx.reason ?? 'Retried after a failed submission.',
      metadata: { action: 'retry' },
    })
  );
}

/** Mark a payment as needing operator reconciliation. */
export async function flagForReconciliation(ctx: ActionContext): Promise<ActionResult> {
  const { db, membership } = ctx;
  if (membership.role !== OrgRole.OWNER && membership.role !== OrgRole.ADMIN) {
    return {
      ok: false,
      status: 403,
      message: 'Only an organization owner or admin can flag a payment for reconciliation.',
    };
  }

  const found = await findPaymentForMember(db, membership, ctx.paymentId);
  if (!found.ok) return { ok: false, status: found.status, message: found.message };

  const actor: Actor = { kind: 'reconciler', system: 'reconciler', address: membership.walletAddress };
  const outcome = await transitionPayment(db, {
    paymentId: found.value.id,
    to: PaymentState.RECONCILIATION_REQUIRED,
    actor,
    orgId: membership.orgId,
    reason: ctx.reason ?? 'Flagged for reconciliation by an operator.',
    metadata: { action: 'reconcile' },
  });
  return outcomeToResult(outcome);
}
