import { render, screen, fireEvent, act } from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { SubmitHoursModal } from '../SubmitHoursModal';

describe('SubmitHoursModal Component', () => {
  const mockOnSubmit = vi.fn();
  const mockOnClose = vi.fn();

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('renders nothing when isOpen is false', () => {
    const { container } = render(
      <SubmitHoursModal isOpen={false} onClose={mockOnClose} onSubmit={mockOnSubmit} />
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders the modal when isOpen is true', () => {
    render(
      <SubmitHoursModal isOpen={true} onClose={mockOnClose} onSubmit={mockOnSubmit} />
    );
    expect(screen.getByText(/Submit Oracle Work Proof/i)).toBeInTheDocument();
    expect(screen.getByText(/Escrow ID/i)).toBeInTheDocument();
    expect(screen.getByText(/Schedule index/i)).toBeInTheDocument();
    expect(screen.getByText(/Hours Logged/i)).toBeInTheDocument();
  });

  it('calls onClose when cancel button is clicked', () => {
    render(
      <SubmitHoursModal isOpen={true} onClose={mockOnClose} onSubmit={mockOnSubmit} />
    );
    const cancelBtn = screen.getByRole('button', { name: /Cancel/i });
    fireEvent.click(cancelBtn);
    expect(mockOnClose).toHaveBeenCalledTimes(1);
  });

  it('calls onSubmit with correctly parsed form values', async () => {
    render(
      <SubmitHoursModal isOpen={true} onClose={mockOnClose} onSubmit={mockOnSubmit} />
    );
    
    // There are 3 spinbuttons: Escrow ID, Schedule Index, Hours Logged
    const inputs = screen.getAllByRole('spinbutton');
    const escrowIdInput = inputs[0];
    const paymentIdInput = inputs[1];
    const hoursInput = inputs[2];

    fireEvent.change(escrowIdInput, { target: { value: '42' } });
    fireEvent.change(paymentIdInput, { target: { value: '1' } });
    fireEvent.change(hoursInput, { target: { value: '160' } });

    const submitBtn = screen.getByRole('button', { name: /Submit Hours/i });
    
    await act(async () => {
      fireEvent.click(submitBtn);
    });

    expect(mockOnSubmit).toHaveBeenCalledWith(42, 1, '160');
  });
});
