import { render, screen, fireEvent, act } from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { CreateEscrowModal } from '../CreateEscrowModal';

const MANAGER = 'G' + 'A'.repeat(55);
const FINANCE = 'G' + 'B'.repeat(55);
const WORKER = 'G' + 'C'.repeat(55);

describe('CreateEscrowModal Component', () => {
  const mockOnSubmit = vi.fn();
  const mockOnClose = vi.fn();

  afterEach(() => {
    vi.clearAllMocks();
  });

  const renderModal = (props: Partial<React.ComponentProps<typeof CreateEscrowModal>> = {}) =>
    render(
      <CreateEscrowModal
        isOpen
        onClose={mockOnClose}
        onSubmit={mockOnSubmit}
        isMockMode={false}
        managerAddress={MANAGER}
        {...props}
      />
    );

  const fill = (label: RegExp, value: string) =>
    fireEvent.change(screen.getByLabelText(label), { target: { value } });

  it('renders nothing when isOpen is false', () => {
    const { container } = renderModal({ isOpen: false });
    expect(container.firstChild).toBeNull();
  });

  it('renders the modal when isOpen is true', () => {
    renderModal({ isMockMode: true });
    expect(screen.getByText(/Initialize New Escrow/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Worker Public Key/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Finance Approver/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Amount \(USDC\)/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Hourly Rate/i)).toBeInTheDocument();
  });

  it('calls onClose when cancel button is clicked', () => {
    renderModal({ isMockMode: true });
    fireEvent.click(screen.getByRole('button', { name: /Cancel/i }));
    expect(mockOnClose).toHaveBeenCalledTimes(1);
  });

  it('shows an error for invalid Stellar addresses in live mode', () => {
    renderModal();
    fill(/Worker Public Key/i, 'InvalidWorker123');
    expect(screen.getByText(/Invalid Stellar address/i)).toBeInTheDocument();
  });

  it('submits Stellar base units, not cents', async () => {
    // The regression this pins: 250.50 USDC is 2_505_000_000 base units on a
    // 7-decimal asset. The old modal emitted 25050 ("cents"), which the client
    // passed straight to the contract — funding 0.0025050 USDC.
    renderModal();
    fill(/Worker Public Key/i, WORKER);
    fill(/Finance Approver/i, FINANCE);
    // 250.50 at 8.35/h is exactly 30 hours, satisfying the contract's
    // hours x rate == amount invariant.
    fill(/Amount \(USDC\)/i, '250.50');
    fill(/Hourly Rate/i, '8.35');

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Create Escrow/i }));
    });

    expect(mockOnSubmit).toHaveBeenCalledWith(
      WORKER,
      FINANCE,
      2_505_000_000n,
      83_500_000n
    );
  });

  it('previews the hours the escrowed amount actually buys', () => {
    renderModal();
    fill(/Amount \(USDC\)/i, '1000');
    fill(/Hourly Rate/i, '25');
    // 1000 / 25 = 40 hours — the figure the contract will require the oracle
    // to attest to, since it enforces hours x rate == amount.
    expect(screen.getByText(/40 h @ 25\.00\/h/)).toBeInTheDocument();
  });

  it('blocks an amount that is not a whole number of hours', () => {
    // The contract rejects this with AmountHoursMismatch (#17), which would
    // otherwise fund custody into an escrow that can never settle.
    renderModal();
    fill(/Amount \(USDC\)/i, '1000.01');
    fill(/Hourly Rate/i, '25');

    expect(screen.getByText(/not a whole number of hours/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Create Escrow/i })).toBeDisabled();
  });

  it('blocks a finance approver equal to the manager', () => {
    // Separation of duties: the contract rejects it with SignersNotDistinct
    // (#15), and the old dashboard sent the manager as both signers every time.
    renderModal();
    fill(/Worker Public Key/i, WORKER);
    fill(/Finance Approver/i, MANAGER);

    expect(screen.getByText(/cannot be the manager/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Create Escrow/i })).toBeDisabled();
  });

  it('blocks a worker approving their own payment', () => {
    renderModal();
    fill(/Worker Public Key/i, WORKER);
    fill(/Finance Approver/i, WORKER);

    expect(screen.getByText(/cannot approve their own payment/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Create Escrow/i })).toBeDisabled();
  });

  it('rejects more precision than the asset can represent', () => {
    renderModal();
    fill(/Amount \(USDC\)/i, '1.00000001');
    expect(screen.getByText(/decimal places but this asset supports 7/i)).toBeInTheDocument();
  });
});
