'use client';

/**
 * useAuth — CoreFlow authentication hook.
 *
 * Manages the full wallet-based sign-in lifecycle:
 *  1. On mount: calls GET /api/auth/me to restore an existing session
 *  2. signIn(): challenge → Freighter sign → verify → session cookie
 *  3. signOut(): logout endpoint → cookie cleared → local state reset
 *
 * Usage:
 *   const { isAuthenticated, walletAddress, role, signIn, signOut, isLoading } = useAuth();
 */

import { useState, useEffect, useCallback } from 'react';
import { STELLAR_CONFIG } from '@/lib/config';

export type UserRole = 'manager' | 'finance' | 'worker' | 'viewer';

interface AuthState {
  isAuthenticated: boolean;
  walletAddress: string;
  role: UserRole;
  isLoading: boolean;
  error: string | null;
}

const INITIAL_STATE: AuthState = {
  isAuthenticated: false,
  walletAddress: '',
  role: 'viewer',
  isLoading: true, // true on mount while we check the session
  error: null,
};

export function useAuth() {
  const [state, setState] = useState<AuthState>(INITIAL_STATE);

  /**
   * Restores the session from the HttpOnly cookie on page load.
   * Calls /api/auth/me which validates the JWT + DB revocation check.
   */
  const restoreSession = useCallback(async () => {
    setState((s) => ({ ...s, isLoading: true, error: null }));
    try {
      const res = await fetch('/api/auth/me');
      if (res.ok) {
        const data = await res.json();
        setState({
          isAuthenticated: true,
          walletAddress: data.user.walletAddress,
          role: data.user.role as UserRole,
          isLoading: false,
          error: null,
        });
        // Sync wallet address into the global Stellar config
        STELLAR_CONFIG.addresses.readAddress = data.user.walletAddress;
        STELLAR_CONFIG.addresses.signingAddress = data.user.walletAddress;
      } else {
        setState({ ...INITIAL_STATE, isLoading: false });
      }
    } catch {
      setState({ ...INITIAL_STATE, isLoading: false });
    }
  }, []);

  useEffect(() => {
    restoreSession();
  }, [restoreSession]);

  /**
   * Full sign-in flow:
   *  1. Request a challenge nonce from the server
   *  2. Sign the challenge with Freighter
   *  3. Send the signature to the server for verification
   *
   * On success, the server sets the HttpOnly session cookie and returns the user.
   * On any failure, sets an error message (never throws to the UI).
   */
  const signIn = useCallback(async () => {
    setState((s) => ({ ...s, isLoading: true, error: null }));

    try {
      // Step 1: Connect Freighter and get the wallet address
      const walletAddress = await STELLAR_CONFIG.freighter.connect();
      if (!walletAddress) throw new Error('Could not get wallet address from Freighter');

      // Step 2: Get a challenge from the server
      const challengeRes = await fetch('/api/auth/challenge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ walletAddress }),
      });

      if (!challengeRes.ok) {
        const err = await challengeRes.json();
        throw new Error(err.error || 'Failed to get auth challenge');
      }

      const { challenge } = await challengeRes.json();

      // Step 3: Sign the challenge string with Freighter
      const signature = await STELLAR_CONFIG.freighter.signMessage(challenge);
      if (!signature) throw new Error('Freighter did not return a signature');

      // Step 4: Verify the signature on the server
      const verifyRes = await fetch('/api/auth/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ walletAddress, signature }),
      });

      if (!verifyRes.ok) {
        const err = await verifyRes.json();
        throw new Error(err.error || 'Signature verification failed');
      }

      const data = await verifyRes.json();

      setState({
        isAuthenticated: true,
        walletAddress: data.user.walletAddress,
        role: data.user.role as UserRole,
        isLoading: false,
        error: null,
      });

      STELLAR_CONFIG.addresses.readAddress = data.user.walletAddress;
      STELLAR_CONFIG.addresses.signingAddress = data.user.walletAddress;
    } catch (err) {
      setState((s) => ({
        ...s,
        isLoading: false,
        error: err instanceof Error ? err.message : 'Sign-in failed',
      }));
    }
  }, []);

  /**
   * Signs out the user: clears the server session and local state.
   */
  const signOut = useCallback(async () => {
    setState((s) => ({ ...s, isLoading: true, error: null }));

    try {
      await fetch('/api/auth/logout', { method: 'POST' });
    } catch {
      // Best-effort — clear local state regardless
    }

    STELLAR_CONFIG.addresses.readAddress = '';
    STELLAR_CONFIG.addresses.signingAddress = null;

    setState({ ...INITIAL_STATE, isLoading: false });
  }, []);

  return {
    ...state,
    signIn,
    signOut,
  };
}
