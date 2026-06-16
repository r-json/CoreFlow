import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { DashboardStats } from '../dashboard/DashboardStats';

describe('DashboardStats Component', () => {
  it('renders all four stats with the correct values', () => {
    const mockStats = {
      total: 10,
      pending: 4,
      approved: 2,
      released: 4,
    };

    render(<DashboardStats stats={mockStats} />);

    // Check labels
    expect(screen.getByText(/Total Escrows/i)).toBeInTheDocument();
    expect(screen.getByText(/Active Escrows/i)).toBeInTheDocument();
    expect(screen.getByText(/Ready to Release/i)).toBeInTheDocument();
    expect(screen.getByText(/Completed Payouts/i)).toBeInTheDocument();

    // Check values
    expect(screen.getByText('10')).toBeInTheDocument();
    expect(screen.getAllByText('4').length).toBe(2); // pending and released
    expect(screen.getByText('2')).toBeInTheDocument();
  });

  it('renders zero values correctly', () => {
    const zeroStats = {
      total: 0,
      pending: 0,
      approved: 0,
      released: 0,
    };

    render(<DashboardStats stats={zeroStats} />);

    // Since there are 4 cards, there should be 4 zeroes
    const zeroes = screen.getAllByText('0');
    expect(zeroes.length).toBe(4);
  });
});
