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
      totalPayrollProcessedUsdc: 5000,
      activeEmployeesCount: 3,
    };

    render(<DashboardStats stats={mockStats} />);

    // Check labels
    expect(screen.getByText(/Total Payroll Processed/i)).toBeInTheDocument();
    expect(screen.getByText(/Pending Approvals/i)).toBeInTheDocument();
    expect(screen.getByText(/Active Employees/i)).toBeInTheDocument();
    expect(screen.getByText(/Completed Payouts/i)).toBeInTheDocument();

    // Check values
    expect(screen.getByText('$5,000 USDC')).toBeInTheDocument();
    expect(screen.getAllByText('4').length).toBe(2);
    expect(screen.getByText('3')).toBeInTheDocument();
  });

  it('renders zero values correctly', () => {
    const zeroStats = {
      total: 0,
      pending: 0,
      approved: 0,
      released: 0,
      totalPayrollProcessedUsdc: 0,
      activeEmployeesCount: 0,
    };

    render(<DashboardStats stats={zeroStats} />);

    expect(screen.getByText('$0 USDC')).toBeInTheDocument();
  });
});
