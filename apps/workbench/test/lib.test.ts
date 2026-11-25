// @vitest-environment node
import {
  KNOWN_NETWORKS,
  claimFromJSON,
  claimToJSON,
  encodeClaim,
  fromHex,
  signClaim,
  toHex,
  type ClaimContext,
} from '@coreflow/sdk';
import { describe, expect, it } from 'vitest';
import { choiceFor, passphraseFor, vectorClaimJSON, vectorContext } from '../src/lib/claims';
import { EVIDENCE_RUNS, VECTORS } from '../src/lib/data';
import { EXAMPLE_ERRORS, KIT_ERRORS, lookupError } from '../src/lib/errorCatalog';
import { reverifyRun, stepNamed } from '../src/lib/evidence';
import { claimInvokeArg, issuerSnippet, releaseCommand } from '../src/lib/exports';
import { cleanHex, groupHex, parseHex, parseU64, relativeTime, unixToIso } from '../src/lib/format';
import { inspectPreimage } from '../src/lib/inspect';
import { runAllVectors, runVector } from '../src/lib/vectorRunner';
import { runVerification } from '../src/lib/verification';

const valid = (name: string) => VECTORS.valid.find((v) => v.name === name)!;
const invalid = (name: string) => VECTORS.invalid.find((v) => v.name === name)!;

describe('format', () => {
  it('tolerates whitespace and a 0x prefix in pasted hex', () => {
    expect(cleanHex(' 0xAB cd\n\tEF ')).toBe('abcdef');
    const parsed = parseHex('0x00 ff', 'x', 2);
    expect(parsed.ok && toHex(parsed.value)).toBe('00ff');
  });

  it('explains what is wrong with bad hex', () => {
    expect(parseHex('', 'The value')).toEqual({ ok: false, error: 'The value is empty.' });
    expect(parseHex('zz', 'The value')).toMatchObject({ ok: false, error: expect.stringMatching(/not hex/) });
    expect(parseHex('abc', 'The value')).toMatchObject({ ok: false, error: expect.stringMatching(/odd number/) });
    expect(parseHex('ab', 'The value', 32)).toMatchObject({
      ok: false,
      error: expect.stringMatching(/must be 32 bytes/),
    });
  });

  it('parses u64 values and rejects everything else', () => {
    expect(parseU64('18446744073709551615', 'n')).toEqual({ ok: true, value: 0xffffffffffffffffn });
    for (const bad of ['18446744073709551616', '-1', '1.5', '01', '', 'abc']) expect(parseU64(bad, 'n').ok).toBe(false);
  });

  it('formats hex groups and times', () => {
    expect(groupHex('0011223344556677', 4)).toBe('00112233 44556677');
    expect(unixToIso(1790000000n)).toBe('2026-09-21T14:13:20Z');
    expect(unixToIso(0xffffffffffffffffn)).toBeUndefined();
    expect(relativeTime(100n, 100n)).toBe('now');
    expect(relativeTime(1000n, 100n)).toBe('in 15 min');
    expect(relativeTime(100n, 100n + 7200n)).toBe('2 h ago');
  });
});

describe('networks', () => {
  it('maps choices to passphrases and back', () => {
    for (const n of KNOWN_NETWORKS) expect(choiceFor(passphraseFor(n.name, ''))).toBe(n.name);
    expect(passphraseFor('custom', 'Standalone Network ; February 2017')).toBe('Standalone Network ; February 2017');
    expect(choiceFor('Standalone Network ; February 2017')).toBe('custom');
  });
});

describe('runVerification', () => {
  const check = (v: (typeof VECTORS.valid)[number]) =>
    runVerification(claimFromJSON(vectorClaimJSON(v.claim)), vectorContext(v), fromHex(v.signature_hex), BigInt(v.now));

  it('passes every off-chain step for a valid vector and leaves contract steps to the contract', () => {
    const report = check(valid('unique-id'));
    expect(report.ok).toBe(true);
    expect(report.steps.map((s) => [s.n, s.status])).toEqual([
      [1, 'contract-only'],
      [2, 'pass'],
      [3, 'pass'],
      [4, 'pass'],
      [5, 'contract-only'],
      [6, 'pass'],
      [7, 'contract-only'],
    ]);
    expect(report.preimageHex).toBe(valid('unique-id').preimage_hex);
  });

  const cases: [string, number, string, number | undefined][] = [
    ['empty-window', 2, 'InvalidWindow', 1102],
    ['expired', 3, 'ClaimExpired', 1103],
    ['sequence-with-claim-id', 4, 'InvalidReplayFields', 1104],
    ['tampered-subject', 6, 'InvalidSignature', undefined],
  ];
  it.each(cases)('stops %s at step %i with %s', (name, step, code, onChain) => {
    const report = check(invalid(name));
    expect(report.ok).toBe(false);
    expect(report.failure).toMatchObject({ code, onChainCode: onChain });
    expect(report.failure!.nextStep.length).toBeGreaterThan(10);
    const offChain = report.steps.filter((s) => s.status !== 'contract-only');
    const failed = offChain.find((s) => s.status === 'fail')!;
    expect(failed.n).toBe(step);
    for (const s of offChain) {
      if (s.n < step) expect(s.status).toBe('pass');
      if (s.n > step) expect(s.status).toBe('not-reached');
    }
  });

  it('reports malformed input without claiming any step passed', () => {
    const v = valid('unique-id');
    const ctx: ClaimContext = { ...vectorContext(v), contractId: 'not-a-contract' };
    const report = runVerification(
      claimFromJSON(vectorClaimJSON(v.claim)),
      ctx,
      fromHex(v.signature_hex),
      BigInt(v.now),
    );
    expect(report.ok).toBe(false);
    expect(report.inputError?.code).toBe('InvalidInput');
    expect(report.steps.some((s) => s.status === 'pass')).toBe(false);
  });
});

describe('error catalogue', () => {
  it('lists 1101-1109 with the SDK next steps', () => {
    expect(KIT_ERRORS.map((e) => e.code)).toEqual([1101, 1102, 1103, 1104, 1105, 1106, 1107, 1108, 1109]);
    expect(KIT_ERRORS.find((e) => e.code === 1103)).toMatchObject({
      name: 'ClaimExpired',
      nextStep: 'Ask the issuer for a fresh claim.',
    });
  });

  it('recognises the replay error the recorded Testnet run printed', () => {
    const replay = stepNamed(EVIDENCE_RUNS[0]!, 'replay')!;
    const found = lookupError(String(replay.simulationMessage));
    expect(found?.entries.map((e) => e.name)).toEqual(['ClaimAlreadyUsed']);
  });

  it.each([
    ['Error(Contract, #1103)', 'ClaimExpired'],
    ['#1105', 'NonceMismatch'],
    ['1101', 'IssuerNotRegistered'],
    ['claimalreadyused', 'ClaimAlreadyUsed'],
    ['HostError: Error(Crypto, InvalidInput) failed host function call', 'Error(Crypto, InvalidInput)'],
  ])('finds %s', (input, name) => {
    expect(lookupError(input)?.entries[0]?.name).toBe(name);
  });

  it('says when a number belongs to the host contract, not the kit', () => {
    const three = lookupError('Error(Contract, #3)')!;
    expect(three.entries).toEqual([EXAMPLE_ERRORS[2]]);
    expect(three.caveat).toMatch(/defined by the contract you called/);
    const other = lookupError('5000')!;
    expect(other.entries).toEqual([]);
    expect(other.caveat).toMatch(/not a coreflow-attest code/);
  });

  it('returns nothing for empty or unknown text', () => {
    expect(lookupError('   ')).toBeUndefined();
    expect(lookupError('something else entirely')).toBeUndefined();
  });
});

describe('inspectPreimage', () => {
  const v = valid('sequence-first');
  const bytes = fromHex(v.preimage_hex!);

  it('finds no problems when the context matches and the claim is live', () => {
    const ins = inspectPreimage(bytes, {
      now: BigInt(v.now),
      expectedPassphrase: v.context.network_passphrase,
      expectedContractId: v.context.contract_id,
    });
    expect(ins.warnings).toEqual([]);
    expect(ins.rows).toHaveLength(14);
    expect(ins.rows.find((r) => r.name === 'claim_type')?.meaning).toBe('SHA-256("marketplace.delivery.v1")');
    expect(ins.rows.find((r) => r.name === 'network_id')?.tone).toBe('ok');
  });

  it('warns about the wrong contract, the wrong network and expiry', () => {
    const ins = inspectPreimage(bytes, {
      now: BigInt(v.claim.expires_at) + 1n,
      expectedPassphrase: KNOWN_NETWORKS[0]!.passphrase,
      expectedContractId: valid('mainnet-second-issuer').context.contract_id,
    });
    expect(ins.warnings.join(' ')).toMatch(/network digest does not match/);
    expect(ins.warnings.join(' ')).toMatch(/contract digest does not match/);
    expect(ins.warnings.join(' ')).toMatch(/1103 ClaimExpired/);
  });

  it('warns about replay fields and reserved values the contract rejects', () => {
    const copy = bytes.slice();
    copy[208] = 1; // claim_id in sequence mode
    copy[198] = 5; // reserved payload_encoding
    const ins = inspectPreimage(copy, { now: BigInt(v.now) });
    expect(ins.warnings.join(' ')).toMatch(/non-zero claim_id/);
    expect(ins.warnings.join(' ')).toMatch(/payload_encoding 5 is reserved/);
  });

  it('still lays out the bytes when the magic is wrong', () => {
    const copy = bytes.slice();
    copy[0] = 0;
    const ins = inspectPreimage(copy, { now: 0n });
    expect(ins.decodeError).toMatch(/magic/);
    expect(ins.decoded).toBeUndefined();
    expect(ins.rows.map((r) => r.name)[0]).toBe('magic');
    expect(ins.rows).toHaveLength(14);
  });
});

describe('vector runner', () => {
  it('passes all 16 committed vectors through @coreflow/sdk', () => {
    const results = runAllVectors();
    expect(results).toHaveLength(16);
    expect(results.filter((r) => !r.ok).map((r) => r.vector.name)).toEqual([]);
  });

  it('fails a vector whose expectation is wrong', () => {
    const wrong = { ...invalid('expired'), expected_error: 'InvalidSignature' };
    const result = runVector(wrong, 'invalid');
    expect(result.ok).toBe(false);
    expect(result.checks[0]?.detail).toBe('Failed with ClaimExpired instead.');
  });

  it('fails a valid vector whose committed preimage is wrong', () => {
    const v = valid('unique-id');
    const result = runVector({ ...v, preimage_hex: v.preimage_hex!.replace(/^43/, '44') }, 'valid');
    expect(result.ok).toBe(false);
  });
});

describe('recorded Testnet evidence', () => {
  it('has the three committed passing runs', () => {
    expect(EVIDENCE_RUNS.length).toBeGreaterThanOrEqual(3);
    expect(EVIDENCE_RUNS.every((r) => r.network === 'testnet' && r.outcome === 'passed')).toBe(true);
  });

  it.each(EVIDENCE_RUNS.map((r) => [r.runId, r] as const))('re-verifies run %s offline', (_id, run) => {
    const check = reverifyRun(run);
    expect(check).toMatchObject({ signatureOk: true, preimageMatches: true });
    expect(check.error).toBeUndefined();
  });

  it('detects a recorded signature that was altered', () => {
    const run = EVIDENCE_RUNS[0]!;
    const steps = run.steps.map((s) =>
      s.name === 'sign-claim' ? { ...s, signatureHex: `${String(s.signatureHex).slice(0, -2)}00` } : s,
    );
    expect(reverifyRun({ ...run, steps })).toMatchObject({ signatureOk: false, preimageMatches: true });
  });

  it('reports a run that recorded no claim', () => {
    const run = EVIDENCE_RUNS[0]!;
    expect(reverifyRun({ ...run, steps: run.steps.filter((s) => s.name !== 'sign-claim') }).error).toMatch(
      /did not record/,
    );
  });
});

describe('exports', () => {
  const v = valid('u64-extremes');
  const json = vectorClaimJSON(v.claim);

  it('writes u64 values as exact JSON numbers for stellar-cli', () => {
    const arg = claimInvokeArg(json);
    expect(arg).toContain(`"expires_at":${json.expires_at}`);
    expect(arg).not.toContain(`"expires_at":"`);
    // The text is JSON, and parsing it back as JSON yields the same claim.
    const big = arg.replace(/:(\d{16,})/g, ':"$1"');
    expect(claimToJSON(claimFromJSON(JSON.parse(big)))).toEqual(json);
  });

  it('builds a release command and leaves placeholders it cannot know', () => {
    const cmd = releaseCommand({
      json,
      contractId: v.context.contract_id,
      network: 'testnet',
      signatureHex: v.signature_hex,
    });
    expect(cmd).toContain('--network testnet');
    expect(cmd).toContain(`--id ${v.context.contract_id}`);
    expect(cmd).toContain('<HOLD_ID>');
    expect(cmd).toContain(`--signature ${v.signature_hex}`);
    const unsigned = releaseCommand({ json, contractId: v.context.contract_id, network: 'mainnet' });
    expect(unsigned).toContain('--network <NETWORK>');
    expect(unsigned).toContain('<SIGNATURE_HEX_FROM_YOUR_ISSUER>');
  });
});

describe('issuer snippet', () => {
  it('compiles, runs and reproduces the claim (apart from the issuer key)', async () => {
    const { mkdirSync, rmSync, writeFileSync } = await import('node:fs');
    const path = await import('node:path');
    const { Keypair } = await import('../../../packages/sdk/node_modules/@stellar/stellar-base');
    const seed = new Uint8Array(32).fill(7);
    const contractId = valid('unique-id').context.contract_id;
    const claimIdHex = 'ab'.repeat(32);
    const snippet = issuerSnippet({
      network: 'testnet',
      passphrase: KNOWN_NETWORKS[1]!.passphrase,
      contractId,
      claimTypeName: 'marketplace.delivery.v1',
      subject: { mode: 'text', value: 'order:42' },
      payload: { mode: 'text', value: '{"order":42,"status":"delivered"}' },
      payloadEncoding: 'raw',
      replay: { mode: 'unique-id', claimIdHex },
      issuedAt: '1790000000',
      expiresAt: '1790000900',
    });
    const stellarBase = path.resolve(
      __dirname,
      '../../../packages/sdk/node_modules/@stellar/stellar-base/lib/index.js',
    );
    const runnable = `${snippet
      .replace("from '@stellar/stellar-base'", `from ${JSON.stringify(stellarBase)}`)
      .replace(
        'verifyClaim(claim, ctx, signature);',
        'verifyClaim(claim, ctx, signature, { now: 1790000001n });',
      )}\nexport { claim, ctx, signature };\n`;
    const dir = path.resolve(__dirname, '.generated');
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `snippet-${process.pid}.ts`);
    writeFileSync(file, runnable);
    process.env.ISSUER_SECRET = Keypair.fromRawEd25519Seed(Buffer.from(seed)).secret();
    try {
      const mod = await import(/* @vite-ignore */ file);
      const expected = signClaim(mod.claim, mod.ctx, seed);
      expect(toHex(mod.signature)).toBe(toHex(expected.signature));
      const out = claimToJSON(mod.claim);
      expect(out).toMatchObject({
        claim_id: claimIdHex,
        issued_at: '1790000000',
        expires_at: '1790000900',
        replay_mode: 1,
      });
      expect(out.claim_type).toBe(valid('unique-id').claim.claim_type_hex);
      expect(toHex(encodeClaim(mod.claim, mod.ctx)).slice(0, 12)).toBe('4346434c0001');
    } finally {
      rmSync(dir, { recursive: true, force: true });
      delete process.env.ISSUER_SECRET;
    }
  });
});
