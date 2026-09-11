import { describe, it, expect, beforeEach, vi } from 'vitest';
import { OrgRole, PaymentState, TxStatus, TxKind } from '@prisma/client';

// STELLAR_CONFIG reads process.env at module load, so it is stubbed rather than
// configured after the fact.
//
// The address is written out INSIDE the factory: vi.mock is hoisted above every
// declaration in this file, so a factory closing over a module constant throws
// "Cannot access 'CONTRACT' before initialization".
vi.mock('@/lib/config', () => {
  const id = 'CDN4FIKLJ72WYNPBIKWYSDJWDZG22QNPLWI37VTUAE4EKKIBVAQRG5F4';
  return {
    STELLAR_CONFIG: {
      contract: { id, network: 'testnet' },
      requireContractId: () => id,
      networkLabel: () => 'Stellar Testnet',
      isMainnet: () => false,
    },
  };
});

const CONTRACT = 'CDN4FIKLJ72WYNPBIKWYSDJWDZG22QNPLWI37VTUAE4EKKIBVAQRG5F4';
const TOKEN = 'CBW2ZKFBHLHNNVCZ7JP4AXHQOOC3S6NLAMORXOAIWQNWMKUVJS743Q5M';
vi.mock('@/lib/oracle', () => ({ getOraclePublicKeyHex: () => 'ab'.repeat(32) }));

import { createFakeDb, type FakeDb } from '@/lib/payments/__tests__/fake-db';
import {
  planDigest,
  readStoredPlan,
  openFundingIntent,
  recordFundingSubmitted,
  failFundingIntent,
  confirmFunding,
  getFundingState,
  selectFinanceApprover,
  fundingIdempotencyKey,
} from '../service';
import type { ChainVerifier } from '@/lib/reconciliation/chain-verifier';
import type { TenantContext } from '@/lib/tenancy/resolve';

const ORG = 'orgA';
const BATCH = { id: 'bat_1', reference: 'CF-00001' };

function wallet(tag: string): string {
  return ('G' + tag.toUpperCase().replace(/[^A-Z2-7]/g, '')).padEnd(56, 'A');
}

const MANAGER = wallet('manager');
const FINANCE = wallet('finance');
const HASH = 'a'.repeat(64);

function ctxFor(role: OrgRole = OrgRole.MANAGER, address = MANAGER): TenantContext {
  return {
    orgId: ORG,
    orgName: 'Org A',
    orgSlug: 'org-a',
    userId: 'usr_manager',
    walletAddress: address,
    role,
  };
}

let db: FakeDb;

/** Three payments whose rows satisfy hours x rate == amount. */
const ROWS = [
  { id: 'pay_1', recipient: wallet('alice'), amount: 10_000_000_000n, rate: 250_000_000n, hours: 40n },
  { id: 'pay_2', recipient: wallet('bob'), amount: 16_000_000_000n, rate: 200_000_000n, hours: 80n },
  { id: 'pay_3', recipient: wallet('carol'), amount: 2_600_000_000n, rate: 130_000_000n, hours: 20n },
];
const TOTAL = 28_600_000_000n;

function seed() {
  db.__tables.organization.rows.push({ id: ORG, name: 'Org A', slug: 'org-a' });
  for (const [role, address, userId] of [
    [OrgRole.MANAGER, MANAGER, 'usr_manager'],
    [OrgRole.FINANCE, FINANCE, 'usr_finance'],
  ] as const) {
    db.__tables.user.rows.push({ id: userId, walletAddress: address });
    db.__tables.orgMember.rows.push({
      id: `ogm_${userId}`,
      orgId: ORG,
      userId,
      role,
      status: 'ACTIVE',
      createdAt: new Date('2026-01-01'),
    });
  }
  db.__tables.payrollBatch.rows.push({
    id: BATCH.id,
    orgId: ORG,
    reference: BATCH.reference,
    createdAt: new Date(),
  });
  for (const [i, r] of ROWS.entries()) {
    db.__tables.payment.rows.push({
      id: r.id,
      orgId: ORG,
      batchId: BATCH.id,
      recipientAddress: r.recipient,
      assetCode: 'USDC',
      assetContractId: TOKEN,
      assetDecimals: 7,
      amountBaseUnits: r.amount,
      rateBaseUnits: r.rate,
      hours: r.hours,
      periodStart: new Date('2026-09-01T00:00:00Z'),
      periodEnd: new Date('2026-09-15T00:00:00Z'),
      state: PaymentState.DRAFT,
      escrowId: null,
      onChainPaymentIndex: null,
      createdAt: new Date(Date.now() + i),
    });
  }
}

/** A verifier that agrees with the plan. */
function agreeingVerifier(over: Partial<ChainVerifier> = {}): ChainVerifier {
  return {
    readTransactionSucceeded: async () => ({ ok: true, value: true }),
    readEscrow: async (onChainId: number) => ({
      ok: true,
      value: {
        onChainId,
        manager: MANAGER,
        financeApprover: FINANCE,
        managerApproved: false,
        financeApproved: false,
        cancelled: false,
        payments: ROWS.map((r, i) => ({
          index: i,
          worker: r.recipient,
          token: TOKEN,
          amountBaseUnits: r.amount,
          hours: 0n,
          proofVerified: false,
          status: 0,
        })),
      },
    }),
    readTransfers: async () => ({
      ok: true,
      value: [
        { from: MANAGER, to: CONTRACT, assetContractId: TOKEN, amountBaseUnits: TOTAL, ledger: 100, txHash: HASH },
      ],
    }),
    latestLedger: async () => ({ ok: true, value: 100 }),
    ...over,
  };
}

beforeEach(() => {
  db = createFakeDb();
  seed();
  process.env.NEXT_PUBLIC_STELLAR_TOKEN_ID = TOKEN;
  process.env.NEXT_PUBLIC_SETTLEMENT_ASSET_CODE = 'USDC';
});

// ---------------------------------------------------------------------------

describe('selectFinanceApprover', () => {
  it('picks a wallet distinct from the funder, preferring FINANCE', async () => {
    expect(await selectFinanceApprover(db, ORG, MANAGER)).toBe(FINANCE);
  });

  it('returns null when the only candidate is the funder', async () => {
    expect(await selectFinanceApprover(db, ORG, FINANCE)).toBeNull();
  });
});

describe('getFundingState', () => {
  it('produces a plan carrying exactly what will be signed', async () => {
    const state = await getFundingState(db, ctxFor(), BATCH);

    expect(state.assessment.eligible).toBe(true);
    expect(state.assessment.totalBaseUnits).toBe(TOTAL.toString());
    expect(state.assessment.total).toBe('2,860.00');

    const plan = state.plan!;
    expect(plan.manager).toBe(MANAGER);
    expect(plan.financeApprover).toBe(FINANCE);
    expect(plan.asset).toEqual({ code: 'USDC', contractId: TOKEN, decimals: 7 });
    expect(plan.contractId).toBe(CONTRACT);
    // Custody is the contract's own address.
    expect(plan.custodyDestination).toBe(CONTRACT);
    expect(plan.network).toEqual({ id: 'testnet', label: 'Stellar Testnet', isMainnet: false });
    expect(plan.schedule).toHaveLength(3);
    expect(plan.schedule.map((r) => r.worker)).toEqual(ROWS.map((r) => r.recipient));
    expect(plan.schedule.map((r) => r.amountBaseUnits)).toEqual(ROWS.map((r) => r.amount));
    // Periods as unix seconds, from the stored dates.
    expect(plan.schedule[0].startDate).toBe(Math.floor(Date.UTC(2026, 8, 1) / 1000));
    expect(plan.schedule[0].endDate).toBe(Math.floor(Date.UTC(2026, 8, 15) / 1000));
  });

  it('withholds the plan when the batch is not fundable', async () => {
    db.__tables.payment.rows[0].periodStart = null;
    const state = await getFundingState(db, ctxFor(), BATCH);
    expect(state.assessment.eligible).toBe(false);
    // No plan for an unfundable batch: there is nothing safe to sign.
    expect(state.plan).toBeNull();
  });

  it('writes nothing', async () => {
    await getFundingState(db, ctxFor(), BATCH);
    expect(db.__tables.blockchainTransaction.rows).toHaveLength(0);
    expect(db.__tables.auditEvent.rows).toHaveLength(0);
    expect(db.__tables.payment.rows.every((p) => p.state === PaymentState.DRAFT)).toBe(true);
  });
});

describe('openFundingIntent', () => {
  it('opens one attempt, moves payments to VALIDATING, and records it', async () => {
    const result = await openFundingIntent(db, ctxFor(), BATCH);

    expect(result.created).toBe(true);
    expect(result.attempt.status).toBe(TxStatus.AWAITING_SIGNATURE);
    expect(result.attempt.attempt).toBe(1);

    const txs = db.__tables.blockchainTransaction.rows;
    expect(txs).toHaveLength(1);
    expect(txs[0].kind).toBe(TxKind.INITIALIZE_ESCROW);
    expect(txs[0].batchId).toBe(BATCH.id);
    expect(txs[0].idempotencyKey).toBe(fundingIdempotencyKey(BATCH.id, 1));
    expect(txs[0].hash).toBeUndefined();

    expect(db.__tables.payment.rows.every((p) => p.state === PaymentState.VALIDATING)).toBe(true);

    const audit = db.__tables.auditEvent.rows.filter((e) => e.type === 'funding.intent.opened');
    expect(audit).toHaveLength(1);
    expect(audit[0].metadata.totalBaseUnits).toBe(TOTAL.toString());
    expect(audit[0].metadata.financeApprover).toBe(FINANCE);
  });

  it('returns the SAME attempt on a second call, rather than funding twice', async () => {
    const first = await openFundingIntent(db, ctxFor(), BATCH);
    const second = await openFundingIntent(db, ctxFor(), BATCH);

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.attempt.id).toBe(first.attempt.id);
    // One attempt, so one escrow, so one custody transfer.
    expect(db.__tables.blockchainTransaction.rows).toHaveLength(1);
  });

  it('converges on one attempt under concurrent calls', async () => {
    const results = await Promise.all([
      openFundingIntent(db, ctxFor(), BATCH),
      openFundingIntent(db, ctxFor(), BATCH),
      openFundingIntent(db, ctxFor(), BATCH),
    ]);
    expect(new Set(results.map((r) => r.attempt.id)).size).toBe(1);
    expect(results.filter((r) => r.created)).toHaveLength(1);
    expect(db.__tables.blockchainTransaction.rows).toHaveLength(1);
  });

  it('refuses an ineligible batch and explains why', async () => {
    db.__tables.payment.rows[1].periodEnd = null;
    await expect(openFundingIntent(db, ctxFor(), BATCH)).rejects.toMatchObject({
      status: 409,
      code: 'STATE_CONFLICT',
    });
    expect(db.__tables.blockchainTransaction.rows).toHaveLength(0);
    // Nothing moved out of DRAFT.
    expect(db.__tables.payment.rows.every((p) => p.state === PaymentState.DRAFT)).toBe(true);
  });

  it('refuses a role that cannot fund', async () => {
    await expect(
      openFundingIntent(db, ctxFor(OrgRole.VIEWER, wallet('viewer')), BATCH),
    ).rejects.toMatchObject({ status: 409 });
  });
});

describe('submission and abandonment', () => {
  it('records a submitted hash without claiming success', async () => {
    const opened = await openFundingIntent(db, ctxFor(), BATCH);
    const attempt = await recordFundingSubmitted(db, ctxFor(), {
      attemptId: opened.attempt.id,
      transactionHash: HASH,
    });

    expect(attempt.status).toBe(TxStatus.SUBMITTED);
    expect(attempt.hash).toBe(HASH);
    expect(attempt.confirmedAt).toBeNull();
    // Submitted is not funded: no escrow, and payments have not advanced.
    expect(db.__tables.escrow.rows).toHaveLength(0);
    expect(db.__tables.payment.rows.every((p) => p.escrowId === null)).toBe(true);
  });

  it('returns payments to DRAFT when the signature is declined', async () => {
    const opened = await openFundingIntent(db, ctxFor(), BATCH);
    const attempt = await failFundingIntent(db, ctxFor(), {
      attemptId: opened.attempt.id,
      reason: 'User declined the signature in Freighter',
      userRejected: true,
      batchId: BATCH.id,
    });

    expect(attempt.status).toBe(TxStatus.CANCELLED);
    // Safe only because nothing was submitted.
    expect(db.__tables.payment.rows.every((p) => p.state === PaymentState.DRAFT)).toBe(true);
    expect(db.__tables.auditEvent.rows.some((e) => e.type === 'funding.declined')).toBe(true);
  });

  it('does NOT rewind payments when a transaction was already submitted', async () => {
    const opened = await openFundingIntent(db, ctxFor(), BATCH);
    await recordFundingSubmitted(db, ctxFor(), { attemptId: opened.attempt.id, transactionHash: HASH, batchId: BATCH.id });
    await failFundingIntent(db, ctxFor(), {
      attemptId: opened.attempt.id,
      reason: 'RPC timed out while polling',
      batchId: BATCH.id,
    });

    // The money may have moved. Quietly marking the batch editable again would
    // invite a second funding of an escrow that already exists.
    expect(db.__tables.payment.rows.every((p) => p.state === PaymentState.VALIDATING)).toBe(true);
  });

  it('allows a fresh attempt after a declined one, with a new idempotency key', async () => {
    const first = await openFundingIntent(db, ctxFor(), BATCH);
    await failFundingIntent(db, ctxFor(), {
      attemptId: first.attempt.id,
      reason: 'declined',
      userRejected: true,
      batchId: BATCH.id,
    });
    const second = await openFundingIntent(db, ctxFor(), BATCH);

    expect(second.created).toBe(true);
    expect(second.attempt.attempt).toBe(2);
    expect(db.__tables.blockchainTransaction.rows).toHaveLength(2);
    const keys = db.__tables.blockchainTransaction.rows.map((t) => t.idempotencyKey);
    expect(new Set(keys).size).toBe(2);
  });

  it('refuses to abandon a confirmed attempt', async () => {
    const opened = await openFundingIntent(db, ctxFor(), BATCH);
    await recordFundingSubmitted(db, ctxFor(), { attemptId: opened.attempt.id, transactionHash: HASH, batchId: BATCH.id });
    await confirmFunding(db, ctxFor(), agreeingVerifier(), {
        attemptId: opened.attempt.id,
        onChainEscrowId: 9,
        batchId: BATCH.id,
      });

    await expect(
      failFundingIntent(db, ctxFor(), {
        attemptId: opened.attempt.id,
        reason: 'changed my mind',
        batchId: BATCH.id,
      }),
    ).rejects.toMatchObject({ status: 409 });
  });
});

describe('confirmFunding', () => {
  async function submitted() {
    const opened = await openFundingIntent(db, ctxFor(), BATCH);
    await recordFundingSubmitted(db, ctxFor(), { attemptId: opened.attempt.id, transactionHash: HASH, batchId: BATCH.id });
    return opened.attempt.id;
  }

  it('records funding only after the chain agrees', async () => {
    const attemptId = await submitted();
    const result = await confirmFunding(db, ctxFor(), agreeingVerifier(), { attemptId, onChainEscrowId: 9, batchId: BATCH.id });

    expect(result.outcome).toBe('CONFIRMED');
    if (result.outcome !== 'CONFIRMED') return;
    expect(result.escrow.onChainId).toBe(9);

    const escrow = db.__tables.escrow.rows[0];
    expect(escrow.onChainId).toBe(9);
    expect(escrow.managerAddress).toBe(MANAGER);
    expect(escrow.financeApproverAddress).toBe(FINANCE);
    expect(escrow.tokenAddress).toBe(TOKEN);
    expect(escrow.totalAmountBaseUnits).toBe(TOTAL);

    // Every payment is linked to its on-chain slot, in submitted order. This is
    // what stops the indexer creating a duplicate set of rows.
    const payments = db.__tables.payment.rows;
    expect(payments.map((p) => p.onChainPaymentIndex)).toEqual([0, 1, 2]);
    expect(payments.every((p) => p.escrowId === escrow.id)).toBe(true);

    const tx = db.__tables.blockchainTransaction.rows[0];
    expect(tx.status).toBe(TxStatus.CONFIRMED);
    expect(tx.escrowId).toBe(escrow.id);

    const audit = db.__tables.auditEvent.rows.filter((e) => e.type === 'funding.confirmed');
    expect(audit).toHaveLength(1);
    // Attributed to the verifier: this record exists because the chain was read.
    expect(audit[0].actorSystem).toBe('funding-verifier');
    expect(audit[0].metadata.custodyDestination).toBe(CONTRACT);
    expect(audit[0].metadata.totalBaseUnits).toBe(TOTAL.toString());
  });

  it('leaves payments in VALIDATING for the indexer to advance', async () => {
    const attemptId = await submitted();
    await confirmFunding(db, ctxFor(), agreeingVerifier(), { attemptId, onChainEscrowId: 9 });
    // Funding links the records; the chain-observing indexer owns the transition to
    // AWAITING_ORACLE when it sees payment/add.
    expect(db.__tables.payment.rows.every((p) => p.state === PaymentState.VALIDATING)).toBe(true);
  });

  it('replays a confirmation instead of recording it twice', async () => {
    const attemptId = await submitted();
    await confirmFunding(db, ctxFor(), agreeingVerifier(), { attemptId, onChainEscrowId: 9 });
    const again = await confirmFunding(db, ctxFor(), agreeingVerifier(), { attemptId, onChainEscrowId: 9, batchId: BATCH.id });

    expect(again.outcome).toBe('CONFIRMED');
    expect(db.__tables.escrow.rows).toHaveLength(1);
    expect(
      db.__tables.auditEvent.rows.filter((e) => e.type === 'funding.confirmed'),
    ).toHaveLength(1);
  });

  it('reports FAILED when the chain says the transaction failed', async () => {
    const attemptId = await submitted();
    const result = await confirmFunding(
      db,
      ctxFor(),
      agreeingVerifier({ readTransactionSucceeded: async () => ({ ok: true, value: false }) }),
      { attemptId, onChainEscrowId: 9 },
    );

    expect(result.outcome).toBe('FAILED');
    expect(db.__tables.escrow.rows).toHaveLength(0);
    // Nothing moved, so the batch becomes preparable again.
    expect(db.__tables.payment.rows.every((p) => p.state === PaymentState.DRAFT)).toBe(true);
  });

  it('reports UNVERIFIABLE when the chain cannot be read, and records nothing', async () => {
    const attemptId = await submitted();
    const result = await confirmFunding(
      db,
      ctxFor(),
      agreeingVerifier({
        readTransactionSucceeded: async () => ({
          ok: false,
          error: { kind: 'UNREADABLE', reason: 'rpc timeout' },
        }),
      }),
      { attemptId, onChainEscrowId: 9 },
    );

    expect(result.outcome).toBe('UNVERIFIABLE');
    // Emphatically not FAILED: marking a funded escrow failed because RPC timed out
    // would be worse than waiting.
    expect(db.__tables.blockchainTransaction.rows[0].status).toBe(TxStatus.SUBMITTED);
    expect(db.__tables.escrow.rows).toHaveLength(0);
  });

  it('reports MISMATCH and records nothing when the escrow is not the one planned', async () => {
    const attemptId = await submitted();
    const result = await confirmFunding(
      db,
      ctxFor(),
      agreeingVerifier({
        readEscrow: async (onChainId: number) => ({
          ok: true,
          value: {
            onChainId,
            manager: MANAGER,
            financeApprover: FINANCE,
            managerApproved: false,
            financeApproved: false,
            cancelled: false,
            // Someone else's escrow: a different payee and a different amount.
            payments: [
              { index: 0, worker: wallet('attacker'), token: TOKEN, amountBaseUnits: 1n, hours: 0n, proofVerified: false, status: 0 },
            ],
          },
        }),
      }),
      { attemptId, onChainEscrowId: 9 },
    );

    expect(result.outcome).toBe('MISMATCH');
    if (result.outcome !== 'MISMATCH') return;
    expect(result.differences.length).toBeGreaterThan(0);
    // The escrow is NOT adopted as this batch's: it is not the escrow we asked for.
    expect(db.__tables.escrow.rows).toHaveLength(0);
    expect(db.__tables.payment.rows.every((p) => p.escrowId === null)).toBe(true);
    expect(db.__tables.auditEvent.rows.some((e) => e.type === 'funding.mismatch')).toBe(true);
  });

  it('reports MISMATCH when the on-chain escrow is cancelled', async () => {
    const attemptId = await submitted();
    const base = agreeingVerifier();
    const result = await confirmFunding(
      db,
      ctxFor(),
      {
        ...base,
        readEscrow: async (id: number) => {
          const r = await base.readEscrow(id);
          if (!r.ok) return r;
          return { ok: true, value: { ...r.value, cancelled: true } };
        },
      },
      { attemptId, onChainEscrowId: 9 },
    );
    expect(result.outcome).toBe('MISMATCH');
  });

  it('does not confirm when no custody transfer is found in that transaction', async () => {
    const attemptId = await submitted();
    const result = await confirmFunding(
      db,
      ctxFor(),
      agreeingVerifier({
        // The escrow exists, but no transfer is observable for this hash.
        readTransfers: async () => ({ ok: true, value: [] }),
      }),
      { attemptId, onChainEscrowId: 9 },
    );

    expect(result.outcome).toBe('UNVERIFIABLE');
    expect(db.__tables.escrow.rows).toHaveLength(0);
  });

  it('does not confirm when the transfer amount differs from the plan', async () => {
    const attemptId = await submitted();
    const result = await confirmFunding(
      db,
      ctxFor(),
      agreeingVerifier({
        readTransfers: async () => ({
          ok: true,
          value: [
            { from: MANAGER, to: CONTRACT, assetContractId: TOKEN, amountBaseUnits: 1n, ledger: 100, txHash: HASH },
          ],
        }),
      }),
      { attemptId, onChainEscrowId: 9 },
    );
    expect(result.outcome).toBe('UNVERIFIABLE');
    expect(db.__tables.escrow.rows).toHaveLength(0);
  });

  it('refuses to verify an attempt with no transaction hash', async () => {
    const opened = await openFundingIntent(db, ctxFor(), BATCH);
    await expect(
      confirmFunding(db, ctxFor(), agreeingVerifier(), {
        attemptId: opened.attempt.id,
        onChainEscrowId: 9,
      }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('links to an escrow the indexer already created, rather than duplicating it', async () => {
    const attemptId = await submitted();
    db.__tables.escrow.rows.push({
      id: 'esc_indexer',
      orgId: ORG,
      onChainId: 9,
      contractId: CONTRACT,
      network: 'testnet',
      managerAddress: MANAGER,
      financeApproverAddress: FINANCE,
      assetDecimals: 7,
      totalAmountBaseUnits: 0n,
      createdAt: new Date(),
    });

    const result = await confirmFunding(db, ctxFor(), agreeingVerifier(), { attemptId, onChainEscrowId: 9, batchId: BATCH.id });

    expect(result.outcome).toBe('CONFIRMED');
    // onChainId is unique: whoever got there first wins and the other links to it.
    expect(db.__tables.escrow.rows).toHaveLength(1);
    expect(db.__tables.payment.rows.every((p) => p.escrowId === 'esc_indexer')).toBe(true);
  });
});

describe('the stored plan is the authority', () => {
  async function submitted() {
    const opened = await openFundingIntent(db, ctxFor(), BATCH);
    await recordFundingSubmitted(db, ctxFor(), { attemptId: opened.attempt.id, transactionHash: HASH, batchId: BATCH.id });
    return opened.attempt.id;
  }

  it('persists the plan and its digest when the intent is opened', async () => {
    await openFundingIntent(db, ctxFor(), BATCH);
    const tx = db.__tables.blockchainTransaction.rows[0];

    expect(tx.plan).toBeDefined();
    expect(tx.planDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(planDigest(tx.plan)).toBe(tx.planDigest);

    // Money inside the JSON is a decimal string, never a Number.
    expect(tx.plan.totalBaseUnits).toBe(TOTAL.toString());
    expect(tx.plan.rows).toHaveLength(3);
    for (const row of tx.plan.rows) {
      expect(typeof row.amountBaseUnits).toBe('string');
      expect(typeof row.rateBaseUnits).toBe('string');
    }
    expect(tx.plan.manager).toBe(MANAGER);
    expect(tx.plan.financeApprover).toBe(FINANCE);
    expect(tx.plan.custodyDestination).toBe(CONTRACT);
    expect(tx.plan.network).toBe('testnet');
  });

  it('refuses a plan whose digest no longer matches it', async () => {
    const attemptId = await submitted();
    const tx = db.__tables.blockchainTransaction.rows[0];
    // Somebody edited the stored JSON to pay a different wallet.
    tx.plan = { ...tx.plan, rows: [{ ...tx.plan.rows[0], worker: wallet('attacker') }, ...tx.plan.rows.slice(1)] };

    await expect(
      confirmFunding(db, ctxFor(), agreeingVerifier(), { attemptId, onChainEscrowId: 9 }),
    ).rejects.toMatchObject({ status: 409 });
    expect(db.__tables.escrow.rows).toHaveLength(0);
  });

  it('refuses to verify an attempt that stored no plan', async () => {
    const attemptId = await submitted();
    const tx = db.__tables.blockchainTransaction.rows[0];
    tx.plan = null;
    tx.planDigest = null;

    await expect(
      confirmFunding(db, ctxFor(), agreeingVerifier(), { attemptId, onChainEscrowId: 9 }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('detects an escrow paying a recipient the plan never named', async () => {
    const attemptId = await submitted();
    const base = agreeingVerifier();
    const result = await confirmFunding(
      db,
      ctxFor(),
      {
        ...base,
        readEscrow: async (id: number) => {
          const r = await base.readEscrow(id);
          if (!r.ok) return r;
          const payments = [...r.value.payments];
          payments[1] = { ...payments[1], worker: wallet('attacker') };
          return { ok: true, value: { ...r.value, payments } };
        },
      },
      { attemptId, onChainEscrowId: 9 },
    );

    expect(result.outcome).toBe('MISMATCH');
    if (result.outcome !== 'MISMATCH') return;
    expect(result.differences.some((d) => d.includes('the plan says'))).toBe(true);
    expect(db.__tables.escrow.rows).toHaveLength(0);
  });

  it('detects an escrow whose finance approver is not the planned one', async () => {
    const attemptId = await submitted();
    const base = agreeingVerifier();
    const result = await confirmFunding(
      db,
      ctxFor(),
      {
        ...base,
        readEscrow: async (id: number) => {
          const r = await base.readEscrow(id);
          if (!r.ok) return r;
          return { ok: true, value: { ...r.value, financeApprover: wallet('someoneelse') } };
        },
      },
      { attemptId, onChainEscrowId: 9 },
    );
    expect(result.outcome).toBe('MISMATCH');
  });

  it('detects an escrow whose manager and finance approver are the same key', async () => {
    const attemptId = await submitted();
    const base = agreeingVerifier();
    const result = await confirmFunding(
      db,
      ctxFor(),
      {
        ...base,
        readEscrow: async (id: number) => {
          const r = await base.readEscrow(id);
          if (!r.ok) return r;
          return { ok: true, value: { ...r.value, financeApprover: MANAGER } };
        },
      },
      { attemptId, onChainEscrowId: 9 },
    );
    // Dual control is vacuous if one key holds both halves; the contract refuses it
    // at creation, and an escrow that somehow had it must not be adopted.
    expect(result.outcome).toBe('MISMATCH');
  });

  it('detects a payment edited after the plan was frozen', async () => {
    const attemptId = await submitted();
    // The chain still matches the plan, but the database no longer does.
    db.__tables.payment.rows[0].amountBaseUnits = 99_999_999_999n;

    const result = await confirmFunding(db, ctxFor(), agreeingVerifier(), { attemptId, onChainEscrowId: 9, batchId: BATCH.id });

    expect(result.outcome).toBe('MISMATCH');
    if (result.outcome !== 'MISMATCH') return;
    expect(result.differences.some((d) => d.includes('altered since the plan'))).toBe(true);
    // Adopting it would attach an escrow to payments nobody authorised.
    expect(db.__tables.escrow.rows).toHaveLength(0);
  });

  it('detects a payment removed from the batch after the plan was frozen', async () => {
    const attemptId = await submitted();
    db.__tables.payment.rows.splice(2, 1);

    const result = await confirmFunding(db, ctxFor(), agreeingVerifier(), { attemptId, onChainEscrowId: 9, batchId: BATCH.id });
    expect(result.outcome).toBe('MISMATCH');
  });

  it('opens a CRITICAL finding on mismatch, preserving the evidence', async () => {
    const attemptId = await submitted();
    const base = agreeingVerifier();
    await confirmFunding(
      db,
      ctxFor(),
      {
        ...base,
        readEscrow: async (id: number) => {
          const r = await base.readEscrow(id);
          if (!r.ok) return r;
          return { ok: true, value: { ...r.value, payments: [] } };
        },
      },
      { attemptId, onChainEscrowId: 9 },
    );

    const findings = db.__tables.reconciliationFinding.rows;
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe('CRITICAL');
    expect(findings[0].detail).toContain('was NOT adopted');
    expect(findings[0].chainState).toBe('escrow:9');
  });

  it('verifies custody against the plan asset, not current configuration', async () => {
    const attemptId = await submitted();
    // The operator switches the settlement asset while the transaction is pending.
    process.env.NEXT_PUBLIC_SETTLEMENT_ASSET_CODE = 'EURC';
    try {
      const result = await confirmFunding(db, ctxFor(), agreeingVerifier(), { attemptId, onChainEscrowId: 9, batchId: BATCH.id });
      // The plan said USDC, the chain says USDC, so this confirms — a recomputed
      // plan would have disagreed with both.
      expect(result.outcome).toBe('CONFIRMED');
      expect(db.__tables.escrow.rows[0].tokenAddress).toBe(TOKEN);
    } finally {
      process.env.NEXT_PUBLIC_SETTLEMENT_ASSET_CODE = 'USDC';
    }
  });

  it('readStoredPlan round-trips a plan it considers valid', async () => {
    await openFundingIntent(db, ctxFor(), BATCH);
    const tx = db.__tables.blockchainTransaction.rows[0];
    const plan = readStoredPlan({ plan: tx.plan, planDigest: tx.planDigest });
    expect(plan.rows.map((r) => r.worker)).toEqual(ROWS.map((r) => r.recipient));
    expect(BigInt(plan.totalBaseUnits)).toBe(TOTAL);
  });
});

describe('an attempt is scoped to its batch', () => {
  it('is not actionable through a different batch', async () => {
    db.__tables.payrollBatch.rows.push({
      id: 'bat_other',
      orgId: ORG,
      reference: 'CF-00002',
      createdAt: new Date(),
    });
    const opened = await openFundingIntent(db, ctxFor(), BATCH);

    // The attempt exists and belongs to this organization, but not to this batch.
    // Without the batch filter, naming its id on another batch's route would act on
    // it — and the tests would not have noticed, because tsconfig excludes test
    // files from typechecking and `where: { batchId: undefined }` means "no filter".
    await expect(
      recordFundingSubmitted(db, ctxFor(), {
        attemptId: opened.attempt.id,
        transactionHash: HASH,
        batchId: 'bat_other',
      }),
    ).rejects.toMatchObject({ status: 404 });

    await expect(
      failFundingIntent(db, ctxFor(), {
        attemptId: opened.attempt.id,
        reason: 'wrong batch',
        batchId: 'bat_other',
      }),
    ).rejects.toMatchObject({ status: 404 });

    await expect(
      confirmFunding(db, ctxFor(), agreeingVerifier(), {
        attemptId: opened.attempt.id,
        onChainEscrowId: 9,
        batchId: 'bat_other',
      }),
    ).rejects.toMatchObject({ status: 404 });

    // Untouched.
    expect(db.__tables.blockchainTransaction.rows[0].status).toBe(TxStatus.AWAITING_SIGNATURE);
  });
});
