import { fromHex } from '@coreflow/sdk';

/** Strip whitespace, an optional 0x prefix and line breaks; lower-case the rest. */
export function cleanHex(input: string): string {
  const compact = input.replace(/\s+/g, '');
  return (compact.startsWith('0x') || compact.startsWith('0X') ? compact.slice(2) : compact).toLowerCase();
}

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

/**
 * Parse hex typed or pasted by a person. Whitespace and a 0x prefix are
 * tolerated so a value copied from a terminal or a log can be pasted as is.
 */
export function parseHex(input: string, label: string, expectedBytes?: number): Parsed<Uint8Array> {
  const hex = cleanHex(input);
  if (hex.length === 0) return { ok: false, error: `${label} is empty.` };
  if (!/^[0-9a-f]*$/.test(hex))
    return { ok: false, error: `${label} contains characters that are not hex (0-9, a-f).` };
  if (hex.length % 2 !== 0) return { ok: false, error: `${label} has an odd number of hex digits (${hex.length}).` };
  const bytes = fromHex(hex);
  if (expectedBytes !== undefined && bytes.length !== expectedBytes) {
    return {
      ok: false,
      error: `${label} must be ${expectedBytes} bytes (${expectedBytes * 2} hex digits); this is ${bytes.length} bytes.`,
    };
  }
  return { ok: true, value: bytes };
}

/** Parse a decimal u64 typed by a person. */
export function parseU64(input: string, label: string): Parsed<bigint> {
  const text = input.trim();
  if (!/^(0|[1-9][0-9]*)$/.test(text)) return { ok: false, error: `${label} must be a whole number of 0 or more.` };
  const value = BigInt(text);
  if (value > 0xffffffffffffffffn) return { ok: false, error: `${label} does not fit in a u64.` };
  return { ok: true, value };
}

/** Hex split into groups of `groupBytes` bytes, for reading long values. */
export function groupHex(hex: string, groupBytes = 4): string {
  const size = groupBytes * 2;
  const parts: string[] = [];
  for (let i = 0; i < hex.length; i += size) parts.push(hex.slice(i, i + size));
  return parts.join(' ');
}

/** Current Unix time in whole seconds. */
export function nowSeconds(): bigint {
  return BigInt(Math.floor(Date.now() / 1000));
}

const MAX_DATE_SECONDS = 8_640_000_000_000n; // the largest instant a JavaScript Date can hold

/** ISO-8601 (UTC) for Unix seconds, or `undefined` when a Date cannot represent it. */
export function unixToIso(seconds: bigint): string | undefined {
  if (seconds > MAX_DATE_SECONDS) return undefined;
  return new Date(Number(seconds) * 1000).toISOString().replace('.000Z', 'Z');
}

/** "in 15 min", "3 h ago", "now". */
export function relativeTime(seconds: bigint, now: bigint): string {
  const delta = seconds - now;
  const abs = delta < 0n ? -delta : delta;
  if (abs < 5n) return 'now';
  const units: [bigint, string][] = [
    [31_536_000n, 'y'],
    [86_400n, 'd'],
    [3_600n, 'h'],
    [60n, 'min'],
    [1n, 's'],
  ];
  const [size, unit] = units.find(([s]) => abs >= s) ?? [1n, 's'];
  const amount = `${abs / size} ${unit}`;
  return delta < 0n ? `${amount} ago` : `in ${amount}`;
}

/** Shorten a long identifier for tight spaces: `CBZZ4A…L7H6K`. */
export function middleTruncate(text: string, keep = 6): string {
  return text.length <= keep * 2 + 1 ? text : `${text.slice(0, keep)}…${text.slice(-keep)}`;
}
