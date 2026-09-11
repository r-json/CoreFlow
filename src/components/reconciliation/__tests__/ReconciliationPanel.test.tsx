import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { FindingSeverity, FindingStatus, RunStatus } from '@prisma/client';
import { ReconciliationPanel, type FindingView } from '../ReconciliationPanel';

const run = (over: Record<string, unknown> = {}) => ({
  id: 'r1', correlationId: 'rec_abc', status: RunStatus.COMPLETED,
  startedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
  completedAt: new Date().toISOString(),
  paymentsExamined: 146, agreed: 143, mismatched: 3, unreadable: 0,
  findingsOpened: 3, correctionsApplied: 0, errorMessage: null,
  ...over,
});

const finding = (over: Partial<FindingView> = {}): FindingView => ({
  id: 'f1', kind: 'DB_PAID_CHAIN_NOT', status: FindingStatus.OPEN,
  severity: FindingSeverity.CRITICAL,
  detail: 'db says paid, chain does not',
  remediation: 'Do not rely on the payment record. Verify on the explorer.',
  dbState: 'PAID', chainState: 'no confirmed settlement',
  escrowOnChainId: 7, paymentIndex: 0,
  transaction: { hash: 'abcdef1234567890', explorerUrl: 'https://explorer/tx/abcdef1234567890' },
  payment: {
    id: 'pay1', recipient: 'G' + 'W'.repeat(55), amount: '1,000.00',
    assetCode: 'USDC', state: 'PAID',
    batch: { id: 'b1', reference: 'CF-00042' },
  },
  detectedAt: new Date(Date.now() - 3 * 3_600_000).toISOString(),
  lastObservedAt: new Date().toISOString(),
  observationCount: 4,
  acknowledgedBy: null, resolvedBy: null, resolution: null,
  ...over,
});

const health = (over: Record<string, unknown> = {}) => ({
  lastRun: run(), openFindings: 3, criticalFindings: 1,
  oldestUnresolvedHours: 3, degraded: false,
  ...over,
});

describe('operational summary', () => {
  it('shows the last check and the counts an operator asks for', () => {
    render(<ReconciliationPanel health={health()} findings={[]} detailed />);
    expect(screen.getByText('146')).toBeInTheDocument();
    expect(screen.getByText('143')).toBeInTheDocument();
    expect(screen.getByText(/Last check/i)).toBeInTheDocument();
  });

  it('reports DEGRADED when reconciliation has never run', () => {
    render(
      <ReconciliationPanel
        health={health({ lastRun: null, degraded: true, degradedReason: 'Reconciliation has never run for this organization.', openFindings: 0, criticalFindings: 0 })}
        findings={[]}
      />
    );
    expect(screen.getByText(/never run/i)).toBeInTheDocument();
    // "No issues" must NOT read as all-clear when nothing was checked.
    expect(screen.getByText(/has not completed, so no payments were checked/i)).toBeInTheDocument();
    expect(screen.queryByText(/All payments verified/i)).toBeNull();
  });

  it('does not claim all-clear after a failed run', () => {
    render(
      <ReconciliationPanel
        health={health({
          lastRun: run({ status: RunStatus.FAILED, errorMessage: 'rpc timeout' }),
          degraded: true, degradedReason: 'The last reconciliation run failed: rpc timeout',
          openFindings: 0, criticalFindings: 0,
        })}
        findings={[]}
        detailed
      />
    );
    expect(screen.getByText(/last reconciliation run failed/i)).toBeInTheDocument();
    // Surfaced twice on purpose: in the status line a finance user reads, and in
    // the raw error block an operator needs.
    expect(screen.getAllByText(/rpc timeout/i).length).toBeGreaterThanOrEqual(2);
    expect(screen.queryByText(/All payments verified/i)).toBeNull();
  });

  it('says all-clear only when healthy with no critical findings', () => {
    render(
      <ReconciliationPanel
        health={health({ openFindings: 0, criticalFindings: 0 })}
        findings={[]}
      />
    );
    expect(screen.getByText(/All payments verified against Stellar/i)).toBeInTheDocument();
  });
});

describe('two audiences', () => {
  it('gives a finance user plain language, not infrastructure terms', () => {
    render(<ReconciliationPanel health={health()} findings={[finding()]} />);
    expect(screen.getByText(/could not be confirmed. Do not rely on it yet/i)).toBeInTheDocument();
    // Operator detail is withheld.
    expect(screen.queryByText('DB_PAID_CHAIN_NOT')).toBeNull();
    expect(screen.queryByText(/rec_abc/)).toBeNull();
  });

  it('gives an operator the kind, both states, the escrow slot and the transaction', () => {
    render(<ReconciliationPanel health={health()} findings={[finding()]} detailed />);
    expect(screen.getByText('DB_PAID_CHAIN_NOT')).toBeInTheDocument();
    expect(screen.getByText('no confirmed settlement')).toBeInTheDocument();
    expect(screen.getByText(/#7 · slot 0/)).toBeInTheDocument();
    expect(screen.getByRole('link')).toHaveAttribute('href', 'https://explorer/tx/abcdef1234567890');
    expect(screen.getByText(/rec_abc/)).toBeInTheDocument();
  });

  it('never reassures a finance user about an unverified payment', () => {
    // "Verification delayed" for a DB_PAID_CHAIN_NOT would be misleading.
    render(<ReconciliationPanel health={health()} findings={[finding()]} />);
    expect(screen.queryByText(/verification delayed/i)).toBeNull();
  });

  it('does use softer language for a genuine infrastructure delay', () => {
    render(
      <ReconciliationPanel
        health={health()}
        findings={[finding({ kind: 'CHAIN_UNREADABLE', severity: FindingSeverity.LOW })]}
      />
    );
    expect(screen.getByText(/verification delayed/i)).toBeInTheDocument();
  });
});

describe('findings', () => {
  it('always shows what to do', () => {
    render(<ReconciliationPanel health={health()} findings={[finding()]} />);
    expect(screen.getByText(/What to do:/i)).toBeInTheDocument();
    expect(screen.getByText(/Verify on the explorer/i)).toBeInTheDocument();
  });

  it('shows how long a finding has persisted', () => {
    render(<ReconciliationPanel health={health()} findings={[finding()]} detailed />);
    expect(screen.getByText(/still present after 4 checks/i)).toBeInTheDocument();
  });

  it('renders the payment identity so the issue is actionable', () => {
    render(<ReconciliationPanel health={health()} findings={[finding()]} />);
    expect(screen.getByText('CF-00042')).toBeInTheDocument();
    expect(screen.getByText(/1,000.00 USDC/)).toBeInTheDocument();
  });

  it('offers acknowledge and resolve only on unresolved findings', () => {
    const onResolve = vi.fn();
    const onAcknowledge = vi.fn();
    const { unmount } = render(
      <ReconciliationPanel
        health={health()} findings={[finding()]}
        onResolve={onResolve} onAcknowledge={onAcknowledge}
      />
    );
    expect(screen.getByRole('button', { name: /Acknowledge/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Resolve/i })).toBeInTheDocument();
    unmount();

    render(
      <ReconciliationPanel
        health={health()}
        findings={[finding({ status: FindingStatus.RESOLVED, resolution: 'Confirmed settled.', resolvedBy: 'GOPERATOR' })]}
        onResolve={onResolve} onAcknowledge={onAcknowledge}
      />
    );
    expect(screen.queryByRole('button', { name: /Acknowledge/i })).toBeNull();
    expect(screen.getByText(/Confirmed settled/i)).toBeInTheDocument();
  });

  it('does not hide a problem behind a generic banner', () => {
    render(<ReconciliationPanel health={health()} findings={[finding()]} detailed />);
    expect(screen.queryByText(/^Something went wrong$/i)).toBeNull();
    expect(screen.queryByText(/^An error occurred$/i)).toBeNull();
    expect(screen.getByText('CRITICAL')).toBeInTheDocument();
  });
});
