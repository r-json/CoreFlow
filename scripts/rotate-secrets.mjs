#!/usr/bin/env node
/**
 * Secret rotation executor.
 *
 * Rotates the shared secrets exposed by `prodenv.txt`, and proves the OLD value
 * can no longer authenticate. Emits its own evidence record — a rotation you
 * cannot demonstrate is a rotation you have not finished.
 *
 * THE VALUE IS NEVER DISPLAYED. A generated secret goes straight from
 * `crypto.randomBytes` into the stdin of `vercel env update`, which stores it
 * write-only. Nothing is written to a file, echoed, or passed in argv (argv is
 * world-readable via `ps`). What this script prints is a FINGERPRINT:
 * `sha256(value)` truncated to 12 hex characters. The preimage is 256 bits of
 * CSPRNG output, so a fingerprint is not a shortcut to the secret — it exists
 * so you can confirm the value in Vercel matches the value in `.env` without
 * either of them being readable.
 *
 * Usage:
 *   node scripts/rotate-secrets.mjs --plan
 *   node scripts/rotate-secrets.mjs --rotate AUTH_SECRET [--targets production]
 *   node scripts/rotate-secrets.mjs --remove BOOTSTRAP_SECRET
 *   node scripts/rotate-secrets.mjs --fingerprint-local AUTH_SECRET
 *   node scripts/rotate-secrets.mjs --verify-dead CRON_SECRET --url https://…
 *   node scripts/rotate-secrets.mjs --verify-dead AUTH_SECRET --url https://…
 *
 * `--verify-dead` reads the OLD secret from stdin, never argv:
 *   node scripts/rotate-secrets.mjs --verify-dead CRON_SECRET --url https://… < old.txt
 * …and shred that file afterwards.
 */

import { randomBytes, createHash, createHmac } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const EVIDENCE = join(ROOT, 'docs', 'evidence', 'secret-rotation.json');

/** Must track src/lib/auth/index.ts:315. */
const SESSION_COOKIE = 'cf_session';

/** Secrets this script may generate. Each entry states the blast radius. */
const ROTATABLE = {
  AUTH_SECRET: {
    bytes: 32,
    encoding: 'hex',
    effect:
      'Invalidates every issued JWT. All users are logged out at redeploy. ' +
      'There is no dual-secret overlap in src/lib/auth/jwt.ts, so this is a ' +
      'hard cutover, not a graceful one.',
    verify: 'forged-jwt',
  },
  CRON_SECRET: {
    bytes: 32,
    encoding: 'hex',
    effect:
      'Vercel Cron loses access to GET /api/indexer/run and ' +
      'POST /api/reconciliation/run until redeploy. Both read ' +
      'CRON_SECRET || INDEXER_SECRET, so rotate them together or the old one ' +
      'keeps working as a fallback.',
    verify: 'bearer',
  },
  INDEXER_SECRET: {
    bytes: 32,
    encoding: 'hex',
    effect:
      'Same two endpoints as CRON_SECRET — it is the first-choice fallback in ' +
      'src/app/api/indexer/run/route.ts:16. Leaving this at its exposed value ' +
      'while rotating only CRON_SECRET rotates nothing.',
    verify: 'bearer',
  },
  BOOTSTRAP_SECRET: {
    bytes: 32,
    encoding: 'hex',
    effect:
      'Guards POST /api/admin/bootstrap, which claims the FIRST admin. If an ' +
      'admin already exists, prefer --remove: unset, the endpoint answers 404 ' +
      'and no secret can reach it at all. Rotating keeps a live door.',
    verify: 'config-only',
  },
};

/**
 * ORACLE_SECRET_KEY is deliberately NOT rotatable here, and this is the most
 * important guard in the file.
 *
 * Its public half is derived from the secret (src/lib/oracle/index.ts:74) and
 * stored as each escrow's `oracle_pubkey`. The contract accepts attestations
 * only from a key its admin has registered. So rotating the secret is not an
 * environment change — it is an on-chain change, and that registration is the
 * action currently blocked on the owner confirming the key mapping.
 *
 * Generating a third oracle key now would be worse than doing nothing: the
 * open question is which of two keys is post-rotation, and a third candidate
 * destroys the ability to answer it from the evidence that exists.
 */
const ORACLE_REFUSAL =
  'ORACLE_SECRET_KEY is not rotatable by this script.\n\n' +
  '  Its public half is registered ON CHAIN. Rotating the secret produces a\n' +
  '  public key the contract does not trust, which is exactly the state that\n' +
  '  currently blocks the live funding run (OracleKeyNotRegistered).\n\n' +
  '  Generating a third key would also destroy the evidence needed to decide\n' +
  '  which of the two existing keys is post-rotation.\n\n' +
  '  See docs/ORACLE_KEY_TRANSITION.md. That transition is owner-gated.';

const DB_REFUSAL =
  'The database credential is not rotatable by this script.\n\n' +
  '  It lives in the Postgres provider, not in Vercel alone: the password must\n' +
  '  be changed provider-side first, then DATABASE_URL, DIRECT_URL,\n' +
  '  PRISMA_DATABASE_URL and POSTGRES_URL all updated to match. Rotating the\n' +
  '  env vars alone breaks the app; rotating the provider alone breaks it too.\n\n' +
  '  See docs/SECRET_ROTATION.md for the ordered procedure.';

function die(msg) {
  console.error(`\nrefusing: ${msg}\n`);
  process.exit(1);
}

/** sha256 → first 12 hex. Safe to print, publish, and paste. */
function fingerprint(value) {
  return createHash('sha256').update(value).digest('hex').slice(0, 12);
}

function appendEvidence(record) {
  mkdirSync(dirname(EVIDENCE), { recursive: true });
  let log = [];
  if (existsSync(EVIDENCE)) {
    try {
      const parsed = JSON.parse(readFileSync(EVIDENCE, 'utf8'));
      if (Array.isArray(parsed)) log = parsed;
      else if (Array.isArray(parsed.actions)) log = parsed.actions;
    } catch {
      die(`${EVIDENCE} exists but is not valid JSON; refusing to overwrite it`);
    }
  }
  log.push(record);
  writeFileSync(EVIDENCE, `${JSON.stringify(log, null, 2)}\n`);
  console.log(`  evidence appended → docs/evidence/secret-rotation.json`);
}

function requireVercelAuth() {
  const who = spawnSync('vercel', ['whoami'], { encoding: 'utf8' });
  if (who.status !== 0) {
    die(
      'not authenticated to Vercel (`vercel whoami` failed). Run `vercel login`.\n' +
        `  ${(who.stderr || who.stdout || '').trim()}`
    );
  }
  if (!existsSync(join(ROOT, '.vercel', 'project.json'))) {
    die('no .vercel/project.json — this directory is not linked. Run `vercel link`.');
  }
  return who.stdout.trim();
}

/** Reads a local env value WITHOUT importing it into this process's env. */
function readLocalEnvValue(name) {
  for (const file of ['.env', '.env.local']) {
    const path = join(ROOT, file);
    if (!existsSync(path)) continue;
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
      if (!m || m[1] !== name) continue;
      let v = m[2].trim();
      if (
        (v.startsWith('"') && v.endsWith('"')) ||
        (v.startsWith("'") && v.endsWith("'"))
      ) {
        v = v.slice(1, -1);
      }
      if (v) return { value: v, file };
    }
  }
  return null;
}

function plan() {
  console.log('\nSecret rotation plan\n====================\n');
  console.log('Rotatable by this script (Vercel env, value never displayed):\n');
  for (const [name, spec] of Object.entries(ROTATABLE)) {
    const local = readLocalEnvValue(name);
    console.log(`  ${name}`);
    console.log(`    new value   : ${spec.bytes} random bytes, ${spec.encoding}`);
    console.log(
      `    local copy  : ${local ? `present in ${local.file} (fp ${fingerprint(local.value)})` : 'absent'}`
    );
    console.log(`    blast radius: ${spec.effect}`);
    console.log();
  }
  console.log('Refused, by design:\n');
  console.log('  ORACLE_SECRET_KEY   on-chain coupling — see --rotate for detail');
  console.log('  DATABASE credential provider-side — see docs/SECRET_ROTATION.md');
  console.log(
    '\nNote: a Vercel env change does not affect the RUNNING deployment.\n' +
      'Nothing cuts over until you redeploy, so the order above is not urgent —\n' +
      'but an un-redeployed rotation has also not taken effect. Verify after deploy.\n'
  );
}

function rotate(name, targets, alsoLocal) {
  if (name === 'ORACLE_SECRET_KEY') die(ORACLE_REFUSAL);
  if (/DATABASE|POSTGRES|PRISMA|DIRECT_URL/.test(name)) die(DB_REFUSAL);
  const spec = ROTATABLE[name];
  if (!spec) {
    die(`${name} is not a known rotatable secret. Known: ${Object.keys(ROTATABLE).join(', ')}`);
  }

  const account = requireVercelAuth();
  console.log(`\nRotating ${name}`);
  console.log(`  vercel account : ${account}`);
  console.log(`  targets        : ${targets.join(', ')}`);
  console.log(`  effect         : ${spec.effect}\n`);

  // Generated once, reused across targets so every environment agrees.
  const value = randomBytes(spec.bytes).toString(spec.encoding);
  const fp = fingerprint(value);

  for (const target of targets) {
    // `update` replaces in place — no window where the variable is absent.
    // The value arrives on stdin: not in argv, not in a file, not on screen.
    const res = spawnSync('vercel', ['env', 'update', name, target, '--yes'], {
      input: value,
      encoding: 'utf8',
    });
    if (res.status !== 0) {
      const out = `${res.stdout || ''}${res.stderr || ''}`;
      // An absent variable cannot be updated; add it instead.
      if (/not found|does not exist/i.test(out)) {
        const add = spawnSync('vercel', ['env', 'add', name, target, '--force', '--yes'], {
          input: value,
          encoding: 'utf8',
        });
        if (add.status !== 0) {
          die(`vercel env add ${name} ${target} failed:\n  ${(add.stderr || add.stdout || '').trim()}`);
        }
        console.log(`  ${target}: added (was absent)`);
      } else {
        die(`vercel env update ${name} ${target} failed:\n  ${out.trim()}`);
      }
    } else {
      console.log(`  ${target}: updated`);
    }
  }

  if (alsoLocal) {
    const path = join(ROOT, '.env');
    if (!existsSync(path)) die('.env does not exist; not creating it implicitly');
    const lines = readFileSync(path, 'utf8').split('\n');
    let replaced = false;
    const next = lines.map((line) => {
      if (new RegExp(`^\\s*${name}\\s*=`).test(line)) {
        replaced = true;
        return `${name}="${value}"`;
      }
      return line;
    });
    if (!replaced) next.push(`${name}="${value}"`);
    writeFileSync(path, next.join('\n'));
    console.log(`  .env: ${replaced ? 'replaced' : 'appended'} (value not displayed)`);
  }

  console.log(`\n  fingerprint: ${fp}`);
  console.log('  Compare this against the Vercel dashboard only via a later');
  console.log('  --fingerprint-local run; the value itself is now write-only.\n');
  console.log('  NOT YET IN EFFECT. Redeploy, then run --verify-dead with the OLD value.\n');

  appendEvidence({
    timestamp: new Date().toISOString(),
    action: 'rotate',
    secret: name,
    targets,
    local_env_updated: Boolean(alsoLocal),
    new_value_fingerprint: fp,
    vercel_account: account,
    in_effect: false,
    note: 'Vercel env change staged; takes effect at next deployment. Old value not yet proven dead.',
  });
}

function removeSecret(name, targets) {
  if (name !== 'BOOTSTRAP_SECRET') {
    die(
      `--remove is only for BOOTSTRAP_SECRET (removing ${name} would break a live code path).`
    );
  }
  const account = requireVercelAuth();
  console.log(`\nRemoving ${name} — POST /api/admin/bootstrap answers 404 once unset.`);
  console.log('  Do this only if the first admin already exists in production.\n');
  const removed = [];
  for (const target of targets) {
    const res = spawnSync('vercel', ['env', 'remove', name, target, '--yes'], {
      encoding: 'utf8',
    });
    const out = `${res.stdout || ''}${res.stderr || ''}`;
    if (res.status !== 0 && !/not found|does not exist/i.test(out)) {
      die(`vercel env remove ${name} ${target} failed:\n  ${out.trim()}`);
    }
    console.log(`  ${target}: ${res.status === 0 ? 'removed' : 'already absent'}`);
    removed.push(target);
  }
  appendEvidence({
    timestamp: new Date().toISOString(),
    action: 'remove',
    secret: name,
    targets: removed,
    vercel_account: account,
    in_effect: false,
    note: 'Endpoint disabled once redeployed; verify with --verify-dead BOOTSTRAP_SECRET.',
  });
}

function fingerprintLocal(name) {
  const local = readLocalEnvValue(name);
  if (!local) die(`${name} is not set in .env or .env.local`);
  console.log(`\n  ${name}`);
  console.log(`    source     : ${local.file}`);
  console.log(`    fingerprint: ${fingerprint(local.value)}`);
  console.log(`    length     : ${local.value.length} chars\n`);
}

/** Mints an HS256 JWT with the OLD secret. If the app accepts it, it is alive. */
function forgeJwt(secret) {
  const b64 = (o) =>
    Buffer.from(JSON.stringify(o)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const head = b64({ alg: 'HS256', typ: 'JWT' });
  const body = b64({
    sub: 'GROTATIONPROBE000000000000000000000000000000000000000000',
    role: 'admin',
    iat: now,
    exp: now + 300,
  });
  const sig = createHmac('sha256', secret)
    .update(`${head}.${body}`)
    .digest('base64url');
  return `${head}.${body}.${sig}`;
}

async function verifyDead(name, url) {
  if (!url) die('--verify-dead requires --url https://<deployment>');
  if (process.stdin.isTTY) {
    die(
      'the OLD secret must arrive on stdin, never argv (argv is visible in `ps`).\n' +
        `  node scripts/rotate-secrets.mjs --verify-dead ${name} --url ${url} < old-secret.txt`
    );
  }
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  const old = Buffer.concat(chunks).toString('utf8').trim();
  if (!old) die('stdin was empty — expected the OLD secret value');
  // Without this, piping a placeholder would write an evidence record asserting
  // the old credential was rejected — a claim about a value never actually in
  // use. Every secret this script rotates is 64 hex characters.
  if (old.length < 32) {
    die(
      `the value on stdin is ${old.length} characters; every rotated secret is at least 32.\n` +
        '  Refusing to record a rejection for a value that was never the live secret.'
    );
  }

  const base = url.replace(/\/+$/, '');
  const spec = ROTATABLE[name];
  if (!spec) die(`unknown secret ${name}`);

  const probes = [];
  if (spec.verify === 'bearer') {
    probes.push(
      { label: 'GET /api/indexer/run', method: 'GET', path: '/api/indexer/run', headers: { authorization: `Bearer ${old}` } },
      { label: 'POST /api/reconciliation/run', method: 'POST', path: '/api/reconciliation/run', headers: { authorization: `Bearer ${old}` } }
    );
  } else if (spec.verify === 'forged-jwt') {
    probes.push({
      label: 'GET /api/auth/me with JWT forged using the old AUTH_SECRET',
      method: 'GET',
      path: '/api/auth/me',
      headers: { cookie: `${SESSION_COOKIE}=${forgeJwt(old)}` },
    });
  } else if (spec.verify === 'config-only') {
    // Deliberately NOT probed over the network.
    //
    // On a secret match, POST /api/admin/bootstrap proceeds directly to
    // prisma.user.upsert, defaulting the wallet to ADMIN_WALLETS[0] when the
    // body omits one. A probe that *succeeded* would therefore grant admin in
    // production — the verification would cause the thing it is checking for.
    //
    // It is also not externally decidable: the endpoint answers 404 both when
    // the secret is unset and when it is set but wrong. Absence is proven from
    // configuration, not from a response code.
    die(
      'BOOTSTRAP_SECRET cannot be verified by probing.\n\n' +
        '  A request bearing a still-live secret would perform a REAL admin\n' +
        '  bootstrap (route.ts falls back to ADMIN_WALLETS[0]), and the endpoint\n' +
        '  returns 404 whether the secret is unset or merely wrong — so a 404\n' +
        '  proves nothing either way.\n\n' +
        '  Verify from configuration instead:\n' +
        '    vercel env ls production | grep BOOTSTRAP_SECRET   # expect no row\n' +
        '  then confirm a deployment was created after the removal.'
    );
  }

  // reconciliation/run answers 404 as its REJECTION. A wrong path answers 404
  // too, which would otherwise read as a pass. Require the route in source, so
  // a 404 can only mean the credential was refused.
  for (const p of probes) {
    const routeFile = join(ROOT, 'src', 'app', `${p.path}`, 'route.ts');
    if (!existsSync(routeFile)) {
      die(
        `${p.path} has no route at src/app${p.path}/route.ts.\n` +
          '  Refusing to probe: a 404 from a path that does not exist would be\n' +
          '  reported as a rejected credential.'
      );
    }
  }

  console.log(`\nProving the OLD ${name} is dead against ${base}\n`);
  const results = [];
  let allDead = true;
  for (const p of probes) {
    let status = null;
    let error = null;
    try {
      const res = await fetch(`${base}${p.path}`, {
        method: p.method,
        headers: p.headers,
        body: p.body,
        redirect: 'manual',
      });
      status = res.status;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
    // 401/403/404 = rejected. 200 = the old credential still works.
    const dead = status !== null && [401, 403, 404].includes(status);
    if (!dead) allDead = false;
    console.log(
      `  ${dead ? 'DEAD    ' : 'ALIVE ⚠ '} ${p.label} → ${error ? `network error: ${error}` : `HTTP ${status}`}`
    );
    results.push({ probe: p.label, status, error, rejected: dead });
  }

  console.log(
    allDead
      ? `\n  OLD ${name} is rejected everywhere probed. Rotation complete.\n`
      : `\n  OLD ${name} STILL AUTHENTICATES. The rotation is NOT complete —\n` +
          '  check that you redeployed, and that no fallback variable still holds it.\n'
  );

  appendEvidence({
    timestamp: new Date().toISOString(),
    action: 'verify-old-dead',
    secret: name,
    deployment: base,
    old_value_fingerprint: fingerprint(old),
    probes: results,
    probe_paths_verified_in_source: true,
    old_value_rejected_everywhere: allDead,
    in_effect: allDead,
  });

  if (!allDead) process.exit(2);
}

// ---------------------------------------------------------------- arg parsing
const argv = process.argv.slice(2);
const flag = (n) => {
  const i = argv.indexOf(n);
  return i === -1 ? null : argv[i + 1] ?? null;
};
const has = (n) => argv.includes(n);

for (const a of argv) {
  if (/^[0-9a-f]{64}$/i.test(a)) {
    die('a 64-hex value was passed in argv. Secrets must never be in argv — it is visible in `ps`.');
  }
}

const targets = (flag('--targets') ?? 'production')
  .split(',')
  .map((t) => t.trim())
  .filter(Boolean);
for (const t of targets) {
  if (!['production', 'preview', 'development'].includes(t)) {
    die(`unknown target "${t}" (expected production, preview, or development)`);
  }
}

if (has('--plan')) {
  plan();
} else if (has('--rotate')) {
  rotate(flag('--rotate'), targets, has('--local'));
} else if (has('--remove')) {
  removeSecret(flag('--remove'), targets);
} else if (has('--fingerprint-local')) {
  fingerprintLocal(flag('--fingerprint-local'));
} else if (has('--verify-dead')) {
  await verifyDead(flag('--verify-dead'), flag('--url'));
} else {
  console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0]);
  process.exit(1);
}
