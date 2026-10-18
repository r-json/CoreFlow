import { describe, expect, it } from 'vitest';
import { Networks, StrKey } from '@stellar/stellar-base';
import { createHash } from 'node:crypto';
import { claimType, contractDigest, fromHex, networkId, randomClaimId, sha256, toHex } from '../src/index.js';
import { expectClaimError } from './fixtures.js';

describe('sha256', () => {
  it('matches the known digest of the empty string and "abc"', () => {
    expect(toHex(sha256(''))).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(toHex(sha256('abc'))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
  it('hashes strings as UTF-8 and bytes as-is', () => {
    expect(toHex(sha256('zażółć'))).toBe(createHash('sha256').update('zażółć', 'utf8').digest('hex'));
    const bytes = Uint8Array.from([0, 1, 2, 255]);
    expect(toHex(sha256(bytes))).toBe(createHash('sha256').update(bytes).digest('hex'));
  });
  it('returns a plain 32-byte Uint8Array', () => {
    const out = sha256('x');
    expect(out.length).toBe(32);
    expect(Object.getPrototypeOf(out)).toBe(Uint8Array.prototype);
  });
  it('rejects other input types', () => {
    expectClaimError(() => sha256(42 as never), 'InvalidInput');
  });
});

describe('claimType', () => {
  it('is SHA-256 of the name', () => {
    expect(claimType('marketplace.delivery.v1')).toEqual(sha256('marketplace.delivery.v1'));
  });
  it('rejects an empty or non-string name', () => {
    expectClaimError(() => claimType(''), 'InvalidInput');
    expectClaimError(() => claimType(1 as never), 'InvalidInput');
  });
});

describe('networkId', () => {
  it('is SHA-256 of the passphrase (known testnet value)', () => {
    expect(toHex(networkId(Networks.TESTNET))).toBe('cee0302d59844d32bdca915c8203dd44b33fbb7edc19051ea37abedf28ecd472');
  });
  it('rejects a non-string', () => {
    expectClaimError(() => networkId(undefined as never), 'InvalidInput');
  });
});

describe('contractDigest', () => {
  it('hashes 0x00000012 || 0x00000001 || contract hash', () => {
    const hash = createHash('sha256').update('digest-test').digest();
    const xdr = Buffer.concat([Buffer.from([0, 0, 0, 0x12, 0, 0, 0, 1]), hash]);
    expect(xdr).toHaveLength(40);
    const id = StrKey.encodeContract(hash);
    expect(toHex(contractDigest(id))).toBe(createHash('sha256').update(xdr).digest('hex'));
  });
  it('matches the known vector digest', () => {
    expect(toHex(contractDigest('CBWDWZ64DEYTQ4GUFIJAX73W4YSXWYC776N6N3L7M3OMHZNALI2A4I25'))).toBe(
      '8942a92d87fed72917e382d023f50e155473a669bb0fbed2a6a29444a0b69672',
    );
  });
  it('rejects an account strkey, a malformed strkey and non-strings', () => {
    expectClaimError(() => contractDigest('GB3KJPLFUYN5VL6R3GU3EGCGVCKFDSD7BEDX42HWG5BWFKB3KQGJJRMA'), 'InvalidInput');
    expectClaimError(() => contractDigest('C123'), 'InvalidInput');
    expectClaimError(() => contractDigest(5 as never), 'InvalidInput');
  });
});

describe('randomClaimId', () => {
  it('returns 32 bytes that differ between calls', () => {
    const a = randomClaimId();
    const b = randomClaimId();
    expect(a).toHaveLength(32);
    expect(toHex(a)).not.toBe(toHex(b));
  });
});

describe('toHex / fromHex', () => {
  it('round-trips and is lower-case', () => {
    const bytes = Uint8Array.from([0, 1, 15, 16, 171, 255]);
    expect(toHex(bytes)).toBe('00010f10abff');
    expect(fromHex('00010f10abff')).toEqual(bytes);
    expect(fromHex('00010F10ABFF')).toEqual(bytes);
  });
  it('handles empty input', () => {
    expect(toHex(new Uint8Array())).toBe('');
    expect(fromHex('')).toEqual(new Uint8Array());
  });
  it('rejects odd length, non-hex characters and non-strings', () => {
    expectClaimError(() => fromHex('abc'), 'InvalidInput');
    expectClaimError(() => fromHex('zz'), 'InvalidInput');
    expectClaimError(() => fromHex(1 as never), 'InvalidInput');
  });
});
