#!/usr/bin/env node
/**
 * Mutation guard. For every `// check:<name> begin` ... `// check:<name> end`
 * region in src/, copy the package to a temp dir, delete the region, run the
 * test suite there and record whether it fails (KILLED) or still passes
 * (SURVIVED). Exits 1 if any mutant survived, a required marker is missing or
 * a mutant failed for a reason other than a failing test.
 */
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REQUIRED = ['window', 'expiry', 'replay-fields', 'signature', 'network-binding', 'contract-binding', 'issuer-match', 'preimage-signature'];
const pkgRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const vectorsDir = resolve(pkgRoot, '..', 'test-vectors', 'vectors');
const srcDir = join(pkgRoot, 'src');

// ---- find markers ----
const markers = [];
for (const file of readdirSync(srcDir).filter((f) => f.endsWith('.ts'))) {
  const lines = readFileSync(join(srcDir, file), 'utf8').split('\n');
  const open = new Map();
  lines.forEach((line, i) => {
    const m = /\/\/\s*check:([\w-]+)\s+(begin|end)\b/.exec(line);
    if (!m) return;
    const [, name, kind] = m;
    if (kind === 'begin') {
      if (open.has(name)) throw new Error(`${file}:${i + 1}: nested check:${name}`);
      open.set(name, i);
    } else {
      if (!open.has(name)) throw new Error(`${file}:${i + 1}: check:${name} end without begin`);
      markers.push({ name, file, begin: open.get(name), end: i });
      open.delete(name);
    }
  });
  if (open.size) throw new Error(`${file}: unclosed check:${[...open.keys()].join(', ')}`);
}
const missing = REQUIRED.filter((n) => !markers.some((m) => m.name === n));
if (missing.length) {
  console.error(`Missing required markers: ${missing.join(', ')}`);
  process.exit(1);
}

// ---- run vitest in a temp copy ----
const vitestBin = join(pkgRoot, 'node_modules', 'vitest', 'vitest.mjs');
function runInCopy(mutant) {
  const root = mkdtempSync(join(tmpdir(), 'sdk-mutation-'));
  try {
    // Layout mirrors the repo so ../test-vectors resolves from the package copy.
    const pkg = join(root, 'packages', 'sdk');
    mkdirSync(pkg, { recursive: true });
    cpSync(pkgRoot, pkg, { recursive: true, filter: (p) => !/(^|[\\/])(node_modules|dist)$/.test(p) });
    cpSync(vectorsDir, join(root, 'packages', 'test-vectors', 'vectors'), { recursive: true });
    symlinkSync(join(pkgRoot, 'node_modules'), join(pkg, 'node_modules'), 'dir');
    if (mutant) {
      const target = join(pkg, 'src', mutant.file);
      const lines = readFileSync(target, 'utf8').split('\n');
      lines.splice(mutant.begin, mutant.end - mutant.begin + 1);
      writeFileSync(target, lines.join('\n'));
    }
    const res = spawnSync(process.execPath, [vitestBin, 'run', '--reporter=json'], { cwd: pkg, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    let report;
    try {
      report = JSON.parse(res.stdout.slice(res.stdout.indexOf('{')));
    } catch {
      report = undefined;
    }
    return { status: res.status, report, stderr: res.stderr };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const baseline = runInCopy(null);
if (baseline.status !== 0 || !baseline.report || baseline.report.numFailedTests !== 0) {
  console.error('Baseline test run failed; fix the tests before running the mutation check.');
  process.exit(1);
}

const rows = markers.map((m) => {
  const { status, report, stderr } = runInCopy(m);
  let verdict;
  if (status === 0) verdict = 'SURVIVED';
  else if (report && report.numFailedTests > 0) verdict = 'KILLED';
  else verdict = 'ERROR'; // failed without a failing test (syntax or load error): not a valid kill
  return { name: m.name, location: `${m.file}:${m.begin + 1}-${m.end + 1}`, verdict, failed: report?.numFailedTests ?? '-', stderr };
});

const w = Math.max(...rows.map((r) => r.name.length), 4);
const wl = Math.max(...rows.map((r) => r.location.length), 8);
console.log(`${'check'.padEnd(w)}  ${'location'.padEnd(wl)}  verdict   failing tests`);
for (const r of rows) console.log(`${r.name.padEnd(w)}  ${r.location.padEnd(wl)}  ${r.verdict.padEnd(8)}  ${r.failed}`);
const bad = rows.filter((r) => r.verdict !== 'KILLED');
console.log(`\n${rows.length - bad.length}/${rows.length} mutants killed`);
for (const r of bad.filter((x) => x.verdict === 'ERROR')) console.error(`${r.name}: ${r.stderr.slice(0, 500)}`);
process.exit(bad.length ? 1 : 0);
