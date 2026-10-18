#!/usr/bin/env node
/**
 * Record end-to-end attempts that aborted before completing.
 *
 * Aborted attempts are kept in the evidence alongside the successful run.
 * This script reads what each aborted attempt left on Testnet (the deploy
 * transaction from Horizon and the hold state via a read-only `get_hold`
 * simulation) and writes evidence/aborted-runs.json. The abort step and error
 * text are inputs taken from the run's console output; everything else is
 * read from the network at the time this script runs.
 *
 * TESTNET ONLY. Read-only: nothing is submitted.
 * Usage: node scripts/record-aborted-runs.mjs
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const HORIZON = 'https://horizon-testnet.stellar.org';
const EXPLORER = 'https://stellar.expert/explorer/testnet';

// Inputs from the aborted runs' console output.
const ATTEMPTS = [
  {
    runId: '20261018020012-3f0a',
    startedAt: '2026-10-18T02:00:12Z',
    contractId: 'CDEFI7BA7GWL5UDQNLUAKEO5GDZJDCLJIQH2ZBOOGXFU4SM37CDGBAIW',
    abortedAtStep: 'e (sign delivery claim)',
    error: 'issuerSecret: expected an S... string, a 32-byte seed or a Keypair',
    cause: 'The script passed a Keypair from a second @stellar/stellar-base copy; the SDK did not recognise it. Fixed by passing the raw seed.',
  },
  {
    runId: '20261018020145-5307',
    startedAt: '2026-10-18T02:01:45Z',
    contractId: 'CAH3Z2UTN2ATVQ4MHSPZ7OJ7XTAZLWU5HUDF7JX2NFZ7MXNBXL6GBHKH',
    abortedAtStep: 'f (release), at argument parsing; nothing submitted',
    error: "Failed to parse argument 'claim': unknown variant '1792289877', expected one of bool, void, error, u32, ...",
    cause: 'u64 claim fields were passed to stellar-cli as JSON strings instead of numbers. Fixed in the script.',
  },
];

const PROBE = {
  purpose: 'Before the first attempt, one 1 XLM payment between two throwaway accounts to inspect how stellar-cli reports transaction hashes.',
  txHash: '48b92ed6186c75960be8b489702c4d83d704d95734a6ede6efbc648f4c026c2c',
};

const cli = (args) => execFileSync('stellar', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
async function horizon(path) {
  const res = await fetch(`${HORIZON}${path}`);
  return res.ok ? res.json() : null;
}

const records = [];
for (const a of ATTEMPTS) {
  const admin = cli(['keys', 'address', `cfhold-${a.runId}-admin`]);
  // Every transaction the admin account took part in (funding, wasm upload,
  // contract creation, ...), as Horizon reports them; no guessing which is which.
  const txs = await horizon(`/accounts/${admin}/transactions?order=asc&limit=20`);
  let hold = null;
  try {
    hold = JSON.parse(cli(['contract', 'invoke', '--id', a.contractId, '--source', admin, '--network', 'testnet', '--send=no', '--', 'get_hold', '--hold_id', '1']));
  } catch (e) {
    hold = { error: String(e.stderr || e.message).split('\n').slice(-3).join(' ').trim() };
  }
  records.push({
    ...a,
    contractLink: `${EXPLORER}/contract/${a.contractId}`,
    admin,
    adminTransactions: (txs?._embedded.records ?? []).map((t) => ({
      hash: t.hash,
      ledger: t.ledger,
      createdAt: t.created_at,
      successful: t.successful,
      link: `${EXPLORER}/tx/${t.hash}`,
    })),
    holdOneStateNow: hold,
  });
}

const probeTx = await horizon(`/transactions/${PROBE.txHash}`);
const out = {
  description:
    'End-to-end attempts that aborted before completing, recorded next to the successful run. ' +
    'Their original -failed.json files were deleted during the run; this record is rebuilt from ' +
    'Testnet state and the runs’ console output.',
  generatedBy: 'examples/marketplace-hold/scripts/record-aborted-runs.mjs',
  generatedAt: new Date().toISOString(),
  network: 'testnet',
  attempts: records,
  probe: { ...PROBE, successful: probeTx?.successful ?? null, ledger: probeTx?.ledger ?? null, link: `${EXPLORER}/tx/${PROBE.txHash}` },
};
writeFileSync('evidence/aborted-runs.json', JSON.stringify(out, null, 2) + '\n');
console.log(`wrote evidence/aborted-runs.json (${records.length} attempts)`);
for (const r of records) console.log(r.runId, r.contractId, 'hold#1:', JSON.stringify(r.holdOneStateNow).slice(0, 140));
