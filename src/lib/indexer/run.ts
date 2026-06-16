/**
 * RPC-backed indexer run. Reads contract events from Soroban RPC since the last
 * cursor and projects them into the DB via processBatch. Kept separate from
 * ./index so the unit-tested core never imports the heavy Stellar SDK.
 */

import prisma from '@/lib/db/prisma';
import { STELLAR_CONFIG } from '@/lib/config';
import {
  processBatch,
  getCursor,
  type RawIndexedEvent,
  type EscrowDetailForIndex,
  type RunResult,
} from './index';

const LOOKBACK_LEDGERS = 1000;
const PAGE_LIMIT = 100;

export async function runIndexerFromRpc(): Promise<RunResult> {
  const sdk: any = await import('@stellar/stellar-sdk');
  const contractId = STELLAR_CONFIG.contract.id;
  const rpc = new sdk.rpc.Server(STELLAR_CONFIG.getRpcUrl());

  const cursor = await getCursor();
  const latest = await rpc.getLatestLedger();
  const startLedger = cursor > 0 ? cursor + 1 : Math.max(1, latest.sequence - LOOKBACK_LEDGERS);

  const resp = await rpc.getEvents({
    startLedger,
    filters: [{ type: 'contract', contractIds: [contractId] }],
    limit: PAGE_LIMIT,
  });

  const events: RawIndexedEvent[] = (resp.events ?? []).map((e: any) => ({
    id: e.id ?? e.pagingToken,
    ledger: e.ledger,
    topic0: String(sdk.scValToNative(e.topic[0])),
    topic1: String(sdk.scValToNative(e.topic[1])),
    value: sdk.scValToNative(e.value),
  }));

  const fetchEscrowDetail = async (escrowId: number): Promise<EscrowDetailForIndex> => {
    const { CoreFlowClient } = await import('@/lib/contracts');
    const detail = await new CoreFlowClient().getEscrow(escrowId);
    const p = detail.payments[0];
    return {
      worker: p?.worker ?? 'unknown',
      amountCents: p ? Number(p.amount) : 0,
      rateCents: p ? Number(p.rate_per_hour) : 0,
      tokenAddress: detail.token ?? null,
    };
  };

  return processBatch(events, { db: prisma, fetchEscrowDetail });
}
