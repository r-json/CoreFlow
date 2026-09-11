// @vitest-environment node
/**
 * Reconciliation tests.
 *
 * The property under test is restraint: where the database and the chain
 * disagree, the disagreement must become VISIBLE rather than be papered over.
 * A reconciler that silently rewrites the losing side destroys the evidence an
 * incident review depends on.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { PaymentState } from '@prisma/client';
import { createFakeDb, seedOrg, type FakeDb } from './fake-db';
import {
  reconcileOrganization,
  reconcileFailedTransactions,
  CHAIN_STATUS,
  type ChainEscrowView,
} from '../reconcile';

const ORG = 'org_test';
const W1 = 'G' + '1'.repeat(55);
const W2 = 'G' + '2'.repeat(55);
const TOKEN = 'C' + 'T'.repeat(55);

let db: FakeDb;

function seedEscrowWithPayments(
  onChainId: number,
  payments: { index: number; worker: string; amount: bigint; state: PaymentState }[]
) {
  db.__tables.escrow.rows.push({
    id: `esc_${onChainId}`, orgId: ORG, onChainId,
    contractId: 'CCONTRACT', network: 'testnet',
    managerAddress: 'GM', financeApproverAddress: 'GF',
    assetDecimals: 7, totalAmountBaseUnits: 0n,
    managerApproved: true, financeApproved: true, cancelled: false,
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
    });
  }
}

function chainView(
  onChainId: number,
  payments: { index: number; worker: string; amount: bigint; status: number }[]
): ChainEscrowView {
  return {
    onChainId, managerApproved: true, financeApproved: true, cancelled: false,
    payments: payments.map((p) => ({
      index: p.index, worker: p.worker, token: TOKEN,
      amountBaseUnits: p.amount, hours: p.amount,
      proofVerified: true, status: p.status,
    })),
  };
}

const findings = () => db.__tables.reconciliationFinding.rows;
const payment = (id: string) => db.__tables.payment.rows.find((p) => p.id === id)!;

beforeEach(() => {
  db = createFakeDb();
  seedOrg(db, ORG);
});

describe('agreement', () => {
  it('opens no findings when database and chain agree', async () => {
    seedEscrowWithPayments(1, [
      { index: 0, worker: W1, amount: 100n, state: PaymentState.PAID },
      { index: 1, worker: W2, amount: 200n, state: PaymentState.PAID },
    ]);
    const report = await reconcileOrganization(
      {
        db,
        fetchChainEscrow: async () =>
          chainView(1, [
            { index: 0, worker: W1, amount: 100n, status: CHAIN_STATUS.FINALIZED },
            { index: 1, worker: W2, amount: 200n, status: CHAIN_STATUS.FINALIZED },
          ]),
      },
      ORG
    );

    expect(report.paymentsChecked).toBe(2);
    expect(report.findingsOpened).toBe(0);
    expect(findings()).toHaveLength(0);
  });
});

describe('chain settled, database behind', () => {
  it('advances the database to PAID — the money moved regardless of our record', async () => {
    seedEscrowWithPayments(2, [
      { index: 0, worker: W1, amount: 100n, state: PaymentState.CONFIRMING },
    ]);
    const report = await reconcileOrganization(
      {
        db,
        fetchChainEscrow: async () =>
          chainView(2, [{ index: 0, worker: W1, amount: 100n, status: CHAIN_STATUS.FINALIZED }]),
      },
      ORG
    );

    expect(report.advancedToPaid).toBe(1);
    expect(payment('pay_2_0').state).toBe(PaymentState.PAID);
    expect(payment('pay_2_0').settledAt).toBeTruthy();
  });

  it('attributes the correction to the reconciler, not a person', async () => {
    seedEscrowWithPayments(3, [
      { index: 0, worker: W1, amount: 100n, state: PaymentState.CONFIRMING },
    ]);
    await reconcileOrganization(
      {
        db,
        fetchChainEscrow: async () =>
          chainView(3, [{ index: 0, worker: W1, amount: 100n, status: CHAIN_STATUS.FINALIZED }]),
      },
      ORG
    );
    const e = db.__tables.auditEvent.rows.find((x) => x.newState === PaymentState.PAID);
    expect(e.actorSystem).toBe('reconciler');
    expect(e.actorAddress).toBeNull();
  });

  it('records a finding when it cannot advance from the current state', async () => {
    // AWAITING_ORACLE → PAID is not a declared transition. The table is NOT
    // relaxed to accommodate the chain; the gap is surfaced instead.
    seedEscrowWithPayments(4, [
      { index: 0, worker: W1, amount: 100n, state: PaymentState.AWAITING_ORACLE },
    ]);
    const report = await reconcileOrganization(
      {
        db,
        fetchChainEscrow: async () =>
          chainView(4, [{ index: 0, worker: W1, amount: 100n, status: CHAIN_STATUS.FINALIZED }]),
      },
      ORG
    );

    expect(report.advancedToPaid).toBe(0);
    expect(findings().some((f) => f.kind === 'CHAIN_PAID_DB_NOT')).toBe(true);
    expect(payment('pay_4_0').state).toBe(PaymentState.AWAITING_ORACLE);
  });
});

describe('database claims PAID, chain disagrees', () => {
  it('records the discrepancy rather than silently un-paying it', async () => {
    // The worst disagreement in the system: we are telling a finance team money
    // moved when it did not.
    seedEscrowWithPayments(5, [
      { index: 0, worker: W1, amount: 100n, state: PaymentState.PAID },
    ]);
    const report = await reconcileOrganization(
      {
        db,
        fetchChainEscrow: async () =>
          chainView(5, [{ index: 0, worker: W1, amount: 100n, status: CHAIN_STATUS.PENDING }]),
      },
      ORG
    );

    expect(report.findingsOpened).toBeGreaterThan(0);
    const f = findings().find((x) => x.kind === 'DB_PAID_CHAIN_NOT');
    expect(f).toBeDefined();
    expect(f.dbState).toBe('PAID');

    // PAID is terminal, so the state is not rewritten. The finding is the durable
    // record, and the table is not weakened to permit an exit from PAID.
    expect(payment('pay_5_0').state).toBe(PaymentState.PAID);
  });
});

describe('financial identity mismatches', () => {
  it('flags an amount disagreement', async () => {
    seedEscrowWithPayments(6, [
      { index: 0, worker: W1, amount: 100n, state: PaymentState.PAID },
    ]);
    await reconcileOrganization(
      {
        db,
        fetchChainEscrow: async () =>
          chainView(6, [{ index: 0, worker: W1, amount: 999n, status: CHAIN_STATUS.FINALIZED }]),
      },
      ORG
    );
    const f = findings().find((x) => x.kind === 'AMOUNT_MISMATCH');
    expect(f.dbState).toBe('100');
    expect(f.chainState).toBe('999');
  });

  it('flags a recipient disagreement', async () => {
    seedEscrowWithPayments(7, [
      { index: 0, worker: W1, amount: 100n, state: PaymentState.PAID },
    ]);
    await reconcileOrganization(
      {
        db,
        fetchChainEscrow: async () =>
          chainView(7, [{ index: 0, worker: W2, amount: 100n, status: CHAIN_STATUS.FINALIZED }]),
      },
      ORG
    );
    expect(findings().some((x) => x.kind === 'RECIPIENT_MISMATCH')).toBe(true);
  });
});

describe('missing and orphan payments', () => {
  it('flags a database payment with no on-chain slot', async () => {
    seedEscrowWithPayments(8, [
      { index: 0, worker: W1, amount: 100n, state: PaymentState.READY_TO_SETTLE },
      { index: 1, worker: W2, amount: 200n, state: PaymentState.READY_TO_SETTLE },
    ]);
    await reconcileOrganization(
      {
        db,
        fetchChainEscrow: async () =>
          chainView(8, [{ index: 0, worker: W1, amount: 100n, status: CHAIN_STATUS.PENDING }]),
      },
      ORG
    );
    expect(findings().some((x) => x.kind === 'MISSING_ON_CHAIN')).toBe(true);
  });

  it('flags an on-chain payment with no database row', async () => {
    // Without this, the product simply does not show a payment that exists.
    seedEscrowWithPayments(9, [
      { index: 0, worker: W1, amount: 100n, state: PaymentState.READY_TO_SETTLE },
    ]);
    await reconcileOrganization(
      {
        db,
        fetchChainEscrow: async () =>
          chainView(9, [
            { index: 0, worker: W1, amount: 100n, status: CHAIN_STATUS.PENDING },
            { index: 1, worker: W2, amount: 200n, status: CHAIN_STATUS.PENDING },
          ]),
      },
      ORG
    );
    expect(findings().some((x) => x.kind === 'ORPHAN_ON_CHAIN')).toBe(true);
  });
});

describe('unreadable chain state', () => {
  it('does not treat a failed read as agreement', async () => {
    // Assuming "all fine" when the chain cannot be read is how silent drift
    // accumulates unnoticed.
    seedEscrowWithPayments(10, [
      { index: 0, worker: W1, amount: 100n, state: PaymentState.PAID },
    ]);
    const report = await reconcileOrganization(
      {
        db,
        fetchChainEscrow: async () => {
          throw new Error('rpc unavailable');
        },
      },
      ORG
    );

    expect(report.unreadable).toBe(1);
    expect(report.paymentsChecked).toBe(0);
    expect(findings().some((x) => x.kind === 'MISSING_ON_CHAIN')).toBe(true);
  });
});

describe('cancellation', () => {
  it('cancels a database payment the chain reports as cancelled', async () => {
    seedEscrowWithPayments(11, [
      { index: 0, worker: W1, amount: 100n, state: PaymentState.AWAITING_MANAGER },
    ]);
    await reconcileOrganization(
      {
        db,
        fetchChainEscrow: async () =>
          chainView(11, [{ index: 0, worker: W1, amount: 100n, status: CHAIN_STATUS.CANCELLED }]),
      },
      ORG
    );
    expect(payment('pay_11_0').state).toBe(PaymentState.CANCELLED);
  });

  it('does not cancel a payment already settled', async () => {
    seedEscrowWithPayments(12, [
      { index: 0, worker: W1, amount: 100n, state: PaymentState.PAID },
    ]);
    await reconcileOrganization(
      {
        db,
        fetchChainEscrow: async () =>
          chainView(12, [{ index: 0, worker: W1, amount: 100n, status: CHAIN_STATUS.CANCELLED }]),
      },
      ORG
    );
    expect(payment('pay_12_0').state).toBe(PaymentState.PAID);
    expect(findings().some((x) => x.kind === 'DB_PAID_CHAIN_NOT')).toBe(true);
  });
});

describe('idempotency of reconciliation itself', () => {
  it('does not multiply findings for one unchanged discrepancy', async () => {
    // A duplicated finding queue becomes noise, and a noisy queue gets ignored.
    seedEscrowWithPayments(13, [
      { index: 0, worker: W1, amount: 100n, state: PaymentState.PAID },
    ]);
    const deps = {
      db,
      fetchChainEscrow: async () =>
        chainView(13, [{ index: 0, worker: W1, amount: 999n, status: CHAIN_STATUS.FINALIZED }]),
    };

    await reconcileOrganization(deps, ORG);
    const afterFirst = findings().length;
    const second = await reconcileOrganization(deps, ORG);

    expect(second.findingsOpened).toBe(0);
    expect(findings()).toHaveLength(afterFirst);
  });

  it('is safe to run repeatedly on a healthy organization', async () => {
    seedEscrowWithPayments(14, [
      { index: 0, worker: W1, amount: 100n, state: PaymentState.PAID },
    ]);
    const deps = {
      db,
      fetchChainEscrow: async () =>
        chainView(14, [{ index: 0, worker: W1, amount: 100n, status: CHAIN_STATUS.FINALIZED }]),
    };
    await reconcileOrganization(deps, ORG);
    await reconcileOrganization(deps, ORG);
    expect(findings()).toHaveLength(0);
    expect(db.__tables.auditEvent.rows).toHaveLength(0);
  });
});

describe('transactions recorded as failed that actually succeeded', () => {
  beforeEach(() => {
    db.__tables.payment.rows.push({
      id: 'pay_x', orgId: ORG, batchId: 'b', escrowId: 'e',
      recipientAddress: W1, onChainPaymentIndex: 0,
      amountBaseUnits: 100n, rateBaseUnits: 1n, hours: 100n,
      assetDecimals: 7, assetCode: 'USDC',
      state: PaymentState.SETTLEMENT_FAILED, stateUpdatedAt: new Date(), createdAt: new Date(),
    });
    db.__tables.blockchainTransaction.rows.push({
      id: 'btx_1', orgId: ORG, paymentId: 'pay_x', kind: 'PAY_BATCH',
      status: 'FAILED', idempotencyKey: 'k1', attempt: 1, hash: 'HASH_OK',
      network: 'testnet',
    });
  });

  it('detects a false failure and warns against retrying', async () => {
    // An RPC timeout reported as failure while the transaction landed is the most
    // dangerous state in a payments system: it invites a retry that double-pays.
    const r = await reconcileFailedTransactions(
      { db, fetchTxSucceeded: async () => true },
      ORG
    );

    expect(r.falselyFailed).toBe(1);
    const f = findings().find((x) => x.kind === 'FAILED_TX_ACTUALLY_SUCCEEDED');
    expect(f.detail).toMatch(/Do not retry/i);
    expect(db.__tables.blockchainTransaction.rows[0].status).toBe('CONFIRMED');
  });

  it('leaves a genuinely failed transaction alone', async () => {
    const r = await reconcileFailedTransactions(
      { db, fetchTxSucceeded: async () => false },
      ORG
    );
    expect(r.falselyFailed).toBe(0);
    expect(findings()).toHaveLength(0);
    expect(db.__tables.blockchainTransaction.rows[0].status).toBe('FAILED');
  });

  it('leaves a transaction alone when the chain cannot be read', async () => {
    const r = await reconcileFailedTransactions(
      {
        db,
        fetchTxSucceeded: async () => {
          throw new Error('rpc down');
        },
      },
      ORG
    );
    expect(r.falselyFailed).toBe(0);
    expect(db.__tables.blockchainTransaction.rows[0].status).toBe('FAILED');
  });
});
