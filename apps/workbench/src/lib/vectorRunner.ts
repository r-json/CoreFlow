import { ClaimError, claimFromJSON, encodeClaim, fromHex, signClaim, toHex, verifyClaim } from '@coreflow/sdk';
import { vectorClaimJSON, vectorContext } from './claims';
import { VECTORS, type Vector } from './data';

export interface VectorCheck {
  label: string;
  ok: boolean;
  detail?: string;
}

export interface VectorResult {
  vector: Vector;
  kind: 'valid' | 'invalid';
  /** What the vector requires, in words. */
  expectation: string;
  checks: VectorCheck[];
  ok: boolean;
  /** The preimage this SDK builds for the vector, as the verifying contract would. */
  preimageHex?: string;
}

function attempt(fn: () => void): string | undefined {
  try {
    fn();
    return undefined;
  } catch (e) {
    return e instanceof ClaimError ? e.code : String(e);
  }
}

/**
 * Run one vector through @coreflow/sdk. Valid vectors must encode to the
 * committed preimage, verify, and (with the public test seed) re-sign to the
 * committed signature. Invalid vectors must fail with the expected error.
 */
export function runVector(vector: Vector, kind: 'valid' | 'invalid'): VectorResult {
  const ctx = vectorContext(vector);
  const now = BigInt(vector.now);
  const checks: VectorCheck[] = [];
  let preimageHex: string | undefined;

  let claim;
  try {
    claim = claimFromJSON(vectorClaimJSON(vector.claim));
    preimageHex = toHex(encodeClaim(claim, ctx));
  } catch (e) {
    const code = e instanceof ClaimError ? e.code : String(e);
    return {
      vector,
      kind,
      expectation: '',
      checks: [{ label: 'Parse the vector', ok: false, detail: code }],
      ok: false,
    };
  }
  const signature = fromHex(vector.signature_hex);

  if (kind === 'valid') {
    checks.push({
      label: 'Preimage equals preimage_hex',
      ok: preimageHex === vector.preimage_hex,
      detail: preimageHex === vector.preimage_hex ? undefined : 'The encoder produced different bytes.',
    });
    const error = attempt(() => verifyClaim(claim, ctx, signature, { now }));
    checks.push({ label: 'verifyClaim accepts it', ok: !error, detail: error });
    const seed = VECTORS.issuers.find((i) => i.public_key_hex === vector.claim.issuer_hex)?.seed_hex;
    if (seed) {
      const resigned = toHex(signClaim(claim, ctx, fromHex(seed)).signature);
      checks.push({ label: 'Re-signing reproduces signature_hex', ok: resigned === vector.signature_hex });
    }
    return {
      vector,
      kind,
      expectation: 'Encodes to the committed preimage and verifies',
      checks,
      ok: checks.every((c) => c.ok),
      preimageHex,
    };
  }

  const error = attempt(() => verifyClaim(claim, ctx, signature, { now }));
  const ok = error === vector.expected_error;
  checks.push({
    label: `verifyClaim fails with ${vector.expected_error}`,
    ok,
    detail: ok ? undefined : error ? `Failed with ${error} instead.` : 'It was accepted.',
  });
  return { vector, kind, expectation: `Fails with ${vector.expected_error}`, checks, ok, preimageHex };
}

/** Every vector in the committed file, valid first. */
export function runAllVectors(): VectorResult[] {
  return [...VECTORS.valid.map((v) => runVector(v, 'valid')), ...VECTORS.invalid.map((v) => runVector(v, 'invalid'))];
}
