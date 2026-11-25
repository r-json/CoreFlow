#!/usr/bin/env node
/**
 * Archive the Testnet transactions behind docs/evidence/all_50_hashes.txt.
 *
 * Stellar Testnet is reset periodically and a reset deletes all ledger
 * history, so Stellar Expert links to these transactions stop resolving.
 * This script fetches each transaction from Horizon while it still exists
 * and writes the raw responses, so the evidence survives the reset and can be
 * re-checked offline (decode the XDR fields with `stellar xdr decode`).
 *
 * It writes, and nothing else:
 *   docs/evidence/testnet-archive/<label>__<hash>.json   one per transaction
 *   docs/evidence/testnet-archive/manifest.json          index + SHA-256 per file
 *
 * A transaction Horizon cannot return is recorded in the manifest as missing,
 * never dropped, and the script exits non-zero.
 *
 * Usage: node scripts/archive-testnet-evidence.mjs
 *        node scripts/archive-testnet-evidence.mjs --out <dir> --from-evidence <e2e.json>...
 *
 * --from-evidence reads the transaction hashes from end-to-end evidence files
 * (each step's `txHash`, labelled `<runId>:<step name>`) instead of
 * all_50_hashes.txt.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';

const HORIZON = 'https://horizon-testnet.stellar.org';
const NETWORK_PASSPHRASE = 'Test SDF Network ; September 2015';
const args = process.argv.slice(2);
const flagIndex = args.indexOf('--from-evidence');
const evidenceFiles = flagIndex >= 0 ? args.slice(flagIndex + 1).filter((a) => !a.startsWith('--')) : [];
const outIndex = args.indexOf('--out');
const SOURCE = evidenceFiles.length > 0 ? evidenceFiles.join(', ') : 'docs/evidence/all_50_hashes.txt';
const OUT_DIR = outIndex >= 0 ? args[outIndex + 1] : 'docs/evidence/testnet-archive';

async function getJson(path) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const res = await fetch(`${HORIZON}${path}`, { headers: { Accept: 'application/json' } });
    if (res.ok) return res.json();
    if (res.status === 404) return null;
    if (attempt === 3) throw new Error(`${path}: HTTP ${res.status}`);
    await new Promise((r) => setTimeout(r, 1000 * attempt));
  }
}

// Horizon paginates; these transactions are small, but follow `next` anyway
// so a large one is archived whole rather than silently truncated.
async function getAllRecords(path) {
  const records = [];
  let page = await getJson(`${path}?limit=200&order=asc`);
  while (page && page._embedded.records.length > 0) {
    records.push(...page._embedded.records);
    if (page._embedded.records.length < 200) break;
    page = await getJson(new URL(page._links.next.href).pathname + new URL(page._links.next.href).search);
  }
  return records;
}

function fromHashList(path) {
  return readFileSync(path, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [hash, label] = line.split('\t');
      if (!/^[0-9a-f]{64}$/.test(hash)) throw new Error(`malformed hash line: ${line}`);
      return { hash, label: label ?? 'unlabelled' };
    });
}

function fromEvidence(paths) {
  return paths.flatMap((path) => {
    const run = JSON.parse(readFileSync(path, 'utf8'));
    return run.steps
      .filter((step) => typeof step.txHash === 'string')
      .map((step) => {
        if (!/^[0-9a-f]{64}$/.test(step.txHash)) throw new Error(`malformed txHash in ${path}: ${step.txHash}`);
        return { hash: step.txHash, label: `${run.runId}:${step.name}` };
      });
  });
}

const entries = evidenceFiles.length > 0 ? fromEvidence(evidenceFiles) : fromHashList(SOURCE);

mkdirSync(OUT_DIR, { recursive: true });
const fetchedAt = new Date().toISOString();
const manifest = {
  description:
    'Raw Horizon responses for the CoreFlow Testnet transactions listed in ' +
    `${SOURCE}, captured before a Testnet reset removes them.`,
  generatedBy: 'scripts/archive-testnet-evidence.mjs',
  fetchedAt,
  horizon: HORIZON,
  networkPassphrase: NETWORK_PASSPHRASE,
  source: SOURCE,
  count: entries.length,
  transactions: [],
};

let missing = 0;
for (const { hash, label } of entries) {
  const transaction = await getJson(`/transactions/${hash}`);
  if (!transaction) {
    missing++;
    manifest.transactions.push({ hash, label, status: 'missing' });
    console.log(`MISSING  ${label}  ${hash}`);
    continue;
  }
  const [operations, effects] = await Promise.all([
    getAllRecords(`/transactions/${hash}/operations`),
    getAllRecords(`/transactions/${hash}/effects`),
  ]);
  const record = { hash, label, fetchedAt, horizon: HORIZON, transaction, operations, effects };
  const body = JSON.stringify(record, null, 2) + '\n';
  const file = `${label.replace(/[^a-zA-Z0-9_-]+/g, '-')}__${hash}.json`;
  writeFileSync(`${OUT_DIR}/${file}`, body);
  manifest.transactions.push({
    hash,
    label,
    status: 'archived',
    successful: transaction.successful,
    ledger: transaction.ledger,
    createdAt: transaction.created_at,
    sourceAccount: transaction.source_account,
    operationCount: operations.length,
    file,
    sha256: createHash('sha256').update(body).digest('hex'),
  });
  console.log(`archived ${label.padEnd(28)} ${hash}  ledger ${transaction.ledger}  ok=${transaction.successful}`);
}

manifest.archived = manifest.transactions.filter((t) => t.status === 'archived').length;
manifest.missing = missing;
writeFileSync(`${OUT_DIR}/manifest.json`, JSON.stringify(manifest, null, 2) + '\n');
console.log(`\n${manifest.archived}/${entries.length} archived, ${missing} missing -> ${OUT_DIR}/manifest.json`);
if (missing > 0) process.exit(1);
