/**
 * The funding bridge: an approved draft becomes a funded on-chain escrow.
 *
 * ── One signature, not two ──────────────────────────────────────────────────
 * `initialize_multi_sig_escrow` creates the escrow AND pulls custody atomically.
 * There is no `fund()` and no `funded` flag — an escrow exists iff its custody
 * moved. So the lifecycle has ONE wallet interaction, and "created but unfunded"
 * is not a state this product can display, because it is not a state the contract
 * can be in.
 *
 * ── Why an intent record exists ─────────────────────────────────────────────
 * Because the contract is not idempotent. A second submission creates a second
 * escrow and moves the money again. Nothing on-chain prevents that, so a
 * BlockchainTransaction row is opened BEFORE the wallet opens, keyed
 * `fund:batch:<id>`, and its UNIQUE index is what makes a double-click, a refresh
 * or a second tab impossible to turn into a double payment. A disabled button is
 * not a control.
 *
 * ── Why the chain is re-read afterwards ─────────────────────────────────────
 * Freighter returning is not evidence. The client builds and signs the
 * transaction, so it could submit something other than the plan. Funding is
 * recorded only after reading back: the transaction succeeded, the escrow exists
 * with the planned manager, finance approver and payments, and a transfer of the
 * exact total reached the contract's own address in that transaction.
 */

import { createHash } from 'node:crypto';
import { PaymentState, TxKind, TxStatus, OrgRole, MembershipStatus } from '@prisma/client';
import { ApiError } from '@/lib/api/errors';
import { formatAmountWithSeparators } from '@/lib/money';
import { recordAuditEvent } from '@/lib/payments/service';
import { settlementAsset, type SettlementAsset } from '@/lib/payroll/assets';
import { getOraclePublicKeyHex } from '@/lib/oracle';
import { STELLAR_CONFIG } from '@/lib/config';
import type { ChainVerifier } from '@/lib/reconciliation/chain-verifier';
import type { TenantContext } from '@/lib/tenancy/resolve';
import {
  assessFundingEligibility,
  FUNDING_ROLES,
  type FundingAssessment,
  type FundingPayment,
} from './eligibility';

/** Statuses in which an attempt is neither finished nor abandoned. */
const IN_FLIGHT: readonly TxStatus[] = [
  TxStatus.PREPARING,
  TxStatus.SIMULATING,
  TxStatus.AWAITING_SIGNATURE,
  TxStatus.SUBMITTED,
];

/** The idempotency key for a batch's funding. One per batch, per attempt number. */
export function fundingIdempotencyKey(batchId: string, attempt: number): string {
  return attempt <= 1 ? `fund:batch:${batchId}` : `fund:batch:${batchId}:retry:${attempt}`;
}

/** A single row as the contract will receive it. */
export interface FundingScheduleRow {
  paymentId: string;
  worker: string;
  /** SAC address. Never inferred from an asset symbol. */
  token: string;
  amountBaseUnits: bigint;
  rateBaseUnits: bigint;
  /** Unix seconds, as the contract's u64 fields. */
  startDate: number;
  endDate: number;
}

/**
 * Everything the signer is entitled to know before a wallet opens.
 *
 * Assembled server-side from persisted Payment rows. The original CSV is never
 * re-read: the database records are the authoritative payment intent, and
 * re-deriving money from a file at signing time would let the two disagree.
 */
export interface FundingPlan {
  batch: { id: string; reference: string; paymentCount: number };
  total: string;
  totalBaseUnits: string;
  asset: { code: string; contractId: string; decimals: number };
  network: { id: string; label: string; isMainnet: boolean };
  /** The CoreFlow contract being invoked. */
  contractId: string;
  /** Where the funds will be held: the contract's own address. */
  custodyDestination: string;
  manager: string;
  financeApprover: string;
  oraclePublicKey: string;
  schedule: FundingScheduleRow[];
}

/** JSON-safe form of a plan, money as decimal strings. */
export interface StoredFundingPlan {
  batchId: string;
  reference: string;
  orgId: string;
  projectId: string | null;
  contractId: string;
  custodyDestination: string;
  network: string;
  manager: string;
  financeApprover: string;
  oraclePublicKey: string;
  assetCode: string;
  assetContractId: string;
  assetDecimals: number;
  totalBaseUnits: string;
  paymentCount: number;
  createdAt: string;
  rows: {
    paymentId: string;
    worker: string;
    token: string;
    amountBaseUnits: string;
    rateBaseUnits: string;
    startDate: number;
    endDate: number;
  }[];
}

export function serializePlan(
  plan: FundingPlan,
  meta: { orgId: string; projectId: string | null; createdAt: Date },
): StoredFundingPlan {
  return {
    batchId: plan.batch.id,
    reference: plan.batch.reference,
    orgId: meta.orgId,
    projectId: meta.projectId,
    contractId: plan.contractId,
    custodyDestination: plan.custodyDestination,
    network: plan.network.id,
    manager: plan.manager,
    financeApprover: plan.financeApprover,
    oraclePublicKey: plan.oraclePublicKey,
    assetCode: plan.asset.code,
    assetContractId: plan.asset.contractId,
    assetDecimals: plan.asset.decimals,
    totalBaseUnits: plan.totalBaseUnits,
    paymentCount: plan.batch.paymentCount,
    createdAt: meta.createdAt.toISOString(),
    rows: plan.schedule.map((r) => ({
      paymentId: r.paymentId,
      worker: r.worker,
      token: r.token,
      // Strings: JSON has no bigint, and a Number would be the rounding this
      // codebase refuses everywhere else.
      amountBaseUnits: r.amountBaseUnits.toString(),
      rateBaseUnits: r.rateBaseUnits.toString(),
      startDate: r.startDate,
      endDate: r.endDate,
    })),
  };
}

/**
 * SHA-256 over a canonical rendering of the plan.
 *
 * Keys are emitted in a fixed order so the digest depends on the plan's CONTENT
 * rather than on how a JSON serializer happened to order it.
 */
export function planDigest(plan: StoredFundingPlan): string {
  const canonical = JSON.stringify([
    plan.batchId,
    plan.orgId,
    plan.projectId,
    plan.contractId,
    plan.custodyDestination,
    plan.network,
    plan.manager,
    plan.financeApprover,
    plan.oraclePublicKey,
    plan.assetCode,
    plan.assetContractId,
    plan.assetDecimals,
    plan.totalBaseUnits,
    plan.paymentCount,
    plan.rows.map((r) => [
      r.paymentId,
      r.worker,
      r.token,
      r.amountBaseUnits,
      r.rateBaseUnits,
      r.startDate,
      r.endDate,
    ]),
  ]);
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

/**
 * Read back a stored plan, refusing a tampered one.
 *
 * A plan whose digest does not match its content cannot be used to decide whether
 * chain evidence is acceptable — it is no longer evidence of what was intended.
 */
export function readStoredPlan(record: {
  plan: unknown;
  planDigest: string | null;
}): StoredFundingPlan {
  if (!record.plan || typeof record.plan !== 'object') {
    throw new ApiError(
      409,
      'STATE_CONFLICT',
      'This funding attempt has no stored plan, so there is nothing to verify against.',
    );
  }
  const plan = record.plan as StoredFundingPlan;
  if (!record.planDigest || planDigest(plan) !== record.planDigest) {
    throw new ApiError(
      409,
      'STATE_CONFLICT',
      'The stored funding plan does not match its digest and cannot be trusted. ' +
        'Funding will not be confirmed against an altered plan.',
    );
  }
  return plan;
}

export interface FundingAttemptView {
  id: string;
  status: TxStatus;
  attempt: number;
  hash: string | null;
  errorMessage: string | null;
  createdAt: string;
  submittedAt: string | null;
  confirmedAt: string | null;
}

export interface FundingStateView {
  batch: { id: string; reference: string };
  assessment: {
    eligible: boolean;
    blockers: FundingAssessment['blockers'];
    paymentCount: number;
    total: string;
    totalBaseUnits: string;
  };
  /** Present only when the batch is eligible. No plan for an unfundable batch. */
  plan: FundingPlan | null;
  attempt: FundingAttemptView | null;
  escrow: { id: string; onChainId: number | null } | null;
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

const PAYMENT_SELECT = {
  id: true,
  recipientAddress: true,
  assetCode: true,
  assetContractId: true,
  assetDecimals: true,
  amountBaseUnits: true,
  rateBaseUnits: true,
  hours: true,
  periodStart: true,
  periodEnd: true,
  state: true,
  escrowId: true,
  onChainPaymentIndex: true,
} as const;

/**
 * A second wallet for the finance half of the gate.
 *
 * Chosen SERVER-SIDE and never taken from the request: letting a caller nominate
 * the finance approver would let them nominate themselves, which is exactly what
 * the contract refuses with SignersNotDistinct. FINANCE first, then an
 * administrative role, then deterministically by join order so the same batch
 * yields the same plan on every call.
 */
export async function selectFinanceApprover(
  db: any,
  orgId: string,
  excludeWalletAddress: string,
): Promise<string | null> {
  const members = await db.orgMember.findMany({
    where: {
      orgId,
      status: MembershipStatus.ACTIVE,
      role: { in: [OrgRole.FINANCE, OrgRole.OWNER, OrgRole.ADMIN] },
    },
    orderBy: [{ createdAt: 'asc' }],
    include: { user: { select: { walletAddress: true } } },
  });

  const priority: Record<string, number> = {
    [OrgRole.FINANCE]: 0,
    [OrgRole.OWNER]: 1,
    [OrgRole.ADMIN]: 2,
  };

  const candidates = members
    .filter((m: any) => m.user?.walletAddress && m.user.walletAddress !== excludeWalletAddress)
    .sort(
      (a: any, b: any) =>
        (priority[a.role] ?? 9) - (priority[b.role] ?? 9) ||
        new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
    );

  return candidates[0]?.user.walletAddress ?? null;
}

/** The batch's project, recorded on the plan so the intent names its full scope. */
async function projectIdForBatch(db: any, orgId: string, batchId: string): Promise<string | null> {
  const row = await db.payrollBatch.findFirst({
    where: { orgId, id: batchId },
    select: { projectId: true },
  });
  return row?.projectId ?? null;
}

/** The most recent funding attempt for a batch. */
async function latestAttempt(db: any, orgId: string, batchId: string) {
  return db.blockchainTransaction.findFirst({
    where: { orgId, batchId, kind: TxKind.INITIALIZE_ESCROW },
    orderBy: [{ attempt: 'desc' }],
  });
}

function oraclePublicKeyOrNull(): string | null {
  try {
    return getOraclePublicKeyHex();
  } catch {
    // Unconfigured is a blocker, not a crash: the operator needs to be told which
    // thing is missing, not handed a 500.
    return null;
  }
}

/** Seconds, as the contract's u64 period fields. */
function unixSeconds(d: Date): number {
  return Math.floor(d.getTime() / 1000);
}

// ---------------------------------------------------------------------------
// Assessment + plan
// ---------------------------------------------------------------------------

/**
 * Assess a batch and, if it is fundable, produce the exact funding plan.
 *
 * Read-only. Safe to call as often as a screen needs.
 */
export async function getFundingState(
  db: any,
  ctx: TenantContext,
  batch: { id: string; reference: string },
): Promise<FundingStateView> {
  const payments: FundingPayment[] = await db.payment.findMany({
    where: { orgId: ctx.orgId, batchId: batch.id },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: PAYMENT_SELECT,
  });

  const asset = settlementAsset();
  const financeApproverAddress = await selectFinanceApprover(db, ctx.orgId, ctx.walletAddress);
  const attempt = await latestAttempt(db, ctx.orgId, batch.id);
  const oraclePublicKey = oraclePublicKeyOrNull();

  const assessment = assessFundingEligibility({
    payments,
    asset,
    funder: { walletAddress: ctx.walletAddress, role: ctx.role },
    financeApproverAddress,
    attempt: attempt
      ? {
          id: attempt.id,
          status: attempt.status,
          hash: attempt.hash,
          createdAt: attempt.createdAt,
        }
      : null,
    oraclePublicKey,
  });

  const decimals = payments[0]?.assetDecimals ?? asset.decimals;

  // An escrow already linked to this batch, via its payments.
  const linked = payments.find((p) => p.escrowId !== null);
  const escrow = linked
    ? await db.escrow.findFirst({
        where: { orgId: ctx.orgId, id: linked.escrowId! },
        select: { id: true, onChainId: true },
      })
    : null;

  return {
    batch: { id: batch.id, reference: batch.reference },
    assessment: {
      eligible: assessment.eligible,
      blockers: assessment.blockers,
      paymentCount: assessment.paymentCount,
      total: formatAmountWithSeparators(assessment.totalBaseUnits, decimals),
      totalBaseUnits: assessment.totalBaseUnits.toString(),
    },
    plan:
      // A plan is produced when the BATCH is fundable. An attempt already in flight
      // is not a reason to withhold it: it is the same plan, and the signer may
      // need it again after a dropped wallet prompt. ALREADY_FUNDED does suppress
      // it — there is nothing left to sign.
      planReady(assessment) && asset.contractId && financeApproverAddress && oraclePublicKey
        ? buildFundingPlan({
            batch,
            payments,
            asset: { ...asset, contractId: asset.contractId },
            manager: ctx.walletAddress,
            financeApprover: financeApproverAddress,
            oraclePublicKey,
            totalBaseUnits: assessment.totalBaseUnits,
          })
        : null,
    attempt: attempt ? viewAttempt(attempt) : null,
    escrow,
  };
}

/**
 * Is the batch itself fundable, ignoring an attempt already in flight?
 *
 * Separated from `eligible` because the two questions differ: "may this batch be
 * funded?" and "may a NEW attempt be opened right now?". Conflating them left
 * `openFundingIntent` unable to return an existing attempt, because the attempt's
 * own existence made the batch look ineligible.
 */
function planReady(assessment: FundingAssessment): boolean {
  return assessment.blockers.every((b) => b.code === 'FUNDING_IN_FLIGHT');
}

function viewAttempt(tx: any): FundingAttemptView {
  return {
    id: tx.id,
    status: tx.status,
    attempt: tx.attempt,
    hash: tx.hash ?? null,
    errorMessage: tx.errorMessage ?? null,
    createdAt: tx.createdAt.toISOString(),
    submittedAt: tx.submittedAt?.toISOString() ?? null,
    confirmedAt: tx.confirmedAt?.toISOString() ?? null,
  };
}

export function buildFundingPlan(input: {
  batch: { id: string; reference: string };
  payments: readonly FundingPayment[];
  asset: SettlementAsset & { contractId: string };
  manager: string;
  financeApprover: string;
  oraclePublicKey: string;
  totalBaseUnits: bigint;
}): FundingPlan {
  const { asset } = input;

  const schedule: FundingScheduleRow[] = input.payments.map((p) => ({
    paymentId: p.id,
    worker: p.recipientAddress,
    // The CONFIGURED SAC, not whatever was stored on the row: a payment row's
    // assetContractId can be null for a draft created before the asset was wired.
    token: asset.contractId,
    amountBaseUnits: p.amountBaseUnits,
    rateBaseUnits: p.rateBaseUnits,
    // Eligibility has already refused a payment without a period, so these are
    // present. Asserted rather than defaulted: a fabricated pay period would be
    // signed by the oracle as though someone had stated it.
    startDate: unixSeconds(p.periodStart!),
    endDate: unixSeconds(p.periodEnd!),
  }));

  return {
    batch: {
      id: input.batch.id,
      reference: input.batch.reference,
      paymentCount: input.payments.length,
    },
    total: formatAmountWithSeparators(input.totalBaseUnits, asset.decimals),
    totalBaseUnits: input.totalBaseUnits.toString(),
    asset: { code: asset.code, contractId: asset.contractId, decimals: asset.decimals },
    network: {
      id: STELLAR_CONFIG.contract.network,
      label: STELLAR_CONFIG.networkLabel(),
      isMainnet: STELLAR_CONFIG.isMainnet(),
    },
    contractId: STELLAR_CONFIG.requireContractId(),
    // Custody is the contract's own address: `initialize_multi_sig_escrow`
    // transfers to `env.current_contract_address()`.
    custodyDestination: STELLAR_CONFIG.requireContractId(),
    manager: input.manager,
    financeApprover: input.financeApprover,
    oraclePublicKey: input.oraclePublicKey,
    schedule,
  };
}

// ---------------------------------------------------------------------------
// Intent lifecycle
// ---------------------------------------------------------------------------

export interface OpenIntentResult {
  /** False when an equivalent intent was already open. */
  created: boolean;
  attempt: FundingAttemptView;
  plan: FundingPlan;
}

/**
 * Open a funding intent, then hand back the plan to sign.
 *
 * The unique index on `idempotencyKey` is the control. A second call while an
 * attempt is open returns THAT attempt rather than creating another, so a
 * double-click, a refresh and a second tab all converge on one escrow.
 *
 * Payments move DRAFT → VALIDATING here, which is what makes the intent visible in
 * the payment records themselves rather than only in a transaction row.
 */
export async function openFundingIntent(
  db: any,
  ctx: TenantContext,
  batch: { id: string; reference: string },
): Promise<OpenIntentResult> {
  const state = await getFundingState(db, ctx, batch);

  // An attempt already open for this batch IS the answer — checked BEFORE the
  // eligibility gate, because the attempt's own existence is reported as a blocker
  // and would otherwise reject the very request it should satisfy. This is what
  // makes a double-click, a refresh and a second tab converge rather than fail.
  if (state.attempt && IN_FLIGHT.includes(state.attempt.status) && state.plan !== null) {
    return { created: false, attempt: state.attempt, plan: state.plan };
  }

  if (!state.assessment.eligible || state.plan === null) {
    throw new ApiError(
      409,
      'STATE_CONFLICT',
      'This batch cannot be funded yet.',
      { blockers: state.assessment.blockers },
    );
  }

  const nextAttempt = (state.attempt?.attempt ?? 0) + 1;
  const key = fundingIdempotencyKey(batch.id, nextAttempt);

  const projectId = await projectIdForBatch(db, ctx.orgId, batch.id);
  const stored = serializePlan(state.plan, {
    orgId: ctx.orgId,
    projectId,
    createdAt: new Date(),
  });
  const digest = planDigest(stored);

  try {
    const created = await db.$transaction(async (tx: any) => {
      const record = await tx.blockchainTransaction.create({
        data: {
          orgId: ctx.orgId,
          batchId: batch.id,
          kind: TxKind.INITIALIZE_ESCROW,
          status: TxStatus.AWAITING_SIGNATURE,
          idempotencyKey: key,
          attempt: nextAttempt,
          contractId: state.plan!.contractId,
          network: state.plan!.network.id,
          // Frozen here, before any wallet is shown, and never rewritten.
          plan: stored as unknown as object,
          planDigest: digest,
        },
      });

      // Each payment moves to VALIDATING under the state machine's own rules, so
      // the batch visibly leaves the editable stage the moment a wallet is opened.
      for (const row of state.plan!.schedule) {
        await tx.payment.updateMany({
          where: { id: row.paymentId, orgId: ctx.orgId, state: PaymentState.DRAFT },
          data: {
            state: PaymentState.VALIDATING,
            stateUpdatedAt: new Date(),
            stateReason: 'Funding transaction prepared; awaiting signature.',
          },
        });
      }

      await recordAuditEvent(tx, {
        orgId: ctx.orgId,
        type: 'funding.intent.opened',
        actor: { kind: 'user', role: ctx.role, address: ctx.walletAddress },
        batchId: batch.id,
        metadata: {
          attempt: nextAttempt,
          idempotencyKey: key,
          paymentCount: state.plan!.schedule.length,
          totalBaseUnits: state.assessment.totalBaseUnits,
          asset: state.plan!.asset.code,
          assetContractId: state.plan!.asset.contractId,
          contractId: state.plan!.contractId,
          network: state.plan!.network.id,
          manager: state.plan!.manager,
          financeApprover: state.plan!.financeApprover,
          planDigest: digest,
        },
      });

      return record;
    });

    return { created: true, attempt: viewAttempt(created), plan: state.plan };
  } catch (e: any) {
    // Lost the race: a concurrent request opened the intent first. Its attempt is
    // the answer — the caller asked for an intent to exist, and one does.
    if (e?.code === 'P2002') {
      const existing = await latestAttempt(db, ctx.orgId, batch.id);
      if (existing) {
        return { created: false, attempt: viewAttempt(existing), plan: state.plan };
      }
    }
    throw e;
  }
}

/** Record that a signed transaction reached the network. Submitted is not settled. */
export async function recordFundingSubmitted(
  db: any,
  ctx: TenantContext,
  input: { attemptId: string; transactionHash: string; batchId: string },
): Promise<FundingAttemptView> {
  const updated = await db.blockchainTransaction.updateMany({
    where: {
      id: input.attemptId,
      orgId: ctx.orgId,
      // Scoped to the batch in the URL: an attempt belonging to another batch is
      // not reachable by naming its id here.
      batchId: input.batchId,
      status: { in: [TxStatus.AWAITING_SIGNATURE, TxStatus.PREPARING, TxStatus.SIMULATING] },
    },
    data: {
      status: TxStatus.SUBMITTED,
      hash: input.transactionHash,
      submittedAt: new Date(),
    },
  });

  const record = await db.blockchainTransaction.findFirst({
    where: { id: input.attemptId, orgId: ctx.orgId, batchId: input.batchId },
  });
  if (!record) throw new ApiError(404, 'NOT_FOUND', 'Funding attempt not found.');

  if (updated.count === 1) {
    await recordAuditEvent(db, {
      orgId: ctx.orgId,
      type: 'funding.submitted',
      actor: { kind: 'user', role: ctx.role, address: ctx.walletAddress },
      batchId: record.batchId ?? undefined,
      txHash: input.transactionHash,
      metadata: { attemptId: input.attemptId, attempt: record.attempt },
    });
  }

  return viewAttempt(record);
}

/**
 * Abandon an attempt, so a rejected signature does not block the batch forever.
 *
 * Payments return to DRAFT only when nothing was submitted. Once a transaction has
 * a hash, the money may have moved and the record must not be quietly rewound —
 * that case needs chain evidence, not a status change.
 */
export async function failFundingIntent(
  db: any,
  ctx: TenantContext,
  input: { attemptId: string; reason: string; userRejected?: boolean; batchId: string },
): Promise<FundingAttemptView> {
  const record = await db.blockchainTransaction.findFirst({
    where: {
      id: input.attemptId,
      orgId: ctx.orgId,
      batchId: input.batchId,
      kind: TxKind.INITIALIZE_ESCROW,
    },
  });
  if (!record) throw new ApiError(404, 'NOT_FOUND', 'Funding attempt not found.');

  if (record.status === TxStatus.CONFIRMED) {
    throw new ApiError(
      409,
      'STATE_CONFLICT',
      'This funding transaction is already confirmed on-chain and cannot be abandoned.',
    );
  }

  // `== null` deliberately: the question is "was anything submitted?", and an
  // absent column reads as null from Prisma but as undefined from a row that never
  // set it. Either answer means no transaction reached the network.
  const nothingSubmitted = record.hash == null;

  await db.$transaction(async (tx: any) => {
    await tx.blockchainTransaction.updateMany({
      where: { id: record.id, orgId: ctx.orgId },
      data: {
        status: input.userRejected ? TxStatus.CANCELLED : TxStatus.FAILED,
        errorMessage: input.reason.slice(0, 500),
      },
    });

    if (nothingSubmitted && record.batchId) {
      // Safe precisely because nothing reached the network.
      await tx.payment.updateMany({
        where: {
          orgId: ctx.orgId,
          batchId: record.batchId,
          state: PaymentState.VALIDATING,
        },
        data: {
          state: PaymentState.DRAFT,
          stateUpdatedAt: new Date(),
          stateReason: input.userRejected
            ? 'Funding signature declined; the batch is editable again.'
            : `Funding failed before submission: ${input.reason.slice(0, 200)}`,
        },
      });
    }

    await recordAuditEvent(tx, {
      orgId: ctx.orgId,
      type: input.userRejected ? 'funding.declined' : 'funding.failed',
      actor: { kind: 'user', role: ctx.role, address: ctx.walletAddress },
      batchId: record.batchId ?? undefined,
      txHash: record.hash ?? undefined,
      metadata: {
        attemptId: record.id,
        attempt: record.attempt,
        reason: input.reason.slice(0, 500),
        paymentsReturnedToDraft: nothingSubmitted,
      },
    });
  });

  const after = await db.blockchainTransaction.findFirst({
    where: { id: record.id, orgId: ctx.orgId },
  });
  return viewAttempt(after);
}

// ---------------------------------------------------------------------------
// Chain verification
// ---------------------------------------------------------------------------

export type FundingConfirmation =
  | { outcome: 'CONFIRMED'; attempt: FundingAttemptView; escrow: { id: string; onChainId: number } }
  | { outcome: 'UNVERIFIABLE'; attempt: FundingAttemptView; reason: string }
  | { outcome: 'FAILED'; attempt: FundingAttemptView; reason: string }
  | { outcome: 'MISMATCH'; attempt: FundingAttemptView; differences: string[] };

/**
 * Confirm funding from chain evidence, and only then record it.
 *
 * Three outcomes that are NOT success, each distinct on purpose:
 *
 *   FAILED        the chain says the transaction failed. Nothing moved.
 *   UNVERIFIABLE  the chain could not be read. NOT a failure — retry later. Marking
 *                 a funded escrow as failed because RPC timed out would be worse
 *                 than waiting.
 *   MISMATCH      the chain disagrees with the plan. The escrow is NOT recorded as
 *                 this batch's, because it is not the escrow we asked for.
 */
export async function confirmFunding(
  db: any,
  ctx: TenantContext,
  verifier: ChainVerifier,
  input: { attemptId: string; onChainEscrowId: number; batchId: string },
): Promise<FundingConfirmation> {
  const record = await db.blockchainTransaction.findFirst({
    where: {
      id: input.attemptId,
      orgId: ctx.orgId,
      batchId: input.batchId,
      kind: TxKind.INITIALIZE_ESCROW,
    },
  });
  if (!record) throw new ApiError(404, 'NOT_FOUND', 'Funding attempt not found.');
  if (!record.hash) {
    throw new ApiError(
      409,
      'STATE_CONFLICT',
      'This attempt has no transaction hash, so there is nothing to verify.',
    );
  }
  if (!record.batchId) {
    throw new ApiError(409, 'STATE_CONFLICT', 'This attempt is not linked to a batch.');
  }

  // Already done. Replay the answer rather than re-recording.
  if (record.status === TxStatus.CONFIRMED && record.escrowId) {
    const escrow = await db.escrow.findFirst({
      where: { orgId: ctx.orgId, id: record.escrowId },
      select: { id: true, onChainId: true },
    });
    if (escrow?.onChainId != null) {
      return { outcome: 'CONFIRMED', attempt: viewAttempt(record), escrow: { id: escrow.id, onChainId: escrow.onChainId } };
    }
  }

  // ── 1. Did the transaction succeed? ──
  const succeeded = await verifier.readTransactionSucceeded(record.hash);
  if (!succeeded.ok) {
    return {
      outcome: 'UNVERIFIABLE',
      attempt: viewAttempt(record),
      reason: `The transaction could not be read (${succeeded.error.reason}). It may still be confirming.`,
    };
  }
  if (!succeeded.value) {
    const after = await markFailed(db, ctx, record, 'The network reported this transaction as failed.');
    return { outcome: 'FAILED', attempt: after, reason: 'The transaction failed on-chain. No funds moved.' };
  }

  // ── 2. Does the escrow match what we PLANNED — not what we would plan now? ──
  //
  // The comparison is against the stored plan. Configuration can move under a
  // pending transaction: the settlement asset could be switched, a different
  // finance approver could become the first candidate, a payment could be edited.
  // A recomputed plan would quietly agree with whatever the chain contained, which
  // is precisely the agreement that must not be manufactured.
  const plan = readStoredPlan(record);

  const onChain = await verifier.readEscrow(input.onChainEscrowId);
  if (!onChain.ok) {
    return {
      outcome: 'UNVERIFIABLE',
      attempt: viewAttempt(record),
      reason: `Escrow ${input.onChainEscrowId} could not be read (${onChain.error.reason}).`,
    };
  }

  const expectedTotal = BigInt(plan.totalBaseUnits);
  const differences: string[] = [];
  const facts = onChain.value;

  // The environment the transaction was prepared for.
  if (record.network !== plan.network) {
    differences.push(`the attempt records network ${record.network}, the plan says ${plan.network}`);
  }
  if (record.contractId && record.contractId !== plan.contractId) {
    differences.push(
      `the attempt records contract ${record.contractId}, the plan says ${plan.contractId}`,
    );
  }

  if (facts.cancelled) differences.push('the on-chain escrow is cancelled');
  if (facts.manager !== plan.manager) {
    differences.push(`the escrow manager is ${facts.manager}, the plan says ${plan.manager}`);
  }
  if (facts.financeApprover !== plan.financeApprover) {
    differences.push(
      `the escrow finance approver is ${facts.financeApprover}, the plan says ` +
        `${plan.financeApprover}`,
    );
  }
  if (facts.manager === facts.financeApprover) {
    differences.push('the escrow has the same address as manager and finance approver');
  }

  if (facts.payments.length !== plan.rows.length) {
    differences.push(
      `the escrow holds ${facts.payments.length} payments, the plan has ${plan.rows.length}`,
    );
  } else {
    for (const [i, expected] of plan.rows.entries()) {
      const actual = facts.payments[i];
      if (actual.worker !== expected.worker) {
        differences.push(`payment ${i} pays ${actual.worker}, the plan says ${expected.worker}`);
      }
      if (actual.amountBaseUnits !== BigInt(expected.amountBaseUnits)) {
        differences.push(
          `payment ${i} is for ${actual.amountBaseUnits} base units, the plan says ` +
            `${expected.amountBaseUnits}`,
        );
      }
      if (actual.token !== expected.token) {
        differences.push(`payment ${i} uses asset ${actual.token}, the plan says ${expected.token}`);
      }
    }
  }

  // Has the payment set itself been altered since the plan was frozen? The chain
  // may agree with the plan while the database no longer does, and adopting the
  // escrow would then attach it to payments nobody authorised.
  const payments: FundingPayment[] = await db.payment.findMany({
    where: { orgId: ctx.orgId, batchId: record.batchId },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: PAYMENT_SELECT,
  });
  const byId = new Map(payments.map((p) => [p.id, p]));
  for (const row of plan.rows) {
    const current = byId.get(row.paymentId);
    if (!current) {
      differences.push(`payment ${row.paymentId} named in the plan no longer exists`);
      continue;
    }
    if (
      current.recipientAddress !== row.worker ||
      current.amountBaseUnits !== BigInt(row.amountBaseUnits) ||
      current.rateBaseUnits !== BigInt(row.rateBaseUnits)
    ) {
      differences.push(
        `payment ${row.paymentId} has been altered since the plan was prepared`,
      );
    }
  }
  if (payments.length !== plan.rows.length) {
    differences.push(
      `this batch now has ${payments.length} payments, the plan was prepared for ${plan.rows.length}`,
    );
  }

  if (differences.length > 0) {
    // Do NOT record this escrow as the batch's. Recording a mismatched escrow
    // would make the product assert something about money that is not true.
    await db.blockchainTransaction.updateMany({
      where: { id: record.id, orgId: ctx.orgId },
      data: {
        errorMessage: `Chain disagrees with the funding plan: ${differences.join('; ')}`.slice(0, 500),
      },
    });
    await recordAuditEvent(db, {
      orgId: ctx.orgId,
      type: 'funding.mismatch',
      actor: { kind: 'reconciler', system: 'funding-verifier' },
      batchId: record.batchId,
      txHash: record.hash,
      metadata: {
        onChainEscrowId: input.onChainEscrowId,
        differences,
        planDigest: record.planDigest,
      },
    });
    // Evidence is preserved as a finding, not only as a log line: a mismatch means
    // somebody funded an escrow this batch did not describe.
    await db.reconciliationFinding.create({
      data: {
        orgId: ctx.orgId,
        kind: 'UNKNOWN_ON_CHAIN_OBJECT',
        severity: 'CRITICAL',
        detail:
          `Funding transaction ${record.hash} produced escrow ${input.onChainEscrowId}, ` +
          `which does not match the plan prepared for batch ${plan.reference}. ` +
          'The escrow was NOT adopted. ' +
          differences.join('; '),
        dbState: `plan:${record.planDigest}`,
        chainState: `escrow:${input.onChainEscrowId}`,
        metadata: { differences, txHash: record.hash } as any,
      },
    });
    return { outcome: 'MISMATCH', attempt: viewAttempt(record), differences };
  }

  // ── 3. Did custody actually move, in THIS transaction? ──
  const custody = plan.custodyDestination;
  {
    const transfers = await verifier.readTransfers(plan.assetContractId, {});
    if (!transfers.ok) {
      return {
        outcome: 'UNVERIFIABLE',
        attempt: viewAttempt(record),
        reason:
          `Custody could not be verified: asset transfers are unreadable ` +
          `(${transfers.error.reason}).`,
      };
    }
    const funding = transfers.value.find(
      (t) =>
        t.txHash === record.hash &&
        t.to === custody &&
        // The PLAN's manager, not the caller: verification must not depend on who
        // happens to be asking. A different administrator recovering an uncertain
        // transaction must reach the same verdict.
        t.from === plan.manager &&
        t.amountBaseUnits === expectedTotal,
    );
    if (!funding) {
      return {
        outcome: 'UNVERIFIABLE',
        attempt: viewAttempt(record),
        reason:
          `No transfer of ${expectedTotal} base units from ${plan.manager} to ` +
          `${custody} was found in transaction ${record.hash}. The escrow exists, so ` +
          'this is most likely event retention rather than a missing transfer — ' +
          'funding is left unconfirmed rather than asserted.',
      };
    }
  }

  // ── Record it ──
  const escrow = await db.$transaction(async (tx: any) => {
    // The indexer may already have created this escrow from `escrow/created`.
    // onChainId is unique, so whoever is first wins and the other links to it.
    let row = await tx.escrow.findFirst({
      where: { orgId: ctx.orgId, onChainId: input.onChainEscrowId },
      select: { id: true, onChainId: true },
    });
    if (!row) {
      row = await tx.escrow.create({
        data: {
          orgId: ctx.orgId,
          onChainId: input.onChainEscrowId,
          contractId: record.contractId ?? custody,
          network: record.network,
          managerAddress: facts.manager,
          financeApproverAddress: facts.financeApprover,
          oraclePublicKey: plan.oraclePublicKey,
          tokenAddress: plan.assetContractId,
          assetDecimals: plan.assetDecimals,
          totalAmountBaseUnits: expectedTotal,
          projectId: plan.projectId,
        },
        select: { id: true, onChainId: true },
      });
    }

    // Link each payment to its on-chain slot, in the order submitted. This is what
    // lets the indexer recognise these rows instead of creating duplicates, and
    // what makes re-indexing idempotent.
    for (const [i, p] of payments.entries()) {
      await tx.payment.updateMany({
        where: { id: p.id, orgId: ctx.orgId },
        data: {
          escrowId: row!.id,
          onChainPaymentIndex: i,
          assetContractId: plan.assetContractId,
        },
      });
    }

    await tx.blockchainTransaction.updateMany({
      where: { id: record.id, orgId: ctx.orgId },
      data: {
        status: TxStatus.CONFIRMED,
        escrowId: row!.id,
        confirmedAt: new Date(),
        errorMessage: null,
      },
    });

    await recordAuditEvent(tx, {
      orgId: ctx.orgId,
      type: 'funding.confirmed',
      // Attributed to the verifier, not the person: this record exists because the
      // chain was read, not because somebody asserted it.
      actor: { kind: 'reconciler', system: 'funding-verifier' },
      batchId: record.batchId!,
      escrowId: row!.id,
      txHash: record.hash!,
      metadata: {
        onChainEscrowId: input.onChainEscrowId,
        totalBaseUnits: expectedTotal.toString(),
        asset: plan.assetCode,
        assetContractId: plan.assetContractId,
        planDigest: record.planDigest,
        custodyDestination: custody,
        paymentCount: payments.length,
        verifiedManager: facts.manager,
        verifiedFinanceApprover: facts.financeApprover,
      },
    });

    return row!;
  });

  const after = await db.blockchainTransaction.findFirst({
    where: { id: record.id, orgId: ctx.orgId },
  });

  return {
    outcome: 'CONFIRMED',
    attempt: viewAttempt(after),
    escrow: { id: escrow.id, onChainId: input.onChainEscrowId },
  };
}

async function markFailed(
  db: any,
  ctx: TenantContext,
  record: any,
  reason: string,
): Promise<FundingAttemptView> {
  await db.$transaction(async (tx: any) => {
    await tx.blockchainTransaction.updateMany({
      where: { id: record.id, orgId: ctx.orgId },
      data: { status: TxStatus.FAILED, errorMessage: reason.slice(0, 500) },
    });
    // The transaction reached the chain and failed there, so nothing moved and the
    // payments may be prepared again.
    if (record.batchId) {
      await tx.payment.updateMany({
        where: { orgId: ctx.orgId, batchId: record.batchId, state: PaymentState.VALIDATING },
        data: {
          state: PaymentState.DRAFT,
          stateUpdatedAt: new Date(),
          stateReason: 'Funding transaction failed on-chain; no funds moved.',
        },
      });
    }
    await recordAuditEvent(tx, {
      orgId: ctx.orgId,
      type: 'funding.failed',
      actor: { kind: 'reconciler', system: 'funding-verifier' },
      batchId: record.batchId ?? undefined,
      txHash: record.hash ?? undefined,
      metadata: { attemptId: record.id, reason },
    });
  });

  const after = await db.blockchainTransaction.findFirst({
    where: { id: record.id, orgId: ctx.orgId },
  });
  return viewAttempt(after);
}

export { FUNDING_ROLES };
