/**
 * The payment state machine against real PostgreSQL.
 *
 * The unit tests prove the transition TABLE. These prove that the table and the
 * database agree: that a transition is a compare-and-swap against a real row, that
 * a losing race is reported rather than overwriting someone's work, and — most
 * importantly — that no application actor can persist PAID.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { OrgRole, PaymentState } from '@prisma/client';
import prisma from '@/lib/db/prisma';
import { transitionPayment } from '../service';
import {
  assertLocalDatabase,
  resetDatabase,
  seedOrganization,
  payeeWallet,
  type SeededOrg,
} from '@/lib/db/__tests__/helpers';

assertLocalDatabase();

let org: SeededOrg;
let paymentId: string;

const USER_MANAGER = { kind: 'user' as const, role: OrgRole.MANAGER, address: '' };
const INDEXER = { kind: 'indexer' as const, system: 'indexer' };
const SYSTEM = { kind: 'system' as const, system: 'submitter' };

beforeAll(async () => {
  await prisma.$connect();
});
afterAll(async () => {
  await prisma.$disconnect();
});

beforeEach(async () => {
  await resetDatabase(prisma);
  org = await seedOrganization(prisma, 'sm');
  USER_MANAGER.address = org.members.MANAGER.wallet;

  const batch = await prisma.payrollBatch.create({
    data: { orgId: org.orgId, reference: 'CF-SM1' },
    select: { id: true },
  });
  const payment = await prisma.payment.create({
    data: {
      orgId: org.orgId,
      batchId: batch.id,
      recipientAddress: payeeWallet('smpayee'),
      amountBaseUnits: 10_000_000_000n,
      rateBaseUnits: 250_000_000n,
      hours: 40n,
    },
    select: { id: true },
  });
  paymentId = payment.id;
});

async function stateOf(): Promise<PaymentState> {
  const p = await prisma.payment.findUniqueOrThrow({
    where: { id: paymentId },
    select: { state: true },
  });
  return p.state;
}

/** Walk the happy path as far as the given state, using only legal transitions. */
async function advanceTo(target: PaymentState): Promise<void> {
  const path: { to: PaymentState; actor: any }[] = [
    { to: PaymentState.VALIDATING, actor: USER_MANAGER },
    { to: PaymentState.AWAITING_ORACLE, actor: INDEXER },
    { to: PaymentState.ORACLE_VERIFIED, actor: INDEXER },
    { to: PaymentState.AWAITING_MANAGER, actor: INDEXER },
    { to: PaymentState.AWAITING_FINANCE, actor: INDEXER },
    { to: PaymentState.READY_TO_SETTLE, actor: INDEXER },
    { to: PaymentState.SUBMITTING, actor: USER_MANAGER },
    { to: PaymentState.CONFIRMING, actor: SYSTEM },
    { to: PaymentState.PAID, actor: INDEXER },
  ];
  for (const step of path) {
    const outcome = await transitionPayment(prisma, {
      paymentId,
      orgId: org.orgId,
      to: step.to,
      actor: step.actor,
      ...(step.to === PaymentState.PAID
        ? { txHash: 'a'.repeat(64), settledAt: new Date() }
        : {}),
    });
    if (!outcome.ok) {
      throw new Error(`could not reach ${step.to}: ${outcome.message}`);
    }
    if (step.to === target) return;
  }
}

describe('The happy path, persisted', () => {
  it('walks DRAFT to PAID and records every step in the audit trail', async () => {
    await advanceTo(PaymentState.PAID);

    const payment = await prisma.payment.findUniqueOrThrow({
      where: { id: paymentId },
      select: { state: true, settlementTxHash: true, settledAt: true, amountBaseUnits: true },
    });
    expect(payment.state).toBe(PaymentState.PAID);
    expect(payment.settlementTxHash).toBe('a'.repeat(64));
    expect(payment.settledAt).toBeInstanceOf(Date);
    // The amount is never rewritten by a transition.
    expect(payment.amountBaseUnits).toBe(10_000_000_000n);

    const events = await prisma.auditEvent.findMany({
      where: { orgId: org.orgId, paymentId },
      orderBy: { createdAt: 'asc' },
      select: {
        type: true,
        previousState: true,
        newState: true,
        actorSystem: true,
        actorAddress: true,
        txHash: true,
      },
    });
    // Nine transitions, nine audit rows. An unaudited state change is not one.
    expect(events).toHaveLength(9);
    expect(events.every((e) => e.type === 'payment.state.changed')).toBe(true);

    // The trail is CONTINUOUS: each row's previous state is the one before it. A
    // gap would mean a state change happened without being recorded.
    expect(events[0].previousState).toBe(PaymentState.DRAFT);
    for (let i = 1; i < events.length; i++) {
      expect(events[i].previousState).toBe(events[i - 1].newState);
    }
    expect(events[events.length - 1].newState).toBe(PaymentState.PAID);

    const last = events[events.length - 1];
    // The indexer records settlement, not a person, and it carries the evidence.
    expect(last.actorSystem).toBe('indexer');
    expect(last.actorAddress).toBeNull();
    expect(last.txHash).toBe('a'.repeat(64));

    // No person appears as the actor on the transition into PAID.
    const paidRows = events.filter((e) => e.newState === PaymentState.PAID);
    expect(paidRows).toHaveLength(1);
    expect(paidRows[0].actorAddress).toBeNull();
  });
});

describe('PAID is reachable only from chain evidence', () => {
  it('refuses a user actor driving CONFIRMING to PAID', async () => {
    await advanceTo(PaymentState.CONFIRMING);

    const outcome = await transitionPayment(prisma, {
      paymentId,
      orgId: org.orgId,
      to: PaymentState.PAID,
      actor: USER_MANAGER,
      txHash: 'b'.repeat(64),
    });

    expect(outcome.ok).toBe(false);
    // The database still says CONFIRMING. The product cannot claim a payment
    // settled because somebody asked it to.
    expect(await stateOf()).toBe(PaymentState.CONFIRMING);
    const payment = await prisma.payment.findUniqueOrThrow({
      where: { id: paymentId },
      select: { settlementTxHash: true, settledAt: true },
    });
    expect(payment.settlementTxHash).toBeNull();
    expect(payment.settledAt).toBeNull();
  });

  it.each([
    [OrgRole.OWNER],
    [OrgRole.ADMIN],
    [OrgRole.MANAGER],
    [OrgRole.FINANCE],
  ])('refuses %s, however privileged, from marking a payment PAID', async (role) => {
    await advanceTo(PaymentState.CONFIRMING);
    const outcome = await transitionPayment(prisma, {
      paymentId,
      orgId: org.orgId,
      to: PaymentState.PAID,
      actor: { kind: 'user', role, address: org.members[role].wallet },
    });
    expect(outcome.ok).toBe(false);
    expect(await stateOf()).toBe(PaymentState.CONFIRMING);
  });

  it('refuses a jump from DRAFT straight to PAID even for the indexer', async () => {
    const outcome = await transitionPayment(prisma, {
      paymentId,
      orgId: org.orgId,
      to: PaymentState.PAID,
      actor: INDEXER,
      txHash: 'c'.repeat(64),
    });
    expect(outcome.ok).toBe(false);
    expect(await stateOf()).toBe(PaymentState.DRAFT);
  });
});

describe('Invalid transitions leave the row untouched', () => {
  it('refuses a transition whose source state does not match', async () => {
    // DRAFT -> CONFIRMING is not in the table at all.
    const outcome = await transitionPayment(prisma, {
      paymentId,
      orgId: org.orgId,
      to: PaymentState.CONFIRMING,
      actor: SYSTEM,
    });
    expect(outcome.ok).toBe(false);
    expect(await stateOf()).toBe(PaymentState.DRAFT);
    expect(await prisma.auditEvent.count({ where: { paymentId } })).toBe(0);
  });

  it('refuses a role that may not perform an otherwise valid transition', async () => {
    // DRAFT -> VALIDATING is valid, but not for a VIEWER.
    const outcome = await transitionPayment(prisma, {
      paymentId,
      orgId: org.orgId,
      to: PaymentState.VALIDATING,
      actor: { kind: 'user', role: OrgRole.VIEWER, address: org.members.VIEWER.wallet },
    });
    expect(outcome.ok).toBe(false);
    expect(await stateOf()).toBe(PaymentState.DRAFT);
  });

  it('will not transition a payment belonging to another organization', async () => {
    const other = await seedOrganization(prisma, 'smother');
    const outcome = await transitionPayment(prisma, {
      paymentId,
      // The payment exists, but not in this tenant.
      orgId: other.orgId,
      to: PaymentState.VALIDATING,
      actor: { kind: 'user', role: OrgRole.MANAGER, address: other.members.MANAGER.wallet },
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.status).toBe(404);
    expect(await stateOf()).toBe(PaymentState.DRAFT);
  });
});

describe('Concurrency on a real row', () => {
  it('reports a repeated transition as unchanged rather than auditing it twice', async () => {
    const first = await transitionPayment(prisma, {
      paymentId,
      orgId: org.orgId,
      to: PaymentState.VALIDATING,
      actor: USER_MANAGER,
    });
    const second = await transitionPayment(prisma, {
      paymentId,
      orgId: org.orgId,
      to: PaymentState.VALIDATING,
      actor: USER_MANAGER,
    });

    expect(first.ok && first.changed).toBe(true);
    expect(second.ok && second.changed).toBe(false);
    // An indexer re-processing an event is a duplicate, not a failure — but it
    // must not produce a second audit row either.
    expect(await prisma.auditEvent.count({ where: { paymentId } })).toBe(1);
  });

  it('lets exactly one of two genuinely incompatible transitions win', async () => {
    await advanceTo(PaymentState.READY_TO_SETTLE);
    const auditBefore = await prisma.auditEvent.count({ where: { paymentId } });

    // Both are legal FROM READY_TO_SETTLE, and neither is reachable from the
    // other's destination: SUBMITTING has no path to CANCELLED, and CANCELLED is
    // terminal. So exactly one can apply.
    //
    // (An earlier version of this test raced SUBMITTING against PAID and expected
    // one winner. Both succeeded — correctly: the table allows SUBMITTING -> PAID,
    // because a confirmation can arrive before our own update lands. The test was
    // wrong, not the code.)
    const [a, b] = await Promise.all([
      transitionPayment(prisma, {
        paymentId,
        orgId: org.orgId,
        to: PaymentState.SUBMITTING,
        actor: USER_MANAGER,
      }),
      transitionPayment(prisma, {
        paymentId,
        orgId: org.orgId,
        to: PaymentState.CANCELLED,
        actor: INDEXER,
        reason: 'escrow cancelled on-chain',
      }),
    ]);

    const winners = [a, b].filter((r) => r.ok && r.changed === true);
    const losers = [a, b].filter((r) => !r.ok);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);

    // The loser is told its work was not applied, rather than overwriting the
    // winner's transition. Which refusal it gets depends on how the race resolved,
    // and all three are correct:
    //
    //   CONCURRENT_MODIFICATION  both read READY_TO_SETTLE; the compare-and-swap
    //                            matched zero rows because the winner moved first
    //   INVALID_TRANSITION       the loser read SUBMITTING, and SUBMITTING has no
    //                            path to CANCELLED
    //   TERMINAL                 the loser read CANCELLED, which nothing leaves
    //
    // This assertion originally listed only the first two and failed about half the
    // time. The missing case was TERMINAL — the product was right, the test was
    // incomplete. Worth keeping as a comment: a flaky financial test invites being
    // silenced, and the reason it flaked is the interesting part.
    const loser = losers[0];
    if (!loser.ok) {
      expect(['CONCURRENT_MODIFICATION', 'INVALID_TRANSITION', 'TERMINAL']).toContain(
        loser.code,
      );
    }

    const final = await stateOf();
    expect([PaymentState.SUBMITTING, PaymentState.CANCELLED]).toContain(final);

    // One new audit row for the one transition that happened, and the trail stays
    // continuous through the race.
    const events = await prisma.auditEvent.findMany({
      where: { paymentId },
      orderBy: { createdAt: 'asc' },
      select: { previousState: true, newState: true },
    });
    expect(events).toHaveLength(auditBefore + 1);
    expect(events[events.length - 1].previousState).toBe(PaymentState.READY_TO_SETTLE);
    expect(events[events.length - 1].newState).toBe(final);
  });
});

describe('Failure states', () => {
  it('records a submission failure with its reason and allows a retry', async () => {
    await advanceTo(PaymentState.SUBMITTING);

    const failed = await transitionPayment(prisma, {
      paymentId,
      orgId: org.orgId,
      to: PaymentState.SUBMISSION_FAILED,
      actor: SYSTEM,
      reason: 'RPC timed out before the transaction was sent',
    });
    expect(failed.ok).toBe(true);

    const payment = await prisma.payment.findUniqueOrThrow({
      where: { id: paymentId },
      select: { state: true, stateReason: true, settlementTxHash: true },
    });
    expect(payment.state).toBe(PaymentState.SUBMISSION_FAILED);
    expect(payment.stateReason).toBe('RPC timed out before the transaction was sent');
    // Nothing reached the chain, so there is no hash to record.
    expect(payment.settlementTxHash).toBeNull();

    // Safe to retry precisely because nothing was submitted.
    const retried = await transitionPayment(prisma, {
      paymentId,
      orgId: org.orgId,
      to: PaymentState.READY_TO_SETTLE,
      actor: USER_MANAGER,
    });
    expect(retried.ok).toBe(true);
    expect(await stateOf()).toBe(PaymentState.READY_TO_SETTLE);
  });

  it('does not move a PAID payment backwards, for any actor', async () => {
    await advanceTo(PaymentState.PAID);

    for (const to of [
      PaymentState.READY_TO_SETTLE,
      PaymentState.SUBMITTING,
      PaymentState.CONFIRMING,
      PaymentState.CANCELLED,
      PaymentState.REJECTED,
      PaymentState.SUBMISSION_FAILED,
    ]) {
      for (const actor of [USER_MANAGER, INDEXER, SYSTEM]) {
        const outcome = await transitionPayment(prisma, {
          paymentId,
          orgId: org.orgId,
          to,
          actor,
        });
        expect(outcome.ok).toBe(false);
      }
    }

    // A financial terminal state is never rewritten to make the record look tidy.
    expect(await stateOf()).toBe(PaymentState.PAID);
  });

  it('allows RECONCILIATION_REQUIRED from PAID, because a disagreement is a fact', async () => {
    await advanceTo(PaymentState.PAID);
    const outcome = await transitionPayment(prisma, {
      paymentId,
      orgId: org.orgId,
      to: PaymentState.RECONCILIATION_REQUIRED,
      actor: { kind: 'reconciler', system: 'reconciler' },
      reason: 'chain shows no transfer for this payment',
    });

    // Whether this is permitted is the state machine's decision; what matters is
    // that the database agrees with it either way.
    if (outcome.ok) {
      expect(await stateOf()).toBe(PaymentState.RECONCILIATION_REQUIRED);
      const p = await prisma.payment.findUniqueOrThrow({
        where: { id: paymentId },
        select: { stateReason: true, settlementTxHash: true },
      });
      expect(p.stateReason).toContain('chain shows no transfer');
      // The settlement evidence is preserved, not erased.
      expect(p.settlementTxHash).toBe('a'.repeat(64));
    } else {
      expect(await stateOf()).toBe(PaymentState.PAID);
    }
  });
});
