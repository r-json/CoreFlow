import { ClaimError } from './errors.js';

/** Largest value of an unsigned 64-bit integer. */
export const U64_MAX = 0xffffffffffffffffn;

/** Lower-case hex encoding. */
export function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

/** Decode hex (either case). Throws `ClaimError('InvalidInput')` on odd length or non-hex characters. */
export function fromHex(hex: string): Uint8Array {
  if (typeof hex !== 'string' || hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) {
    throw new ClaimError('InvalidInput', 'fromHex: expected an even-length hex string');
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** @internal Throw `InvalidInput` unless `value` is a `Uint8Array` of exactly `length` bytes. */
export function assertBytes(value: unknown, length: number, name: string): asserts value is Uint8Array {
  if (!(value instanceof Uint8Array) || value.length !== length) {
    throw new ClaimError('InvalidInput', `${name}: expected a Uint8Array of ${length} bytes`);
  }
}

/** @internal Throw `InvalidInput` unless `value` is a bigint in 0..2^64-1. */
export function assertU64(value: unknown, name: string): asserts value is bigint {
  if (typeof value !== 'bigint' || value < 0n || value > U64_MAX) {
    throw new ClaimError('InvalidInput', `${name}: expected a bigint in 0..2^64-1`);
  }
}

/** @internal True when every byte is zero. */
export function isZero(bytes: Uint8Array): boolean {
  return bytes.every((b) => b === 0);
}
