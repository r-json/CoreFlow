import { renderHook, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useDashboard } from '../useDashboard';
import { CoreFlowClient } from '@/lib/contracts';

// Mock the Stellar Client
vi.mock('@/lib/contracts', () => {
  const MockClient = vi.fn();
  MockClient.prototype.getEscrow = vi.fn();
  MockClient.prototype.submitManagerApprove = vi.fn();
  MockClient.prototype.submitFinanceApprove = vi.fn();
  MockClient.prototype.submitFinalizePayment = vi.fn();
  MockClient.prototype.submitCancelEscrow = vi.fn();
  MockClient.prototype.submitInitializeEscrow = vi.fn();
  MockClient.prototype.submitHoursProof = vi.fn();

  return {
    CoreFlowClient: MockClient,
  };
});

// Mock Stellar Config
vi.mock('@/lib/config', () => {
  return {
    STELLAR_CONFIG: {
      contract: { id: '' },
      addresses: { readAddress: '', signingAddress: null }
    }
  };
});

describe('useDashboard Hook', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('initializes with default state', () => {
    const { result } = renderHook(() => useDashboard());
    const { state } = result.current;

    expect(state.isConnected).toBe(false);
    expect(state.walletAddress).toBe('');
    expect(state.isLoading).toBe(false);
    expect(state.error).toBeNull();
    expect(state.showCreateModal).toBe(false);
    expect(state.showHoursModal).toBe(false);
  });

  it('derives isConnected from the isAuthenticated prop', () => {
    const { result } = renderHook(() =>
      useDashboard({ isAuthenticated: true, walletAddress: 'GABC123' })
    );
    expect(result.current.state.isConnected).toBe(true);
    expect(result.current.state.walletAddress).toBe('GABC123');
  });

  it('handles mock toggle mode correctly', async () => {
    const { result } = renderHook(() => useDashboard());

    act(() => {
      // Toggle to Mock mode
      result.current.actions.handleToggleMode(true);
    });

    expect(result.current.state.isMockMode).toBe(true);
    expect(result.current.state.infoMessage).toContain('Mock Demo Mode');

    // Wait for the mock escrows to load
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });

    // Mock data loads 3 escrows by default
    expect(result.current.state.escrows.length).toBe(3);
  });
});
