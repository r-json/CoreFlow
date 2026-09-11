// @vitest-environment node
/**
 * Event decoding tests.
 *
 * The projection itself is covered in projection.test.ts; this file pins the
 * boundary where raw contract events become typed domain events. A decoding
 * mistake here is invisible downstream — a dropped field becomes a zero, and a
 * zero amount projects as a real payment of nothing.
 */
import { describe, it, expect } from 'vitest';
import { parseCoreFlowEvent, paymentIndexOf } from '../events';

const WORKER = 'G' + 'W'.repeat(55);
const TOKEN = 'C' + 'T'.repeat(55);
const MANAGER = 'G' + 'M'.repeat(55);

describe('parseCoreFlowEvent', () => {
  it('decodes escrow creation', () => {
    expect(parseCoreFlowEvent('escrow', 'created', [7, MANAGER, 28_600_000_000n])).toEqual({
      kind: 'created', escrowId: 7, manager: MANAGER, totalAmount: 28_600_000_000n,
    });
  });

  it('decodes a per-payment add with its full financial identity', () => {
    expect(
      parseCoreFlowEvent('payment', 'add', [
        7, 2, WORKER, TOKEN, 9_000_000_000n, 200_000_000n, 1000n, 2000n,
      ])
    ).toEqual({
      kind: 'payment_added', escrowId: 7, paymentIndex: 2,
      worker: WORKER, token: TOKEN,
      amountBaseUnits: 9_000_000_000n, rateBaseUnits: 200_000_000n,
      periodStart: 1000n, periodEnd: 2000n,
    });
  });

  it('decodes a per-payment settlement', () => {
    expect(
      parseCoreFlowEvent('payment', 'paid', [7, 1, WORKER, TOKEN, 9_600_000_000n, 32n])
    ).toEqual({
      kind: 'payment_paid', escrowId: 7, paymentIndex: 1,
      worker: WORKER, token: TOKEN, amountBaseUnits: 9_600_000_000n, hours: 32n,
    });
  });

  it('decodes hours, approvals, cancellation, rotation and the aggregate finalize', () => {
    expect(parseCoreFlowEvent('hours', 'submit', [7, 0, 40n])).toEqual({
      kind: 'hours', escrowId: 7, paymentIndex: 0, hours: 40n,
    });
    expect(parseCoreFlowEvent('approve', 'manager', 7)).toEqual({
      kind: 'manager_approved', escrowId: 7,
    });
    expect(parseCoreFlowEvent('approve', 'finance', 7)).toEqual({
      kind: 'finance_approved', escrowId: 7,
    });
    expect(parseCoreFlowEvent('payment', 'cancel', [7, 2])).toEqual({
      kind: 'payment_cancelled', escrowId: 7, paymentIndex: 2,
    });
    expect(parseCoreFlowEvent('escrow', 'cancel', 7)).toEqual({
      kind: 'cancelled', escrowId: 7,
    });
    expect(parseCoreFlowEvent('oracle', 'rotate', [7, 3])).toEqual({
      kind: 'oracle_rotated', escrowId: 7, rotations: 3,
    });
    expect(parseCoreFlowEvent('payment', 'final', [7, 28_600_000_000n, 3])).toEqual({
      kind: 'finalized', escrowId: 7, totalAmount: 28_600_000_000n, count: 3,
    });
  });

  it('returns null for unrelated events rather than throwing', () => {
    // A future contract version emitting something new must not halt ingestion.
    expect(parseCoreFlowEvent('something', 'else', [1])).toBeNull();
    expect(parseCoreFlowEvent('escrow', 'unknown', 1)).toBeNull();
  });

  it('keeps money as bigint, never Number', () => {
    // Above 2^53-1 a Number cast silently rounds, which for a ledger means a
    // wrong amount recorded as fact.
    const huge = 9_007_199_254_740_993n; // 2^53 + 1
    const ev = parseCoreFlowEvent('payment', 'paid', [1, 0, WORKER, TOKEN, huge, 1n]);
    expect(ev).toMatchObject({ amountBaseUnits: huge });
    expect(typeof (ev as any).amountBaseUnits).toBe('bigint');
  });

  it('accepts an amount delivered as a decimal string', () => {
    // scValToNative yields bigint, but a replayed stored payload is JSON strings.
    const ev = parseCoreFlowEvent('payment', 'paid', [1, 0, WORKER, TOKEN, '10000000000', '40']);
    expect(ev).toMatchObject({ amountBaseUnits: 10_000_000_000n, hours: 40n });
  });

  it('identifies which events refer to a payment slot', () => {
    const add = parseCoreFlowEvent('payment', 'add', [7, 2, WORKER, TOKEN, 1n, 1n, 0n, 1n])!;
    const approval = parseCoreFlowEvent('approve', 'manager', 7)!;
    expect(paymentIndexOf(add)).toBe(2);
    expect(paymentIndexOf(approval)).toBeNull();
  });

  it('treats a scalar value as a one-element tuple', () => {
    expect(parseCoreFlowEvent('escrow', 'cancel', 9)).toEqual({ kind: 'cancelled', escrowId: 9 });
  });
});
