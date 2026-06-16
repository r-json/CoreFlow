/**
 * Tests for the useAuth hook.
 */

import { renderHook, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useAuth } from '../useAuth';

// ── Mock fetch globally ──────────────────────────────────────────────────────
const mockFetch = vi.fn();
global.fetch = mockFetch;

// ── Mock STELLAR_CONFIG ──────────────────────────────────────────────────────
vi.mock('@/lib/config', () => ({
  STELLAR_CONFIG: {
    addresses: { readAddress: '', signingAddress: null },
    freighter: {
      connect: vi.fn(),
      signMessage: vi.fn(),
    },
  },
}));

import { STELLAR_CONFIG } from '@/lib/config';

describe('useAuth', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('starts unauthenticated then finishes loading after 401 from /me', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 401 });

    const { result } = renderHook(() => useAuth());

    // Initially loading
    expect(result.current.isLoading).toBe(true);

    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(result.current.isAuthenticated).toBe(false);
    expect(result.current.isLoading).toBe(false);
    expect(result.current.walletAddress).toBe('');
  });

  it('restores session from /me on mount if cookie is valid', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ user: { walletAddress: 'GTEST123', role: 'manager' } }),
    });

    const { result } = renderHook(() => useAuth());

    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(result.current.isAuthenticated).toBe(true);
    expect(result.current.walletAddress).toBe('GTEST123');
    expect(result.current.role).toBe('manager');
  });

  it('signIn — calls challenge → Freighter sign → verify in sequence', async () => {
    // 1. /me → not authenticated
    mockFetch.mockResolvedValueOnce({ ok: false });
    // 2. /api/auth/challenge → challenge string
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ challenge: 'CoreFlow:auth:GTEST:nonce' }),
    });
    // 3. /api/auth/verify → success
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ user: { walletAddress: 'GTEST', role: 'viewer' } }),
    });

    vi.mocked(STELLAR_CONFIG.freighter.connect).mockResolvedValue('GTEST');
    vi.mocked(STELLAR_CONFIG.freighter.signMessage).mockResolvedValue('base64-signature');

    const { result } = renderHook(() => useAuth());
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });

    await act(async () => {
      await result.current.signIn();
    });

    expect(STELLAR_CONFIG.freighter.connect).toHaveBeenCalledOnce();
    expect(STELLAR_CONFIG.freighter.signMessage).toHaveBeenCalledWith('CoreFlow:auth:GTEST:nonce');
    expect(result.current.isAuthenticated).toBe(true);
    expect(result.current.role).toBe('viewer');
  });

  it('signIn — sets error if challenge request fails', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false }); // /me
    mockFetch.mockResolvedValueOnce({ ok: false, json: () => Promise.resolve({ error: 'Server error' }) });

    vi.mocked(STELLAR_CONFIG.freighter.connect).mockResolvedValue('GTEST');

    const { result } = renderHook(() => useAuth());
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });

    await act(async () => {
      await result.current.signIn();
    });

    expect(result.current.isAuthenticated).toBe(false);
    expect(result.current.error).toBeTruthy();
  });

  it('signOut — clears state and calls logout endpoint', async () => {
    // Start authenticated
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ user: { walletAddress: 'GTEST', role: 'manager' } }),
    });
    // Logout endpoint
    mockFetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ ok: true }) });

    const { result } = renderHook(() => useAuth());
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });

    expect(result.current.isAuthenticated).toBe(true);

    await act(async () => {
      await result.current.signOut();
    });

    expect(result.current.isAuthenticated).toBe(false);
    expect(result.current.walletAddress).toBe('');
    expect(mockFetch).toHaveBeenCalledWith('/api/auth/logout', expect.objectContaining({ method: 'POST' }));
  });
});
