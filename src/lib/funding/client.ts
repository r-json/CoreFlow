/**
 * Browser-side funding client.
 *
 * The one rule this file exists to enforce: **the browser displays the
 * server-issued plan and signs it. It never constructs a financial intent of its
 * own.** Nothing here computes a total, converts a decimal, derives an amount, or
 * decides what an escrow should contain. Every figure shown and every value signed
 * comes from the plan the server froze when the intent was opened.
 *
 * Money crosses the wire as decimal STRINGS and is converted to `bigint` only at
 * the point of building the contract arguments. A `Number` anywhere here would
 * reintroduce the rounding the rest of the system refuses.
 */

'use client';

import type { FundingStateView, FundingPlan, FundingAttemptView } from './service';

export type { FundingStateView, FundingPlan, FundingAttemptView };

/** Every outcome the confirm endpoint can report. Never collapsed in the UI. */
export type ConfirmOutcome = 'CONFIRMED' | 'FAILED' | 'UNVERIFIABLE' | 'MISMATCH';

export interface ConfirmResult {
  outcome: ConfirmOutcome;
  attempt: FundingAttemptView;
  escrow?: { id: string; onChainId: number };
  reason?: string;
  differences?: string[];
}

export class FundingRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'FundingRequestError';
  }
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: {
      ...(init?.body ? { 'content-type': 'application/json' } : {}),
      ...init?.headers,
    },
  });

  const text = await response.text();
  let body: any = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    // A non-JSON body from a proxy or gateway. The status is still meaningful.
  }

  if (!response.ok) {
    throw new FundingRequestError(
      response.status,
      body?.error ?? `The request failed (${response.status}).`,
      body?.code,
      body?.details,
    );
  }
  return body as T;
}

const base = (batchId: string) =>
  `/api/payroll/batches/${encodeURIComponent(batchId)}/funding`;

/**
 * Current funding state: blockers, the plan, and any attempt already in flight.
 *
 * Called on mount, so a reload during submission recovers the existing intent
 * instead of starting a second one.
 */
export function getFundingState(batchId: string, orgId?: string): Promise<FundingStateView> {
  const query = orgId ? `?orgId=${encodeURIComponent(orgId)}` : '';
  return request<FundingStateView>(`${base(batchId)}${query}`, { method: 'GET' });
}

export interface OpenIntentResponse {
  created: boolean;
  attempt: FundingAttemptView;
  plan: FundingPlan;
}

/** Open or recover the funding intent. Idempotent: a second call returns the first. */
export function openFundingIntent(
  batchId: string,
  orgId?: string,
): Promise<OpenIntentResponse> {
  return request<OpenIntentResponse>(`${base(batchId)}/intent`, {
    method: 'POST',
    body: JSON.stringify(orgId ? { orgId } : {}),
  });
}

/** Record a hash the network accepted. Deliberately does not claim funding. */
export function recordSubmitted(
  batchId: string,
  input: { attemptId: string; transactionHash: string; orgId?: string },
): Promise<{ attempt: FundingAttemptView }> {
  return request(`${base(batchId)}/submitted`, {
    method: 'POST',
    body: JSON.stringify({
      attemptId: input.attemptId,
      transactionHash: input.transactionHash,
      ...(input.orgId ? { orgId: input.orgId } : {}),
    }),
  });
}

/** Ask the server to verify the transaction against the frozen plan. */
export function confirmFunding(
  batchId: string,
  input: { attemptId: string; onChainEscrowId?: number; orgId?: string },
): Promise<ConfirmResult> {
  return request<ConfirmResult>(`${base(batchId)}/confirm`, {
    method: 'POST',
    body: JSON.stringify({
      attemptId: input.attemptId,
      // Omitted when the client could not read it. The server resolves the escrow
      // from the transaction hash, so a missing id is a recoverable gap, not a
      // reason to sign again.
      ...(input.onChainEscrowId !== undefined
        ? { onChainEscrowId: input.onChainEscrowId }
        : {}),
      ...(input.orgId ? { orgId: input.orgId } : {}),
    }),
  });
}

/** Close an attempt that never reached the network. */
export function abandonFunding(
  batchId: string,
  input: { attemptId: string; reason: string; userRejected?: boolean; orgId?: string },
): Promise<{ attempt: FundingAttemptView }> {
  return request(`${base(batchId)}/abandon`, {
    method: 'POST',
    body: JSON.stringify({
      attemptId: input.attemptId,
      reason: input.reason,
      ...(input.userRejected ? { userRejected: true } : {}),
      ...(input.orgId ? { orgId: input.orgId } : {}),
    }),
  });
}

/**
 * Turn the server's plan into contract arguments, verbatim.
 *
 * A 1:1 mapping with no arithmetic and no reordering. Order is load-bearing:
 * verification compares the on-chain payment vector against the plan BY INDEX, so
 * reordering here would read as a mismatch — correctly, because it would mean the
 * signed transaction was not the reviewed one.
 */
export function planToContractArguments(plan: FundingPlan): {
  manager: string;
  financeApprover: string;
  oraclePublicKeyHex: string;
  payments: {
    worker: string;
    token: string;
    amount: bigint;
    rate_per_hour: bigint;
    start_date: number;
    end_date: number;
  }[];
} {
  return {
    manager: plan.manager,
    financeApprover: plan.financeApprover,
    oraclePublicKeyHex: plan.oraclePublicKey,
    payments: plan.schedule.map((row) => ({
      worker: row.worker,
      token: row.token,
      // Strings to bigint. The only conversion in this file, and it is exact.
      amount: BigInt(row.amountBaseUnits),
      rate_per_hour: BigInt(row.rateBaseUnits),
      start_date: row.startDate,
      end_date: row.endDate,
    })),
  };
}

/**
 * A short, human-quotable reference for the frozen plan.
 *
 * Exists so a finance user can say which plan they signed without reading 64 hex
 * characters aloud. The full digest remains available in technical details; this is
 * a label, never an identifier the server trusts.
 */
export function planReference(planDigest: string | null | undefined): string | null {
  if (!planDigest || planDigest.length < 8) return null;
  return `CF-PLAN-${planDigest.slice(0, 8).toUpperCase()}`;
}
