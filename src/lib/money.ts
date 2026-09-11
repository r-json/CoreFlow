/**
 * Exact monetary conversion for CoreFlow.
 *
 * ── The bug this module exists to prevent ────────────────────────────────────
 * The dashboard used to collect dollars, multiply by 100 to get "cents", and
 * pass that integer straight to the contract as the on-chain amount. Stellar
 * assets carry SEVEN decimals, not two, so `$250.50` funded 25050 base units —
 * 0.0025050 USDC — while the UI went on rendering "$250.50". A 100,000×
 * under-settlement, reported to the user as success.
 *
 * Two rules follow, and both are enforced here rather than left to call sites:
 *
 *  1. Money never touches a JS `number`. `parseFloat('0.1') * 100` is 10.000000
 *     000000002, and `Math.floor` of a value like that silently loses a unit.
 *     Amounts are parsed from their decimal STRING into `bigint` base units.
 *  2. Base units are only meaningful alongside the asset's decimals. Every
 *     conversion takes them explicitly; there is no ambient default to get
 *     wrong.
 *
 * ── Decimals on Stellar ──────────────────────────────────────────────────────
 * Every Stellar Asset Contract (a classic asset wrapped as a Soroban token —
 * native XLM and issued USDC alike) uses 7 decimals. A non-classic Soroban
 * token may declare anything, so `CoreFlowClient.getTokenDecimals()` reads the
 * value from the contract; SAC_DECIMALS is the correct constant only for SACs.
 */

/** Decimals for any Stellar Asset Contract (classic asset), including native XLM. */
export const SAC_DECIMALS = 7;

/** Thrown for input that cannot be converted exactly. */
export class MoneyParseError extends Error {}

const DECIMAL_RE = /^-?\d+(\.\d+)?$/;

/**
 * Parses a decimal string into integer base units.
 *
 *   parseAmount('250.50', 7) === 2_505_000_000n
 *   parseAmount('0.0000001', 7) === 1n
 *
 * Rejects more fractional digits than the asset can represent instead of
 * rounding: silently truncating a payroll amount is a financial error, not a
 * formatting preference, and the caller must decide what to do about it.
 */
export function parseAmount(input: string, decimals: number): bigint {
  const raw = input.trim().replace(/,/g, '');
  if (!DECIMAL_RE.test(raw)) {
    throw new MoneyParseError(
      `"${input}" is not a valid amount. Use digits and at most one decimal point.`
    );
  }

  const negative = raw.startsWith('-');
  const [whole, fraction = ''] = (negative ? raw.slice(1) : raw).split('.');

  if (fraction.length > decimals) {
    throw new MoneyParseError(
      `"${input}" has ${fraction.length} decimal places but this asset supports ${decimals}.`
    );
  }

  const padded = fraction.padEnd(decimals, '0');
  const units = BigInt(whole + padded);
  return negative ? -units : units;
}

/**
 * Renders base units as a decimal string. Exact — no rounding, no `toFixed`.
 *
 *   formatAmount(2_505_000_000n, 7) === '250.50'
 */
export function formatAmount(
  units: bigint,
  decimals: number,
  opts: { trimTrailingZeros?: boolean; minFractionDigits?: number } = {}
): string {
  const { trimTrailingZeros = true, minFractionDigits = 2 } = opts;

  const negative = units < 0n;
  const abs = negative ? -units : units;
  const divisor = 10n ** BigInt(decimals);

  const whole = (abs / divisor).toString();
  let fraction = (abs % divisor).toString().padStart(decimals, '0');

  if (trimTrailingZeros) {
    fraction = fraction.replace(/0+$/, '');
  }
  while (fraction.length < minFractionDigits) fraction += '0';

  const body = fraction.length > 0 ? `${whole}.${fraction}` : whole;
  return negative ? `-${body}` : body;
}

/** Renders base units with thousands separators, e.g. `8,420.00`. */
export function formatAmountWithSeparators(
  units: bigint,
  decimals: number,
  opts?: Parameters<typeof formatAmount>[2]
): string {
  const s = formatAmount(units, decimals, opts);
  const negative = s.startsWith('-');
  const [whole, fraction] = (negative ? s.slice(1) : s).split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const body = fraction ? `${grouped}.${fraction}` : grouped;
  return negative ? `-${body}` : body;
}

/**
 * Sum base units without overflow. `bigint` has no ceiling, which is the point:
 * the previous schema stored money in a 32-bit column that overflowed at
 * $21,474,836.47 — a hard payroll ceiling nobody would have discovered until a
 * batch silently wrapped.
 */
export function sumAmounts(amounts: readonly bigint[]): bigint {
  return amounts.reduce((a, b) => a + b, 0n);
}

/**
 * Whole hours implied by an amount at a given rate, or null when the amount is
 * not a whole multiple.
 *
 * The contract enforces `hours × rate_per_hour == amount` and refuses anything
 * else, so a batch that fails this check would fund custody into an escrow that
 * can never settle. Checking here turns that into a form error.
 */
export function hoursForAmount(amount: bigint, ratePerHour: bigint): bigint | null {
  if (ratePerHour <= 0n) return null;
  return amount % ratePerHour === 0n ? amount / ratePerHour : null;
}
