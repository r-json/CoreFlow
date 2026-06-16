import { useState, useEffect, useCallback, useMemo } from 'react';
import { EscrowData } from '@/components/EscrowCard';
import { Transaction } from '@/components/TransactionFeed';
import { CoreFlowClient } from '@/lib/contracts';
import { STELLAR_CONFIG } from '@/lib/config';

interface UseDashboardProps {
  isAuthenticated: boolean;
  walletAddress: string;
}

export function useDashboard({ isAuthenticated, walletAddress }: UseDashboardProps = { isAuthenticated: false, walletAddress: '' }) {
  const [escrows, setEscrows] = useState<EscrowData[]>([]);
  const [transactions, setTransactions] = useState<Transaction[]>([]);

  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [infoMessage, setInfoMessage] = useState<string | null>(null);

  // Modals state
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showHoursModal, setShowHoursModal] = useState(false);

  const client = useMemo(() => new CoreFlowClient(), []);
  const isContractConfigured = !!STELLAR_CONFIG.contract.id && STELLAR_CONFIG.contract.id !== '';
  const [isMockMode, setIsMockMode] = useState(!isContractConfigured);

  // Derive isConnected from isAuthenticated
  const isConnected = isAuthenticated;

  const loadInitialData = useCallback(async () => {
    // Default Mock Data
    const mockEscrows: EscrowData[] = [
      {
        id: 1,
        worker: 'GABC...XYZ123',
        amount: '4,200',
        currency: 'USDC',
        hoursLogged: '40',
        status: 'pending_manager',
        manager_approved: false,
        finance_approved: false,
        hours_verified: true,
        created_at: '2 hours ago',
        isMock: true,
      },
      {
        id: 2,
        worker: 'GDEF...ABC456',
        amount: '3,500',
        currency: 'USDC',
        hoursLogged: '35',
        status: 'pending_finance',
        manager_approved: true,
        finance_approved: false,
        hours_verified: true,
        created_at: '5 hours ago',
        transaction_hash: '1a2b3c4d...',
        isMock: true,
      },
      {
        id: 3,
        worker: 'GHIJ...DEF789',
        amount: '2,100',
        currency: 'USDC',
        hoursLogged: '21',
        status: 'paid',
        manager_approved: true,
        finance_approved: true,
        hours_verified: true,
        created_at: '1 day ago',
        transaction_hash: 'xyz789abc...',
        isMock: true,
      },
    ];

    const mockTransactions: Transaction[] = [
      {
        id: '1',
        type: 'approval',
        escrowId: 2,
        hash: 'a1b2c3d4e5f6g7h8i9j0',
        status: 'success',
        timestamp: '2 min ago',
        details: 'Manager approved escrow',
      },
      {
        id: '2',
        type: 'submission',
        escrowId: 1,
        hash: 'x9y8z7w6v5u4t3s2r1q0',
        status: 'success',
        timestamp: '15 min ago',
        details: 'Hours proof submitted',
      },
      {
        id: '3',
        type: 'payment',
        escrowId: 3,
        hash: 'p1o2n3m4l5k6j7i8h9g0',
        status: 'success',
        timestamp: '1 day ago',
        details: 'Payment finalized',
      },
    ];

    setTransactions(mockTransactions);

    if (isContractConfigured && !isMockMode) {
      setIsLoading(true);
      try {
        const res = await fetch('/api/escrows');
        if (!res.ok) throw new Error('Failed to fetch from indexer');
        
        const data = await res.json();
        
        if (data.escrows && data.escrows.length > 0) {
          setEscrows(data.escrows);
          setInfoMessage('Loaded indexed escrow records from backend database');
        } else {
          setEscrows(mockEscrows);
          setInfoMessage('No on-chain escrows found in database. Showing mock demo data.');
        }
      } catch (err) {
        console.error('Failed to load live escrows, using mock fallback:', err);
        setEscrows(mockEscrows);
      } finally {
        setIsLoading(false);
      }
    } else {
      setEscrows(mockEscrows);
      if (isContractConfigured) {
        setInfoMessage('Mock Demo Mode active. Showing mock demo data.');
      } else {
        setInfoMessage('Using offline mock demo data. Set contract environment variables to enable live integration.');
      }
    }
  }, [isMockMode, isContractConfigured]);

  useEffect(() => {
    loadInitialData();
  }, [loadInitialData]);


  const handleToggleMode = (useMock: boolean) => {
    setIsMockMode(useMock);
    setError(null);
    if (useMock) {
      setInfoMessage('Switched to Mock Demo Mode. State changes will be local-only.');
    } else {
      setInfoMessage('Switched to Live On-Chain Mode. Interactions will require Freighter wallet.');
    }
  };

  const updateCumulativeStats = (amountUsdc: number) => {
    const traditionalFeePercent = 0.055;
    const coreFlowFeeUsd = 0.001;
    const savedUsd = (amountUsdc * traditionalFeePercent) - coreFlowFeeUsd;

    const stored = localStorage.getItem('coreflow_impact_stats');
    if (stored) {
      try {
        const stats = JSON.parse(stored);
        const newStats = {
          totalPaidUsd: stats.totalPaidUsd + amountUsdc,
          totalSavedUsd: stats.totalSavedUsd + savedUsd,
          totalWorkersPaid: stats.totalWorkersPaid + 1,
        };
        localStorage.setItem('coreflow_impact_stats', JSON.stringify(newStats));
        window.dispatchEvent(new Event('coreflow_stats_updated'));
      } catch (e) {
        console.error('Failed to update stats in storage', e);
      }
    }
  };

  const handleManagerApprove = async (escrowId: number) => {
    setIsLoading(true);
    setError(null);
    try {
      const isMock = escrows.find((e) => e.id === escrowId)?.isMock || isMockMode;
      if (isContractConfigured && !isMock) {
        const result = await client.submitManagerApprove(escrowId);

        // Sync to backend DB - non-blocking
        try {
          await fetch(`/api/escrows/${escrowId}/status`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ managerApproved: true, status: 'pending_finance' }),
          });
        } catch (e) {
          console.error('Off-chain sync failed:', e);
        }

        setTransactions((prev) => [
          {
            id: Date.now().toString(),
            type: 'approval',
            escrowId,
            hash: result.transactionHash,
            status: 'success',
            timestamp: 'now',
            details: 'Manager approved escrow',
          },
          ...prev,
        ]);
        await loadInitialData();
      } else {
        await new Promise(resolve => setTimeout(resolve, 1200));
        setEscrows((prev) =>
          prev.map((e) =>
            e.id === escrowId
              ? { ...e, manager_approved: true, status: 'pending_finance' }
              : e
          )
        );
        setTransactions((prev) => [
          {
            id: Date.now().toString(),
            type: 'approval',
            escrowId,
            hash: '0x' + Math.random().toString(16).slice(2, 18),
            status: 'success',
            timestamp: 'now',
            details: 'Manager approved escrow (Mock)',
          },
          ...prev,
        ]);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Approval failed');
    } finally {
      setIsLoading(false);
    }
  };

  const handleFinanceApprove = async (escrowId: number) => {
    setIsLoading(true);
    setError(null);
    try {
      const isMock = escrows.find((e) => e.id === escrowId)?.isMock || isMockMode;
      if (isContractConfigured && !isMock) {
        const result = await client.submitFinanceApprove(escrowId);

        // Sync to backend DB - non-blocking
        try {
          await fetch(`/api/escrows/${escrowId}/status`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ financeApproved: true, status: 'ready' }),
          });
        } catch (e) {
          console.error('Off-chain sync failed:', e);
        }

        setTransactions((prev) => [
          {
            id: Date.now().toString(),
            type: 'approval',
            escrowId,
            hash: result.transactionHash,
            status: 'success',
            timestamp: 'now',
            details: 'Finance approved escrow',
          },
          ...prev,
        ]);
        await loadInitialData();
      } else {
        await new Promise(resolve => setTimeout(resolve, 1200));
        setEscrows((prev) =>
          prev.map((e) =>
            e.id === escrowId
              ? { ...e, finance_approved: true, status: 'ready' }
              : e
          )
        );
        setTransactions((prev) => [
          {
            id: Date.now().toString(),
            type: 'approval',
            escrowId,
            hash: '0x' + Math.random().toString(16).slice(2, 18),
            status: 'success',
            timestamp: 'now',
            details: 'Finance approved escrow (Mock)',
          },
          ...prev,
        ]);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Approval failed');
    } finally {
      setIsLoading(false);
    }
  };

  const handleFinalize = async (escrowId: number) => {
    setIsLoading(true);
    setError(null);
    try {
      const targetEscrow = escrows.find(e => e.id === escrowId);
      const amountVal = targetEscrow ? parseFloat(targetEscrow.amount.replace(/,/g, '')) : 0;
      const isMock = targetEscrow?.isMock || isMockMode;

      if (isContractConfigured && !isMock) {
        const result = await client.submitFinalizePayment(escrowId);

        // Sync to backend DB - non-blocking
        try {
          await fetch(`/api/escrows/${escrowId}/status`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ status: 'paid' }),
          });
        } catch (e) {
          console.error('Off-chain sync failed:', e);
        }

        setTransactions((prev) => [
          {
            id: Date.now().toString(),
            type: 'payment',
            escrowId,
            hash: result.transactionHash,
            status: 'success',
            timestamp: 'now',
            details: 'Payment finalized & released to worker',
          },
          ...prev,
        ]);
        updateCumulativeStats(amountVal);
        await loadInitialData();
      } else {
        await new Promise(resolve => setTimeout(resolve, 1500));
        setEscrows((prev) =>
          prev.map((e) =>
            e.id === escrowId
              ? { ...e, status: 'paid' }
              : e
          )
        );
        setTransactions((prev) => [
          {
            id: Date.now().toString(),
            type: 'payment',
            escrowId,
            hash: '0x' + Math.random().toString(16).slice(2, 18),
            status: 'success',
            timestamp: 'now',
            details: 'Payment finalized (Mock)',
          },
          ...prev,
        ]);
        updateCumulativeStats(amountVal);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Release failed');
    } finally {
      setIsLoading(false);
    }
  };

  const handleCancelEscrow = async (escrowId: number) => {
    setIsLoading(true);
    setError(null);
    try {
      const isMock = escrows.find((e) => e.id === escrowId)?.isMock || isMockMode;
      if (isContractConfigured && !isMock) {
        const result = await client.submitCancelEscrow(escrowId);

        // Sync to backend DB - non-blocking
        try {
          await fetch(`/api/escrows/${escrowId}/status`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ status: 'cancelled' }),
          });
        } catch (e) {
          console.error('Off-chain sync failed:', e);
        }

        setTransactions((prev) => [
          {
            id: Date.now().toString(),
            type: 'cancellation',
            escrowId,
            hash: result.transactionHash,
            status: 'success',
            timestamp: 'now',
            details: 'Escrow cancelled',
          },
          ...prev,
        ]);
        await loadInitialData();
      } else {
        await new Promise(resolve => setTimeout(resolve, 1000));
        setEscrows((prev) =>
          prev.map((e) =>
            e.id === escrowId
              ? { ...e, status: 'cancelled' }
              : e
          )
        );
        setTransactions((prev) => [
          {
            id: Date.now().toString(),
            type: 'cancellation',
            escrowId,
            hash: '0x' + Math.random().toString(16).slice(2, 18),
            status: 'success',
            timestamp: 'now',
            details: 'Escrow cancelled (Mock)',
          },
          ...prev,
        ]);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Cancellation failed');
    } finally {
      setIsLoading(false);
    }
  };

  const handleCreateEscrow = async (workerPubKey: string, amountCents: number, rateCents: number) => {
    if (!isConnected) {
      setError('Please connect Freighter wallet first');
      return;
    }

    setIsLoading(true);
    setError(null);
    setShowCreateModal(false);

    try {
      if (!workerPubKey) throw new Error('Worker address is required');

      if (isContractConfigured && !isMockMode) {
        // Validate worker address for live on-chain
        const isStellarAddr = /^[GC][A-Z2-7]{55}$/.test(workerPubKey);
        if (!isStellarAddr) {
          throw new Error(
            `Unsupported address type: "${workerPubKey}". In live on-chain mode, the worker address must be a valid 56-character Stellar public key (starting with 'G') or Contract ID (starting with 'C').`
          );
        }

        // The settlement token (USDC SAC) must be configured for on-chain
        // custody — the contract pulls funds from the manager on creation.
        const tokenAddress = STELLAR_CONFIG.token.id;
        if (!tokenAddress) {
          throw new Error(
            'Settlement token not configured. Set NEXT_PUBLIC_STELLAR_TOKEN_ID to the USDC Stellar Asset Contract address for on-chain custody.'
          );
        }

        const payload = [
          {
            worker: workerPubKey,
            amount: BigInt(amountCents),
            start_date: Math.floor(Date.now() / 1000),
            end_date: Math.floor(Date.now() / 1000) + 86400 * 7,
            rate_per_hour: BigInt(rateCents),
          }
        ];

        // Fetch the oracle's public key so the escrow only accepts hours
        // proofs signed by our attestation service.
        const pubkeyRes = await fetch('/api/oracle/pubkey');
        if (!pubkeyRes.ok) {
          throw new Error('Oracle is not configured; cannot create a verifiable escrow.');
        }
        const { pubkey: oraclePubkey } = await pubkeyRes.json();
        const txResult = await client.submitInitializeEscrow(walletAddress, walletAddress, tokenAddress, oraclePubkey, payload);
        
        // Sync to backend DB - non-blocking
        try {
          await fetch('/api/escrows', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              onChainId: txResult.returnValue || 0,
              workerPubKey,
              amountCents,
              rateCents,
              tokenAddress,
            }),
          });
        } catch (e) {
          console.error('Off-chain sync failed:', e);
        }

        setTransactions((prev) => [
          {
            id: Date.now().toString(),
            type: 'submission',
            escrowId: txResult.returnValue || 0,
            hash: txResult.transactionHash,
            status: 'success',
            timestamp: 'now',
            details: 'Escrow initialized on-chain',
          },
          ...prev,
        ]);
        await loadInitialData();
      } else {
        // Mock creation
        await new Promise(resolve => setTimeout(resolve, 1000));
        const newId = escrows.length + 1;
        const newEsc: EscrowData = {
          id: newId,
          worker: workerPubKey.length >= 10 ? workerPubKey.slice(0, 6) + '...' + workerPubKey.slice(-4) : workerPubKey,
          amount: (amountCents / 100).toLocaleString(),
          currency: 'USDC',
          hoursLogged: '0',
          status: 'pending_hours',
          manager_approved: false,
          finance_approved: false,
          hours_verified: false,
          created_at: 'now',
          isMock: true,
        };

        setEscrows(prev => [newEsc, ...prev]);
        setTransactions(prev => [
          {
            id: Date.now().toString(),
            type: 'submission',
            escrowId: newId,
            hash: '0x' + Math.random().toString(16).slice(2, 18),
            status: 'success',
            timestamp: 'now',
            details: 'Escrow created (Mock)',
          },
          ...prev,
        ]);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create escrow');
    } finally {
      setIsLoading(false);
    }
  };

  const handleSubmitHours = async (hoursEscrowId: number, hoursPaymentId: number, hoursValue: string) => {
    setIsLoading(true);
    setError(null);
    setShowHoursModal(false);

    try {
      const isMock = escrows.find((e) => e.id === hoursEscrowId)?.isMock || isMockMode;
      if (isContractConfigured && !isMock) {
        const hours = parseInt(hoursValue);

        // 1) Read the on-chain expected nonce (replay protection).
        const nonce = await client.getNonce(hoursEscrowId);

        // 2) Ask the oracle to attest these hours at that nonce.
        const attestRes = await fetch('/api/oracle/attest', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            onChainId: hoursEscrowId,
            paymentId: hoursPaymentId,
            hoursLogged: hours,
            nonce,
          }),
        });
        if (!attestRes.ok) {
          const err = await attestRes.json().catch(() => ({}));
          throw new Error(err.error || 'Oracle attestation failed');
        }
        const { signature } = await attestRes.json();

        // 3) Submit the oracle-signed proof on-chain.
        const result = await client.submitHoursProof(
          hoursEscrowId,
          hoursPaymentId,
          hours,
          nonce,
          signature
        );

        // Sync to backend DB - non-blocking
        try {
          await fetch('/api/hours', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              onChainId: hoursEscrowId,
              hoursLogged: parseInt(hoursValue),
              paymentId: hoursPaymentId,
              txHash: result.transactionHash,
            }),
          });
        } catch (e) {
          console.error('Off-chain sync failed:', e);
        }

        setTransactions((prev) => [
          {
            id: Date.now().toString(),
            type: 'submission',
            escrowId: hoursEscrowId,
            hash: result.transactionHash,
            status: 'success',
            timestamp: 'now',
            details: `Logged ${hoursValue} hours`,
          },
          ...prev,
        ]);
        await loadInitialData();
      } else {
        // Mock hours log
        await new Promise(resolve => setTimeout(resolve, 1000));
        setEscrows(prev =>
          prev.map(esc => {
            if (esc.id === hoursEscrowId) {
              const amountFloat = parseFloat(esc.amount.replace(/,/g, ''));
              const newAmountVal = (amountFloat * (parseInt(hoursValue) / 40)).toFixed(0);
              return {
                ...esc,
                hoursLogged: hoursValue,
                hours_verified: true,
                status: 'pending_manager',
                amount: parseFloat(newAmountVal).toLocaleString(),
              };
            }
            return esc;
          })
        );
        setTransactions(prev => [
          {
            id: Date.now().toString(),
            type: 'submission',
            escrowId: hoursEscrowId,
            hash: '0x' + Math.random().toString(16).slice(2, 18),
            status: 'success',
            timestamp: 'now',
            details: `Hours submitted (Mock): ${hoursValue} hours`,
          },
          ...prev,
        ]);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to submit hours');
    } finally {
      setIsLoading(false);
    }
  };

  const stats = {
    total: escrows.length,
    pending: escrows.filter((e) => e.status !== 'paid' && e.status !== 'cancelled').length,
    approved: escrows.filter((e) => e.status === 'ready').length,
    released: escrows.filter((e) => e.status === 'paid').length,
  };

  return {
    state: {
      escrows,
      transactions,
      isConnected,
      walletAddress,
      isLoading,
      error,
      infoMessage,
      showCreateModal,
      showHoursModal,
      isMockMode,
      isContractConfigured,
      stats,
      client,
    },
    actions: {
      setShowCreateModal,
      setShowHoursModal,
      handleToggleMode,
      loadInitialData,
      handleManagerApprove,
      handleFinanceApprove,
      handleFinalize,
      handleCancelEscrow,
      handleCreateEscrow,
      handleSubmitHours,
      setError,
      setIsLoading,
      setTransactions,
      setEscrows,
    }
  };
}
