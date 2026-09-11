import { useState, useEffect, useCallback, useMemo } from 'react';
import { EscrowData } from '@/components/EscrowCard';
import { Transaction } from '@/components/TransactionFeed';
import { CoreFlowClient } from '@/lib/contracts';
import { STELLAR_CONFIG } from '@/lib/config';
import { SAC_DECIMALS, formatAmountWithSeparators } from '@/lib/money';

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
  const [selectedEscrowIdForHours, setSelectedEscrowIdForHours] = useState<number | null>(null);

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
        setInfoMessage('Mock Demo Mode active. State changes will be local-only.');
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

  /**
   * DB-Transaction Reconciliation / Error handling helper.
   * If a blockchain call fails, logs the error report and rolls back UI state.
   */
  const handleBlockchainError = async (escrowId: number, originalStatus: string, err: unknown) => {
    const errorMsg = err instanceof Error ? err.message : 'Blockchain transaction failed';
    console.error(`[Reconciliation] Blockchain transaction failed for Escrow #${escrowId}:`, err);

    // No DB rollback write.
    //
    // There is nothing to roll back: the client never advanced the stored state in
    // the first place. And "the submission threw" does not establish what the chain
    // did — an RPC timeout can accompany a transaction that landed. Reverting the
    // record here could mark a settled payment as unsettled, which is a false
    // statement about money. Reconciliation resolves it against chain state.

    // Report error for audit
    try {
      await fetch('/api/observability/report', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          eventType: 'BLOCKCHAIN_FAILURE',
          message: errorMsg,
          escrowId,
          timestamp: new Date().toISOString(),
        }),
      });
    } catch {
      // Best-effort
    }

    setError('Blockchain transaction failed. Please retry.');
  };

  const handleManagerApprove = async (escrowId: number) => {
    setIsLoading(true);
    setError(null);
    const targetEscrow = escrows.find((e) => e.id === escrowId);
    const originalStatus = targetEscrow?.status || 'pending_manager';

    try {
      const isMock = targetEscrow?.isMock || isMockMode;
      if (isContractConfigured && !isMock) {
        let result;
        try {
          result = await client.submitManagerApprove(escrowId);
        } catch (err) {
          await handleBlockchainError(escrowId, originalStatus, err);
          return;
        }

        // No off-chain status write here, deliberately.
        //
        // The transaction above was submitted; whether the CHAIN accepted it is a
        // separate question, answered by the indexer observing the contract's event
        // log. Writing the expected status from the client would assert an outcome
        // nobody has confirmed — the precise failure mode the payment state machine
        // exists to prevent. The dashboard refreshes below and advances when the
        // indexer catches up.

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
        await new Promise(resolve => setTimeout(resolve, 1000));
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
    const targetEscrow = escrows.find((e) => e.id === escrowId);
    const originalStatus = targetEscrow?.status || 'pending_finance';

    try {
      const isMock = targetEscrow?.isMock || isMockMode;
      if (isContractConfigured && !isMock) {
        let result;
        try {
          result = await client.submitFinanceApprove(escrowId);
        } catch (err) {
          await handleBlockchainError(escrowId, originalStatus, err);
          return;
        }

        // No off-chain status write here, deliberately.
        //
        // The transaction above was submitted; whether the CHAIN accepted it is a
        // separate question, answered by the indexer observing the contract's event
        // log. Writing the expected status from the client would assert an outcome
        // nobody has confirmed — the precise failure mode the payment state machine
        // exists to prevent. The dashboard refreshes below and advances when the
        // indexer catches up.

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
        await new Promise(resolve => setTimeout(resolve, 1000));
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
    const targetEscrow = escrows.find((e) => e.id === escrowId);
    const amountVal = targetEscrow ? parseFloat(targetEscrow.amount.replace(/,/g, '')) : 0;
    const originalStatus = targetEscrow?.status || 'ready';

    try {
      const isMock = targetEscrow?.isMock || isMockMode;

      if (isContractConfigured && !isMock) {
        let result;
        try {
          result = await client.submitFinalizePayment(escrowId);
        } catch (err) {
          await handleBlockchainError(escrowId, originalStatus, err);
          return;
        }

        // No off-chain status write here, deliberately.
        //
        // The transaction above was submitted; whether the CHAIN accepted it is a
        // separate question, answered by the indexer observing the contract's event
        // log. Writing the expected status from the client would assert an outcome
        // nobody has confirmed — the precise failure mode the payment state machine
        // exists to prevent. The dashboard refreshes below and advances when the
        // indexer catches up.

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
        const mockTxHash = '0x' + Math.random().toString(16).slice(2, 18) + 'abcdef1234567890';
        await new Promise(resolve => setTimeout(resolve, 1200));
        setEscrows((prev) =>
          prev.map((e) =>
            e.id === escrowId
              ? { ...e, status: 'paid', transaction_hash: mockTxHash }
              : e
          )
        );
        setTransactions((prev) => [
          {
            id: Date.now().toString(),
            type: 'payment',
            escrowId,
            hash: mockTxHash,
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
    const targetEscrow = escrows.find((e) => e.id === escrowId);
    const originalStatus = targetEscrow?.status || 'pending_manager';

    try {
      const isMock = targetEscrow?.isMock || isMockMode;
      if (isContractConfigured && !isMock) {
        let result;
        try {
          result = await client.submitCancelEscrow(escrowId);
        } catch (err) {
          await handleBlockchainError(escrowId, originalStatus, err);
          return;
        }

        // No off-chain status write here, deliberately.
        //
        // The transaction above was submitted; whether the CHAIN accepted it is a
        // separate question, answered by the indexer observing the contract's event
        // log. Writing the expected status from the client would assert an outcome
        // nobody has confirmed — the precise failure mode the payment state machine
        // exists to prevent. The dashboard refreshes below and advances when the
        // indexer catches up.

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

  /**
   * Handle Rejection Edge Case (Sad Path).
   * Updates status to 'rejected' with rejectionReason.
   */
  const handleRejectHours = async (escrowId: number, reason: string) => {
    setIsLoading(true);
    setError(null);
    try {
      const isMock = escrows.find((e) => e.id === escrowId)?.isMock || isMockMode;
      if (isContractConfigured && !isMock) {
        await fetch(`/api/escrows/${escrowId}/status`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: 'rejected', rejectionReason: reason }),
        });
        await loadInitialData();
      } else {
        await new Promise(resolve => setTimeout(resolve, 800));
        setEscrows((prev) =>
          prev.map((e) =>
            e.id === escrowId
              ? { ...e, status: 'rejected', rejectionReason: reason, manager_approved: false }
              : e
          )
        );
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to reject hours');
    } finally {
      setIsLoading(false);
    }
  };

  /**
   * Create and fund an escrow on-chain.
   *
   * Amounts arrive as base units (bigint) from the modal, NOT as
   * dollars-times-100. Passing "cents" here used to under-fund every escrow by
   * 100,000x, because Stellar assets carry seven decimals — see lib/money.
   */
  const handleCreateEscrow = async (
    workerPubKey: string,
    financeApprover: string,
    amountUnits: bigint,
    rateUnits: bigint
  ) => {
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
        const isStellarAddr = /^[GC][A-Z2-7]{55}$/.test(workerPubKey);
        if (!isStellarAddr) {
          throw new Error(
            `Unsupported address type: "${workerPubKey}". In live on-chain mode, the worker address must be a valid 56-character Stellar public key (starting with 'G') or Contract ID (starting with 'C').`
          );
        }
        if (!/^[GC][A-Z2-7]{55}$/.test(financeApprover)) {
          throw new Error(
            `Finance approver "${financeApprover}" is not a valid Stellar address.`
          );
        }
        // Separation of duties is the product's core claim, and the contract
        // enforces it with SignersNotDistinct (#15). The dashboard previously
        // passed the connected wallet as BOTH manager and finance approver, so
        // this call trapped on every attempt and the dual-approval flow had no
        // working path at all.
        if (financeApprover === walletAddress) {
          throw new Error(
            'The finance approver must be a different wallet from the manager. ' +
              'CoreFlow requires two distinct signers before funds can move.'
          );
        }

        const tokenAddress = STELLAR_CONFIG.token.id;
        if (!tokenAddress) {
          throw new Error(
            'Settlement token not configured. Set NEXT_PUBLIC_STELLAR_TOKEN_ID to the USDC Stellar Asset Contract address for on-chain custody.'
          );
        }

        const payload = [
          {
            worker: workerPubKey,
            // Per-payee asset. This single-escrow path uses the configured
            // default SAC; the Bulk Pay CSV flow sets it per row.
            token: tokenAddress,
            amount: amountUnits,
            start_date: Math.floor(Date.now() / 1000),
            end_date: Math.floor(Date.now() / 1000) + 86400 * 7,
            rate_per_hour: rateUnits,
          }
        ];

        const pubkeyRes = await fetch('/api/oracle/pubkey');
        if (!pubkeyRes.ok) {
          throw new Error('Oracle is not configured; cannot create a verifiable escrow.');
        }
        const { pubkey: oraclePubkey } = await pubkeyRes.json();
        const txResult = await client.submitInitializeEscrow(
          walletAddress,
          financeApprover,
          oraclePubkey,
          payload
        );
        
        try {
          await fetch('/api/escrows', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              onChainId: txResult.returnValue || 0,
              workerPubKey,
              // Base units as a string: JSON has no bigint, and the value can
              // exceed Number.MAX_SAFE_INTEGER for large batches.
              amountBaseUnits: amountUnits.toString(),
              rateBaseUnits: rateUnits.toString(),
              assetDecimals: SAC_DECIMALS,
              financeApprover,
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
        await new Promise(resolve => setTimeout(resolve, 1000));
        const newId = escrows.length + 1;
        const newEsc: EscrowData = {
          id: newId,
          worker: workerPubKey.length >= 10 ? workerPubKey.slice(0, 6) + '...' + workerPubKey.slice(-4) : workerPubKey,
          amount: formatAmountWithSeparators(amountUnits, SAC_DECIMALS),
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
        const nonce = await client.getNonce(hoursEscrowId);

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

        const result = await client.submitHoursProof(
          hoursEscrowId,
          hoursPaymentId,
          hours,
          nonce,
          signature
        );

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
                rejectionReason: null,
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

  const handleOpenResubmit = (escrowId: number) => {
    setSelectedEscrowIdForHours(escrowId);
    setShowHoursModal(true);
  };

  // Real-time KPI calculations
  const totalPayrollProcessedUsdc = useMemo(() => {
    return escrows
      .filter((e) => e.status === 'paid')
      .reduce((sum, e) => sum + (parseFloat(e.amount.replace(/,/g, '')) || 0), 0);
  }, [escrows]);

  const pendingApprovalsCount = useMemo(() => {
    return escrows.filter((e) => e.status === 'pending_manager' || e.status === 'pending_finance').length;
  }, [escrows]);

  const activeEmployeesCount = useMemo(() => {
    const workers = new Set(escrows.map((e) => e.worker));
    return Math.max(workers.size, 1);
  }, [escrows]);

  const stats = {
    total: escrows.length,
    pending: pendingApprovalsCount,
    approved: escrows.filter((e) => e.status === 'ready').length,
    released: escrows.filter((e) => e.status === 'paid').length,
    totalPayrollProcessedUsdc,
    activeEmployeesCount,
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
      selectedEscrowIdForHours,
      isMockMode,
      isContractConfigured,
      stats,
      client,
    },
    actions: {
      setShowCreateModal,
      setShowHoursModal,
      setSelectedEscrowIdForHours,
      handleToggleMode,
      loadInitialData,
      handleManagerApprove,
      handleFinanceApprove,
      handleFinalize,
      handleCancelEscrow,
      handleRejectHours,
      handleOpenResubmit,
      handleCreateEscrow,
      handleSubmitHours,
      setError,
      setIsLoading,
      setTransactions,
      setEscrows,
    }
  };
}
