import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { PaymentState } from '@prisma/client';
import { BatchPaymentsTable } from '../BatchPaymentsTable';

vi.mock('@/lib/explorer', () => ({ txUrl: (h: string) => `https://explorer/tx/${h}` }));

const HASH = 'c3847d85680bdeadbeefc0ffee1234567890abcdef1234567890abcdef123456';

const THREE = [
  { id: 'p0', index: 0, recipient: 'G' + '1'.repeat(55), amount: '1,000.00', hours: '40', state: PaymentState.PAID, txHash: HASH },
  { id: 'p1', index: 1, recipient: 'G' + '2'.repeat(55), amount: '960.00', hours: '32', state: PaymentState.AWAITING_FINANCE, txHash: null },
  { id: 'p2', index: 2, recipient: 'G' + '3'.repeat(55), amount: '900.00', hours: '45', state: PaymentState.SETTLEMENT_FAILED, txHash: HASH },
];

describe('BatchPaymentsTable', () => {
  it('renders one row per payment, not one row per batch', () => {
    // The defect this replaces: twelve contractors rendered as a single payment.
    render(<BatchPaymentsTable reference="CF-00042" payments={THREE} total="2,860.00" />);
    expect(screen.getAllByRole('row')).toHaveLength(4); // header + 3
    expect(screen.getByText('3 payments')).toBeInTheDocument();
  });

  it('shows each payment’s own amount', () => {
    render(<BatchPaymentsTable payments={THREE} />);
    for (const amount of ['1,000.00', '960.00', '900.00']) {
      expect(screen.getByText(amount)).toBeInTheDocument();
    }
  });

  it('shows each payment’s own state, not one batch state', () => {
    render(<BatchPaymentsTable payments={THREE} />);
    expect(screen.getByText('Paid')).toBeInTheDocument();
    expect(screen.getByText('Awaiting finance approval')).toBeInTheDocument();
    expect(screen.getByText('Settlement failed')).toBeInTheDocument();
  });

  it('links a transaction only where one exists', () => {
    render(<BatchPaymentsTable payments={THREE} />);
    // PAID and SETTLEMENT_FAILED have hashes; AWAITING_FINANCE does not.
    expect(screen.getAllByRole('link')).toHaveLength(2);
  });

  it('renders an empty state rather than an empty table', () => {
    render(<BatchPaymentsTable payments={[]} />);
    expect(screen.getByText(/No payments in this batch/i)).toBeInTheDocument();
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('gives the table an accessible caption', () => {
    render(<BatchPaymentsTable reference="CF-00042" payments={THREE} />);
    expect(screen.getByRole('table')).toHaveAccessibleName(/Payments in batch CF-00042/i);
  });
});
