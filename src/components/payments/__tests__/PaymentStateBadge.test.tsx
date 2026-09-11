import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { PaymentState } from '@prisma/client';
import { PaymentStateBadge, PaymentTransactionRef } from '../PaymentStateBadge';

describe('PaymentStateBadge', () => {
  it('renders a distinct label for every state, never "Processing"', () => {
    for (const state of Object.values(PaymentState)) {
      const { unmount } = render(<PaymentStateBadge state={state} />);
      expect(screen.queryByText(/^Processing$/i)).toBeNull();
      unmount();
    }
  });

  it.each([
    [PaymentState.AWAITING_ORACLE, 'Awaiting oracle verification'],
    [PaymentState.AWAITING_MANAGER, 'Awaiting manager approval'],
    [PaymentState.AWAITING_FINANCE, 'Awaiting finance approval'],
    [PaymentState.READY_TO_SETTLE, 'Ready to settle'],
    [PaymentState.SUBMITTING, 'Submitting to Stellar'],
    [PaymentState.CONFIRMING, 'Confirming on Stellar'],
    [PaymentState.PAID, 'Paid'],
    [PaymentState.SETTLEMENT_FAILED, 'Settlement failed'],
    [PaymentState.RECONCILIATION_REQUIRED, 'Reconciliation required'],
  ])('labels %s as "%s"', (state, label) => {
    render(<PaymentStateBadge state={state} />);
    expect(screen.getByText(label)).toBeInTheDocument();
  });

  it('does not present CONFIRMING as paid', () => {
    render(<PaymentStateBadge state={PaymentState.CONFIRMING} withDescription />);
    expect(screen.getByText(/not yet paid/i)).toBeInTheDocument();
  });

  it('surfaces an unrecognized state instead of normalising it', () => {
    // Rendering an unknown value as something benign would hide a data problem.
    render(<PaymentStateBadge state="TOTALLY_NOT_A_STATE" />);
    expect(screen.getByText(/Unknown state/i)).toBeInTheDocument();
  });
});

describe('PaymentTransactionRef', () => {
  const HASH = 'c3847d85680bdeadbeefc0ffee1234567890abcdef1234567890abcdef123456';

  it('shows a reference for a settled payment', () => {
    render(<PaymentTransactionRef state={PaymentState.PAID} hash={HASH} href="https://x" />);
    expect(screen.getByRole('link')).toHaveAttribute('href', 'https://x');
  });

  it('renders nothing when there is no hash', () => {
    const { container } = render(<PaymentTransactionRef state={PaymentState.PAID} hash={null} />);
    expect(container.firstChild).toBeNull();
  });

  it.each([PaymentState.DRAFT, PaymentState.AWAITING_ORACLE, PaymentState.SUBMISSION_FAILED])(
    'renders nothing for %s even if a hash is supplied',
    (state) => {
      // A link here would imply something reached the chain when nothing did.
      const { container } = render(<PaymentTransactionRef state={state} hash={HASH} />);
      expect(container.firstChild).toBeNull();
    }
  );
});
