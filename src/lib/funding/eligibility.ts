/**
 * When may a batch be funded?
 *
 * ── The fact that shapes this whole module ──────────────────────────────────
 * `initialize_multi_sig_escrow` creates the escrow AND pulls custody in ONE
 * atomic invocation. There is no separate `fund()` in the contract, and
 * `CoreFlowEscrow` has no `funded` flag: an escrow EXISTS if and only if its
 * custody was transferred.
 *
 * Two consequences:
 *
 * 1. "Created but not funded" is not a representable state. There is one
 *    signature, not two.
 * 2. Submitting it twice creates a SECOND escrow and moves the money AGAIN. The
 *    contract offers no idempotency, so everything that stops a manager being
 *    charged twice lives off-chain — which is why eligibility is assessed before a
 *    wallet ever opens, and why an in-flight attempt blocks a second one.
 *
 * Deliberately pure: it takes already-loaded records and returns a verdict. The
 * question "may this money move?" should be answerable in a test without a
 * database, an RPC endpoint or a wallet.
 */

import { PaymentState, OrgRole } from '@prisma/client';
import { formatAmount } from '@/lib/money';
import type { SettlementAsset } from '@/lib/payroll/assets';

/** The contract's MAX_BATCH_SIZE. A larger batch cannot be created at all. */
export const MAX_FUNDABLE_PAYMENTS = 100;

/** States from which a payment may enter funding. */
const FUNDABLE_STATES: readonly PaymentState[] = [
  PaymentState.DRAFT,
  // A retry after a failed attempt: the previous intent already moved these.
  PaymentState.VALIDATING,
];

/** Roles permitted to fund, mirroring `escrow:create`. */
export const FUNDING_ROLES: readonly OrgRole[] = [OrgRole.OWNER, OrgRole.ADMIN, OrgRole.MANAGER];

export type FundingBlockerCode =
  | 'NO_PAYMENTS'
  | 'TOO_MANY_PAYMENTS'
  | 'ALREADY_FUNDED'
  | 'FUNDING_IN_FLIGHT'
  | 'PAYMENT_NOT_FUNDABLE'
  | 'PAYMENT_ALREADY_ON_CHAIN'
  | 'SETTLEMENT_ASSET_UNCONFIGURED'
  | 'ASSET_MISMATCH'
  | 'MIXED_ASSETS'
  | 'AMOUNT_NOT_POSITIVE'
  | 'HOURS_RATE_MISMATCH'
  | 'PERIOD_REQUIRED'
  | 'PERIOD_INVALID'
  | 'NO_DISTINCT_FINANCE_APPROVER'
  | 'ORACLE_KEY_UNAVAILABLE'
  | 'ROLE_NOT_PERMITTED';

export interface FundingBlocker {
  code: FundingBlockerCode;
  /** What to do about it, in the operator's terms. */
  message: string;
  paymentId?: string;
  /** 1-based position within the batch, for a human scanning a table. */
  position?: number;
}

/** The payment fields funding reads. Typed, never `any`: `any * any` is `number`. */
export interface FundingPayment {
  id: string;
  recipientAddress: string;
  assetCode: string;
  assetContractId: string | null;
  assetDecimals: number;
  amountBaseUnits: bigint;
  rateBaseUnits: bigint;
  hours: bigint;
  periodStart: Date | null;
  periodEnd: Date | null;
  state: PaymentState;
  escrowId: string | null;
  onChainPaymentIndex: number | null;
}

export interface ExistingFundingAttempt {
  id: string;
  status: 'PREPARING' | 'SIMULATING' | 'AWAITING_SIGNATURE' | 'SUBMITTED' | 'CONFIRMED' | 'FAILED' | 'EXPIRED' | 'CANCELLED';
  hash: string | null;
  createdAt: Date;
}

export interface EligibilityInput {
  payments: readonly FundingPayment[];
  asset: SettlementAsset;
  /** The wallet that will sign, and the role it holds. */
  funder: { walletAddress: string; role: OrgRole };
  /** A second, distinct wallet for the finance half of the gate. */
  financeApproverAddress: string | null;
  /** The most recent funding attempt for this batch, if any. */
  attempt: ExistingFundingAttempt | null;
  oraclePublicKey: string | null;
}

export interface FundingAssessment {
  eligible: boolean;
  blockers: FundingBlocker[];
  /** Exact total to be pulled into custody, in base units. */
  totalBaseUnits: bigint;
  paymentCount: number;
}

/** Statuses in which an attempt is neither finished nor abandoned. */
const IN_FLIGHT = new Set(['PREPARING', 'SIMULATING', 'AWAITING_SIGNATURE', 'SUBMITTED']);

function short(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

/**
 * Decide whether this batch may be funded, and say exactly why not if it may not.
 *
 * Every blocker is returned, not just the first: an operator fixing one problem at
 * a time across a twelve-row payroll cannot work, and the wallet prompt is the
 * worst possible place to discover the thirteenth.
 */
export function assessFundingEligibility(input: EligibilityInput): FundingAssessment {
  const blockers: FundingBlocker[] = [];
  const { payments, asset, funder, attempt } = input;

  // ── Who is asking ──
  if (!FUNDING_ROLES.includes(funder.role)) {
    blockers.push({
      code: 'ROLE_NOT_PERMITTED',
      message:
        `Your role (${funder.role}) cannot fund a payroll. Funding moves money into ` +
        'escrow custody and is performed by the escrow manager.',
    });
  }

  // ── Has this already happened, or is it happening now ──
  if (attempt && attempt.status === 'CONFIRMED') {
    blockers.push({
      code: 'ALREADY_FUNDED',
      message:
        'This batch has already been funded on-chain' +
        (attempt.hash ? ` (transaction ${attempt.hash.slice(0, 12)}…)` : '') +
        '. Funding it again would create a second escrow and move the money a ' +
        'second time.',
    });
  } else if (attempt && IN_FLIGHT.has(attempt.status)) {
    blockers.push({
      code: 'FUNDING_IN_FLIGHT',
      message:
        `A funding attempt started ${attempt.createdAt.toISOString()} has not finished ` +
        `(${attempt.status}). Wait for it to confirm or fail before starting another — ` +
        'two attempts would fund two escrows.',
    });
  }

  // ── Is there anything to fund ──
  if (payments.length === 0) {
    blockers.push({ code: 'NO_PAYMENTS', message: 'This batch has no payments.' });
  }
  if (payments.length > MAX_FUNDABLE_PAYMENTS) {
    blockers.push({
      code: 'TOO_MANY_PAYMENTS',
      message:
        `${payments.length} payments exceeds the ${MAX_FUNDABLE_PAYMENTS} the contract ` +
        'accepts in one escrow. Split the payroll.',
    });
  }

  // ── The settlement asset ──
  if (asset.contractId === null) {
    blockers.push({
      code: 'SETTLEMENT_ASSET_UNCONFIGURED',
      message:
        `No Stellar Asset Contract is configured for ${asset.code}, so there is no ` +
        'address to move funds to. CoreFlow will not infer one from an asset symbol.',
    });
  }

  const assetCodes = new Set(payments.map((p) => p.assetCode));
  if (assetCodes.size > 1) {
    blockers.push({
      code: 'MIXED_ASSETS',
      message:
        `This batch mixes ${[...assetCodes].join(' and ')}. One escrow holds one ` +
        'asset, so a mixed batch needs one escrow per asset.',
    });
  }

  // ── Each payment ──
  let total = 0n;
  for (const [i, p] of payments.entries()) {
    const position = i + 1;
    const where = `${short(p.recipientAddress)} (row ${position})`;

    if (!FUNDABLE_STATES.includes(p.state)) {
      blockers.push({
        code: 'PAYMENT_NOT_FUNDABLE',
        paymentId: p.id,
        position,
        message: `${where} is ${p.state} and is not awaiting funding.`,
      });
    }

    // Already attached to an escrow: funding again would pay twice.
    if (p.escrowId !== null || p.onChainPaymentIndex !== null) {
      blockers.push({
        code: 'PAYMENT_ALREADY_ON_CHAIN',
        paymentId: p.id,
        position,
        message: `${where} is already attached to an on-chain escrow.`,
      });
    }

    if (p.assetCode !== asset.code) {
      blockers.push({
        code: 'ASSET_MISMATCH',
        paymentId: p.id,
        position,
        message:
          `${where} is denominated in ${p.assetCode}, but this deployment settles ` +
          `${asset.code}.`,
      });
    }

    if (p.amountBaseUnits <= 0n || p.rateBaseUnits <= 0n || p.hours <= 0n) {
      blockers.push({
        code: 'AMOUNT_NOT_POSITIVE',
        paymentId: p.id,
        position,
        message: `${where} has a non-positive amount, rate or hours.`,
      });
    } else if (p.hours * p.rateBaseUnits !== p.amountBaseUnits) {
      // The contract rejects this (AmountHoursMismatch) and `submit_hours_proof`
      // could never be satisfied, so the escrow would be funded and unsettleable.
      blockers.push({
        code: 'HOURS_RATE_MISMATCH',
        paymentId: p.id,
        position,
        message:
          `${where} has an amount of ${formatAmount(p.amountBaseUnits, p.assetDecimals)} ` +
          `but ${p.hours} hours at ${formatAmount(p.rateBaseUnits, p.assetDecimals)} is ` +
          `${formatAmount(p.hours * p.rateBaseUnits, p.assetDecimals)}.`,
      });
    }

    // The contract requires end_date > start_date (InvalidPeriod), and the period is
    // a SIGNED field of the oracle proof. A missing period cannot be filled in here:
    // attesting to a pay period nobody stated is exactly the kind of invented
    // financial data this system refuses.
    if (p.periodStart === null || p.periodEnd === null) {
      blockers.push({
        code: 'PERIOD_REQUIRED',
        paymentId: p.id,
        position,
        message:
          `${where} has no pay period. The contract requires one, and the period is ` +
          'part of what the oracle signs — it cannot be assumed. Add period_start ' +
          'and period_end to the payroll file.',
      });
    } else if (p.periodEnd.getTime() <= p.periodStart.getTime()) {
      blockers.push({
        code: 'PERIOD_INVALID',
        paymentId: p.id,
        position,
        message: `${where} has a pay period that does not end after it starts.`,
      });
    }

    total += p.amountBaseUnits;
  }

  // ── Dual control, before a wallet opens ──
  if (input.financeApproverAddress === null) {
    blockers.push({
      code: 'NO_DISTINCT_FINANCE_APPROVER',
      message:
        'This organization has no second wallet to act as the finance approver. ' +
        'CoreFlow requires two distinct approvers, and the contract refuses an ' +
        'escrow whose manager and finance approver are the same key.',
    });
  } else if (input.financeApproverAddress === funder.walletAddress) {
    blockers.push({
      code: 'NO_DISTINCT_FINANCE_APPROVER',
      message:
        'You would be both the manager and the finance approver on this escrow. ' +
        'The contract rejects that (SignersNotDistinct): invite or assign a second ' +
        'approver first.',
    });
  }

  if (!input.oraclePublicKey) {
    blockers.push({
      code: 'ORACLE_KEY_UNAVAILABLE',
      message:
        'The oracle signing key is unavailable, so work could never be verified for ' +
        'this escrow. Funding is refused rather than creating an escrow that can ' +
        'never settle.',
    });
  }

  return {
    eligible: blockers.length === 0,
    blockers,
    totalBaseUnits: total,
    paymentCount: payments.length,
  };
}
