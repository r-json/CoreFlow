// @vitest-environment node
/**
 * Indexer projection tests.
 *
 * THE REGRESSION THIS GUARDS: the previous projection stored one worker and one
 * amount per Escrow, so a three-payee settlement collapsed into a single row
 * carrying the first payee's figures. Two of the three payments did not exist in
 * the product at all. The first test below is the one that must never go green
 * again for the wrong reason.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { PaymentState } from '@prisma/client';
import { processBatch, type RawIndexedEvent, type IndexerContext } from '../index';
import { createFakeDb, seedOrg, type FakeDb } from '@/lib/payments/__tests__/fake-db';

const CONTRACT = 'CDN4FIKLJ72WYNPBIKWYSDJWDZG22QNPLWI37VTUAE4EKKIBVAQRG5F4';
const TOKEN = 'CBW2ZKFBHLHNNVCZ7JP4AXHQOOC3S6NLAMORXOAIWQNWMKUVJS743Q5M';
const MANAGER = 'G' + 'M'.repeat(55);
const W = (n: number) => 'G' + String(n).repeat(55).slice(0, 55);

let db: FakeDb;
let ctx: IndexerContext;
let ORG: string;

/**
 * Pre-register the tenant mapping for an escrow.
 *
 * The indexer no longer invents an organization: ownership comes only from an
 * Escrow row the application wrote. In production that row is created when a
 * member submits the creation transaction; here it is seeded explicitly, which
 * also makes each test state which tenant it is about.
 */
function mapEscrowToTenant(onChainId: number, orgId = ORG) {
  db.__tables.escrow.rows.push({
    id: `esc_${onChainId}`,
    orgId,
    onChainId,
    contractId: CONTRACT,
    network: 'testnet',
    managerAddress: MANAGER,
    financeApproverAddress: 'G' + 'F'.repeat(55),
    assetDecimals: 7,
    totalAmountBaseUnits: 0n,
    managerApproved: false,
    financeApproved: false,
    cancelled: false,
    oracleRotations: 0,
  });
}

beforeEach(() => {
  db = createFakeDb();
  ORG = seedOrg(db);
  ctx = { contractId: CONTRACT, network: 'testnet', assetDecimals: 7 };
});

let tokenSeq = 0;
/** Unique RPC paging token per event, as the real RPC provides. */
const tok = () => `0000000${++tokenSeq}-0000000001`;

function created(escrowId: number, total: bigint, ledger = 100): RawIndexedEvent {
  return {
    id: tok(), ledger, topic0: 'escrow', topic1: 'created',
    value: [escrowId, MANAGER, total], txHash: `tx_created_${escrowId}`,
  };
}
function added(
  escrowId: number, index: number, worker: string, amount: bigint, rate: bigint, ledger = 100
): RawIndexedEvent {
  return {
    id: tok(), ledger, topic0: 'payment', topic1: 'add',
    value: [escrowId, index, worker, TOKEN, amount, rate, 1000n, 2000n],
    txHash: `tx_created_${escrowId}`,
  };
}
function hours(escrowId: number, index: number, h: bigint, ledger = 110): RawIndexedEvent {
  return {
    id: tok(), ledger, topic0: 'hours', topic1: 'submit',
    value: [escrowId, index, h], txHash: `tx_hours_${escrowId}_${index}`,
  };
}
function approve(escrowId: number, who: 'manager' | 'finance', ledger = 120): RawIndexedEvent {
  return {
    id: tok(), ledger, topic0: 'approve', topic1: who,
    value: escrowId, txHash: `tx_${who}_${escrowId}`,
  };
}
function paid(
  escrowId: number, index: number, worker: string, amount: bigint, h: bigint, ledger = 130
): RawIndexedEvent {
  return {
    id: tok(), ledger, topic0: 'payment', topic1: 'paid',
    value: [escrowId, index, worker, TOKEN, amount, h], txHash: `tx_paid_${escrowId}`,
  };
}
function finalized(escrowId: number, total: bigint, count: number, ledger = 130): RawIndexedEvent {
  return {
    id: tok(), ledger, topic0: 'payment', topic1: 'final',
    value: [escrowId, total, count], txHash: `tx_paid_${escrowId}`,
  };
}
function cancelPayment(escrowId: number, index: number, ledger = 140): RawIndexedEvent {
  return {
    id: tok(), ledger, topic0: 'payment', topic1: 'cancel',
    value: [escrowId, index], txHash: `tx_cancel_${escrowId}`,
  };
}

/** The validated golden path: 3 contractors, 1000/960/900 USDC at 25/30/20 per hour. */
const THREE_PAYEES = [
  { index: 0, worker: W(1), amount: 10_000_000_000n, rate: 250_000_000n, hours: 40n },
  { index: 1, worker: W(2), amount: 9_600_000_000n, rate: 300_000_000n, hours: 32n },
  { index: 2, worker: W(3), amount: 9_000_000_000n, rate: 200_000_000n, hours: 45n },
];
const TOTAL = THREE_PAYEES.reduce((a, p) => a + p.amount, 0n);

function goldenPathEvents(escrowId = 2): RawIndexedEvent[] {
  return [
    created(escrowId, TOTAL),
    ...THREE_PAYEES.map((p) => added(escrowId, p.index, p.worker, p.amount, p.rate)),
    ...THREE_PAYEES.map((p) => hours(escrowId, p.index, p.hours)),
    approve(escrowId, 'manager'),
    approve(escrowId, 'finance'),
    ...THREE_PAYEES.map((p) => paid(escrowId, p.index, p.worker, p.amount, p.hours)),
    finalized(escrowId, TOTAL, 3),
  ];
}

const payments = () => db.__tables.payment.rows;
const findings = () => db.__tables.reconciliationFinding.rows;

describe('multi-payment projection', () => {
  it('produces one Payment per payee, not one per escrow', async () => {
    mapEscrowToTenant(2);
    mapEscrowToTenant(2);
    const result = await processBatch(goldenPathEvents(), { db, ctx });

    expect(result.paymentsCreated).toBe(3);
    expect(payments()).toHaveLength(3);

    // Each carries its OWN recipient, amount, rate and hours — the figures that
    // the old single-row projection discarded for payees 2 and 3.
    for (const expected of THREE_PAYEES) {
      const row = payments().find((p) => p.onChainPaymentIndex === expected.index);
      expect(row, `payment ${expected.index} missing`).toBeDefined();
      expect(row!.recipientAddress).toBe(expected.worker);
      expect(row!.amountBaseUnits).toBe(expected.amount);
      expect(row!.rateBaseUnits).toBe(expected.rate);
      expect(row!.hours).toBe(expected.hours);
    }

    // Distinct recipients — a collapsed projection would repeat the first.
    expect(new Set(payments().map((p) => p.recipientAddress)).size).toBe(3);
  });

  it('keeps the batch relationship while payments stay individual', async () => {
    mapEscrowToTenant(2);
    await processBatch(goldenPathEvents(), { db, ctx });
    const batches = db.__tables.payrollBatch.rows;
    expect(batches).toHaveLength(1);
    expect(payments().every((p) => p.batchId === batches[0].id)).toBe(true);
  });

  it('settles all three to PAID with the correct amounts', async () => {
    mapEscrowToTenant(2);
    const result = await processBatch(goldenPathEvents(), { db, ctx });

    expect(result.paymentsPaid).toBe(3);
    expect(payments().every((p) => p.state === PaymentState.PAID)).toBe(true);

    const settled = payments().reduce((a, p) => a + p.amountBaseUnits, 0n);
    expect(settled).toBe(TOTAL);
    expect(settled).toBe(28_600_000_000n); // 2,860 USDC
  });

  it('records no reconciliation findings on a clean golden path', async () => {
    mapEscrowToTenant(2);
    const result = await processBatch(goldenPathEvents(), { db, ctx });
    expect(result.findings).toBe(0);
    expect(findings()).toHaveLength(0);
  });

  it('creates a Worker row per distinct payee', async () => {
    mapEscrowToTenant(2);
    await processBatch(goldenPathEvents(), { db, ctx });
    expect(db.__tables.worker.rows).toHaveLength(3);
  });

  it('walks each payment through the full lifecycle in order', async () => {
    const escrowId = 5;
    mapEscrowToTenant(5);
    const step = async (evs: RawIndexedEvent[]) => processBatch(evs, { db, ctx });

    await step([created(escrowId, TOTAL), ...THREE_PAYEES.map((p) => added(escrowId, p.index, p.worker, p.amount, p.rate))]);
    expect(payments().every((p) => p.state === PaymentState.AWAITING_ORACLE)).toBe(true);

    await step(THREE_PAYEES.map((p) => hours(escrowId, p.index, p.hours)));
    expect(payments().every((p) => p.state === PaymentState.ORACLE_VERIFIED)).toBe(true);

    await step([approve(escrowId, 'manager')]);
    expect(payments().every((p) => p.state === PaymentState.AWAITING_FINANCE)).toBe(true);

    await step([approve(escrowId, 'finance')]);
    expect(payments().every((p) => p.state === PaymentState.READY_TO_SETTLE)).toBe(true);

    await step(THREE_PAYEES.map((p) => paid(escrowId, p.index, p.worker, p.amount, p.hours)));
    expect(payments().every((p) => p.state === PaymentState.PAID)).toBe(true);
  });
});

describe('idempotency', () => {
  it('skips re-delivered events and creates nothing twice', async () => {
    mapEscrowToTenant(2);
    const events = goldenPathEvents();
    const first = await processBatch(events, { db, ctx });
    const second = await processBatch(events, { db, ctx });

    expect(first.processed).toBeGreaterThan(0);
    expect(second.processed).toBe(0);
    expect(second.skipped).toBe(events.length);

    // The property that matters: no duplicate payments, and no second payout.
    expect(payments()).toHaveLength(3);
    expect(second.paymentsCreated).toBe(0);
    expect(second.paymentsPaid).toBe(0);
  });

  it('survives the same event appearing twice within one batch', async () => {
    mapEscrowToTenant(2);
    const events = goldenPathEvents();
    const doubled = [...events, ...events];
    const result = await processBatch(doubled, { db, ctx });

    expect(payments()).toHaveLength(3);
    expect(result.skipped).toBe(events.length);
  });

  it('does not re-pay a payment that is already PAID', async () => {
    const escrowId = 7;
    mapEscrowToTenant(7);
    await processBatch(goldenPathEvents(escrowId), { db, ctx });

    // A duplicate paid event arriving under a NEW paging token — a real
    // possibility after an RPC replay — must still not double-count.
    const replay = paid(escrowId, 0, THREE_PAYEES[0].worker, THREE_PAYEES[0].amount, 40n);
    const result = await processBatch([replay], { db, ctx });

    expect(result.processed).toBe(1);
    expect(result.paymentsPaid).toBe(0);
    const audits = db.__tables.auditEvent.rows.filter(
      (a) => a.type === 'payment.state.changed' && a.newState === PaymentState.PAID
    );
    expect(audits).toHaveLength(3); // one per payment, not four
  });

  it('does not create a second payment for a re-delivered add under a new token', async () => {
    const escrowId = 8;
    mapEscrowToTenant(8);
    await processBatch([created(escrowId, TOTAL), added(escrowId, 0, W(1), 10_000_000_000n, 250_000_000n)], { db, ctx });
    await processBatch([added(escrowId, 0, W(1), 10_000_000_000n, 250_000_000n)], { db, ctx });
    expect(payments()).toHaveLength(1);
  });
});

describe('restart and partial ingestion', () => {
  it('resumes from the cursor after a restart', async () => {
    const escrowId = 11;
    mapEscrowToTenant(11);
    const head = [created(escrowId, TOTAL), ...THREE_PAYEES.map((p) => added(escrowId, p.index, p.worker, p.amount, p.rate))];
    const tail = [...THREE_PAYEES.map((p) => hours(escrowId, p.index, p.hours)), approve(escrowId, 'manager')];

    const a = await processBatch(head, { db, ctx });
    expect(a.lastLedger).toBe(100);
    const cursor = db.__tables.indexerCursor.rows[0];
    expect(cursor.lastLedger).toBe(100);
    expect(cursor.contractId).toBe(CONTRACT);
    expect(cursor.network).toBe('testnet');

    // Simulate a process restart: a brand-new run over the remaining events.
    const b = await processBatch(tail, { db, ctx });
    expect(b.lastLedger).toBe(120);
    expect(payments().every((p) => p.state === PaymentState.AWAITING_FINANCE)).toBe(true);
  });

  it('leaves no partial effect when an event fails mid-batch', async () => {
    const escrowId = 12;
    mapEscrowToTenant(12);
    // Fail while creating the SECOND payment.
    db.__failOn('payment', 'create', 1);

    await expect(
      processBatch(
        [created(escrowId, TOTAL), ...THREE_PAYEES.map((p) => added(escrowId, p.index, p.worker, p.amount, p.rate))],
        { db, ctx }
      )
    ).rejects.toThrow();

    // The escrow from the first event committed; the failed add rolled back
    // entirely, leaving no half-written payment and no ChainEvent marker for it.
    expect(db.__tables.escrow.rows).toHaveLength(1);
    expect(payments()).toHaveLength(0);
    const markers = db.__tables.chainEvent.rows.map((c) => c.type);
    expect(markers).toEqual(['created']);
  });

  it('re-applies the failed event on the next run and completes', async () => {
    const escrowId = 13;
    mapEscrowToTenant(13);
    const events = [
      created(escrowId, TOTAL),
      ...THREE_PAYEES.map((p) => added(escrowId, p.index, p.worker, p.amount, p.rate)),
    ];
    db.__failOn('payment', 'create', 1);
    await expect(processBatch(events, { db, ctx })).rejects.toThrow();
    expect(payments()).toHaveLength(0);

    // Same events, no injected failure: ingestion completes and the skipped
    // marker for `created` prevents it being applied twice.
    const retry = await processBatch(events, { db, ctx });
    expect(retry.skipped).toBe(1);
    expect(payments()).toHaveLength(3);
  });

  it('does not advance the cursor past an event it failed to apply', async () => {
    const escrowId = 14;
    mapEscrowToTenant(14);
    db.__failOn('payment', 'create', 1);
    await expect(
      processBatch(
        [
          created(escrowId, TOTAL, 200),
          added(escrowId, 0, W(1), 10_000_000_000n, 250_000_000n, 300),
        ],
        { db, ctx }
      )
    ).rejects.toThrow();

    // Cursor sits at the last COMMITTED ledger, never at the failed one.
    expect(db.__tables.indexerCursor.rows[0].lastLedger).toBe(200);
  });

  it('orders events deterministically regardless of RPC delivery order', async () => {
    const escrowId = 15;
    mapEscrowToTenant(15);
    const events = goldenPathEvents(escrowId);
    const shuffled = [...events].reverse();

    await processBatch(shuffled, { db, ctx });

    // Reversed delivery still ends in the same terminal state, because the batch
    // is sorted by (ledger, paging token) before application.
    expect(payments()).toHaveLength(3);
    expect(payments().every((p) => p.state === PaymentState.PAID)).toBe(true);
  });
});

describe('reconciliation findings from the log', () => {
  it('flags a settlement for a payment it has no row for', async () => {
    // Indexing started after escrow creation, so the add events were missed.
    const result = await processBatch(
      [paid(99, 0, W(1), 10_000_000_000n, 40n)],
      { db, ctx }
    );
    // No escrow row at all, so nothing to attach: the event is recorded and
    // ignored rather than inventing an escrow.
    expect(payments()).toHaveLength(0);
    expect(result.processed).toBe(1);
  });

  it('flags an orphan settlement when the escrow exists but the slot does not', async () => {
    const escrowId = 21;
    mapEscrowToTenant(21);
    await processBatch([created(escrowId, TOTAL), added(escrowId, 0, W(1), 10_000_000_000n, 250_000_000n)], { db, ctx });

    const result = await processBatch([paid(escrowId, 9, W(9), 1n, 1n)], { db, ctx });

    expect(result.findings).toBe(1);
    expect(findings()[0].kind).toBe('ORPHAN_ON_CHAIN');
  });

  it('flags a settled amount that disagrees with the record, and still marks PAID', async () => {
    const escrowId = 22;
    mapEscrowToTenant(22);
    await processBatch(
      [created(escrowId, TOTAL), added(escrowId, 0, W(1), 10_000_000_000n, 250_000_000n),
       hours(escrowId, 0, 40n), approve(escrowId, 'manager'), approve(escrowId, 'finance')],
      { db, ctx }
    );

    // The chain moved a different amount than we recorded.
    const result = await processBatch(
      [paid(escrowId, 0, W(1), 9_999_999_999n, 40n)],
      { db, ctx }
    );

    expect(result.findings).toBe(1);
    expect(findings()[0].kind).toBe('AMOUNT_MISMATCH');
    // The transfer happened either way — the payment is PAID, and the
    // discrepancy is a separate recorded fact rather than a reason to hide it.
    expect(payments()[0].state).toBe(PaymentState.PAID);
  });

  it('does not overwrite a stored payment when a replayed add disagrees', async () => {
    const escrowId = 23;
    mapEscrowToTenant(23);
    await processBatch([created(escrowId, TOTAL), added(escrowId, 0, W(1), 10_000_000_000n, 250_000_000n)], { db, ctx });

    const result = await processBatch(
      [added(escrowId, 0, W(2), 5_000_000_000n, 250_000_000n)],
      { db, ctx }
    );

    expect(result.findings).toBe(1);
    expect(findings()[0].kind).toBe('AMOUNT_MISMATCH');
    // Financial identity is immutable: the original row stands.
    expect(payments()[0].recipientAddress).toBe(W(1));
    expect(payments()[0].amountBaseUnits).toBe(10_000_000_000n);
  });

  it('flags an aggregate finalize that disagrees with per-payment state', async () => {
    const escrowId = 24;
    mapEscrowToTenant(24);
    await processBatch(
      [created(escrowId, TOTAL), ...THREE_PAYEES.map((p) => added(escrowId, p.index, p.worker, p.amount, p.rate))],
      { db, ctx }
    );

    // The escrow-level summary claims three settled, but no per-payment events
    // arrived. The summary never sets PAID; it only surfaces the gap.
    const result = await processBatch([finalized(escrowId, TOTAL, 3)], { db, ctx });

    expect(result.findings).toBe(1);
    expect(findings()[0].kind).toBe('CHAIN_PAID_DB_NOT');
    expect(payments().every((p) => p.state !== PaymentState.PAID)).toBe(true);
  });

  it('flags a cancellation arriving for an already-settled payment', async () => {
    const escrowId = 25;
    mapEscrowToTenant(25);
    await processBatch(goldenPathEvents(escrowId), { db, ctx });

    const result = await processBatch([cancelPayment(escrowId, 0)], { db, ctx });

    expect(result.findings).toBe(1);
    expect(findings()[0].kind).toBe('DB_PAID_CHAIN_NOT');
    expect(payments().find((p) => p.onChainPaymentIndex === 0)!.state).toBe(PaymentState.PAID);
  });
});

describe('cancellation and rotation', () => {
  it('cancels each payment individually from per-payment events', async () => {
    const escrowId = 31;
    mapEscrowToTenant(31);
    await processBatch(
      [created(escrowId, TOTAL), ...THREE_PAYEES.map((p) => added(escrowId, p.index, p.worker, p.amount, p.rate))],
      { db, ctx }
    );
    await processBatch(THREE_PAYEES.map((p) => cancelPayment(escrowId, p.index)), { db, ctx });

    expect(payments().every((p) => p.state === PaymentState.CANCELLED)).toBe(true);
  });

  it('returns payments to AWAITING_ORACLE when the oracle key rotates', async () => {
    const escrowId = 32;
    mapEscrowToTenant(32);
    await processBatch(
      [created(escrowId, TOTAL), added(escrowId, 0, W(1), 10_000_000_000n, 250_000_000n),
       hours(escrowId, 0, 40n), approve(escrowId, 'manager')],
      { db, ctx }
    );
    expect(payments()[0].state).toBe(PaymentState.AWAITING_FINANCE);

    await processBatch(
      [{ id: tok(), ledger: 150, topic0: 'oracle', topic1: 'rotate', value: [escrowId, 1] }],
      { db, ctx }
    );

    // Rotation revokes verified proofs on-chain, so the projection must follow —
    // otherwise the dashboard shows an approval chain resting on a revoked proof.
    expect(payments()[0].state).toBe(PaymentState.AWAITING_ORACLE);
    expect(db.__tables.escrow.rows[0].oracleRotations).toBe(1);
  });
});

describe('audit trail', () => {
  it('records a state transition for every payment movement', async () => {
    mapEscrowToTenant(41);
    await processBatch(goldenPathEvents(41), { db, ctx });
    const events = db.__tables.auditEvent.rows;

    // Indexed, oracle-verified, both approvals, and paid — per payment.
    expect(events.filter((e) => e.type === 'payment.indexed')).toHaveLength(3);
    expect(events.filter((e) => e.type === 'payment.oracle.verified')).toHaveLength(3);
    expect(events.filter((e) => e.type === 'approval.manager.observed')).toHaveLength(3);
    expect(events.filter((e) => e.type === 'approval.finance.observed')).toHaveLength(3);
    expect(
      events.filter((e) => e.type === 'payment.state.changed' && e.newState === PaymentState.PAID)
    ).toHaveLength(3);
  });

  it('attributes chain-driven transitions to the indexer, not a person', async () => {
    mapEscrowToTenant(42);
    await processBatch(goldenPathEvents(42), { db, ctx });
    const paidEvents = db.__tables.auditEvent.rows.filter(
      (e) => e.type === 'payment.state.changed' && e.newState === PaymentState.PAID
    );
    for (const e of paidEvents) {
      expect(e.actorSystem).toBe('indexer');
      expect(e.actorAddress).toBeNull();
    }
  });

  it('carries previous and new state so history is reconstructable', async () => {
    mapEscrowToTenant(43);
    await processBatch(goldenPathEvents(43), { db, ctx });
    const transition = db.__tables.auditEvent.rows.find(
      (e) => e.type === 'payment.state.changed' && e.newState === PaymentState.PAID
    );
    expect(transition.previousState).toBe(PaymentState.READY_TO_SETTLE);
    expect(transition.txHash).toBeTruthy();
  });
});

describe('money handling', () => {
  it('keeps amounts as bigint end to end', async () => {
    mapEscrowToTenant(51);
    await processBatch(goldenPathEvents(51), { db, ctx });
    for (const p of payments()) {
      expect(typeof p.amountBaseUnits).toBe('bigint');
      expect(typeof p.rateBaseUnits).toBe('bigint');
      expect(typeof p.hours).toBe('bigint');
    }
  });

  it('handles an amount beyond Number.MAX_SAFE_INTEGER without loss', async () => {
    // 10^18 base units — far past 2^53-1, where a Number cast starts rounding.
    const huge = 1_000_000_000_000_000_000n;
    mapEscrowToTenant(61);
    await processBatch(
      [created(61, huge), added(61, 0, W(1), huge, 1n)],
      { db, ctx }
    );
    expect(payments()[0].amountBaseUnits).toBe(huge);
    expect(payments()[0].hours).toBe(huge);
  });

  it('stores bigints as strings in the chain event payload', async () => {
    // JSON.stringify throws on bigint, so an unconverted payload is a crash.
    await processBatch([created(62, TOTAL), added(62, 0, W(1), 10_000_000_000n, 250_000_000n)], { db, ctx });
    const marker = db.__tables.chainEvent.rows.find((c) => c.type === 'payment_added');
    expect(marker.payload.amountBaseUnits).toBe('10000000000');
    expect(() => JSON.stringify(marker.payload)).not.toThrow();
  });
});

describe('tenant attribution', () => {
  it('refuses to project an escrow it has no mapping for', async () => {
    // The chain knows nothing about organizations. Attaching an unmapped escrow
    // to whichever tenant seemed likely would place one party's payroll,
    // recipients and amounts inside another's workspace.
    const result = await processBatch(goldenPathEvents(81), { db, ctx });

    expect(result.unattributed).toBeGreaterThan(0);
    expect(result.paymentsCreated).toBe(0);
    expect(payments()).toHaveLength(0);
    // Nothing was invented: no organization, no escrow, no batch.
    expect(db.__tables.organization.rows).toHaveLength(1); // only the seeded one
    expect(db.__tables.escrow.rows).toHaveLength(0);
    expect(db.__tables.payrollBatch.rows).toHaveLength(0);
  });

  it('records the unattributable event so it is visible, not dropped', async () => {
    await processBatch([created(82, TOTAL)], { db, ctx });

    const marker = db.__tables.chainEvent.rows[0];
    expect(marker).toBeDefined();
    expect(marker.attributed).toBe(false);
    // The payload is kept, so the event can be applied after a claim.
    expect(marker.payload).toBeTruthy();
  });

  it('applies a previously unattributed event once the escrow is claimed', async () => {
    // A claim must not lose the history that arrived before it.
    const events = goldenPathEvents(83);
    const first = await processBatch(events, { db, ctx });
    expect(first.unattributed).toBeGreaterThan(0);
    expect(payments()).toHaveLength(0);

    // An operator claims escrow 83 into their organization.
    mapEscrowToTenant(83);

    const second = await processBatch(events, { db, ctx });
    expect(second.unattributed).toBe(0);
    expect(payments()).toHaveLength(3);
    expect(payments().every((p) => p.state === PaymentState.PAID)).toBe(true);
    expect(payments().every((p) => p.orgId === ORG)).toBe(true);
  });

  it('does not leak an escrow between tenants on the same on-chain id', async () => {
    // Escrow ids are assigned per contract, so the same id exists in other
    // deployments owned by other tenants.
    const OTHER = 'org_other';
    db.__tables.organization.rows.push({ id: OTHER, name: 'Other', slug: 'other' });
    mapEscrowToTenant(91, OTHER);

    await processBatch(goldenPathEvents(91), { db, ctx });

    expect(payments()).toHaveLength(3);
    expect(payments().every((p) => p.orgId === OTHER)).toBe(true);
    expect(payments().some((p) => p.orgId === ORG)).toBe(false);
  });

  it('does not match an escrow mapped to a DIFFERENT deployment', async () => {
    // Same on-chain id, different contract: not the same escrow.
    db.__tables.escrow.rows.push({
      id: 'esc_mainnet', orgId: ORG, onChainId: 95,
      contractId: 'CCTF5WBOQR7JP2KPLQT372X7JCGCINHDFRSAPF4YTYRKZXZ3J2XPRFFW',
      network: 'public', managerAddress: MANAGER, financeApproverAddress: 'GF',
      assetDecimals: 7,
    });

    const result = await processBatch([created(95, TOTAL)], { db, ctx });

    expect(result.unattributed).toBe(1);
    expect(payments()).toHaveLength(0);
  });

  it('attributes every payment in a batch to the same organization', async () => {
    mapEscrowToTenant(96);
    await processBatch(goldenPathEvents(96), { db, ctx });

    const orgs = new Set(payments().map((p) => p.orgId));
    expect(orgs.size).toBe(1);
    expect([...orgs][0]).toBe(ORG);

    // Findings and audit rows inherit the same tenant.
    for (const row of db.__tables.auditEvent.rows) expect(row.orgId).toBe(ORG);
  });
});

describe('unknown events', () => {
  it('records but does not halt on an unrecognized event', async () => {
    // A future contract version emitting something new must not stop ingestion
    // of the events we do understand.
    mapEscrowToTenant(71);
    const result = await processBatch(
      [
        { id: tok(), ledger: 100, topic0: 'future', topic1: 'thing', value: [1, 2, 3] },
        created(71, TOTAL),
      ],
      { db, ctx }
    );
    expect(result.processed).toBe(2);
    expect(db.__tables.chainEvent.rows.some((c) => c.type.startsWith('unknown:'))).toBe(true);
    expect(db.__tables.escrow.rows).toHaveLength(1);
  });
});
