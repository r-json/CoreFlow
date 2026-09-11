#!/usr/bin/env node
/**
 * Environment preflight. Fail-closed.
 *
 * Why this exists: on 2026-09-11 a `vercel env pull` overwrote .env / .env.local
 * with the DEPLOYMENT's variables. That silently repointed local development at
 * Mainnet v1 and at the production database. Nothing in the app objected, because
 * every individual value was valid — only the combination was wrong.
 *
 * So this does not ask "does each variable look plausible?" It asks "is this the
 * combination development is allowed to run?" and refuses otherwise. Judgements
 * are made against EXPLICIT ALLOWLISTS below, not string heuristics, so adding a
 * new deployment is a deliberate edit rather than an accident of pattern matching.
 *
 * Secrets are never read for their value and never printed. Only hostnames and
 * contract addresses appear in output, both of which are public.
 *
 * Escape hatches are explicit, per-run, and never defaults:
 *   COREFLOW_ALLOW_MAINNET=1           act against Mainnet on purpose
 *   COREFLOW_ALLOW_REMOTE_DB=1         act against a non-local database on purpose
 *   COREFLOW_ALLOW_UNKNOWN_CONTRACT=1  use a contract not in the registry below
 */

import { existsSync, readFileSync } from 'node:fs';

// ---------------------------------------------------------------------------
// Registry. Single source of truth for this check; mirrors docs/DEPLOYMENTS.md.
// Update this when a contract is deployed — that is the intended friction.
// ---------------------------------------------------------------------------

/** CoreFlow v2, hardened, Stellar Testnet. The only contract development may use. */
const V2_TESTNET = {
  contractId: 'CDN4FIKLJ72WYNPBIKWYSDJWDZG22QNPLWI37VTUAE4EKKIBVAQRG5F4',
  tokenId: 'CBW2ZKFBHLHNNVCZ7JP4AXHQOOC3S6NLAMORXOAIWQNWMKUVJS743Q5M',
};

/** CoreFlow v1, Stellar Mainnet. Superseded, and NOT what v2 development targets. */
const V1_MAINNET_CONTRACT = 'CCTF5WBOQR7JP2KPLQT372X7JCGCINHDFRSAPF4YTYRKZXZ3J2XPRFFW';

const KNOWN_CONTRACTS = new Map([
  [V2_TESTNET.contractId, { label: 'CoreFlow v2 (Testnet)', network: 'testnet' }],
  [V1_MAINNET_CONTRACT, { label: 'CoreFlow v1 (Mainnet)', network: 'public' }],
]);

/**
 * Hosts that count as a local development database. An allowlist, because the
 * failure being prevented is a REMOTE host arriving unnoticed — and a denylist
 * can only ever exclude the remote hosts somebody already thought of.
 */
const LOCAL_DB_HOSTS = new Set([
  'localhost',
  '127.0.0.1',
  '::1',
  '0.0.0.0',
  'host.docker.internal',
  'postgres', // docker-compose service name
  'db', // docker-compose service name
]);

/** Every variable that can carry a database connection. All must be local in dev. */
const DB_URL_VARS = ['DATABASE_URL', 'DIRECT_URL', 'PRISMA_DATABASE_URL', 'POSTGRES_URL'];

// ---------------------------------------------------------------------------

/** Next.js precedence: .env.local overrides .env. Mirror it, then real env wins. */
function loadEnvFiles() {
  const merged = {};
  for (const file of ['.env', '.env.local']) {
    if (!existsSync(file)) continue;
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      const m = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line.trim());
      if (m) merged[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
    }
  }
  return { ...merged, ...process.env };
}

const env = loadEnvFiles();
const errors = [];
const notes = [];
const allowMainnet = env.COREFLOW_ALLOW_MAINNET === '1';
const allowRemoteDb = env.COREFLOW_ALLOW_REMOTE_DB === '1';
const allowUnknownContract = env.COREFLOW_ALLOW_UNKNOWN_CONTRACT === '1';
const isProductionBuild = process.env.NODE_ENV === 'production';

// --- Network ---------------------------------------------------------------
const network = (env.NEXT_PUBLIC_STELLAR_NETWORK ?? '').trim().toLowerCase();
const isMainnet = network === 'public' || network === 'mainnet';

if (isMainnet && !allowMainnet) {
  errors.push(
    'NEXT_PUBLIC_STELLAR_NETWORK is "' + network + '" (Mainnet).\n' +
      '    v2 development runs exclusively against Testnet. The hardened v2\n' +
      '    contract is NOT deployed on Mainnet; Mainnet still runs v1.\n' +
      '    Fix: NEXT_PUBLIC_STELLAR_NETWORK=testnet\n' +
      '    Override (deliberate Mainnet action): COREFLOW_ALLOW_MAINNET=1',
  );
}
if (!network) {
  notes.push('NEXT_PUBLIC_STELLAR_NETWORK is unset; the app defaults to testnet.');
}

// --- Contract --------------------------------------------------------------
const contractId = (env.NEXT_PUBLIC_STELLAR_CONTRACT_ID ?? '').trim();
const known = KNOWN_CONTRACTS.get(contractId);

if (!contractId) {
  errors.push(
    'NEXT_PUBLIC_STELLAR_CONTRACT_ID is unset. CoreFlow will not guess a contract\n' +
      '    address, so every contract call would fail at the point of use.\n' +
      '    Fix: set it to ' + V2_TESTNET.contractId,
  );
} else if (known && known.network === 'public' && !allowMainnet) {
  errors.push(
    'NEXT_PUBLIC_STELLAR_CONTRACT_ID is the ' + known.label + ' contract.\n' +
      '    This is the live contract holding real funds, and it does NOT carry the\n' +
      '    v2 security fixes. Development must not point at it.\n' +
      '    Fix: set it to ' + V2_TESTNET.contractId + '\n' +
      '    Override (deliberate Mainnet action): COREFLOW_ALLOW_MAINNET=1',
  );
} else if (!known && !allowUnknownContract) {
  errors.push(
    'NEXT_PUBLIC_STELLAR_CONTRACT_ID is not a known deployment:\n' +
      '      ' + contractId + '\n' +
      '    Refusing rather than assuming which chain or contract version this is.\n' +
      '    Fix: add it to KNOWN_CONTRACTS in scripts/check-env.mjs and to\n' +
      '    docs/DEPLOYMENTS.md, or use ' + V2_TESTNET.contractId + '\n' +
      '    Override (one-off, e.g. a scratch deployment):\n' +
      '    COREFLOW_ALLOW_UNKNOWN_CONTRACT=1',
  );
} else if (known && !isMainnet && known.network !== 'testnet') {
  errors.push(
    'Network is testnet but the contract is ' + known.label + '.\n' +
      '    A contract address aimed at the wrong network fails every call.',
  );
}

// --- Settlement asset ------------------------------------------------------
const tokenId = (env.NEXT_PUBLIC_STELLAR_TOKEN_ID ?? '').trim();
if (!isMainnet && contractId === V2_TESTNET.contractId && tokenId !== V2_TESTNET.tokenId) {
  if (!tokenId) {
    errors.push(
      'NEXT_PUBLIC_STELLAR_TOKEN_ID is unset. An escrow holds exactly one Stellar\n' +
        '    Asset Contract; without it, funding and settlement verification cannot\n' +
        '    proceed and CoreFlow will not infer a SAC address from an asset symbol.\n' +
        '    Fix: set it to ' + V2_TESTNET.tokenId,
    );
  } else {
    errors.push(
      'NEXT_PUBLIC_STELLAR_TOKEN_ID does not match the asset the v2 Testnet\n' +
        '    deployment was configured with.\n' +
        '      configured: ' + tokenId + '\n' +
        '      expected:   ' + V2_TESTNET.tokenId + '\n' +
        '    Escrows funded with a different SAC cannot be verified against the\n' +
        '    transfers this deployment observes.',
    );
  }
}

// --- Databases -------------------------------------------------------------
const dbHosts = {};
const remote = [];
for (const name of DB_URL_VARS) {
  const raw = env[name];
  if (!raw) continue;
  let host;
  try {
    host = new URL(raw).hostname;
  } catch {
    errors.push(name + ' is not a parseable URL.');
    continue;
  }
  dbHosts[name] = host;

  // Production builds legitimately use the production database.
  if (isProductionBuild) continue;

  if (!LOCAL_DB_HOSTS.has(host)) remote.push(name + ' -> ' + host);
}

// Reported as ONE finding. A vercel env pull rewrites all four at once, and four
// copies of the same paragraph buries the instruction that fixes it.
if (remote.length > 0) {
  if (allowRemoteDb) {
    notes.push('Remote database targets, explicitly allowed: ' + remote.join(', '));
  } else {
    errors.push(
      'These variables point at a NON-LOCAL database outside production:\n' +
        remote.map((r) => '      ' + r).join('\n') + '\n' +
        '    Development writes, migrations, seeds and test resets would land\n' +
        '    there. If that is the deployed database, this destroys real payroll\n' +
        '    records. Development requires its own local database.\n' +
        '    Fix: see docs/ENVIRONMENTS.md for local Postgres setup.\n' +
        '    Override (deliberate remote action): COREFLOW_ALLOW_REMOTE_DB=1',
    );
  }
}
if (!env.DATABASE_URL) errors.push('DATABASE_URL is unset.');

// --- Report ----------------------------------------------------------------
console.log('CoreFlow env preflight');
console.log('  network:  ' + (isMainnet ? 'MAINNET' : network || 'testnet (default)'));
console.log('  contract: ' + (contractId || '(unset)') + (known ? '  [' + known.label + ']' : ''));
console.log('  asset:    ' + (tokenId || '(unset)'));
for (const name of DB_URL_VARS) {
  if (dbHosts[name]) {
    const local = LOCAL_DB_HOSTS.has(dbHosts[name]);
    console.log('  ' + name + ': ' + dbHosts[name] + (local ? '  [local]' : '  [REMOTE]'));
  }
}

for (const n of notes) console.log('\n  note: ' + n);

if (errors.length > 0) {
  console.error('\nRefusing to continue:\n');
  for (const e of errors) console.error('  - ' + e + '\n');
  process.exit(1);
}
console.log('\nOK: local database + Testnet v2.');
