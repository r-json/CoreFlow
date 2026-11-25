/**
 * Independent on-chain verification.
 *
 * ── Why this does not reuse the indexer ──────────────────────────────────────
 * The indexer trusts CoreFlow's OWN events (`payment/paid`). A reconciler that
 * re-read those same events, through the same parser, into the same projection
 * would verify nothing: a bug in how CoreFlow emits or decodes its events would
 * validate itself. That is the same trap the oracle preimage tests avoid by
 * keeping a second, longhand implementation.
 *
 * So verification is derived from sources CoreFlow did not author:
 *
 *   1. **Stellar Asset Contract `transfer` events.** The TOKEN contract emits
 *      these — `transfer / from / to / asset → amount`. They are the actual
 *      movement of value, independent of anything CoreFlow says about it. If
 *      CoreFlow claims a payment settled and no SAC transfer to that recipient
 *      for that amount exists, the claim is false regardless of what our own
 *      event log says.
 *
 *   2. **Contract storage via `get_escrow`.** A read of current state, not of the
 *      event stream. A projection built from events and a read of storage are two
 *      different derivations of the same truth.
 *
 *   3. **Transaction results.** Whether a specific hash actually succeeded.
 *
 * A discrepancy between (1) and CoreFlow's projection is therefore meaningful
 * evidence, not a tautology.
 */

import { STELLAR_CONFIG } from '@/lib/config';

/** One asset movement, as reported by the token contract itself. */
export interface ObservedTransfer {
  from: string;
  to: string;
  /** SAC contract address of the asset moved. */
  assetContractId: string;
  amountBaseUnits: bigint;
  ledger: number;
  txHash?: string;
}

export interface ChainPaymentFacts {
  index: number;
  worker: string;
  token: string;
  amountBaseUnits: bigint;
  hours: bigint;
  proofVerified: boolean;
  /** PaymentStatus discriminant from the contract's #[repr(u32)] enum. */
  status: number;
}

export interface ChainEscrowFacts {
  onChainId: number;
  manager: string;
  financeApprover: string;
  managerApproved: boolean;
  financeApproved: boolean;
  cancelled: boolean;
  payments: ChainPaymentFacts[];
}

/** On-chain PaymentStatus discriminants. */
export const CHAIN_STATUS = {
  PENDING: 0,
  MANAGER_APPROVED: 1,
  FINANCE_APPROVED: 2,
  FINALIZED: 3,
  CANCELLED: 4,
} as const;

/**
 * Why a read failed.
 *
 * `UNREADABLE` is emphatically not `DISAGREES`. Treating a timeout as a mismatch
 * would mark healthy payments as broken; treating it as agreement would let real
 * drift accumulate unseen. The distinction is the whole point.
 */
export type VerificationError =
  | { kind: 'UNREADABLE'; reason: string }
  | { kind: 'NOT_FOUND'; reason: string };

export type Verified<T> = { ok: true; value: T } | { ok: false; error: VerificationError };

export interface ChainVerifier {
  /** Current contract storage for an escrow. */
  readEscrow(onChainId: number): Promise<Verified<ChainEscrowFacts>>;
  /**
   * Asset movements observed from the TOKEN contract's own events.
   *
   * `ledgerWindow` bounds the search. Soroban RPC retains only a limited event
   * history, so a payment older than retention is UNREADABLE rather than absent —
   * reporting "no transfer found" for data the node no longer holds would
   * manufacture a false DB_PAID_CHAIN_NOT on every historical payment.
   */
  readTransfers(
    assetContractId: string,
    opts: { fromLedger?: number; limit?: number }
  ): Promise<Verified<ObservedTransfer[]>>;
  /** Whether a specific transaction succeeded. */
  readTransactionSucceeded(hash: string): Promise<Verified<boolean>>;
  /**
   * Escrow ids created by a specific transaction, from the contract's own
   * `escrow/created` events.
   *
   * The recovery anchor for funding. A client that submits
   * `initialize_multi_sig_escrow` and then fails to parse the return value still
   * knows the transaction hash, and the hash is enough to learn which escrow that
   * transaction created — so nobody has to sign a second one to find out.
   *
   * Returns every match so the caller can refuse ambiguity rather than pick.
   */
  findEscrowsCreatedByTransaction(
    hash: string,
    opts: { fromLedger?: number }
  ): Promise<Verified<number[]>>;
  /** Current ledger, for bounding windows. */
  latestLedger(): Promise<Verified<number>>;
}

/** How far back to look for transfers when no explicit window is given. */
export const DEFAULT_TRANSFER_LOOKBACK_LEDGERS = 16_000; // ~22 hours at 5s/ledger

/** Live verifier backed by Soroban RPC. */
export function createRpcVerifier(): ChainVerifier {
  const loadSdk = () => import('@stellar/stellar-sdk');

  const unreadable = (e: unknown): VerificationError => ({
    kind: 'UNREADABLE',
    reason: e instanceof Error ? e.message : String(e),
  });

  return {
    async latestLedger() {
      try {
        const sdk: any = await loadSdk();
        const rpc = new sdk.rpc.Server(STELLAR_CONFIG.getRpcUrl());
        const latest = await rpc.getLatestLedger();
        return { ok: true, value: latest.sequence };
      } catch (e) {
        return { ok: false, error: unreadable(e) };
      }
    },

    async readEscrow(onChainId: number) {
      try {
        const { CoreFlowClient } = await import('@/lib/contracts');
        const e = await new CoreFlowClient().getEscrow(onChainId);
        return {
          ok: true,
          value: {
            onChainId,
            manager: e.manager,
            financeApprover: e.finance_approver,
            managerApproved: e.manager_approved,
            financeApproved: e.finance_approved,
            cancelled: e.cancelled,
            payments: e.payments.map((p) => ({
              index: Number(p.id) - 1 >= 0 ? Number(p.id) - 1 : 0,
              worker: p.worker,
              token: p.token,
              amountBaseUnits: p.amount,
              hours: p.hours_logged,
              proofVerified: p.proof_verified,
              status: p.status,
            })),
          },
        };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        // The contract's own "no such escrow" is a genuine absence; anything else
        // is a failure to read, and the two must not be conflated.
        if (/InvalidPaymentId|Error\(Contract, #4\)/.test(msg)) {
          return { ok: false, error: { kind: 'NOT_FOUND', reason: msg } };
        }
        return { ok: false, error: unreadable(e) };
      }
    },

    async findEscrowsCreatedByTransaction(hash, opts) {
      try {
        const sdk: any = await loadSdk();
        const rpc = new sdk.rpc.Server(STELLAR_CONFIG.getRpcUrl());
        const contractId = STELLAR_CONFIG.requireContractId();

        let startLedger = opts.fromLedger;
        if (startLedger === undefined) {
          const latest = await rpc.getLatestLedger();
          startLedger = Math.max(1, latest.sequence - DEFAULT_TRANSFER_LOOKBACK_LEDGERS);
        }

        const found: number[] = [];
        let cursor: string | undefined;

        for (let page = 0; page < 20; page++) {
          const res = await rpc.getEvents({
            ...(cursor ? { cursor } : { startLedger }),
            filters: [{ type: 'contract', contractIds: [contractId] }],
            limit: 200,
          });
          const events = res.events ?? [];
          for (const ev of events) {
            if (ev.txHash !== hash) continue;
            const topics: string[] = (ev.topic ?? []).map((t: any) => {
              try {
                return String(sdk.scValToNative(t));
              } catch {
                return '';
              }
            });
            if (topics[0] !== 'escrow' || topics[1] !== 'created') continue;
            try {
              // (escrow_id, manager, total_amount)
              const value = sdk.scValToNative(ev.value);
              const id = Number(Array.isArray(value) ? value[0] : value);
              if (Number.isInteger(id) && id > 0 && !found.includes(id)) found.push(id);
            } catch {
              // An undecodable event is not evidence; skip it rather than guess.
            }
          }
          cursor = res.cursor;
          if (!cursor || events.length === 0) break;
        }

        return { ok: true, value: found };
      } catch (e) {
        return { ok: false, error: unreadable(e) };
      }
    },

    async readTransfers(assetContractId, opts) {
      try {
        const sdk: any = await loadSdk();
        const rpc = new sdk.rpc.Server(STELLAR_CONFIG.getRpcUrl());

        let startLedger = opts.fromLedger;
        if (startLedger === undefined) {
          const latest = await rpc.getLatestLedger();
          startLedger = Math.max(1, latest.sequence - DEFAULT_TRANSFER_LOOKBACK_LEDGERS);
        }

        const out: ObservedTransfer[] = [];
        let cursor: string | undefined;

        // Page until exhausted or capped: a settlement's transfers can be spread
        // across pages, and stopping early would look like a missing transfer.
        for (let page = 0; page < 20; page++) {
          const res = await rpc.getEvents({
            ...(cursor ? { cursor } : { startLedger }),
            filters: [{ type: 'contract', contractIds: [assetContractId] }],
            limit: opts.limit ?? 200,
          });

          for (const ev of res.events ?? []) {
            const topics = (ev.topic ?? []).map((t: any) => {
              try { return sdk.scValToNative(t); } catch { return null; }
            });
            if (String(topics[0]) !== 'transfer') continue;

            let amount: bigint;
            try {
              const raw = sdk.scValToNative(ev.value);
              amount = typeof raw === 'bigint' ? raw : BigInt(String(raw));
            } catch {
              continue;
            }

            out.push({
              from: String(topics[1]),
              to: String(topics[2]),
              assetContractId,
              amountBaseUnits: amount,
              ledger: ev.ledger,
              txHash: ev.txHash ?? ev.transactionHash ?? undefined,
            });
          }

          if (!res.cursor || (res.events ?? []).length === 0) break;
          cursor = res.cursor;
        }

        return { ok: true, value: out };
      } catch (e) {
        return { ok: false, error: unreadable(e) };
      }
    },

    async readTransactionSucceeded(hash: string) {
      try {
        const sdk: any = await loadSdk();
        const rpc = new sdk.rpc.Server(STELLAR_CONFIG.getRpcUrl());
        const tx = await rpc.getTransaction(hash);
        if (tx.status === 'NOT_FOUND') {
          // Beyond retention, or never submitted. Not the same as "failed": a
          // transaction the node has forgotten may well have succeeded.
          return { ok: false, error: { kind: 'NOT_FOUND', reason: `tx ${hash} not found` } };
        }
        return { ok: true, value: tx.status === 'SUCCESS' };
      } catch (e) {
        return { ok: false, error: unreadable(e) };
      }
    },
  };
}

export interface SettlementExpectation {
  escrowContractId: string;
  recipient: string;
  assetContractId: string;
  amountBaseUnits: bigint;
  /**
   * The settlement transaction, when known. Supplying it makes the match exact.
   *
   * WITHOUT it the match is ambiguous across settlements, because the tuple
   * (escrow contract, recipient, asset, amount) is NOT unique: the same contract
   * pays the same contractor the same rate every pay period. Seven runs of an
   * identical payroll produce seven identical transfers, and treating those as
   * seven matches for one payment reported a duplicate payment that never
   * happened. Scoping to one transaction is what makes the check precise.
   */
  txHash?: string | null;
}

/**
 * Find the transfer(s) that settle a payment.
 *
 * Matched on (from = escrow contract, to = recipient, asset, exact amount), and —
 * when a transaction is known — within that transaction only. All of those must
 * hold: a transfer of the right amount to the wrong address, or the wrong amount
 * to the right address, is not this payment settling.
 */
export function matchSettlementTransfer(
  transfers: readonly ObservedTransfer[],
  expect: SettlementExpectation
): ObservedTransfer[] {
  const candidates = transfers.filter(
    (t) =>
      t.from === expect.escrowContractId &&
      t.to === expect.recipient &&
      t.assetContractId === expect.assetContractId &&
      t.amountBaseUnits === expect.amountBaseUnits
  );

  if (expect.txHash) {
    return candidates.filter((t) => t.txHash === expect.txHash);
  }
  return candidates;
}

/**
 * Whether a payment was settled more than once.
 *
 * Counted WITHIN a single transaction. Two identical transfers in different
 * transactions are two different settlements of two different escrows — the normal
 * shape of recurring payroll. Two in the SAME transaction would mean one
 * `pay_batch` paid the same payee twice, which is the actual double-payment
 * condition worth alarming on.
 */
export function countDuplicateSettlementsInSameTransaction(
  matches: readonly ObservedTransfer[]
): { duplicated: boolean; txHash?: string; count: number } {
  const byTx = new Map<string, number>();
  for (const t of matches) {
    if (!t.txHash) continue;
    byTx.set(t.txHash, (byTx.get(t.txHash) ?? 0) + 1);
  }
  for (const [txHash, count] of byTx) {
    if (count > 1) return { duplicated: true, txHash, count };
  }
  return { duplicated: false, count: matches.length };
}

/**
 * Pick the transaction that settled this escrow, when the payment does not
 * already record one.
 *
 * A `pay_batch` transaction contains one transfer per payee, so the settling
 * transaction is the one whose transfers cover EVERY expected payment of the
 * escrow. Choosing by "contains this payment's transfer" alone would pick an
 * arbitrary earlier period's settlement.
 */
export function inferSettlementTransaction(
  transfers: readonly ObservedTransfer[],
  escrowContractId: string,
  expectedPayments: readonly { recipient: string; amountBaseUnits: bigint; assetContractId: string }[]
): string | null {
  if (expectedPayments.length === 0) return null;

  const byTx = new Map<string, ObservedTransfer[]>();
  for (const t of transfers) {
    if (t.from !== escrowContractId || !t.txHash) continue;
    const list = byTx.get(t.txHash) ?? [];
    list.push(t);
    byTx.set(t.txHash, list);
  }

  let best: { txHash: string; ledger: number } | null = null;
  for (const [txHash, group] of byTx) {
    const coversAll = expectedPayments.every((e) =>
      group.some(
        (t) =>
          t.to === e.recipient &&
          t.assetContractId === e.assetContractId &&
          t.amountBaseUnits === e.amountBaseUnits
      )
    );
    if (!coversAll) continue;
    const ledger = Math.max(...group.map((t) => t.ledger));
    // Most recent covering transaction: a re-settlement attempt would be later.
    if (!best || ledger > best.ledger) best = { txHash, ledger };
  }
  return best?.txHash ?? null;
}

/**
 * Transfers to the recipient for the right asset but the WRONG amount.
 *
 * Reported separately because it is a materially different finding: money moved
 * to the right person, in the wrong quantity. Matching only on exact amount would
 * classify that as "no settlement found", which is both wrong and less alarming
 * than the truth.
 */
export function findAmountMismatchedTransfers(
  transfers: readonly ObservedTransfer[],
  expect: SettlementExpectation
): ObservedTransfer[] {
  const candidates = transfers.filter(
    (t) =>
      t.from === expect.escrowContractId &&
      t.to === expect.recipient &&
      t.assetContractId === expect.assetContractId &&
      t.amountBaseUnits !== expect.amountBaseUnits
  );
  return expect.txHash
    ? candidates.filter((t) => t.txHash === expect.txHash)
    : candidates;
}
