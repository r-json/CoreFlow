// @vitest-environment node
/**
 * Money conversion tests.
 *
 * These pin the fix for the cents/stroops defect: the dashboard collected
 * dollars, multiplied by 100, and sent the result on-chain as if base units
 * were cents. Stellar uses 7 decimals, so every amount settled 100,000× short
 * while the UI reported success.
 */
import { describe, it, expect } from 'vitest';
import {
  parseAmount,
  formatAmount,
  formatAmountWithSeparators,
  sumAmounts,
  hoursForAmount,
  MoneyParseError,
  SAC_DECIMALS,
} from '../money';

describe('parseAmount', () => {
  it('converts dollars to Stellar base units, not to cents', () => {
    // The regression itself: $250.50 must fund 2_505_000_000 base units.
    // The old code produced 25_050 — 0.0025050 USDC.
    expect(parseAmount('250.50', SAC_DECIMALS)).toBe(2_505_000_000n);
    expect(parseAmount('250.50', SAC_DECIMALS)).not.toBe(25_050n);
  });

  it('handles whole numbers and the smallest representable unit', () => {
    expect(parseAmount('1', SAC_DECIMALS)).toBe(10_000_000n);
    expect(parseAmount('0.0000001', SAC_DECIMALS)).toBe(1n);
    expect(parseAmount('0', SAC_DECIMALS)).toBe(0n);
  });

  it('is exact where floating point is not', () => {
    // parseFloat('0.1') * 10 ** 7 is 1000000.0000000001 in IEEE-754.
    expect(parseAmount('0.1', SAC_DECIMALS)).toBe(1_000_000n);
    expect(parseAmount('8420.29', SAC_DECIMALS)).toBe(84_202_900_000n);
    expect(parseAmount('0.07', SAC_DECIMALS)).toBe(700_000n);
  });

  it('carries amounts far past the old 32-bit ceiling', () => {
    // The previous Int column overflowed at $21,474,836.47.
    expect(parseAmount('100000000.00', SAC_DECIMALS)).toBe(1_000_000_000_000_000n);
  });

  it('accepts thousands separators from pasted input', () => {
    expect(parseAmount('8,420.00', SAC_DECIMALS)).toBe(84_200_000_000n);
  });

  it('rejects more precision than the asset can represent', () => {
    // Rounding here would quietly change a payroll figure.
    expect(() => parseAmount('1.00000001', SAC_DECIMALS)).toThrow(MoneyParseError);
  });

  it.each(['', 'abc', '1.2.3', '1e5', '$250', '  '])(
    'rejects malformed input %j',
    (bad) => {
      expect(() => parseAmount(bad, SAC_DECIMALS)).toThrow(MoneyParseError);
    }
  );

  it('round-trips through formatAmount', () => {
    for (const v of ['0.50', '1.00', '250.50', '8420.29', '999999.99']) {
      expect(formatAmount(parseAmount(v, SAC_DECIMALS), SAC_DECIMALS)).toBe(v);
    }
  });
});

describe('formatAmount', () => {
  it('renders base units exactly', () => {
    expect(formatAmount(2_505_000_000n, SAC_DECIMALS)).toBe('250.50');
    expect(formatAmount(1n, SAC_DECIMALS)).toBe('0.0000001');
    expect(formatAmount(0n, SAC_DECIMALS)).toBe('0.00');
  });

  it('groups thousands', () => {
    expect(formatAmountWithSeparators(84_202_900_000n, SAC_DECIMALS)).toBe('8,420.29');
    expect(formatAmountWithSeparators(10_000_000_000_000n, SAC_DECIMALS)).toBe('1,000,000.00');
  });

  it('handles negatives', () => {
    expect(formatAmount(-2_505_000_000n, SAC_DECIMALS)).toBe('-250.50');
  });
});

describe('sumAmounts', () => {
  it('sums a batch without overflow', () => {
    const batch = Array.from({ length: 12 }, () => parseAmount('8420.29', SAC_DECIMALS));
    expect(sumAmounts(batch)).toBe(84_202_900_000n * 12n);
  });

  it('returns zero for an empty batch', () => {
    expect(sumAmounts([])).toBe(0n);
  });
});

describe('hoursForAmount', () => {
  it('returns whole hours when the amount divides evenly', () => {
    // 40 h at $25/h = $1000
    const rate = parseAmount('25', SAC_DECIMALS);
    expect(hoursForAmount(parseAmount('1000', SAC_DECIMALS), rate)).toBe(40n);
  });

  it('returns null when no whole number of hours reaches the amount', () => {
    // The contract would reject this with AmountHoursMismatch (#17), funding
    // custody into an escrow that can never settle.
    const rate = parseAmount('25', SAC_DECIMALS);
    expect(hoursForAmount(parseAmount('1000.01', SAC_DECIMALS), rate)).toBeNull();
  });

  it('returns null for a non-positive rate', () => {
    expect(hoursForAmount(1000n, 0n)).toBeNull();
  });
});
