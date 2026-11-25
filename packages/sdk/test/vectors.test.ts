import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  ClaimError,
  contractDigest,
  encodeClaim,
  fromHex,
  networkId,
  signClaim,
  toHex,
  verifyClaim,
  type Claim,
  type ClaimContext,
} from '../src/index.js';

interface VectorContext {
  network_passphrase: string;
  network_id_hex: string;
  contract_id: string;
  contract_digest_hex: string;
}
interface VectorClaim {
  issuer_hex: string;
  claim_type_hex: string;
  subject_hex: string;
  payload_hash_hex: string;
  payload_encoding: number;
  replay_mode: number;
  nonce: string;
  claim_id_hex: string;
  issued_at: string;
  expires_at: string;
}
interface ValidVector {
  name: string;
  context: VectorContext;
  claim: VectorClaim;
  now: string;
  preimage_hex: string;
  signature_hex: string;
}
interface InvalidVector {
  name: string;
  expected_error: string;
  context: VectorContext;
  claim: VectorClaim;
  now: string;
  signature_hex: string;
}
interface VectorFile {
  issuers: { name: string; seed_hex: string; public_key_hex: string }[];
  valid: ValidVector[];
  invalid: InvalidVector[];
}

// Path is relative to the package root: packages/sdk -> packages/test-vectors.
const file = new URL('../../test-vectors/vectors/claim-v1.json', import.meta.url);
const vectors = JSON.parse(readFileSync(file, 'utf8')) as VectorFile;

function toClaim(c: VectorClaim): Claim {
  return {
    issuer: fromHex(c.issuer_hex),
    claimType: fromHex(c.claim_type_hex),
    subject: fromHex(c.subject_hex),
    payloadHash: fromHex(c.payload_hash_hex),
    payloadEncoding: c.payload_encoding === 0 ? 'raw' : 'xdr',
    // The vector file may carry an inconsistent inactive replay field on purpose.
    replay:
      c.replay_mode === 0
        ? ({ mode: 'sequence', nonce: BigInt(c.nonce), claimId: fromHex(c.claim_id_hex) } as Claim['replay'])
        : ({ mode: 'unique-id', claimId: fromHex(c.claim_id_hex), nonce: BigInt(c.nonce) } as Claim['replay']),
    issuedAt: BigInt(c.issued_at),
    expiresAt: BigInt(c.expires_at),
  };
}
const toContext = (c: VectorContext): ClaimContext => ({
  networkPassphrase: c.network_passphrase,
  contractId: c.contract_id,
});

describe('test-vectors file', () => {
  it('has the expected shape', () => {
    expect(vectors.valid.length).toBeGreaterThanOrEqual(6);
    expect(vectors.invalid.length).toBeGreaterThanOrEqual(10);
    expect(vectors.issuers.length).toBeGreaterThanOrEqual(2);
  });
});

describe.each(vectors.valid)('valid vector $name', (v) => {
  const claim = toClaim(v.claim);
  const ctx = toContext(v.context);

  it('derives the context digests', () => {
    expect(toHex(networkId(ctx.networkPassphrase))).toBe(v.context.network_id_hex);
    expect(toHex(contractDigest(ctx.contractId))).toBe(v.context.contract_digest_hex);
  });
  it('encodes to the vector preimage', () => {
    expect(toHex(encodeClaim(claim, ctx))).toBe(v.preimage_hex);
  });
  it('verifies at its `now`', () => {
    verifyClaim(claim, ctx, fromHex(v.signature_hex), { now: BigInt(v.now) });
  });
});

describe('signing with the public test issuer seeds', () => {
  const issuerBySeed = new Map(vectors.issuers.map((i) => [i.public_key_hex, i.seed_hex]));

  it.each(vectors.valid)('reproduces signature_hex for $name', (v) => {
    const seedHex = issuerBySeed.get(v.claim.issuer_hex);
    expect(seedHex, 'issuer seed present in the vector file').toBeDefined();
    const { preimage, signature } = signClaim(toClaim(v.claim), toContext(v.context), fromHex(seedHex!));
    expect(toHex(preimage)).toBe(v.preimage_hex);
    expect(toHex(signature)).toBe(v.signature_hex);
  });
});

describe.each(vectors.invalid)('invalid vector $name', (v) => {
  it(`throws ClaimError ${v.expected_error}`, () => {
    let thrown: unknown;
    try {
      verifyClaim(toClaim(v.claim), toContext(v.context), fromHex(v.signature_hex), { now: BigInt(v.now) });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(ClaimError);
    expect((thrown as ClaimError).code).toBe(v.expected_error);
  });
});
