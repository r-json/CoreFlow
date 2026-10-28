import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  ClaimError,
  KNOWN_NETWORKS,
  PREIMAGE_LAYOUT,
  claimFromJSON,
  claimToJSON,
  comparePreimages,
  contractDigest,
  decodePreimage,
  encodeClaim,
  fromHex,
  identifyNetwork,
  issuerFromStrkey,
  issuerToStrkey,
  networkId,
  signClaim,
  toHex,
  verifyClaim,
  verifyPreimage,
  type Claim,
  type ClaimJSON,
} from '../src/index.js';
import { ctx as CTX, makeClaim as baseClaim, seed as SEED } from './fixtures.js';

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
interface Vector {
  name: string;
  expected_error?: string;
  context: { network_passphrase: string; contract_id: string; network_id_hex: string; contract_digest_hex: string };
  claim: VectorClaim;
  now: string;
  preimage_hex?: string;
  signature_hex: string;
}
const vectors = JSON.parse(
  readFileSync(new URL('../../test-vectors/vectors/claim-v1.json', import.meta.url), 'utf8'),
) as { valid: Vector[]; invalid: Vector[]; issuers: { public_key_hex: string }[] };

/** The vector file's claim, re-keyed into the portable JSON form. */
const vectorJSON = (c: VectorClaim): ClaimJSON => ({
  issuer: c.issuer_hex,
  claim_type: c.claim_type_hex,
  subject: c.subject_hex,
  payload_hash: c.payload_hash_hex,
  payload_encoding: c.payload_encoding,
  replay_mode: c.replay_mode,
  nonce: c.nonce,
  claim_id: c.claim_id_hex,
  issued_at: c.issued_at,
  expires_at: c.expires_at,
});
const ctxOf = (v: Vector) => ({ networkPassphrase: v.context.network_passphrase, contractId: v.context.contract_id });

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(ClaimError);
    return (e as ClaimError).code;
  }
  return undefined;
}

describe('PREIMAGE_LAYOUT', () => {
  it('is contiguous and covers exactly 256 bytes', () => {
    let next = 0;
    for (const f of PREIMAGE_LAYOUT) {
      expect(f.offset).toBe(next);
      next += f.size;
    }
    expect(next).toBe(256);
  });

  it('is frozen', () => {
    expect(Object.isFrozen(PREIMAGE_LAYOUT)).toBe(true);
    expect(Object.isFrozen(PREIMAGE_LAYOUT[0])).toBe(true);
  });

  // Ties the table to the encoder: changing one input changes exactly the field the table names.
  const base = baseClaim();
  const changes: [string, Partial<Claim>, string][] = [
    ['issuer', { issuer: new Uint8Array(32).fill(9) }, 'issuer'],
    ['claimType', { claimType: new Uint8Array(32).fill(9) }, 'claim_type'],
    ['subject', { subject: new Uint8Array(32).fill(9) }, 'subject'],
    ['payloadHash', { payloadHash: new Uint8Array(32).fill(9) }, 'payload_hash'],
    ['payloadEncoding', { payloadEncoding: 'xdr' }, 'payload_encoding'],
    ['issuedAt', { issuedAt: base.issuedAt + 1n }, 'issued_at'],
    ['expiresAt', { expiresAt: base.expiresAt + 1n }, 'expires_at'],
    ['sequence nonce', { replay: { mode: 'sequence', nonce: 8n } }, 'nonce'],
  ];
  it.each(changes)('changing %s changes exactly one layout field', (_label, change, expected) => {
    const before = encodeClaim(base, CTX);
    const after = encodeClaim({ ...base, ...change }, CTX);
    expect(comparePreimages(before, after).map((d) => d.name)).toEqual([expected]);
  });

  it('places the network and the contract where the table says', () => {
    const before = encodeClaim(base, CTX);
    const otherNet = encodeClaim(base, { ...CTX, networkPassphrase: KNOWN_NETWORKS[0]!.passphrase });
    expect(comparePreimages(before, otherNet).map((d) => d.name)).toEqual(['network_id']);
    const otherContract = encodeClaim(base, { ...CTX, contractId: vectors.valid[5]!.context.contract_id });
    expect(comparePreimages(before, otherContract).map((d) => d.name)).toEqual(['contract']);
  });
});

describe('decodePreimage', () => {
  it.each(vectors.valid)('reads back every field of valid vector $name', (v) => {
    const d = decodePreimage(fromHex(v.preimage_hex!));
    expect(d.version).toBe(1);
    expect(toHex(d.networkId)).toBe(v.context.network_id_hex);
    expect(toHex(d.contractDigest)).toBe(v.context.contract_digest_hex);
    expect(toHex(d.issuer)).toBe(v.claim.issuer_hex);
    expect(toHex(d.claimType)).toBe(v.claim.claim_type_hex);
    expect(toHex(d.subject)).toBe(v.claim.subject_hex);
    expect(toHex(d.payloadHash)).toBe(v.claim.payload_hash_hex);
    expect(d.payloadEncoding).toBe(v.claim.payload_encoding);
    expect(d.replayMode).toBe(v.claim.replay_mode);
    expect(d.nonce).toBe(BigInt(v.claim.nonce));
    expect(toHex(d.claimId)).toBe(v.claim.claim_id_hex);
    expect(d.issuedAt).toBe(BigInt(v.claim.issued_at));
    expect(d.expiresAt).toBe(BigInt(v.claim.expires_at));
    expect(identifyNetwork(d.networkId)?.passphrase).toBe(v.context.network_passphrase);
  });

  it('returns copies, not views into the input', () => {
    const bytes = encodeClaim(baseClaim(), CTX);
    const d = decodePreimage(bytes);
    bytes[70] = bytes[70]! ^ 0xff;
    expect(d.issuer[0]).toBe(baseClaim().issuer[0]);
  });

  it('reads a preimage that sits inside a larger buffer', () => {
    const inner = encodeClaim(baseClaim(), CTX);
    const outer = new Uint8Array(300);
    outer.set(inner, 20);
    expect(decodePreimage(outer.subarray(20, 276)).issuedAt).toBe(baseClaim().issuedAt);
  });

  it('reports inconsistent replay fields instead of rejecting them', () => {
    const bytes = encodeClaim(baseClaim(), CTX); // sequence mode
    bytes[208] = 1; // non-zero claim_id in sequence mode
    const d = decodePreimage(bytes);
    expect(d.replayMode).toBe(0);
    expect(d.claimId[0]).toBe(1);
  });

  it('reports reserved byte values as they are', () => {
    const bytes = encodeClaim(baseClaim(), CTX);
    bytes[198] = 7;
    bytes[199] = 9;
    const d = decodePreimage(bytes);
    expect([d.payloadEncoding, d.replayMode]).toEqual([7, 9]);
  });

  it('rejects input that is not a 256-byte preimage', () => {
    expect(codeOf(() => decodePreimage(new Uint8Array(255)))).toBe('InvalidInput');
    expect(codeOf(() => decodePreimage('00' as never))).toBe('InvalidInput');
    const badMagic = encodeClaim(baseClaim(), CTX);
    badMagic[0] = 0x00;
    expect(() => decodePreimage(badMagic)).toThrow(/magic/);
    const v2 = encodeClaim(baseClaim(), CTX);
    v2[5] = 2;
    expect(() => decodePreimage(v2)).toThrow(/version 2/);
  });
});

describe('verifyPreimage', () => {
  it.each(vectors.valid)('accepts the signature of valid vector $name', (v) => {
    expect(() => verifyPreimage(fromHex(v.preimage_hex!), fromHex(v.signature_hex))).not.toThrow();
  });

  it('rejects a signature over different bytes', () => {
    const v = vectors.valid[0]!;
    const bytes = fromHex(v.preimage_hex!);
    bytes[150] = bytes[150]! ^ 1; // inside subject
    expect(codeOf(() => verifyPreimage(bytes, fromHex(v.signature_hex)))).toBe('InvalidSignature');
  });

  it.each(['other-network', 'other-contract', 'wrong-issuer-key', 'zero-signature'])(
    'rejects the signature of invalid vector %s over the verifier preimage',
    (name) => {
      const v = vectors.invalid.find((x) => x.name === name)!;
      const preimage = encodeClaim(claimFromJSON(vectorJSON(v.claim)), ctxOf(v));
      expect(codeOf(() => verifyPreimage(preimage, fromHex(v.signature_hex)))).toBe('InvalidSignature');
    },
  );

  it('rejects a signature that is not 64 bytes', () => {
    const v = vectors.valid[0]!;
    expect(codeOf(() => verifyPreimage(fromHex(v.preimage_hex!), new Uint8Array(63)))).toBe('InvalidInput');
  });

  it('does not check expiry: a long-expired preimage still matches its signature', () => {
    const v = vectors.invalid.find((x) => x.name === 'expired')!;
    const claim = claimFromJSON(vectorJSON(v.claim));
    expect(codeOf(() => verifyClaim(claim, ctxOf(v), fromHex(v.signature_hex), { now: BigInt(v.now) }))).toBe(
      'ClaimExpired',
    );
    expect(() => verifyPreimage(encodeClaim(claim, ctxOf(v)), fromHex(v.signature_hex))).not.toThrow();
  });
});

describe('comparePreimages', () => {
  it('returns nothing for identical bytes', () => {
    const p = encodeClaim(baseClaim(), CTX);
    expect(comparePreimages(p, p.slice())).toEqual([]);
  });

  it('names several differing fields in layout order, with both values', () => {
    const a = encodeClaim(baseClaim(), CTX);
    const b = a.slice();
    b[0] = 0x41; // magic
    b[255] = b[255]! ^ 1; // expires_at
    b[40] = b[40]! ^ 1; // contract
    const diffs = comparePreimages(a, b);
    expect(diffs.map((d) => d.name)).toEqual(['magic', 'contract', 'expires_at']);
    expect(diffs[0]).toMatchObject({ offset: 0, size: 4 });
    expect(diffs[0]!.a[0]).toBe(0x43);
    expect(diffs[0]!.b[0]).toBe(0x41);
  });

  it('rejects input that is not two 256-byte arrays', () => {
    const p = encodeClaim(baseClaim(), CTX);
    expect(codeOf(() => comparePreimages(p, new Uint8Array(10)))).toBe('InvalidInput');
    expect(codeOf(() => comparePreimages([] as never, p))).toBe('InvalidInput');
  });
});

describe('claim JSON', () => {
  it.each(vectors.valid)('round-trips valid vector $name to the same preimage', (v) => {
    const claim = claimFromJSON(vectorJSON(v.claim));
    expect(toHex(encodeClaim(claim, ctxOf(v)))).toBe(v.preimage_hex);
    const again = claimFromJSON(JSON.stringify(claimToJSON(claim)));
    expect(toHex(encodeClaim(again, ctxOf(v)))).toBe(v.preimage_hex);
    expect(claimToJSON(again)).toEqual(vectorJSON(v.claim));
  });

  it.each(vectors.invalid)('gives verifyClaim the expected error for invalid vector $name', (v) => {
    const claim = claimFromJSON(vectorJSON(v.claim));
    expect(codeOf(() => verifyClaim(claim, ctxOf(v), fromHex(v.signature_hex), { now: BigInt(v.now) }))).toBe(
      v.expected_error,
    );
  });

  it('writes u64 values as decimal strings, including the maximum', () => {
    const claim = { ...baseClaim(), expiresAt: 0xffffffffffffffffn };
    const json = claimToJSON(claim);
    expect(json.expires_at).toBe('18446744073709551615');
    expect(typeof json.issued_at).toBe('string');
    expect(claimFromJSON(json).expiresAt).toBe(0xffffffffffffffffn);
  });

  it('accepts safe-integer numbers, as written by stellar-cli scripts', () => {
    const json = { ...claimToJSON(baseClaim()), nonce: 3, issued_at: 1792291817, expires_at: 1792292717 };
    const claim = claimFromJSON(json);
    expect(claim.issuedAt).toBe(1792291817n);
    expect(claim.replay).toEqual({ mode: 'sequence', nonce: 3n });
  });

  it('accepts upper-case hex', () => {
    const json = claimToJSON(baseClaim());
    expect(claimFromJSON({ ...json, subject: json.subject.toUpperCase() }).subject).toEqual(baseClaim().subject);
  });

  const good = () => claimToJSON(baseClaim()) as unknown as Record<string, unknown>;
  const bad: [string, (j: Record<string, unknown>) => unknown, RegExp][] = [
    ['an unknown key', (j) => ({ ...j, claimType: j.claim_type }), /unknown key "claimType"/],
    ['a missing key', (j) => { const { subject: _s, ...rest } = j; return rest; }, /missing key "subject"/],
    ['short hex', (j) => ({ ...j, issuer: 'ab' }), /issuer: expected 64 hex/],
    ['non-hex', (j) => ({ ...j, payload_hash: 'z'.repeat(64) }), /payload_hash: expected 64 hex/],
    ['a 0x prefix', (j) => ({ ...j, claim_id: `0x${'0'.repeat(62)}` }), /claim_id: expected 64 hex/],
    ['payload_encoding 2', (j) => ({ ...j, payload_encoding: 2 }), /payload_encoding: expected 0 or 1/],
    ['replay_mode as a string', (j) => ({ ...j, replay_mode: '1' }), /replay_mode: expected 0 or 1/],
    ['a u64 above 2^64-1', (j) => ({ ...j, expires_at: '18446744073709551616' }), /expires_at: expected a decimal u64/],
    ['a negative number', (j) => ({ ...j, nonce: -1 }), /nonce: numbers must be non-negative/],
    ['an unsafe integer', (j) => ({ ...j, issued_at: 2 ** 60 }), /issued_at: numbers must be non-negative safe/],
    ['a leading zero', (j) => ({ ...j, nonce: '01' }), /nonce: expected a decimal u64/],
    ['a fraction', (j) => ({ ...j, nonce: 1.5 }), /nonce: numbers must be/],
  ];
  it.each(bad)('rejects %s with InvalidInput', (_label, mutate, message) => {
    const input = mutate(good());
    expect(codeOf(() => claimFromJSON(input))).toBe('InvalidInput');
    expect(() => claimFromJSON(input)).toThrow(message);
  });

  it('rejects input that is not a JSON object', () => {
    for (const input of ['{not json', '[]', 'null', 42, null, []]) {
      expect(codeOf(() => claimFromJSON(input))).toBe('InvalidInput');
    }
  });

  it('refuses to serialize an untyped claim with a non-zero inactive replay field', () => {
    const claim = { ...baseClaim(), replay: { mode: 'sequence', nonce: 0n, claimId: new Uint8Array(32).fill(1) } };
    expect(codeOf(() => claimToJSON(claim as Claim))).toBe('InvalidReplayFields');
  });

  it('serializes unique-id claims with nonce "0"', () => {
    const claimId = new Uint8Array(32).fill(5);
    const json = claimToJSON({ ...baseClaim(), replay: { mode: 'unique-id', claimId } });
    expect(json).toMatchObject({ replay_mode: 1, nonce: '0', claim_id: toHex(claimId) });
  });

  it('produces a claim that signs and verifies', () => {
    const claim = claimFromJSON(JSON.stringify(claimToJSON(baseClaim())));
    const { signature } = signClaim(claim, CTX, SEED);
    expect(() => verifyClaim(claim, CTX, signature, { now: claim.issuedAt })).not.toThrow();
  });
});

describe('networks and issuer strkeys', () => {
  it('identifies each public network by its id', () => {
    for (const n of KNOWN_NETWORKS) expect(identifyNetwork(networkId(n.passphrase))?.name).toBe(n.name);
  });

  it('returns undefined for an unknown network or malformed input', () => {
    expect(identifyNetwork(networkId('Standalone Network ; February 2017'))).toBeUndefined();
    expect(identifyNetwork(new Uint8Array(31))).toBeUndefined();
    expect(identifyNetwork('x' as never)).toBeUndefined();
  });

  it('round-trips an issuer key through its G... strkey', () => {
    const key = fromHex(vectors.issuers[0]!.public_key_hex);
    const address = issuerToStrkey(key);
    expect(address).toMatch(/^G[A-D][A-Z2-7]{54}$/);
    expect(issuerFromStrkey(address)).toEqual(key);
  });

  it('rejects anything but a valid G... public key', () => {
    const address = issuerToStrkey(fromHex(vectors.issuers[0]!.public_key_hex));
    const broken = address.slice(0, -1) + (address.endsWith('A') ? 'B' : 'A');
    for (const input of [broken, 'SB' + address.slice(2), vectors.valid[0]!.context.contract_id, '', 7]) {
      expect(codeOf(() => issuerFromStrkey(input as string))).toBe('InvalidInput');
    }
    expect(codeOf(() => issuerToStrkey(new Uint8Array(31)))).toBe('InvalidInput');
  });

  it('agrees with contractDigest for the vector contracts', () => {
    for (const v of vectors.valid) expect(toHex(contractDigest(v.context.contract_id))).toBe(v.context.contract_digest_hex);
  });
});
