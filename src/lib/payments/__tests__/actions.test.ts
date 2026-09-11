// @vitest-environment node
/**
 * Payment action and tenant-isolation tests.
 *
 * Two properties dominate here:
 *   1. A user from Organization A cannot read or mutate Organization B's
 *      payments by changing an id — and cannot even learn that the id exists.
 *   2. A retried financial mutation does not produce a second payment.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { PaymentState, OrgRole, ApprovalDecision, TxStatus } from '@prisma/client';
import { createFakeDb, seedOrg, seedMember, type FakeDb } from './fake-db';
import { resolveMembership, findPaymentForMember, canRead } from '../authz';
import {
  approvePayment, rejectPayment, cancelPayment,
  submitPaymentForSettlement, retryPayment, flagForReconciliation,
} from '../actions';
import { transitionPayment, rollupBatch } from '../service';

const ORG_A = 'org_a';
const ORG_B = 'org_b';

let db: FakeDb;

/** Seed two tenants, each with their own payment and a full role set. */
function seedTwoTenants() {
  for (const [org, slug] of [[ORG_A, 'a'], [ORG_B, 'b']] as const) {
    db.__tables.organization.rows.push({ id: org, name: org, slug });
  }
  seedMember(db, ORG_A, 'u_a_owner', OrgRole.OWNER, 'G' + 'A'.repeat(55));
  seedMember(db, ORG_A, 'u_a_mgr', OrgRole.MANAGER, 'G' + 'M'.repeat(55));
  seedMember(db, ORG_A, 'u_a_fin', OrgRole.FINANCE, 'G' + 'F'.repeat(55));
  seedMember(db, ORG_A, 'u_a_view', OrgRole.VIEWER, 'G' + 'V'.repeat(55));
  seedMember(db, ORG_A, 'u_a_work', OrgRole.WORKER, 'G' + 'W'.repeat(55));
  seedMember(db, ORG_B, 'u_b_owner', OrgRole.OWNER, 'G' + 'B'.repeat(55));

  db.__tables.payrollBatch.rows.push(
    { id: 'bat_a', orgId: ORG_A, reference: 'CF-00001' },
    { id: 'bat_b', orgId: ORG_B, reference: 'CF-00002' }
  );
  const base = {
    recipientAddress: 'G' + 'R'.repeat(55),
    onChainPaymentIndex: 0,
    assetCode: 'USDC', assetDecimals: 7,
    amountBaseUnits: 10_000_000_000n, rateBaseUnits: 250_000_000n, hours: 40n,
    stateUpdatedAt: new Date(), createdAt: new Date(),
  };
  db.__tables.payment.rows.push(
    { id: 'pay_a', orgId: ORG_A, batchId: 'bat_a', escrowId: 'esc_a', state: PaymentState.READY_TO_SETTLE, ...base },
    { id: 'pay_b', orgId: ORG_B, batchId: 'bat_b', escrowId: 'esc_b', state: PaymentState.READY_TO_SETTLE, ...base }
  );
}

beforeEach(() => {
  db = createFakeDb();
  seedTwoTenants();
});

const member = async (userId: string, orgId: string) => {
  const r = await resolveMembership(db, userId, orgId);
  if (!r.ok) throw new Error(`expected membership: ${r.message}`);
  return r.value;
};

describe('tenant isolation', () => {
  it('reports a foreign organization as not found, not forbidden', async () => {
    // A 403 would confirm the organization exists, letting anyone enumerate
    // tenants by id.
    const r = await resolveMembership(db, 'u_a_owner', ORG_B);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(404);
  });

  it('refuses to load another tenant’s payment by id', async () => {
    const m = await member('u_a_owner', ORG_A);
    const r = await findPaymentForMember(db, m, 'pay_b');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(404);
  });

  it('loads the caller’s own payment', async () => {
    const m = await member('u_a_owner', ORG_A);
    const r = await findPaymentForMember(db, m, 'pay_a');
    expect(r.ok).toBe(true);
  });

  it.each([
    ['approve', approvePayment],
    ['reject', rejectPayment],
    ['cancel', cancelPayment],
    ['retry', retryPayment],
    ['reconcile', flagForReconciliation],
    ['submit', submitPaymentForSettlement],
  ] as const)('refuses cross-tenant %s', async (_name, action) => {
    const m = await member('u_a_owner', ORG_A);
    const r = await action({
      db, membership: m, paymentId: 'pay_b',
      reason: 'cross-tenant attempt', idempotencyKey: 'key-x',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(404);

    // And the foreign payment is untouched.
    expect(db.__tables.payment.rows.find((p) => p.id === 'pay_b')!.state)
      .toBe(PaymentState.READY_TO_SETTLE);
  });

  it('refuses a transition scoped to the wrong organization', async () => {
    const r = await transitionPayment(db, {
      paymentId: 'pay_b', to: PaymentState.CANCELLED,
      actor: { kind: 'user', role: OrgRole.OWNER, address: 'GA' },
      orgId: ORG_A, // caller's org, payment belongs to B
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(404);
  });

  it('writes no audit event for a refused cross-tenant action', async () => {
    const m = await member('u_a_owner', ORG_A);
    await cancelPayment({ db, membership: m, paymentId: 'pay_b' });
    expect(db.__tables.auditEvent.rows).toHaveLength(0);
  });

  it('excludes WORKER from payment reads', () => {
    expect(canRead(OrgRole.WORKER)).toBe(false);
    expect(canRead(OrgRole.VIEWER)).toBe(true);
  });
});

describe('approval and separation of duties', () => {
  it('derives the approval role from membership, never from the request', async () => {
    const mgr = await member('u_a_mgr', ORG_A);
    const r = await approvePayment({ db, membership: mgr, paymentId: 'pay_a' });
    expect(r.ok).toBe(true);
    const approval = db.__tables.approval.rows[0];
    expect(approval.role).toBe(OrgRole.MANAGER);
    expect(approval.decision).toBe(ApprovalDecision.APPROVED);
  });

  it('does not advance the payment on an off-chain approval', async () => {
    // The authoritative approval is the on-chain signature. Recording a decision
    // here must not move the payment, or the dashboard would show an approval the
    // chain never received.
    const mgr = await member('u_a_mgr', ORG_A);
    await approvePayment({ db, membership: mgr, paymentId: 'pay_a' });
    expect(db.__tables.payment.rows.find((p) => p.id === 'pay_a')!.state)
      .toBe(PaymentState.READY_TO_SETTLE);
  });

  it('treats a repeat approval as a duplicate, not a second fact', async () => {
    const mgr = await member('u_a_mgr', ORG_A);
    await approvePayment({ db, membership: mgr, paymentId: 'pay_a' });
    const second = await approvePayment({ db, membership: mgr, paymentId: 'pay_a' });

    expect(second.ok).toBe(true);
    if (second.ok) expect(second.body.changed).toBe(false);
    expect(db.__tables.approval.rows).toHaveLength(1);
  });

  it('records manager and finance as separate approvals', async () => {
    await approvePayment({ db, membership: await member('u_a_mgr', ORG_A), paymentId: 'pay_a' });
    await approvePayment({ db, membership: await member('u_a_fin', ORG_A), paymentId: 'pay_a' });

    const roles = db.__tables.approval.rows.map((a) => a.role).sort();
    expect(roles).toEqual([OrgRole.FINANCE, OrgRole.MANAGER].sort());
  });

  it('refuses one wallet supplying both halves of the gate', async () => {
    // An OWNER acts for whichever approval is outstanding. Having recorded one,
    // the same wallet must not be able to record the other.
    const owner = await member('u_a_owner', ORG_A);
    const first = await approvePayment({ db, membership: owner, paymentId: 'pay_a' });
    expect(first.ok).toBe(true);

    // Move the payment so the owner would now be asked for the finance half.
    db.__tables.payment.rows.find((p) => p.id === 'pay_a')!.state = PaymentState.AWAITING_FINANCE;

    const second = await approvePayment({ db, membership: owner, paymentId: 'pay_a' });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.status).toBe(409);
    expect(db.__tables.approval.rows).toHaveLength(1);
  });

  it.each([OrgRole.VIEWER, OrgRole.WORKER])('refuses %s approving', async (role) => {
    seedMember(db, ORG_A, `u_${role}`, role, `G${role}`.padEnd(56, 'X'));
    const m = await member(`u_${role}`, ORG_A);
    const r = await approvePayment({ db, membership: m, paymentId: 'pay_a' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(403);
  });
});

describe('rejection', () => {
  it('requires a reason', async () => {
    // An unexplained rejection is unauditable: nobody downstream can tell a data
    // error from a dispute.
    const fin = await member('u_a_fin', ORG_A);
    const r = await rejectPayment({ db, membership: fin, paymentId: 'pay_a' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(400);
  });

  it('refuses a MANAGER rejecting at the finance stage', async () => {
    db.__tables.payment.rows.find((p) => p.id === 'pay_a')!.state = PaymentState.AWAITING_FINANCE;
    const mgr = await member('u_a_mgr', ORG_A);
    const r = await rejectPayment({
      db, membership: mgr, paymentId: 'pay_a', reason: 'Not my decision to make',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(403);
  });

  it('lets FINANCE reject at the finance stage and records the decision', async () => {
    db.__tables.payment.rows.find((p) => p.id === 'pay_a')!.state = PaymentState.AWAITING_FINANCE;
    const fin = await member('u_a_fin', ORG_A);
    const r = await rejectPayment({ db, membership: fin, paymentId: 'pay_a', reason: 'Duplicate invoice' });

    expect(r.ok).toBe(true);
    expect(db.__tables.payment.rows.find((p) => p.id === 'pay_a')!.state).toBe(PaymentState.REJECTED);
    expect(db.__tables.approval.rows[0].decision).toBe(ApprovalDecision.REJECTED);
    expect(db.__tables.approval.rows[0].reason).toBe('Duplicate invoice');
  });
});

describe('settlement submission idempotency', () => {
  it('requires an idempotency key', async () => {
    const mgr = await member('u_a_mgr', ORG_A);
    const r = await submitPaymentForSettlement({ db, membership: mgr, paymentId: 'pay_a' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(400);
  });

  it('records one attempt and moves the payment to SUBMITTING', async () => {
    const mgr = await member('u_a_mgr', ORG_A);
    const r = await submitPaymentForSettlement({
      db, membership: mgr, paymentId: 'pay_a', idempotencyKey: 'idem-1',
    });
    expect(r.ok).toBe(true);
    expect(db.__tables.payment.rows.find((p) => p.id === 'pay_a')!.state).toBe(PaymentState.SUBMITTING);
    expect(db.__tables.blockchainTransaction.rows).toHaveLength(1);
    expect(db.__tables.blockchainTransaction.rows[0].attempt).toBe(1);
  });

  it('replays the original attempt for a repeated key — the double-pay guard', async () => {
    // This is the property that matters most in payroll: a client that times out
    // and retries must not cause a second payment.
    const mgr = await member('u_a_mgr', ORG_A);
    const first = await submitPaymentForSettlement({
      db, membership: mgr, paymentId: 'pay_a', idempotencyKey: 'idem-2',
    });
    const second = await submitPaymentForSettlement({
      db, membership: mgr, paymentId: 'pay_a', idempotencyKey: 'idem-2',
    });

    expect(first.ok && second.ok).toBe(true);
    if (second.ok) expect(second.body.changed).toBe(false);
    expect(db.__tables.blockchainTransaction.rows).toHaveLength(1);
  });

  it('refuses a key already used for a different payment', async () => {
    const mgrA = await member('u_a_mgr', ORG_A);
    db.__tables.payment.rows.push({
      id: 'pay_a2', orgId: ORG_A, batchId: 'bat_a', escrowId: 'esc_a',
      state: PaymentState.READY_TO_SETTLE, onChainPaymentIndex: 1,
      recipientAddress: 'GX', assetDecimals: 7, assetCode: 'USDC',
      amountBaseUnits: 1n, rateBaseUnits: 1n, hours: 1n,
      stateUpdatedAt: new Date(), createdAt: new Date(),
    });

    await submitPaymentForSettlement({ db, membership: mgrA, paymentId: 'pay_a', idempotencyKey: 'shared' });
    const r = await submitPaymentForSettlement({ db, membership: mgrA, paymentId: 'pay_a2', idempotencyKey: 'shared' });

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(409);
  });

  it('does not reach PAID', async () => {
    const mgr = await member('u_a_mgr', ORG_A);
    await submitPaymentForSettlement({ db, membership: mgr, paymentId: 'pay_a', idempotencyKey: 'idem-3' });
    expect(db.__tables.payment.rows.find((p) => p.id === 'pay_a')!.state).not.toBe(PaymentState.PAID);
  });

  it('refuses submission from a state that is not ready', async () => {
    db.__tables.payment.rows.find((p) => p.id === 'pay_a')!.state = PaymentState.AWAITING_ORACLE;
    const mgr = await member('u_a_mgr', ORG_A);
    const r = await submitPaymentForSettlement({
      db, membership: mgr, paymentId: 'pay_a', idempotencyKey: 'idem-4',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(409);
  });

  it('numbers a genuine second attempt after a failed submission', async () => {
    const mgr = await member('u_a_mgr', ORG_A);
    await submitPaymentForSettlement({ db, membership: mgr, paymentId: 'pay_a', idempotencyKey: 'a1' });

    // Submission failed; operator retries, then submits again with a NEW key.
    db.__tables.payment.rows.find((p) => p.id === 'pay_a')!.state = PaymentState.SUBMISSION_FAILED;
    await retryPayment({ db, membership: mgr, paymentId: 'pay_a' });
    await submitPaymentForSettlement({ db, membership: mgr, paymentId: 'pay_a', idempotencyKey: 'a2' });

    const attempts = db.__tables.blockchainTransaction.rows.map((t) => t.attempt).sort();
    expect(attempts).toEqual([1, 2]);
  });
});

describe('retry', () => {
  it('allows retry after a submission that never reached the chain', async () => {
    db.__tables.payment.rows.find((p) => p.id === 'pay_a')!.state = PaymentState.SUBMISSION_FAILED;
    const mgr = await member('u_a_mgr', ORG_A);
    const r = await retryPayment({ db, membership: mgr, paymentId: 'pay_a' });

    expect(r.ok).toBe(true);
    expect(db.__tables.payment.rows.find((p) => p.id === 'pay_a')!.state)
      .toBe(PaymentState.READY_TO_SETTLE);
  });

  it('refuses retry after a settlement that DID reach the chain', async () => {
    db.__tables.payment.rows.find((p) => p.id === 'pay_a')!.state = PaymentState.SETTLEMENT_FAILED;
    const owner = await member('u_a_owner', ORG_A);
    const r = await retryPayment({ db, membership: owner, paymentId: 'pay_a' });

    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(409);
      expect(r.code).toBe('RECONCILIATION_FIRST');
    }
  });
});

describe('reconciliation flag', () => {
  it('is restricted to owners and admins', async () => {
    db.__tables.payment.rows.find((p) => p.id === 'pay_a')!.state = PaymentState.CONFIRMING;
    const mgr = await member('u_a_mgr', ORG_A);
    const r = await flagForReconciliation({ db, membership: mgr, paymentId: 'pay_a' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(403);
  });

  it('lets an owner flag a confirming payment', async () => {
    db.__tables.payment.rows.find((p) => p.id === 'pay_a')!.state = PaymentState.CONFIRMING;
    const owner = await member('u_a_owner', ORG_A);
    const r = await flagForReconciliation({ db, membership: owner, paymentId: 'pay_a', reason: 'stuck' });

    expect(r.ok).toBe(true);
    expect(db.__tables.payment.rows.find((p) => p.id === 'pay_a')!.state)
      .toBe(PaymentState.RECONCILIATION_REQUIRED);
  });
});

describe('cancellation authority', () => {
  it('refuses a user cancelling a payment whose approvals are already on-chain', async () => {
    // Escrowed funds are released or refunded by the CONTRACT. Letting an
    // operator mark an approved payment cancelled off-chain would desync the
    // product from custody that is still held on-chain.
    const owner = await member('u_a_owner', ORG_A);
    const r = await cancelPayment({ db, membership: owner, paymentId: 'pay_a', reason: 'changed mind' });

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(403);
    expect(db.__tables.payment.rows.find((p) => p.id === 'pay_a')!.state)
      .toBe(PaymentState.READY_TO_SETTLE);
  });

  it('lets a user cancel before anything is funded', async () => {
    db.__tables.payment.rows.find((p) => p.id === 'pay_a')!.state = PaymentState.DRAFT;
    const mgr = await member('u_a_mgr', ORG_A);
    const r = await cancelPayment({ db, membership: mgr, paymentId: 'pay_a' });
    expect(r.ok).toBe(true);
  });
});

describe('concurrency', () => {
  it('lets only one of two racing transitions win', async () => {
    // Both read READY_TO_SETTLE, both try to move. Without a compare-and-swap
    // both would write, losing one transition and its audit entry.
    const actor = { kind: 'user' as const, role: OrgRole.MANAGER, address: 'GM' };
    const [a, b] = await Promise.all([
      transitionPayment(db, { paymentId: 'pay_a', to: PaymentState.SUBMITTING, actor, orgId: ORG_A }),
      transitionPayment(db, { paymentId: 'pay_a', to: PaymentState.CANCELLED, actor, orgId: ORG_A }),
    ]);

    const winners = [a, b].filter((r) => r.ok && r.changed);
    expect(winners).toHaveLength(1);

    // Exactly one state-change audit row, matching the winner.
    const transitions = db.__tables.auditEvent.rows.filter((e) => e.type === 'payment.state.changed');
    expect(transitions).toHaveLength(1);
  });
});

describe('audit trail', () => {
  it('records actor, previous and new state for a user transition', async () => {
    // Cancelled from DRAFT: once approvals exist on-chain, cancellation is a
    // chain action (cancel_escrow) and the table makes it indexer-only.
    db.__tables.payment.rows.find((p) => p.id === 'pay_a')!.state = PaymentState.DRAFT;
    const mgr = await member('u_a_mgr', ORG_A);
    await cancelPayment({ db, membership: mgr, paymentId: 'pay_a', reason: 'Wrong recipient' });

    const e = db.__tables.auditEvent.rows.find((x) => x.type === 'payment.state.changed');
    expect(e.previousState).toBe(PaymentState.DRAFT);
    expect(e.newState).toBe(PaymentState.CANCELLED);
    expect(e.actorAddress).toBe(mgr.walletAddress);
    expect(e.actorSystem).toBeNull();
    expect(e.orgId).toBe(ORG_A);
    expect(e.metadata.operatorReason).toBe('Wrong recipient');
  });
});

describe('batch rollup', () => {
  const p = (state: PaymentState, amount = 1_000_000_000n) => ({ state, amountBaseUnits: amount });

  it('is derived, never stored', () => {
    const r = rollupBatch([p(PaymentState.PAID), p(PaymentState.PAID), p(PaymentState.AWAITING_FINANCE)]);
    expect(r.total).toBe(3);
    expect(r.paidAmountBaseUnits).toBe(2_000_000_000n);
    expect(r.totalAmountBaseUnits).toBe(3_000_000_000n);
  });

  it('reports a batch containing a failure as failed, not as mostly-fine', () => {
    // Summarising by the most common state would let one broken payment hide
    // inside a healthy batch — the one a finance team most needs to see.
    const r = rollupBatch([
      p(PaymentState.PAID), p(PaymentState.PAID), p(PaymentState.PAID),
      p(PaymentState.SETTLEMENT_FAILED),
    ]);
    expect(r.headline).toBe('Settlement failed');
    expect(r.needsAttention).toBe(1);
  });

  it('reports the least-advanced state when nothing is broken', () => {
    const r = rollupBatch([p(PaymentState.PAID), p(PaymentState.AWAITING_MANAGER)]);
    expect(r.headline).toBe('Awaiting manager approval');
  });

  it('handles an empty batch', () => {
    expect(rollupBatch([]).headline).toBe('Empty');
  });
});
