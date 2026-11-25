#!/usr/bin/env node
/**
 * End-to-end run of the marketplace hold on Stellar TESTNET.
 *
 *   deploy -> open_hold -> issuer signs a delivery claim -> seller relays
 *   `release` -> replay on a second hold is refused with error 1106
 *
 * TESTNET ONLY. Identities are throwaway (`stellar keys generate --fund`); the
 * issuer key exists only in memory and is never printed or written. The
 * evidence file is written by this script from values it observed, never by
 * hand. Any unexpected result aborts the run.
 *
 * Requires the `stellar` CLI (27.x) and a built `@coreflow/sdk`.
 * Usage: npm run e2e
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { Keypair, Networks, xdr } from '@stellar/stellar-base';
import {
  claimType, randomClaimId, sha256, signClaim, toHex, verifyClaim,
} from '@coreflow/sdk';

const SCRIPT_VERSION = '0.1.0-alpha';
const NETWORK = 'testnet';
const PASSPHRASE = Networks.TESTNET;
const RPC_URL = 'https://soroban-testnet.stellar.org';
const EXPLORER = 'https://stellar.expert/explorer/testnet';

const AMOUNT = 100_000_000n; // 10 XLM in stroops
const MAX_FEE = 10_000_000n; // 1 XLM: generous upper bound on one tx fee
const ATTEMPTS = 3;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXAMPLE = path.resolve(HERE, '..');
const CONTRACT_DIR = path.join(EXAMPLE, 'contracts', 'marketplace-hold');
const WASM = path.join(CONTRACT_DIR, 'target', 'wasm32v1-none', 'release', 'marketplace_hold.wasm');
const EVIDENCE_DIR = path.join(EXAMPLE, 'evidence');

const startedAt = new Date();
const runId = `${startedAt.toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${randomBytes(2).toString('hex')}`;
const stamp = startedAt.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');

const steps = [];
const evidence = {
  scriptVersion: SCRIPT_VERSION,
  runId,
  network: NETWORK,
  networkPassphrase: PASSPHRASE,
  startedAt: startedAt.toISOString(),
  steps,
};

// ---------------------------------------------------------------- plumbing

const log = (msg) => console.log(msg);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Abort extends Error {}
const abort = (msg) => { throw new Abort(msg); };
const expect = (cond, msg) => { if (!cond) abort(`unexpected result: ${msg}`); log(`    ok  ${msg}`); };

/** Run the stellar CLI; returns { stdout, stderr } or throws with both streams. */
function stellar(args, { env } = {}) {
  try {
    const stdout = execFileSync('stellar', args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...env },
      maxBuffer: 64 * 1024 * 1024,
    });
    return { stdout: stdout.trim(), stderr: '' };
  } catch (e) {
    const err = new Error(`stellar ${args[0]} ${args[1] ?? ''} failed`);
    err.stdout = String(e.stdout ?? '');
    err.stderr = String(e.stderr ?? '');
    throw err;
  }
}

/**
 * Like `stellar`, but also returns stderr on success: the CLI prints progress,
 * including the transaction hash, on stderr.
 */
function stellarFull(args, { cwd } = {}) {
  const r = spawnSync('stellar', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, cwd });
  if (r.error) throw r.error;
  const out = { stdout: (r.stdout ?? '').trim(), stderr: r.stderr ?? '', status: r.status };
  if (r.status !== 0) {
    const err = new Error(`stellar ${args[0]} ${args[1] ?? ''} exited ${r.status}`);
    Object.assign(err, out);
    throw err;
  }
  return out;
}

const TRANSPORT = /(429|502|503|504|ECONNRESET|ETIMEDOUT|ENOTFOUND|timed out|timeout|fetch failed|temporarily|unavailable|connection)/i;

/** Retry with exponential backoff; only errors matching `retryable` are retried. */
async function retry(label, fn, retryable = () => true) {
  let delay = 2000;
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      const text = `${e.message}\n${e.stderr ?? ''}\n${e.stdout ?? ''}`;
      if (attempt >= ATTEMPTS || e instanceof Abort || !retryable(text)) throw e;
      log(`    ${label}: attempt ${attempt} failed (${e.message}); retrying in ${delay / 1000}s`);
      await sleep(delay);
      delay *= 2;
    }
  }
}

async function rpc(method, params) {
  const res = await fetch(RPC_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  if (!res.ok) throw new Error(`RPC ${method}: HTTP ${res.status}`);
  const body = await res.json();
  if (body.error) throw new Error(`RPC ${method}: ${JSON.stringify(body.error)}`);
  return body.result;
}

/** Confirm a transaction on the network and return what the ledger recorded. */
async function confirm(hash) {
  for (let i = 0; i < 20; i++) {
    const r = await retry('getTransaction', () => rpc('getTransaction', { hash }));
    if (r.status === 'SUCCESS') {
      const result = xdr.TransactionResult.fromXDR(r.resultXdr, 'base64');
      return { ledger: r.ledger, createdAt: r.createdAt, feeCharged: BigInt(result.feeCharged().toString()) };
    }
    if (r.status === 'FAILED') abort(`transaction ${hash} FAILED on-chain`);
    await sleep(2000);
  }
  return abort(`transaction ${hash} not found after waiting`);
}

const HASH_PATTERNS = [
  /Signing transaction:\s*([0-9a-f]{64})/i,
  /transaction hash is\s*([0-9a-f]{64})/i,
  /explorer\/testnet\/tx\/([0-9a-f]{64})/i,
];
function findHash(text) {
  for (const p of HASH_PATTERNS) {
    const m = text.match(p);
    if (m) return m[1].toLowerCase();
  }
  return null;
}

const explorerTx = (hash) => `${EXPLORER}/tx/${hash}`;

/** Submit a state-changing CLI call and return its result and confirmed tx hash. */
async function sendTx(label, args) {
  const out = await retry(label, () => stellarFull(args), (t) => TRANSPORT.test(t));
  const hash = findHash(`${out.stderr}\n${out.stdout}`);
  if (!hash) abort(`${label}: the CLI output carried no transaction hash`);
  const confirmed = await confirm(hash);
  return { stdout: out.stdout, stderr: out.stderr, hash, ...confirmed };
}

function recordStep(name, data) {
  const step = { name, at: new Date().toISOString(), ...data };
  if (data.txHash) step.explorer = explorerTx(data.txHash);
  steps.push(step);
  return step;
}

const jsonOut = (s) => JSON.parse(s);

// ---------------------------------------------------------------- run

async function main() {
  log(`marketplace-hold testnet e2e (run ${runId})`);
  expect(statSync(path.join(EXAMPLE, 'node_modules', '@coreflow', 'sdk', 'dist', 'index.js')).isFile(),
    '@coreflow/sdk is built and linked');

  // a. throwaway identities; the issuer key lives in memory only
  const names = { admin: `cfhold-${runId}-admin`, buyer: `cfhold-${runId}-buyer`, seller: `cfhold-${runId}-seller` };
  log('\n[a] Generating funded throwaway testnet identities');
  for (const name of Object.values(names)) {
    await retry('friendbot', () => stellarFull(['keys', 'generate', name, '--fund', '--network', NETWORK]));
  }
  const addr = Object.fromEntries(
    Object.entries(names).map(([k, n]) => [k, stellar(['keys', 'address', n]).stdout]),
  );
  expect(new Set(Object.values(addr)).size === 3, 'admin, buyer and seller are three distinct accounts');
  const issuerKey = Keypair.random(); // not a Stellar account; never printed or saved
  const issuerPub = new Uint8Array(issuerKey.rawPublicKey());
  const issuerPubHex = toHex(issuerPub);
  recordStep('identities', {
    admin: addr.admin, buyer: addr.buyer, seller: addr.seller,
    issuerPublicKeyHex: issuerPubHex,
    note: 'throwaway testnet accounts; the issuer key is in-memory and not a Stellar account',
  });

  // b. build and deploy
  log('\n[b] Building and deploying the contract');
  // Run inside the crate so its rust-toolchain.toml applies.
  stellarFull(['contract', 'build'], { cwd: CONTRACT_DIR });
  const wasm = readFileSync(WASM);
  const wasmHash = createHash('sha256').update(wasm).digest('hex');
  log(`    wasm ${wasm.length} bytes, sha256 ${wasmHash}`);
  const deploy = await sendTx('deploy', [
    'contract', 'deploy', '--wasm', WASM, '--optimize=false',
    '--source', names.admin, '--network', NETWORK,
    '--', '--admin', addr.admin, '--issuer', issuerPubHex,
  ]);
  const contractId = deploy.stdout.split('\n').pop().trim();
  expect(/^C[A-Z2-7]{55}$/.test(contractId), `deployed contract ${contractId}`);
  evidence.contractId = contractId;
  evidence.wasm = { path: 'target/wasm32v1-none/release/marketplace_hold.wasm', bytes: wasm.length, sha256: wasmHash };
  recordStep('deploy', {
    txHash: deploy.hash, ledger: deploy.ledger, contractId, wasmSha256: wasmHash,
    constructorArgs: { admin: addr.admin, issuer: issuerPubHex },
    contractExplorer: `${EXPLORER}/contract/${contractId}`,
  });
  const isIssuer = jsonOut(stellar(['contract', 'invoke', '--id', contractId, '--source', names.admin,
    '--network', NETWORK, '--', 'is_issuer', '--issuer', issuerPubHex]).stdout);
  expect(isIssuer === true, 'the constructor registered the issuer key');

  // c. token and balances
  log('\n[c] Native XLM asset contract and starting balances');
  const token = stellar(['contract', 'id', 'asset', '--asset', 'native', '--network', NETWORK]).stdout;
  expect(/^C[A-Z2-7]{55}$/.test(token), `native XLM SAC ${token}`);
  const balance = (who) => retry('balance', () => BigInt(jsonOut(stellar([
    'contract', 'invoke', '--id', token, '--source', names.admin, '--network', NETWORK,
    '--', 'balance', '--id', who]).stdout)), (t) => TRANSPORT.test(t));
  const snapshot = async () => ({
    buyer: (await balance(addr.buyer)).toString(),
    seller: (await balance(addr.seller)).toString(),
    contract: (await balance(contractId)).toString(),
  });
  const before = await snapshot();
  expect(before.contract === '0', 'the contract holds nothing before the first hold');
  evidence.token = token;
  recordStep('balances-before', { token, balances: before });

  // d. buyer opens the hold
  log('\n[d] Buyer opens a hold');
  const orderPreimage = `order:${runId}`;
  const order = sha256(orderPreimage);
  const orderHex = toHex(order);
  const now = Math.floor(Date.now() / 1000);
  const refundAfter = now + 3600;
  const openArgs = (source) => [
    'contract', 'invoke', '--id', contractId, '--source', source, '--network', NETWORK, '--',
    'open_hold', '--buyer', addr.buyer, '--seller', addr.seller, '--token', token,
    '--amount', AMOUNT.toString(), '--order', orderHex, '--refund_after', String(refundAfter),
  ];
  const open1 = await sendTx('open_hold #1', openArgs(names.buyer));
  const holdId1 = Number(jsonOut(open1.stdout));
  expect(Number.isInteger(holdId1) && holdId1 >= 1, `hold #${holdId1} opened`);
  const afterOpen = await snapshot();
  expect(BigInt(afterOpen.contract) === AMOUNT, 'the contract holds exactly the amount');
  const buyerSpent = BigInt(before.buyer) - BigInt(afterOpen.buyer);
  expect(buyerSpent >= AMOUNT && buyerSpent <= AMOUNT + MAX_FEE, `buyer paid the amount plus a fee of ${buyerSpent - AMOUNT} stroops`);
  recordStep('open-hold', {
    txHash: open1.hash, ledger: open1.ledger, holdId: holdId1, order: orderPreimage, orderHex,
    amount: AMOUNT.toString(), refundAfter, balances: afterOpen, feeCharged: open1.feeCharged.toString(),
  });

  // e. issuer signs a delivery claim (off-chain), then pre-verifies it
  log('\n[e] Issuer signs a delivery claim');
  const ctx = { networkPassphrase: PASSPHRASE, contractId };
  const payload = new TextEncoder().encode(JSON.stringify({ order: orderPreimage, deliveredAt: new Date().toISOString() }));
  const issuedAt = BigInt(Math.floor(Date.now() / 1000));
  const claim = {
    issuer: issuerPub,
    claimType: claimType('marketplace.delivery.v1'),
    subject: order,
    payloadHash: sha256(payload),
    payloadEncoding: 'raw',
    replay: { mode: 'unique-id', claimId: randomClaimId() },
    issuedAt,
    expiresAt: issuedAt + 900n,
  };
  const { preimage, signature } = signClaim(claim, ctx, new Uint8Array(issuerKey.rawSecretKey()));
  verifyClaim(claim, ctx, signature, { now: issuedAt });
  expect(preimage.length === 256 && signature.length === 64, 'claim signed and pre-verified off-chain');
  const claimJson = {
    issuer: toHex(claim.issuer),
    claim_type: toHex(claim.claimType),
    subject: toHex(claim.subject),
    payload_hash: toHex(claim.payloadHash),
    payload_encoding: 0,
    replay_mode: 1, // unique-id
    nonce: 0,
    claim_id: toHex(claim.replay.claimId),
    // The CLI reads u64 arguments as JSON numbers; these are far below 2^53.
    issued_at: Number(claim.issuedAt),
    expires_at: Number(claim.expiresAt),
  };
  const sigHex = toHex(signature);
  recordStep('sign-claim', {
    claim: claimJson, signatureHex: sigHex, preimageHex: toHex(preimage),
    payloadUtf8: new TextDecoder().decode(payload), offChainVerify: 'passed',
  });

  // f. the seller relays the claim
  log('\n[f] Seller relays the claim: release');
  const releaseArgs = (id, send) => [
    'contract', 'invoke', '--id', contractId, '--source', names.seller, '--network', NETWORK,
    ...(send ? ['--send', send] : []), '--',
    'release', '--hold_id', String(id), '--claim', JSON.stringify(claimJson), '--signature', sigHex,
  ];
  const release = await sendTx('release', releaseArgs(holdId1));
  const afterRelease = await snapshot();
  const sellerGain = BigInt(afterRelease.seller) - BigInt(before.seller);
  expect(sellerGain <= AMOUNT && sellerGain >= AMOUNT - MAX_FEE,
    `seller received the amount minus its own fee (${AMOUNT - sellerGain} stroops)`);
  expect(afterRelease.contract === '0', 'the contract holds nothing after release');
  const hold1 = jsonOut(stellar(['contract', 'invoke', '--id', contractId, '--source', names.seller,
    '--network', NETWORK, '--', 'get_hold', '--hold_id', String(holdId1)]).stdout);
  expect(['1', 'Released'].includes(String(hold1.status)), 'the hold is Released');
  recordStep('release', {
    txHash: release.hash, ledger: release.ledger, holdId: holdId1, submittedBy: addr.seller,
    balances: afterRelease, sellerGainStroops: sellerGain.toString(), feeCharged: release.feeCharged.toString(),
  });

  // g. replay: a second hold for the same order, the same claim
  log('\n[g] Replay: the same claim against a second hold');
  const open2 = await sendTx('open_hold #2', openArgs(names.buyer));
  const holdId2 = Number(jsonOut(open2.stdout));
  expect(holdId2 === holdId1 + 1, `second hold #${holdId2} opened for the same order`);
  recordStep('open-second-hold', { txHash: open2.hash, ledger: open2.ledger, holdId: holdId2, orderHex });
  let observed = null;
  let replayText = '';
  try {
    stellarFull(releaseArgs(holdId2, 'no')); // simulation only, never submitted
  } catch (e) {
    replayText = `${e.stderr ?? ''}\n${e.stdout ?? ''}`;
    const m = replayText.match(/Error\(Contract,\s*#(\d+)\)/);
    observed = m ? Number(m[1]) : null;
  }
  if (observed === null && !replayText) abort('the replayed claim was accepted by simulation');
  expect(observed === 1106, `replay refused with contract error ${observed} (ClaimAlreadyUsed, expected 1106)`);
  const afterReplay = await snapshot();
  expect(BigInt(afterReplay.contract) === AMOUNT, 'the second hold still holds its funds');
  const releaseSim = replayText.split('\n').find((l) => /Error\(Contract/.test(l)) ?? '';
  recordStep('replay', {
    holdId: holdId2, submitted: false, expected: 1106, observed, errorName: 'ClaimAlreadyUsed',
    simulationMessage: releaseSim.trim().slice(0, 300), balances: afterReplay,
  });

  // wrap up
  evidence.issuerPublicKeyHex = issuerPubHex;
  evidence.finishedAt = new Date().toISOString();
  evidence.outcome = 'passed';
  evidence.summary = {
    holdReleasedTx: release.hash,
    replayExpected: 1106,
    replayObserved: observed,
    openHoldsLeftOpen: [holdId2],
    note: 'Hold #2 stays open on purpose; its buyer can refund after refundAfter.',
  };
  write('');
  log(`\nPASSED. Evidence: ${evidencePath()}`);
}

const evidencePath = (suffix = '') => path.join(EVIDENCE_DIR, `testnet-e2e-${stamp}${suffix}.json`);
function write(suffix) {
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  writeFileSync(evidencePath(suffix), `${JSON.stringify(evidence, null, 2)}\n`);
}

main().catch((e) => {
  console.error(`\nFAILED: ${e.message}`);
  if (e.stderr) console.error(String(e.stderr).split('\n').slice(-12).join('\n'));
  if (steps.length > 0) {
    evidence.finishedAt = new Date().toISOString();
    evidence.outcome = 'failed';
    evidence.failure = e.message;
    write('-failed');
    console.error(`Partial evidence: ${evidencePath('-failed')}`);
  }
  process.exit(1);
});
