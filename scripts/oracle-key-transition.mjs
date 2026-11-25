#!/usr/bin/env node
/**
 * Oracle registry transition: register a new key, verify, revoke the old, verify.
 *
 * NOT RUNNABLE BY ACCIDENT. It refuses unless BOTH public keys are named on the
 * command line and `--confirm-mapping` is passed, because the one fact this cannot
 * determine for itself is which key is the post-rotation one. Naming suggests an
 * answer; naming is not evidence. Registering the wrong key would authorize a
 * credential an attacker may hold to sign work attestations — exactly what the
 * admin-managed registry exists to prevent.
 *
 *   node scripts/oracle-key-transition.mjs \
 *     --new <64-hex public key> \
 *     --old <64-hex public key> \
 *     --confirm-mapping
 *
 * Add --dry-run to perform only the read-only checks.
 *
 * Order is load-bearing: register BEFORE revoke. Revoking first would leave the
 * contract with no registered key at all, stranding every escrow awaiting an
 * attestation.
 *
 * Verification reads CHAIN STATE, never the CLI exit code. Only public values are
 * printed: network, contract, admin address, oracle public keys, operation.
 */

import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const value = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : null;
};

const NEW_KEY = value('new');
const OLD_KEY = value('old');
const DRY_RUN = flag('dry-run');
const CONFIRMED = flag('confirm-mapping');
const NETWORK = process.env.NETWORK || 'testnet';
const IDENTITY = process.env.ADMIN_IDENTITY || 'coreflow-v2-admin';
const HEX64 = /^[0-9a-f]{64}$/;

function die(message) {
  console.error(`\nrefusing to continue: ${message}\n`);
  process.exit(1);
}

if (!HEX64.test(NEW_KEY ?? '')) die('--new must be a 64-character lower-case hex public key.');
if (!HEX64.test(OLD_KEY ?? '')) die('--old must be a 64-character lower-case hex public key.');
if (NEW_KEY === OLD_KEY) die('--new and --old are the same key.');
if (!CONFIRMED) {
  die(
    'the key mapping must be confirmed explicitly with --confirm-mapping.\n' +
      '    Which key is post-rotation cannot be determined from here, and registering\n' +
      '    the wrong one would re-authorize a possibly exposed credential.',
  );
}

const contractId = (process.env.NEXT_PUBLIC_STELLAR_CONTRACT_ID || readEnvFile().NEXT_PUBLIC_STELLAR_CONTRACT_ID || '').trim();
if (!contractId) die('NEXT_PUBLIC_STELLAR_CONTRACT_ID is not set.');

function readEnvFile() {
  const out = {};
  if (!existsSync('.env')) return out;
  for (const line of readFileSync('.env', 'utf8').split('\n')) {
    const m = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line.trim());
    if (m) out[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
  }
  return out;
}

function cli(argv) {
  const command = `stellar ${argv.map((a) => `'${String(a).replace(/'/g, "'\\''")}'`).join(' ')} 2>&1`;
  try {
    return execFileSync('bash', ['-c', command], { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
  } catch (e) {
    throw new Error(`stellar CLI failed:\n${`${e.stdout ?? ''}${e.stderr ?? ''}`.trim()}`);
  }
}

const invoke = (fn, extra = [], send = true) =>
  cli([
    'contract', 'invoke', '--id', contractId, '--source', IDENTITY, '--network', NETWORK,
    ...(send ? [] : ['--send=no']), '--', fn, ...extra,
  ]);

const isRegistered = (pubkey) =>
  invoke('is_oracle_key_registered', ['--pubkey', pubkey], false).trim().endsWith('true');

const hashOf = (output) => output.match(/tx\/([0-9a-f]{64})/)?.[1] ?? null;

const adminAddress = cli(['keys', 'address', IDENTITY]).trim();

console.log('Oracle registry transition');
console.log(`  network:      Stellar ${NETWORK}`);
console.log(`  contract:     ${contractId}`);
console.log(`  admin:        ${adminAddress}`);
console.log(`  old oracle:   ${OLD_KEY}`);
console.log(`  new oracle:   ${NEW_KEY}`);
console.log(`  mode:         ${DRY_RUN ? 'DRY RUN (read-only)' : 'EXECUTE'}`);

// --- 0. The signer must BE the on-chain admin -------------------------------
const onChainAdmin = invoke('get_admin', [], false).trim().replace(/[^G-Z2-7]/g, '');
if (!onChainAdmin.includes(adminAddress)) {
  die(
    `the signing identity is not the contract admin.\n` +
      `    signing as: ${adminAddress}\n` +
      `    get_admin:  ${onChainAdmin}`,
  );
}
console.log('\n  get_admin matches the signing identity.');

const before = { new: isRegistered(NEW_KEY), old: isRegistered(OLD_KEY) };
console.log(`  before:  new=${before.new ? 'registered' : 'not registered'}` +
  `  old=${before.old ? 'registered' : 'not registered'}`);

const record = {
  title: 'Oracle registry transition',
  network: `Stellar ${NETWORK}`,
  contract: contractId,
  admin: adminAddress,
  oldOracleKey: OLD_KEY,
  newOracleKey: NEW_KEY,
  before,
  executedAt: new Date().toISOString(),
};

if (DRY_RUN) {
  console.log('\nDry run complete. No transaction sent.');
  process.exit(0);
}

// --- 1. Register the new key FIRST -----------------------------------------
if (before.new) {
  console.log('\n  new key is already registered; skipping registration.');
  record.registrationTx = null;
} else {
  console.log('\n  registering the new oracle key...');
  record.registrationTx = hashOf(invoke('register_oracle_key', ['--pubkey', NEW_KEY]));
  console.log(`  registration tx: ${record.registrationTx ?? '(hash not parsed)'}`);
}

// --- 2. Verify from chain state, not the exit code -------------------------
record.afterRegistration = { new: isRegistered(NEW_KEY), old: isRegistered(OLD_KEY) };
console.log(`  after registration:  new=${record.afterRegistration.new}` +
  `  old=${record.afterRegistration.old}`);

if (!record.afterRegistration.new) {
  writeRecord();
  die(
    'the new key is NOT registered after the registration attempt.\n' +
      '    STOPPING. The old key has deliberately NOT been revoked: revoking now\n' +
      '    would leave the contract with no usable oracle.',
  );
}

// --- 3. Revoke the old key -------------------------------------------------
if (!record.afterRegistration.old) {
  console.log('\n  old key is already not registered; skipping revocation.');
  record.revocationTx = null;
} else {
  console.log('\n  revoking the old oracle key...');
  record.revocationTx = hashOf(invoke('revoke_oracle_key', ['--pubkey', OLD_KEY]));
  console.log(`  revocation tx: ${record.revocationTx ?? '(hash not parsed)'}`);
}

// --- 4. Verify the final registry state ------------------------------------
record.afterRevocation = { new: isRegistered(NEW_KEY), old: isRegistered(OLD_KEY) };
console.log(`  after revocation:  new=${record.afterRevocation.new}` +
  `  old=${record.afterRevocation.old}`);

const expected = record.afterRevocation.new === true && record.afterRevocation.old === false;
record.finalStateAsExpected = expected;
writeRecord();

if (!expected) {
  die(
    'the final registry state does not match the expected state.\n' +
      `    expected: new=registered, old=not registered\n` +
      `    actual:   new=${record.afterRevocation.new}, old=${record.afterRevocation.old}\n` +
      '    STOPPING without a corrective transaction. Report this state for review.',
  );
}

console.log('\nTransition complete and verified against chain state.');
console.log('Evidence: docs/evidence/oracle-key-transition.json');

function writeRecord() {
  mkdirSync('docs/evidence', { recursive: true });
  writeFileSync('docs/evidence/oracle-key-transition.json', JSON.stringify(record, null, 2) + '\n');
}
