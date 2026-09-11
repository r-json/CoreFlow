/**
 * RPC-backed indexer run.
 *
 * Reads CoreFlow contract events from Soroban RPC since the last cursor and hands
 * them to `processBatch`. Kept separate from ./index so the unit-tested core
 * never imports the heavy Stellar SDK — and, more importantly, so the projection
 * logic can be tested without a network at all.
 *
 * No escrow state is read from the contract here. The projection is a function of
 * the event log only; see the determinism note in ./index.
 */

import prisma from '@/lib/db/prisma';
import { STELLAR_CONFIG } from '@/lib/config';
import { SAC_DECIMALS } from '@/lib/money';
import {
  processBatch, replayUnattributed, getCursor,
  type RawIndexedEvent, type IndexerContext, type RunResult,
} from './index';

/** How far back to look when there is no cursor yet. */
const LOOKBACK_LEDGERS = 1000;
const PAGE_LIMIT = 200;

export async function runIndexerFromRpc(): Promise<RunResult> {
  const sdk: any = await import('@stellar/stellar-sdk');
  const contractId = STELLAR_CONFIG.requireContractId();
  const network = STELLAR_CONFIG.contract.network;
  const rpc = new sdk.rpc.Server(STELLAR_CONFIG.getRpcUrl());

  // No organization is resolved here, deliberately.
  //
  // This used to auto-create one organization per deployment and attach every
  // discovered escrow to it. That is a guess: escrows created outside the app
  // belong to whoever created them, and placing them in a shared bucket puts one
  // party's payroll where another tenant might read it. Ownership now comes only
  // from an Escrow row the application itself wrote — see resolveEscrowTenant.
  const ctx: IndexerContext = {
    contractId,
    network,
    assetDecimals: SAC_DECIMALS,
  };

  const cursor = await getCursor(prisma, ctx);
  const latest = await rpc.getLatestLedger();
  const startLedger =
    cursor > 0 ? cursor + 1 : Math.max(1, latest.sequence - LOOKBACK_LEDGERS);

  const resp = await rpc.getEvents({
    startLedger,
    filters: [{ type: 'contract', contractIds: [contractId] }],
    limit: PAGE_LIMIT,
  });

  const events: RawIndexedEvent[] = (resp.events ?? []).map((e: any) => ({
    id: e.id,
    ledger: e.ledger,
    topic0: String(sdk.scValToNative(e.topic[0])),
    topic1: String(sdk.scValToNative(e.topic[1])),
    value: sdk.scValToNative(e.value),
    txHash: e.txHash ?? e.transactionHash ?? undefined,
  }));

  const result = await processBatch(events, { db: prisma, ctx });

  // Replay anything an earlier run could not attribute. An escrow claimed since
  // then is behind the cursor, so its history would otherwise be unreachable.
  const replayed = await replayUnattributed(prisma, ctx);
  if (replayed.applied > 0) {
    console.info(
      `[indexer] replayed ${replayed.applied} previously unattributed event(s) ` +
      `(+${replayed.paymentsCreated} payments, +${replayed.paymentsPaid} settled)`
    );
  }

  return {
    ...result,
    paymentsCreated: result.paymentsCreated + replayed.paymentsCreated,
    paymentsPaid: result.paymentsPaid + replayed.paymentsPaid,
    unattributed: replayed.stillUnattributed,
  };
}
