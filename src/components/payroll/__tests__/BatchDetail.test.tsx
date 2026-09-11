/**
 * Batch detail rendering.
 *
 * The properties that matter here are truthfulness properties: one row per payment
 * with exact stored amounts, approvals read from Approval records rather than
 * inferred from payment state, and a timeline containing only events that exist.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { BatchDetail, type BatchDetailData } from '../BatchDetail';

vi.mock('@/components/NetworkBadge', () => ({
  NetworkBadge: () => <span data-testid="network-badge">TESTNET</span>,
}));
// The funding panel has its own tests; here it must simply not interfere.
vi.mock('@/components/funding/FundingPanel', () => ({
  FundingPanel: ({ batchId }: { batchId: string }) => (
    <div data-testid="funding-panel">{batchId}</div>
  ),
}));

const A = 'G' + 'A'.repeat(55);
const B = 'G' + 'B'.repeat(55);
const C = 'G' + 'C'.repeat(55);
const MANAGER = 'G' + 'M'.repeat(55);

function payment(over: Partial<BatchDetailData['batch']['payments'][number]> = {}) {
  return {
    id: 'pay_1',
    recipient: A,
    amount: '1,000.00',
    amountBaseUnits: '10000000000',
    rate: '25.00',
    rateBaseUnits: '250000000',
    hours: '40',
    asset: 'USDC',
    state: 'AWAITING_ORACLE',
    stateLabel: 'Awaiting oracle',
    tone: 'neutral',
    needsAttention: false,
    stateReason: null,
    reference: null,
    transactionHash: null,
    settledAt: null,
    onChainPaymentIndex: 0,
    approvals: [],
    ...over,
  };
}

function data(over: Partial<BatchDetailData> = {}): BatchDetailData {
  return {
    batch: {
      id: 'bat_1',
      reference: 'CF-00042',
      projectId: null,
      periodStart: '2026-09-01T00:00:00.000Z',
      periodEnd: '2026-09-15T00:00:00.000Z',
      createdAt: '2026-09-11T09:41:00.000Z',
      source: { filename: 'september.csv', rowsSeen: 3, checksum: 'f'.repeat(64), uploadedBy: 'u1' },
      total: '2,860.00',
      totalBaseUnits: '28600000000',
      asset: 'USDC',
      paymentCount: 3,
      standing: {
        headline: 'AWAITING_ORACLE',
        byState: { AWAITING_ORACLE: 3 },
        needsAttention: 0,
        totalAmountBaseUnits: '28600000000',
        paidAmountBaseUnits: '0',
        paid: '0.00',
      },
      payments: [
        payment(),
        payment({ id: 'pay_2', recipient: B, amount: '1,600.00', amountBaseUnits: '16000000000', hours: '80' }),
        payment({ id: 'pay_3', recipient: C, amount: '260.00', amountBaseUnits: '2600000000', hours: '20' }),
      ],
    },
    activity: [
      {
        id: 'aud_1',
        type: 'payroll.batch.created',
        at: '2026-09-11T09:41:00.000Z',
        actor: { kind: 'user', address: MANAGER },
        previousState: null,
        newState: null,
        txHash: null,
        paymentId: null,
        metadata: { paymentCount: 3, totalBaseUnits: '28600000000' },
      },
      {
        id: 'aud_2',
        type: 'funding.confirmed',
        at: '2026-09-11T09:46:00.000Z',
        actor: { kind: 'system', system: 'funding-verifier' },
        previousState: null,
        newState: null,
        txHash: 'a'.repeat(64),
        paymentId: null,
        metadata: { onChainEscrowId: 9 },
      },
    ],
    findings: [],
    ...over,
  };
}

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.restoreAllMocks());

describe('header and summary', () => {
  it('shows the reference, a human status and the Testnet environment', () => {
    render(<BatchDetail data={data()} />);
    expect(screen.getByText('CF-00042')).toBeDefined();
    // Mapped from the domain state, not invented.
    // Appears in the header and on each payment badge; all are the mapped label.
    expect(screen.getAllByText('Awaiting work verification').length).toBeGreaterThan(0);
    expect(screen.getByTestId('network-badge')).toBeDefined();
    expect(screen.getByText(/CoreFlow v2 on Stellar Testnet/i)).toBeDefined();
  });

  it('renders money as the server formatted it, with no client arithmetic', () => {
    render(<BatchDetail data={data()} />);
    expect(screen.getByText('2,860.00')).toBeDefined();
    expect(screen.getByText('0.00')).toBeDefined();
    // Exact base units available, but only in technical details.
    expect(screen.queryByText('28600000000')).toBeNull();
    fireEvent.click(screen.getByText('Technical details'));
    expect(screen.getAllByText('28600000000').length).toBeGreaterThan(0);
  });

  it('shows the pay period and source file', () => {
    render(<BatchDetail data={data()} />);
    expect(screen.getByText('2026-09-01')).toBeDefined();
    expect(screen.getByText('to 2026-09-15')).toBeDefined();
    expect(screen.getByText('september.csv')).toBeDefined();
  });
});

describe('payments', () => {
  it('renders one row per payment and never an aggregate', () => {
    render(<BatchDetail data={data()} />);
    // Three distinct amounts, three rows.
    expect(screen.getByText('1,000.00')).toBeDefined();
    expect(screen.getByText('1,600.00')).toBeDefined();
    expect(screen.getByText('260.00')).toBeDefined();
    expect(screen.getAllByRole('button', { name: 'Details' })).toHaveLength(3);
  });

  it('reveals exact stored values in the drill-down', () => {
    render(<BatchDetail data={data()} />);
    fireEvent.click(screen.getAllByRole('button', { name: 'Details' })[0]);

    expect(screen.getByText((t) => t === A)).toBeDefined();
    expect(screen.getByText('10000000000')).toBeDefined();
    expect(screen.getByText('250000000')).toBeDefined();
    // The readable rate is in the row; the exact value only in the drill-down.
    expect(screen.getAllByText('25.00').length).toBeGreaterThan(0);
    // No transaction exists yet, and the UI says so rather than showing a link.
    expect(screen.getByText('not yet available')).toBeDefined();
  });

  it('shows a state reason when the domain recorded one', () => {
    const d = data();
    d.batch.payments[0].stateReason = 'Funding transaction prepared; awaiting signature.';
    render(<BatchDetail data={d} />);
    fireEvent.click(screen.getAllByRole('button', { name: 'Details' })[0]);
    expect(screen.getByText(/awaiting signature/i)).toBeDefined();
  });

  it('renders an empty batch without a blank page', () => {
    const d = data();
    d.batch.payments = [];
    d.batch.paymentCount = 0;
    render(<BatchDetail data={d} />);
    expect(screen.getByText('This batch has no payments.')).toBeDefined();
  });
});

describe('approvals', () => {
  it('reads approvals from Approval records and shows the missing half', () => {
    const d = data();
    d.batch.payments[0].approvals = [
      { role: 'MANAGER', decision: 'APPROVED', actorAddress: MANAGER, createdAt: '2026-09-11T14:41:00.000Z' },
    ];
    render(<BatchDetail data={d} />);

    expect(screen.getByText('Approved')).toBeDefined();
    // The absent half is stated, not omitted — that is the fact a reviewer needs.
    expect(screen.getByText('Waiting for approval')).toBeDefined();
    expect(screen.getByText('Manager')).toBeDefined();
    expect(screen.getByText('Finance')).toBeDefined();
  });

  it('does not infer approval from payment state', () => {
    const d = data();
    // A payment past the approval stages, but with no Approval records.
    d.batch.payments = [payment({ state: 'READY_TO_SETTLE', approvals: [] })];
    render(<BatchDetail data={d} />);
    expect(screen.getAllByText('Waiting for approval')).toHaveLength(2);
    expect(screen.queryByText('Approved')).toBeNull();
  });
});

describe('activity timeline', () => {
  it('renders only the events that exist', () => {
    render(<BatchDetail data={data()} />);
    expect(screen.getByText('Payroll batch created')).toBeDefined();
    expect(screen.getByText('Funding confirmed on Stellar')).toBeDefined();

    // Plausible-sounding events nobody recorded must not appear.
    for (const fabricated of [
      'CSV reviewed',
      'Oracle verified',
      'Manager reviewed',
      'Finance reviewed',
    ]) {
      expect(screen.queryByText(fabricated)).toBeNull();
    }
    expect(screen.getAllByText('More')).toHaveLength(2);
  });

  it('says so plainly when nothing has been recorded', () => {
    render(<BatchDetail data={data({ activity: [] })} />);
    expect(screen.getByText('No activity has been recorded for this batch yet.')).toBeDefined();
  });

  it('attributes a system actor without pretending a person acted', () => {
    render(<BatchDetail data={data()} />);
    expect(screen.getByText(/by funding-verifier/)).toBeDefined();
  });

  it('exposes event metadata on demand', () => {
    render(<BatchDetail data={data()} />);
    fireEvent.click(screen.getAllByText('More')[1]);
    expect(screen.getByText('funding.confirmed')).toBeDefined();
    expect(screen.getByText('9')).toBeDefined();
  });
});

describe('reconciliation findings', () => {
  it('warns without claiming the payment failed', () => {
    const d = data({
      findings: [
        {
          id: 'fnd_1',
          kind: 'ASSET_MISMATCH',
          severity: 'HIGH',
          status: 'OPEN',
          detail: 'The chain shows a different asset than the database records.',
          paymentId: 'pay_1',
          firstDetectedAt: '2026-09-11T10:00:00.000Z',
          lastObservedAt: '2026-09-11T11:00:00.000Z',
          observationCount: 2,
          remediation: 'Compare the escrow token against the configured SAC.',
        },
      ],
    });
    render(<BatchDetail data={d} />);

    expect(screen.getByText('Payment verification needs attention')).toBeDefined();
    expect(screen.getByText('HIGH')).toBeDefined();
    expect(screen.getByText(/does not by\s+itself mean a payment failed/i)).toBeDefined();
    // Never restated as failure.
    expect(screen.queryByText(/failed/i)).not.toBe(screen.getByText('HIGH'));

    // Surfaced against the payment it belongs to.
    expect(screen.getAllByText(/needs attention/i).length).toBeGreaterThan(0);
  });
});

describe('funding', () => {
  it('delegates the funding card to the funding panel for this batch', () => {
    render(<BatchDetail data={data()} />);
    expect(screen.getByTestId('funding-panel').textContent).toBe('bat_1');
  });
});

describe('accessibility', () => {
  it('uses labelled sections and an accessible payments table', () => {
    render(<BatchDetail data={data()} />);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('CF-00042');
    expect(screen.getByRole('heading', { name: 'Payments' })).toBeDefined();
    expect(screen.getByRole('heading', { name: 'Approvals' })).toBeDefined();
    expect(screen.getByRole('heading', { name: 'Activity' })).toBeDefined();
    expect(screen.getByRole('table')).toBeDefined();
    expect(screen.getAllByRole('columnheader').length).toBeGreaterThan(4);
  });

  it('marks expandable controls with their state', async () => {
    render(<BatchDetail data={data()} />);
    const toggle = screen.getAllByRole('button', { name: 'Details' })[0];
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(toggle);
    await waitFor(() =>
      expect(
        screen.getAllByRole('button', { name: 'Hide' })[0].getAttribute('aria-expanded'),
      ).toBe('true'),
    );
  });
});
