import { render, screen, fireEvent, act } from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { CreateEscrowModal } from '../CreateEscrowModal';

describe('CreateEscrowModal Component', () => {
  const mockOnSubmit = vi.fn();
  const mockOnClose = vi.fn();

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('renders nothing when isOpen is false', () => {
    const { container } = render(
      <CreateEscrowModal isOpen={false} onClose={mockOnClose} onSubmit={mockOnSubmit} isMockMode={true} />
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders the modal when isOpen is true', () => {
    render(
      <CreateEscrowModal isOpen={true} onClose={mockOnClose} onSubmit={mockOnSubmit} isMockMode={true} />
    );
    expect(screen.getByText(/Initialize New Escrow/i)).toBeInTheDocument();
    expect(screen.getByText(/Worker Public Key/i)).toBeInTheDocument();
    expect(screen.getByText(/Max Amount/i)).toBeInTheDocument();
    expect(screen.getByText(/Hourly Rate/i)).toBeInTheDocument();
  });

  it('calls onClose when cancel button is clicked', () => {
    render(
      <CreateEscrowModal isOpen={true} onClose={mockOnClose} onSubmit={mockOnSubmit} isMockMode={true} />
    );
    const cancelBtn = screen.getByRole('button', { name: /Cancel/i });
    fireEvent.click(cancelBtn);
    expect(mockOnClose).toHaveBeenCalledTimes(1);
  });

  it('shows an error for invalid Stellar addresses in live mode', () => {
    render(
      <CreateEscrowModal isOpen={true} onClose={mockOnClose} onSubmit={mockOnSubmit} isMockMode={false} />
    );
    
    const workerInput = screen.getByPlaceholderText('G...');
    fireEvent.change(workerInput, { target: { value: 'InvalidWorker123' } });

    // The invalid warning should appear since it does not match the G... or C... 56 char regex
    expect(screen.getByText(/Invalid Stellar address/i)).toBeInTheDocument();
  });

  it('calls onSubmit with correct parsed cents values on form submit', async () => {
    render(
      <CreateEscrowModal isOpen={true} onClose={mockOnClose} onSubmit={mockOnSubmit} isMockMode={true} />
    );
    
    const workerInput = screen.getByPlaceholderText('G...');
    const maxAmountInput = screen.getAllByRole('spinbutton')[0];
    const hourlyRateInput = screen.getAllByRole('spinbutton')[1];

    fireEvent.change(workerInput, { target: { value: 'WorkerAlpha' } });
    fireEvent.change(maxAmountInput, { target: { value: '250.50' } });
    fireEvent.change(hourlyRateInput, { target: { value: '15.25' } });

    const submitBtn = screen.getByRole('button', { name: /Create Escrow/i });
    
    // Use act to wait for the async onSubmit and state reset
    await act(async () => {
      fireEvent.click(submitBtn);
    });

    // 250.50 * 100 = 25050
    // 15.25 * 100 = 1525
    expect(mockOnSubmit).toHaveBeenCalledWith('WorkerAlpha', 25050, 1525);
  });
});
