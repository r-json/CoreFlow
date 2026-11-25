// @vitest-environment node
/**
 * Reconciliation tests.
 *
 * The property under test is restraint plus independence. Verification comes from
 * the TOKEN contract's own transfer events — a source CoreFlow did not author — so
 * a bug in how CoreFlow emits or parses its own events cannot validate itself.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { PaymentState, FindingKind, FindingSeverity, FindingStatus } from '@prisma/client';
import { createFakeDb, type FakeDb } from '@/lib/payments/__tests__/fake-db';
import {
  reconcileOrganization, reconcileFailedTransactions,
  reportUnattributedEscrows, policyFor,
} from '../reconciler';
import {
  CHAIN_STATUS, matchSettlementTransfer, findAmountMismatchedTransfers,
  type ChainVerifier, type ObservedTransfer, type ChainEscrowFacts,
} from '../chain-verifier';

const ORG = 'orgA';
const ESCROW_CONTRACT = 'C' + 'E'.repeat(55);
const TOKEN = 'C' + 'T'.repeat(55);
const W1 = 'G' + '1'.repeat(55);
const W2 = 'G' + '2'.repeat(55);
const W3 = 'G' + '3'.repeat(55);

let db: FakeDb;
const RUN = { id: 'run1', correlationId: 'rec_test' };

/** `pay_batch` settles every payee of an escrow in ONE transaction. */
const SETTLEMENT_TX = 'TX_SETTLEMENT';

/** Golden-path figures: 1000 / 960 / 900 USDC at 7 decimals. */
const P = [
  { index: 0, worker: W1, amount: 10_000_000_000n },
  { index: 1, worker: W2, amount: 9_600_000_000n },
  { index: 2, worker: W3, amount: 9_000_000_000n },
];

function seedEscrow(
  onChainId: number,
  payments: { index: number; worker: string; amount: bigint; state: PaymentState }[]
) {
  db.__tables.escrow.rows.push({
    id: `esc_${onChainId}`, orgId: ORG, onChainId,
    contractId: ESCROW_CONTRACT, network: 'testnet',
    managerAddress: 'GM', financeApproverAddress: 'GF',
    assetDecimals: 7, totalAmountBaseUnits: 0n,
    managerApproved: true, financeApproved: true, cancelled: false,
    createdAt: new Date(),
  });
  db.__tables.payrollBatch.rows.push({ id: `bat_${onChainId}`, orgId: ORG, reference: `R${onChainId}` });
  for (const p of payments) {
    db.__tables.payment.rows.push({
      id: `pay_${onChainId}_${p.index}`, orgId: ORG,
      batchId: `bat_${onChainId}`, escrowId: `esc_${onChainId}`,
      recipientAddress: p.worker, onChainPaymentIndex: p.index,
      assetContractId: TOKEN, assetCode: 'USDC', assetDecimals: 7,
      amountBaseUnits: p.amount, rateBaseUnits: 1n, hours: p.amount,
      state: p.state, stateUpdatedAt: new Date(), createdAt: new Date(),
      // A settled payment records the transaction that settled it. Recording a
      // hash with no corresponding transfer is a separate scenario, tested below.
      settlementTxHash: p.state === PaymentState.PAID ? SETTLEMENT_TX : null,
    });
  }
}

function chainEscrow(
  onChainId: number,
  payments: { index: number; worker: string; amount: bigint; status: number }[]
): ChainEscrowFacts {
  return {
    onChainId, manager: 'GM', financeApprover: 'GF',
    managerApproved: true, financeApproved: true, cancelled: false,
    payments: payments.map((p) => ({
      index: p.index, worker: p.worker, token: TOKEN,
      amountBaseUnits: p.amount, hours: p.amount,
      proofVerified: true, status: p.status,
    })),
  };
}

/**
 * Settlement transfers as the TOKEN contract would report them.
 *
 * All transfers default to ONE transaction hash, because `pay_batch` settles every
 * payee of an escrow in a single transaction. Giving each its own hash would be
 * unrealistic and would hide the transaction-scoped matching this verifies.
 */
function transfers(
  items: { to: string; amount: bigint; from?: string; tx?: string }[]
): ObservedTransfer[] {
  return items.map((i, n) => ({
    from: i.from ?? ESCROW_CONTRACT,
    to: i.to,
    assetContractId: TOKEN,
    amountBaseUnits: i.amount,
    ledger: 1000 + n,
    txHash: i.tx ?? SETTLEMENT_TX,
  }));
}

/** Transfers from an EARLIER, identical pay period — same payees, same amounts. */
function priorPeriodTransfers(): ObservedTransfer[] {
  return P.map((p, n) => ({
    from: ESCROW_CONTRACT,
    to: p.worker,
    assetContractId: TOKEN,
    amountBaseUnits: p.amount,
    ledger: 500 + n,
    txHash: 'TX_LAST_MONTH',
  }));
}

function verifier(opts: {
  escrow?: ChainEscrowFacts | 'unreadable' | 'notfound';
  transfers?: ObservedTransfer[] | 'unreadable';
  txSucceeded?: boolean | 'unreadable' | 'notfound';
}): ChainVerifier {
  return {
    async latestLedger() { return { ok: true, value: 9999 }; },
    async readEscrow() {
      if (opts.escrow === 'unreadable') {
        return { ok: false, error: { kind: 'UNREADABLE', reason: 'rpc timeout' } };
      }
      if (opts.escrow === 'notfound' || !opts.escrow) {
        return { ok: false, error: { kind: 'NOT_FOUND', reason: 'no such escrow' } };
      }
      return { ok: true, value: opts.escrow };
    },
    async readTransfers() {
      if (opts.transfers === 'unreadable') {
        return { ok: false, error: { kind: 'UNREADABLE', reason: 'rpc timeout' } };
      }
      return { ok: true, value: opts.transfers ?? [] };
    },
    async readTransactionSucceeded() {
      if (opts.txSucceeded === 'unreadable') {
        return { ok: false, error: { kind: 'UNREADABLE', reason: 'rpc down' } };
      }
      if (opts.txSucceeded === 'notfound') {
        return { ok: false, error: { kind: 'NOT_FOUND', reason: 'tx not found' } };
      }
      return { ok: true, value: opts.txSucceeded ?? false };
    },
  };
}

const findings = () => db.__tables.reconciliationFinding.rows;
const payment = (id: string) => db.__tables.payment.rows.find((p) => p.id === id)!;
const kinds = () => findings().map((f) => f.kind);

beforeEach(() => {
  db = createFakeDb();
  db.__tables.organization.rows.push({ id: ORG, name: 'A', slug: 'a' });
  db.__tables.reconciliationRun.rows.push({
    id: RUN.id, orgId: ORG, correlationId: RUN.correlationId, scope: 'organization', status: 'RUNNING',
  });
});

describe('AGREED', () => {
  it('opens no findings when chain, transfers and projection all agree', async () => {
    seedEscrow(1, P.map((p) => ({ ...p, state: PaymentState.PAID })));
    const v = verifier({
      escrow: chainEscrow(1, P.map((p) => ({ ...p, status: CHAIN_STATUS.FINALIZED }))),
      transfers: transfers(P.map((p) => ({ to: p.worker, amount: p.amount }))),
    });

    const t = await reconcileOrganization(db, v, ORG, RUN);

    expect(t.paymentsExamined).toBe(3);
    expect(t.agreed).toBe(3);
    expect(t.mismatched).toBe(0);
    expect(t.findingsOpened).toBe(0);
    expect(findings()).toHaveLength(0);
  });
});

describe('independence from CoreFlow’s own events', () => {
  it('refuses to confirm settlement the contract claims but no transfer supports', async () => {
    // This is the whole point. The contract says FINALIZED — which is exactly what
    // the indexer would have trusted — but the TOKEN reports no matching transfer.
    // A reconciler reusing the indexer's source would have agreed.
    seedEscrow(2, [{ ...P[0], state: PaymentState.CONFIRMING }]);
    const v = verifier({
      escrow: chainEscrow(2, [{ ...P[0], status: CHAIN_STATUS.FINALIZED }]),
      transfers: [], // no asset movement
    });

    const t = await reconcileOrganization(db, v, ORG, RUN);

    expect(t.mismatched).toBe(1);
    expect(kinds()).toContain(FindingKind.MISSING_PAYMENT_EVENT);
    // Crucially: the projection was NOT advanced on contract state alone.
    expect(payment('pay_2_0').state).toBe(PaymentState.CONFIRMING);
    expect(t.correctionsApplied).toBe(0);
  });

  it('matches a transfer only on from, to, asset AND exact amount', () => {
    const all = [
      ...transfers([{ to: W1, amount: 10_000_000_000n }]),
      ...transfers([{ to: W1, amount: 9_999_999_999n }]),      // wrong amount
      ...transfers([{ to: W2, amount: 10_000_000_000n }]),      // wrong recipient
      ...transfers([{ to: W1, amount: 10_000_000_000n, from: 'GSOMEONE' }]), // wrong source
    ];
    const matched = matchSettlementTransfer(all, {
      escrowContractId: ESCROW_CONTRACT, recipient: W1,
      assetContractId: TOKEN, amountBaseUnits: 10_000_000_000n,
    });
    expect(matched).toHaveLength(1);
  });

  it('reports a wrong-amount transfer as a mismatch, not as absence', () => {
    // "Money went to the right person in the wrong quantity" is a louder fact
    // than "no settlement found".
    const all = transfers([{ to: W1, amount: 8_600_000_000n }]);
    expect(
      findAmountMismatchedTransfers(all, {
        escrowContractId: ESCROW_CONTRACT, recipient: W1,
        assetContractId: TOKEN, amountBaseUnits: 10_000_000_000n,
      })
    ).toHaveLength(1);
  });
});

describe('CHAIN_AHEAD recovery', () => {
  it('advances the projection when a transfer independently confirms settlement', async () => {
    seedEscrow(3, [{ ...P[0], state: PaymentState.CONFIRMING }]);
    const v = verifier({
      escrow: chainEscrow(3, [{ ...P[0], status: CHAIN_STATUS.FINALIZED }]),
      transfers: transfers([{ to: W1, amount: P[0].amount, tx: 'TX_REAL' }]),
    });

    const t = await reconcileOrganization(db, v, ORG, RUN);

    expect(t.chainAhead).toBe(1);
    expect(t.correctionsApplied).toBe(1);
    const p = payment('pay_3_0');
    expect(p.state).toBe(PaymentState.PAID);
    expect(p.settlementTxHash).toBe('TX_REAL');
    expect(p.settledAt).toBeTruthy();
  });

  it('attributes the correction to the reconciler and records the evidence', async () => {
    seedEscrow(4, [{ ...P[0], state: PaymentState.CONFIRMING }]);
    const v = verifier({
      escrow: chainEscrow(4, [{ ...P[0], status: CHAIN_STATUS.FINALIZED }]),
      transfers: transfers([{ to: W1, amount: P[0].amount }]),
    });
    await reconcileOrganization(db, v, ORG, RUN);

    const e = db.__tables.auditEvent.rows.find((x) => x.newState === PaymentState.PAID);
    expect(e.actorSystem).toBe('reconciler');
    expect(e.actorAddress).toBeNull();
    expect(e.metadata.verifiedBy).toBe('sac-transfer-event');
    expect(e.metadata.correlationId).toBe(RUN.correlationId);
  });

  it('creates no second payment when correcting', async () => {
    seedEscrow(5, P.map((p) => ({ ...p, state: PaymentState.CONFIRMING })));
    const v = verifier({
      escrow: chainEscrow(5, P.map((p) => ({ ...p, status: CHAIN_STATUS.FINALIZED }))),
      transfers: transfers(P.map((p) => ({ to: p.worker, amount: p.amount }))),
    });
    await reconcileOrganization(db, v, ORG, RUN);
    expect(db.__tables.payment.rows).toHaveLength(3);
  });

  it('is idempotent across repeated runs', async () => {
    seedEscrow(6, [{ ...P[0], state: PaymentState.CONFIRMING }]);
    const v = verifier({
      escrow: chainEscrow(6, [{ ...P[0], status: CHAIN_STATUS.FINALIZED }]),
      transfers: transfers([{ to: W1, amount: P[0].amount }]),
    });

    const first = await reconcileOrganization(db, v, ORG, RUN);
    const second = await reconcileOrganization(db, v, ORG, RUN);

    expect(first.correctionsApplied).toBe(1);
    expect(second.correctionsApplied).toBe(0);
    expect(second.agreed).toBe(1);
    expect(findings()).toHaveLength(0);
    const transitions = db.__tables.auditEvent.rows.filter(
      (e) => e.newState === PaymentState.PAID
    );
    expect(transitions).toHaveLength(1);
  });
});

describe('DATABASE_AHEAD is never reverted', () => {
  it('records a CRITICAL finding and leaves PAID in place', async () => {
    // The worst finding in the system: we are telling a finance team money moved.
    // Reverting it would destroy the evidence of our own worst bug.
    seedEscrow(7, [{ ...P[0], state: PaymentState.PAID }]);
    const v = verifier({
      escrow: chainEscrow(7, [{ ...P[0], status: CHAIN_STATUS.PENDING }]),
      transfers: [],
    });

    const t = await reconcileOrganization(db, v, ORG, RUN);

    expect(t.databaseAhead).toBe(1);
    const f = findings().find((x) => x.kind === FindingKind.DB_PAID_CHAIN_NOT);
    expect(f).toBeDefined();
    expect(f.severity).toBe(FindingSeverity.CRITICAL);
    expect(f.dbState).toBe('PAID');
    expect(f.remediation).toMatch(/Do not rely on the payment record/i);
    // Unchanged.
    expect(payment('pay_7_0').state).toBe(PaymentState.PAID);
    expect(t.correctionsApplied).toBe(0);
  });

  it('does not fabricate a transaction hash', async () => {
    seedEscrow(8, [{ ...P[0], state: PaymentState.PAID }]);
    const before = payment('pay_8_0').settlementTxHash;
    const v = verifier({
      escrow: chainEscrow(8, [{ ...P[0], status: CHAIN_STATUS.PENDING }]),
      transfers: [],
    });
    await reconcileOrganization(db, v, ORG, RUN);
    expect(payment('pay_8_0').settlementTxHash).toBe(before);
  });
});

describe('CHAIN_UNREADABLE is not agreement', () => {
  it('records unreadable rather than agreeing when the escrow cannot be read', async () => {
    seedEscrow(9, [{ ...P[0], state: PaymentState.PAID }]);
    const v = verifier({ escrow: 'unreadable' });

    const t = await reconcileOrganization(db, v, ORG, RUN);

    expect(t.unreadable).toBe(1);
    expect(t.agreed).toBe(0);
    expect(t.mismatched).toBe(0);
    expect(kinds()).toContain(FindingKind.CHAIN_UNREADABLE);
    expect(payment('pay_9_0').state).toBe(PaymentState.PAID);
  });

  it('does not advance a payment when transfers cannot be read', async () => {
    // Advancing on contract state alone would defeat the independent check.
    seedEscrow(10, [{ ...P[0], state: PaymentState.CONFIRMING }]);
    const v = verifier({
      escrow: chainEscrow(10, [{ ...P[0], status: CHAIN_STATUS.FINALIZED }]),
      transfers: 'unreadable',
    });

    const t = await reconcileOrganization(db, v, ORG, RUN);

    expect(t.unreadable).toBe(1);
    expect(t.chainAhead).toBe(0);
    expect(payment('pay_10_0').state).toBe(PaymentState.CONFIRMING);
    const f = findings().find((x) => x.kind === FindingKind.CHAIN_UNREADABLE);
    expect(f.detail).toMatch(/NOT advanced/i);
  });

  it('does not mark anything failed because of a timeout', async () => {
    seedEscrow(11, [{ ...P[0], state: PaymentState.CONFIRMING }]);
    const v = verifier({ escrow: 'unreadable' });
    await reconcileOrganization(db, v, ORG, RUN);
    expect(payment('pay_11_0').state).toBe(PaymentState.CONFIRMING);
    expect(payment('pay_11_0').state).not.toBe(PaymentState.SETTLEMENT_FAILED);
  });

  it('distinguishes an absent escrow from an unreadable one', async () => {
    seedEscrow(12, [{ ...P[0], state: PaymentState.READY_TO_SETTLE }]);
    const v = verifier({ escrow: 'notfound' });
    await reconcileOrganization(db, v, ORG, RUN);
    expect(kinds()).toContain(FindingKind.MISSING_ON_CHAIN);
    expect(kinds()).not.toContain(FindingKind.CHAIN_UNREADABLE);
  });
});

describe('batch-level verification does not hide payment-level errors', () => {
  it('catches individual mismatches even when the batch total matches', async () => {
    // The brief's case: 1000/960/900 recorded, 1000/860/1000 settled. Total is
    // 2860 either way. Aggregate equality would report everything fine.
    seedEscrow(13, P.map((p) => ({ ...p, state: PaymentState.PAID })));
    const settledWrong = [
      { index: 0, worker: W1, amount: 10_000_000_000n, status: CHAIN_STATUS.FINALIZED },
      { index: 1, worker: W2, amount: 8_600_000_000n, status: CHAIN_STATUS.FINALIZED },
      { index: 2, worker: W3, amount: 10_000_000_000n, status: CHAIN_STATUS.FINALIZED },
    ];
    const dbTotal = P.reduce((a, p) => a + p.amount, 0n);
    const chainTotal = settledWrong.reduce((a, p) => a + p.amount, 0n);
    expect(chainTotal).toBe(dbTotal); // totals agree

    const v = verifier({
      escrow: chainEscrow(13, settledWrong),
      transfers: transfers(settledWrong.map((p) => ({ to: p.worker, amount: p.amount }))),
    });

    const t = await reconcileOrganization(db, v, ORG, RUN);

    // Two individual payments disagree and both are reported.
    const amountFindings = findings().filter((f) => f.kind === FindingKind.AMOUNT_MISMATCH);
    expect(amountFindings.length).toBeGreaterThanOrEqual(2);
    expect(t.mismatched).toBeGreaterThanOrEqual(2);
    // And a mismatched payment is NOT also counted as agreed. Reporting
    // "3 of 3 agreed" for a batch with two wrong amounts would be worse than
    // reporting nothing.
    expect(t.agreed).toBe(1);
    expect(t.agreed + t.mismatched).toBeLessThanOrEqual(3 + amountFindings.length);
  });
});

describe('identity mismatches', () => {
  it('flags a recipient mismatch', async () => {
    seedEscrow(14, [{ ...P[0], state: PaymentState.PAID }]);
    const v = verifier({
      escrow: chainEscrow(14, [{ index: 0, worker: W2, amount: P[0].amount, status: CHAIN_STATUS.FINALIZED }]),
      transfers: transfers([{ to: W2, amount: P[0].amount }]),
    });
    await reconcileOrganization(db, v, ORG, RUN);
    const f = findings().find((x) => x.kind === FindingKind.RECIPIENT_MISMATCH);
    expect(f.dbState).toBe(W1);
    expect(f.chainState).toBe(W2);
    expect(f.severity).toBe(FindingSeverity.HIGH);
  });

  it('flags an asset mismatch', async () => {
    seedEscrow(15, [{ ...P[0], state: PaymentState.PAID }]);
    const other = 'C' + 'X'.repeat(55);
    const chain = chainEscrow(15, [{ ...P[0], status: CHAIN_STATUS.FINALIZED }]);
    chain.payments[0].token = other;
    const v = verifier({ escrow: chain, transfers: [] });
    await reconcileOrganization(db, v, ORG, RUN);
    expect(kinds()).toContain(FindingKind.ASSET_MISMATCH);
  });

  it('flags duplicate transfers as possible double payment', async () => {
    seedEscrow(16, [{ ...P[0], state: PaymentState.PAID }]);
    const v = verifier({
      escrow: chainEscrow(16, [{ ...P[0], status: CHAIN_STATUS.FINALIZED }]),
      // Two transfers for one payee inside ONE pay_batch — the genuine
      // double-payment condition, as opposed to the same payroll run twice.
      transfers: transfers([
        { to: W1, amount: P[0].amount, tx: SETTLEMENT_TX },
        { to: W1, amount: P[0].amount, tx: SETTLEMENT_TX },
      ]),
    });
    await reconcileOrganization(db, v, ORG, RUN);
    const f = findings().find((x) => x.kind === FindingKind.DUPLICATE_PAYMENT_EVENT);
    expect(f.detail).toMatch(/paid twice/i);
    expect(f.severity).toBe(FindingSeverity.HIGH);
  });
});

describe('recurring payroll is not a duplicate payment', () => {
  it('does not flag a repeat of an identical pay period as a double payment', async () => {
    // THE LIVE-CAUGHT BUG. The tuple (escrow contract, recipient, asset, amount)
    // repeats every pay period, so an unscoped match found one transfer per
    // historical settlement and reported duplicate payments that never happened.
    seedEscrow(30, P.map((p) => ({ ...p, state: PaymentState.PAID })));
    const v = verifier({
      escrow: chainEscrow(30, P.map((p) => ({ ...p, status: CHAIN_STATUS.FINALIZED }))),
      transfers: [
        ...priorPeriodTransfers(),                                        // last month
        ...priorPeriodTransfers().map((t) => ({ ...t, txHash: 'TX_TWO_MONTHS_AGO', ledger: 200 })),
        ...transfers(P.map((p) => ({ to: p.worker, amount: p.amount }))), // this month
      ],
    });

    const t = await reconcileOrganization(db, v, ORG, RUN);

    expect(kinds()).not.toContain(FindingKind.DUPLICATE_PAYMENT_EVENT);
    expect(t.agreed).toBe(3);
    expect(t.mismatched).toBe(0);
  });

  it('still confirms settlement when the payment already records its transaction', async () => {
    seedEscrow(31, P.map((p) => ({ ...p, state: PaymentState.PAID })));
    // Payments carry the settlement tx from seedEscrow; the observed transfers
    // for this period are under that same hash, and an earlier period is not.
    const v = verifier({
      escrow: chainEscrow(31, P.map((p) => ({ ...p, status: CHAIN_STATUS.FINALIZED }))),
      transfers: [
        ...priorPeriodTransfers(),
        ...transfers(P.map((p) => ({ to: p.worker, amount: p.amount, tx: SETTLEMENT_TX }))),
      ],
    });

    const t = await reconcileOrganization(db, v, ORG, RUN);

    expect(t.agreed).toBe(3);
    expect(kinds()).not.toContain(FindingKind.DUPLICATE_PAYMENT_EVENT);
  });
});

describe('a recorded transaction with no matching transfer', () => {
  it('flags a payment whose recorded hash has no corresponding transfer', async () => {
    // The DB names a settlement transaction; the token reports no such movement.
    // Scoping to that transaction is what makes this detectable at all.
    seedEscrow(32, [{ ...P[0], state: PaymentState.PAID }]);
    db.__tables.payment.rows.find((p) => p.id === 'pay_32_0')!.settlementTxHash = 'HASH_NOT_ON_CHAIN';

    const v = verifier({
      escrow: chainEscrow(32, [{ ...P[0], status: CHAIN_STATUS.FINALIZED }]),
      transfers: transfers([{ to: W1, amount: P[0].amount }]), // under a different tx
    });

    const t = await reconcileOrganization(db, v, ORG, RUN);

    expect(kinds()).toContain(FindingKind.MISSING_PAYMENT_EVENT);
    expect(t.agreed).toBe(0);
    // PAID is not reverted; the finding is the record.
    expect(payment('pay_32_0').state).toBe(PaymentState.PAID);
  });
});

describe('orphans and missing slots', () => {
  it('flags an on-chain payment with no database row', async () => {
    seedEscrow(17, [{ ...P[0], state: PaymentState.PAID }]);
    const v = verifier({
      escrow: chainEscrow(17, P.map((p) => ({ ...p, status: CHAIN_STATUS.FINALIZED }))),
      transfers: transfers(P.map((p) => ({ to: p.worker, amount: p.amount }))),
    });
    await reconcileOrganization(db, v, ORG, RUN);
    expect(findings().filter((f) => f.kind === FindingKind.ORPHAN_ON_CHAIN)).toHaveLength(2);
  });

  it('reports unattributed escrows without attaching them to a tenant', async () => {
    // Preserves the P2 #2 decision: never invent an owner.
    db.__tables.chainEvent.rows.push(
      { id: 'c1', contractId: ESCROW_CONTRACT, network: 'testnet', type: 'created', ledger: 10, escrowOnChainId: 77, attributed: false },
      { id: 'c2', contractId: ESCROW_CONTRACT, network: 'testnet', type: 'payment_added', ledger: 11, escrowOnChainId: 77, attributed: false }
    );

    const r = await reportUnattributedEscrows(db, ORG, RUN, {
      contractId: ESCROW_CONTRACT, network: 'testnet',
    });

    // One finding for the escrow, not one per event.
    expect(r.findingsOpened).toBe(1);
    const f = findings()[0];
    expect(f.kind).toBe(FindingKind.UNKNOWN_ON_CHAIN_OBJECT);
    expect(f.severity).toBe(FindingSeverity.LOW);
    expect(f.remediation).toMatch(/will not guess an owner/i);
    // No escrow, payment or organization was created.
    expect(db.__tables.escrow.rows).toHaveLength(0);
    expect(db.__tables.organization.rows).toHaveLength(1);
  });
});

describe('falsely-failed transactions', () => {
  beforeEach(() => {
    db.__tables.payment.rows.push({
      id: 'pay_x', orgId: ORG, batchId: 'b', escrowId: 'e',
      recipientAddress: W1, onChainPaymentIndex: 0,
      amountBaseUnits: 100n, rateBaseUnits: 1n, hours: 100n,
      assetDecimals: 7, assetCode: 'USDC',
      state: PaymentState.SETTLEMENT_FAILED, stateUpdatedAt: new Date(), createdAt: new Date(),
    });
    db.__tables.blockchainTransaction.rows.push({
      id: 'btx1', orgId: ORG, paymentId: 'pay_x', kind: 'PAY_BATCH',
      status: 'FAILED', idempotencyKey: 'k1', attempt: 1, hash: 'HASH_OK',
    });
  });

  it('detects a false failure and says DO NOT RETRY', async () => {
    const r = await reconcileFailedTransactions(db, verifier({ txSucceeded: true }), ORG, RUN);
    expect(r.falselyFailed).toBe(1);
    const f = findings().find((x) => x.kind === FindingKind.FAILED_TX_ACTUALLY_SUCCEEDED);
    expect(f.severity).toBe(FindingSeverity.CRITICAL);
    expect(f.remediation).toMatch(/DO NOT RETRY/i);
    expect(db.__tables.blockchainTransaction.rows[0].status).toBe('CONFIRMED');
  });

  it('leaves a genuinely failed transaction alone', async () => {
    const r = await reconcileFailedTransactions(db, verifier({ txSucceeded: false }), ORG, RUN);
    expect(r.falselyFailed).toBe(0);
    expect(db.__tables.blockchainTransaction.rows[0].status).toBe('FAILED');
  });

  it.each(['unreadable', 'notfound'] as const)('leaves it alone when the chain says %s', async (mode) => {
    const r = await reconcileFailedTransactions(db, verifier({ txSucceeded: mode }), ORG, RUN);
    expect(r.falselyFailed).toBe(0);
    expect(db.__tables.blockchainTransaction.rows[0].status).toBe('FAILED');
  });
});

describe('finding deduplication', () => {
  it('re-observes rather than duplicating an unchanged discrepancy', async () => {
    // A queue that grows by a row per run per problem becomes noise, and noise
    // gets ignored — the same as having no queue.
    seedEscrow(18, [{ ...P[0], state: PaymentState.PAID }]);
    const v = verifier({
      escrow: chainEscrow(18, [{ ...P[0], status: CHAIN_STATUS.PENDING }]),
      transfers: [],
    });

    await reconcileOrganization(db, v, ORG, RUN);
    const afterFirst = findings().length;
    const second = await reconcileOrganization(db, v, ORG, RUN);

    expect(second.findingsOpened).toBe(0);
    expect(findings()).toHaveLength(afterFirst);
    const f = findings()[0];
    expect(f.observationCount).toBe(2);
    expect(f.lastObservedAt).toBeInstanceOf(Date);
  });

  it('does not reset an acknowledgement when re-observing', async () => {
    seedEscrow(19, [{ ...P[0], state: PaymentState.PAID }]);
    const v = verifier({
      escrow: chainEscrow(19, [{ ...P[0], status: CHAIN_STATUS.PENDING }]),
      transfers: [],
    });
    await reconcileOrganization(db, v, ORG, RUN);

    const f = findings()[0];
    f.status = FindingStatus.ACKNOWLEDGED;
    f.acknowledgedBy = 'GOPERATOR';

    await reconcileOrganization(db, v, ORG, RUN);

    // Acknowledging a persistent finding must stay acknowledged, or it is
    // impossible to acknowledge anything that recurs.
    expect(findings()[0].status).toBe(FindingStatus.ACKNOWLEDGED);
    expect(findings()[0].acknowledgedBy).toBe('GOPERATOR');
  });

  it('opens a new finding once the previous one is resolved', async () => {
    seedEscrow(20, [{ ...P[0], state: PaymentState.PAID }]);
    const v = verifier({
      escrow: chainEscrow(20, [{ ...P[0], status: CHAIN_STATUS.PENDING }]),
      transfers: [],
    });
    await reconcileOrganization(db, v, ORG, RUN);
    findings()[0].status = FindingStatus.RESOLVED;
    findings()[0].resolvedAt = new Date();

    const again = await reconcileOrganization(db, v, ORG, RUN);

    expect(again.findingsOpened).toBe(1);
    expect(findings()).toHaveLength(2);
  });
});

describe('finding policy', () => {
  it('reserves CRITICAL for false statements about money', () => {
    expect(policyFor(FindingKind.DB_PAID_CHAIN_NOT).severity).toBe(FindingSeverity.CRITICAL);
    expect(policyFor(FindingKind.FAILED_TX_ACTUALLY_SUCCEEDED).severity).toBe(FindingSeverity.CRITICAL);
    // A lag is not a crisis.
    expect(policyFor(FindingKind.CHAIN_PAID_DB_NOT).severity).not.toBe(FindingSeverity.CRITICAL);
    expect(policyFor(FindingKind.CHAIN_UNREADABLE).severity).toBe(FindingSeverity.LOW);
  });

  it('gives every finding kind actionable remediation', () => {
    for (const kind of Object.values(FindingKind)) {
      const p = policyFor(kind);
      expect(p.remediation.length, kind).toBeGreaterThan(30);
      expect(p.severity, kind).toBeTruthy();
    }
  });
});
