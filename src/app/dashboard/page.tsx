'use client';

import { useState, useEffect } from 'react';
import { WalletButton } from '@/components/WalletButton';
import { EscrowCard, EscrowData } from '@/components/EscrowCard';
import { TransactionFeed, Transaction } from '@/components/TransactionFeed';
import { Alert } from '@/components/Alert';
import { ImpactTracker } from '@/components/ImpactTracker';
import { CoreFlowClient } from '@/lib/contracts';
import { STELLAR_CONFIG } from '@/lib/config';
import { PlusCircle, FileText, AlertCircle, RefreshCw } from 'lucide-react';

export default function DashboardPage() {
  const [escrows, setEscrows] = useState<EscrowData[]>([]);
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [isConnected, setIsConnected] = useState(false);
  const [walletAddress, setWalletAddress] = useState<string>('');
  
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [infoMessage, setInfoMessage] = useState<string | null>(null);

  // Modals state
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showHoursModal, setShowHoursModal] = useState(false);

  // Form states
  const [newWorker, setNewWorker] = useState('');
  const [newAmount, setNewAmount] = useState('100');
  const [newRate, setNewRate] = useState('2.5'); // $2.50 per hour e.g. for tiny demo payout

  const [hoursEscrowId, setHoursEscrowId] = useState<number>(1);
  const [hoursPaymentId, setHoursPaymentId] = useState<number>(0);
  const [hoursValue, setHoursValue] = useState('40');

  const client = new CoreFlowClient();
  const isContractConfigured = !!STELLAR_CONFIG.contract.id && STELLAR_CONFIG.contract.id !== '';
  const [isMockMode, setIsMockMode] = useState(!isContractConfigured);

  // Initialize and load
  useEffect(() => {
    loadInitialData();
  }, []);

  const loadInitialData = async (forceMockMode?: boolean) => {
    const activeMockMode = forceMockMode !== undefined ? forceMockMode : isMockMode;
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

    if (isContractConfigured && !activeMockMode) {
      setIsLoading(true);
      try {
        // Attempt to load live escrows from contract
        // Since we cannot list all escrows from custom keys easily without an indexer,
        // we probe IDs 1, 2, 3...
        const liveEscrows: EscrowData[] = [];
        for (let id = 1; id <= 10; id++) {
          try {
            const data = await client.getEscrow(id);
            if (data) {
              const statusMap = (statusNum: number, m: boolean, f: boolean): EscrowData['status'] => {
                if (statusNum === 3) return 'paid';
                if (statusNum === 4) return 'cancelled';
                if (m && f) return 'ready';
                if (m) return 'pending_finance';
                return 'pending_manager';
              };

              // Summarize payments in escrow (we use first schedule for card display)
              const firstPayment = data.payments[0];
              const totalAmount = data.payments.reduce((acc, p) => acc + p.amount, 0n);
              const totalHours = data.payments.reduce((acc, p) => acc + p.hours_logged, 0n);
              const formattedAmount = (Number(totalAmount) / 100).toFixed(2); // Stored in stroops/cents

              liveEscrows.push({
                id,
                worker: firstPayment ? `${firstPayment.worker.slice(0, 6)}...${firstPayment.worker.slice(-6)}` : 'Unknown',
                amount: formattedAmount,
                currency: 'USDC',
                hoursLogged: totalHours.toString(),
                status: statusMap(firstPayment ? firstPayment.status : 0, data.manager_approved, data.finance_approved),
                manager_approved: data.manager_approved,
                finance_approved: data.finance_approved,
                hours_verified: totalHours > 0n,
                created_at: 'On-chain',
              });
            }
          } catch (e) {
            // Stop probing once we hit an error or non-existent ID
            break;
          }
        }

        if (liveEscrows.length > 0) {
          setEscrows(liveEscrows);
          setInfoMessage('Loaded live escrow records from Stellar Network');
        } else {
          setEscrows(mockEscrows);
          setInfoMessage('No on-chain escrows found. Showing mock demo data.');
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
  };

  const handleWalletConnect = (address: string) => {
    setIsConnected(true);
    setWalletAddress(address);
    // Temporarily update readAddress config for simulations
    STELLAR_CONFIG.addresses.readAddress = address;
    STELLAR_CONFIG.addresses.signingAddress = address;
    setError(null);
  };

  const handleWalletDisconnect = () => {
    setIsConnected(false);
    setWalletAddress('');
  };

  const handleToggleMode = (useMock: boolean) => {
    setIsMockMode(useMock);
    setError(null);
    if (useMock) {
      setInfoMessage('Switched to Mock Demo Mode. State changes will be local-only.');
    } else {
      setInfoMessage('Switched to Live On-Chain Mode. Interactions will require Freighter wallet.');
    }
    loadInitialData(useMock);
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
        // Mock implementation
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
        // Mock implementation
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
        // Mock implementation
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
        // Mock implementation
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

  const handleCreateEscrow = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isConnected) {
      setError('Please connect Freighter wallet first');
      return;
    }

    setIsLoading(true);
    setError(null);
    setShowCreateModal(false);

    try {
      const amountCents = Math.floor(parseFloat(newAmount) * 100);
      const rateCents = Math.floor(parseFloat(newRate) * 100);
      const workerPubKey = newWorker.trim();

      if (!workerPubKey) throw new Error('Worker address is required');

      if (isContractConfigured && !isMockMode) {
        // Validate worker address for live on-chain
        const isStellarAddr = /^[GC][A-Z2-7]{55}$/.test(workerPubKey);
        if (!isStellarAddr) {
          throw new Error(
            `Unsupported address type: "${workerPubKey}". In live on-chain mode, the worker address must be a valid 56-character Stellar public key (starting with 'G') or Contract ID (starting with 'C').`
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

        // Manager and finance approvals default to the wallet owner for bootcamp demo convenience
        const txResult = await client.submitInitializeEscrow(walletAddress, walletAddress, payload);
        
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
          amount: parseFloat(newAmount).toLocaleString(),
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

  const handleSubmitHours = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);
    setError(null);
    setShowHoursModal(false);

    try {
      const isMock = escrows.find((e) => e.id === hoursEscrowId)?.isMock || isMockMode;
      if (isContractConfigured && !isMock) {
        // Generates dummy Ed25519 signature of length 64 (all 1s) to satisfy smart contract length requirements
        const dummySignature = Buffer.alloc(64, 1).toString('base64');
        
        const result = await client.submitHoursProof(
          hoursEscrowId,
          hoursPaymentId,
          parseInt(hoursValue),
          dummySignature
        );

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

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-950 via-purple-950/60 to-slate-950 text-slate-100 flex flex-col font-sans">
      
      {/* Header */}
      <header className="sticky top-0 z-40 border-b border-violet-500/10 bg-slate-950/85 backdrop-blur-xl shadow-md shadow-black/10">
        <div className="max-w-7xl mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="relative w-9 h-9 flex items-center justify-center">
              {/* Glowing aura background */}
              <div className="absolute inset-0 bg-violet-600/20 blur-md rounded-full animate-pulse-glow" />
              <svg
                className="w-9 h-9 text-violet-500 relative z-10 animate-float"
                viewBox="0 0 32 32"
                fill="none"
                xmlns="http://www.w3.org/2000/svg"
              >
                <defs>
                  <linearGradient id="logo-grad-1" x1="0%" y1="0%" x2="100%" y2="100%">
                    <stop offset="0%" stopColor="#8b5cf6" />
                    <stop offset="100%" stopColor="#3b82f6" />
                  </linearGradient>
                  <linearGradient id="logo-grad-2" x1="100%" y1="0%" x2="0%" y2="100%">
                    <stop offset="0%" stopColor="#10b981" />
                    <stop offset="100%" stopColor="#06b6d4" />
                  </linearGradient>
                </defs>
                {/* Background base ring */}
                <circle cx="16" cy="16" r="13" className="stroke-slate-800/80 fill-slate-900/60" strokeWidth="1.5" />
                
                {/* Flow line 1 */}
                <path
                  d="M10 12C12 9 17 9 20 12C23 15 23 17 20 20C17 23 12 23 10 20"
                  stroke="url(#logo-grad-1)"
                  strokeWidth="2.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
                
                {/* Flow line 2 */}
                <path
                  d="M22 20C20 23 15 23 12 20C9 17 9 15 12 12C15 9 20 9 22 12"
                  stroke="url(#logo-grad-2)"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeDasharray="4 2"
                />

                {/* Core active node */}
                <circle cx="16" cy="16" r="3" className="fill-violet-400 animate-pulse" />
              </svg>
            </div>
            <div>
              <h1 className="text-lg font-extrabold tracking-tight text-white flex items-center gap-1.5">
                CoreFlow
                <span className="text-[9px] bg-violet-500/10 border border-violet-500/20 text-violet-400 font-bold px-1.5 py-0.5 rounded uppercase tracking-wide">
                  Soroban Escrow
                </span>
              </h1>
              <p className="text-[10px] text-slate-400">On-Chain Accounts Payable & Remittance</p>
            </div>
          </div>

          <div className="flex items-center gap-4">
            {isContractConfigured && (
              <div className="flex items-center gap-1 bg-slate-900/80 border border-slate-800 rounded-xl p-1 text-xs">
                <button
                  type="button"
                  onClick={() => handleToggleMode(false)}
                  className={`px-3 py-1.5 rounded-lg font-medium transition-all ${
                    !isMockMode
                      ? 'bg-violet-600 text-white shadow-md'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  Live On-Chain
                </button>
                <button
                  type="button"
                  onClick={() => handleToggleMode(true)}
                  className={`px-3 py-1.5 rounded-lg font-medium transition-all ${
                    isMockMode
                      ? 'bg-amber-600/90 text-white shadow-md'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  Mock Demo
                </button>
              </div>
            )}
            <button
              onClick={() => loadInitialData()}
              className="p-2 rounded-lg border border-slate-800 hover:border-slate-700 bg-slate-900/60 text-slate-400 hover:text-slate-200 transition-colors"
              title="Refresh contract records"
            >
              <RefreshCw className={`w-4 h-4 ${isLoading ? 'animate-spin' : ''}`} />
            </button>
            <WalletButton onConnect={handleWalletConnect} onDisconnect={handleWalletDisconnect} />
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="flex-1 max-w-7xl w-full mx-auto px-6 py-8">
        
        {/* Info alerts */}
        {infoMessage && (
          <div className="mb-6 p-3 rounded-xl border border-violet-500/20 bg-violet-950/10 flex items-center gap-2">
            <AlertCircle className="w-4 h-4 text-violet-400 shrink-0" />
            <p className="text-xs text-violet-300 font-medium">{infoMessage}</p>
          </div>
        )}

        {error && (
          <Alert variant="destructive" className="mb-6 border-rose-500/20 bg-rose-950/10 text-rose-300">
            <p className="text-xs font-mono">{error}</p>
          </Alert>
        )}

        {/* Stats Grid */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
          {[
            { label: 'Total Escrows', value: stats.total, color: 'from-violet-500', bgColor: 'from-violet-950/20 to-slate-900/10' },
            { label: 'Active Escrows', value: stats.pending, color: 'from-purple-500', bgColor: 'from-purple-950/20 to-slate-900/10' },
            { label: 'Ready to Release', value: stats.approved, color: 'from-indigo-500', bgColor: 'from-indigo-950/20 to-slate-900/10' },
            { label: 'Completed Payouts', value: stats.released, color: 'from-emerald-500', bgColor: 'from-emerald-950/15 to-slate-900/10' },
          ].map((stat, i) => (
            <div
              key={i}
              className={`p-4 rounded-2xl border border-white/5 bg-gradient-to-br ${stat.bgColor} backdrop-blur-md shadow-sm`}
            >
              <p className="text-[10px] text-slate-500 uppercase tracking-wider mb-1 font-semibold">{stat.label}</p>
              <p className={`text-2xl font-black bg-gradient-to-r ${stat.color} to-slate-300 bg-clip-text text-transparent`}>
                {stat.value}
              </p>
            </div>
          ))}
        </div>

        {/* Action Header bar */}
        <div className="flex items-center justify-between mb-6">
          <h2 className="text-base font-extrabold tracking-tight text-white uppercase tracking-wider">
            Escrow Registers
          </h2>
          <div className="flex gap-2">
            <button
              onClick={() => setShowHoursModal(true)}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold border border-white/10 bg-slate-900/80 hover:bg-slate-800 hover:border-white/20 text-slate-300 transition-colors shadow-sm"
            >
              <FileText className="w-3.5 h-3.5 text-violet-400" />
              Submit Hours
            </button>
            <button
              onClick={() => setShowCreateModal(true)}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-gradient-to-r from-violet-600 to-indigo-600 hover:from-violet-500 hover:to-indigo-500 text-white transition-colors shadow-md shadow-violet-500/15"
            >
              <PlusCircle className="w-3.5 h-3.5" />
              New Escrow
            </button>
          </div>
        </div>

        {/* Main Grid: Escrows + Activity */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
          {/* Escrow Cards */}
          <div className="lg:col-span-2 space-y-5">
            {isLoading && escrows.length === 0 ? (
              <div className="space-y-4">
                {[1, 2].map((i) => (
                  <div key={i} className="h-56 rounded-2xl bg-gradient-to-br from-slate-900 to-slate-900/60 animate-pulse border border-white/5" />
                ))}
              </div>
            ) : escrows.length === 0 ? (
              <div className="text-center py-16 border border-dashed border-white/10 rounded-2xl bg-slate-900/20">
                <AlertCircle className="w-8 h-8 text-slate-500 mx-auto mb-2" />
                <p className="text-sm font-semibold text-slate-400">No active escrows registered.</p>
                <p className="text-xs text-slate-500 mt-1">Deploy contract and connect Freighter wallet to initialize.</p>
              </div>
            ) : (
              escrows.map((escrow) => (
                <EscrowCard
                  key={escrow.id}
                  escrow={escrow}
                  onManagerApprove={handleManagerApprove}
                  onFinanceApprove={handleFinanceApprove}
                  onFinalize={handleFinalize}
                  onCancel={handleCancelEscrow}
                  isConnected={isConnected}
                />
              ))
            )}
          </div>

          {/* Activity / Stats Sidebar */}
          <div className="space-y-6">
            <ImpactTracker />
            <div>
              <h3 className="text-xs font-extrabold tracking-wider uppercase text-slate-400 mb-3">On-Chain Activity</h3>
              <TransactionFeed transactions={transactions} />
            </div>
          </div>
        </div>

        {/* Footer Info */}
        <footer className="mt-16 p-6 rounded-2xl border border-white/5 bg-slate-900/20 backdrop-blur-md">
          <h3 className="text-xs font-bold text-slate-300 uppercase tracking-wider mb-2">💡 Decentralized B2B Payroll & Remittance Architecture</h3>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mt-4 text-xs text-slate-400">
            <div className="p-3 rounded-xl bg-slate-950/40 border border-white/5">
              <p className="font-semibold text-slate-200 mb-1">1. Oracle-Verified Time Tracking</p>
              <p className="leading-relaxed">Work logs verified by oracles are submitted to Soroban contract alongside cryptographic signatures. Limits trust requirements and prevents false claims.</p>
            </div>
            <div className="p-3 rounded-xl bg-slate-950/40 border border-white/5">
              <p className="font-semibold text-slate-200 mb-1">2. Multi-Sig Approval Guards</p>
              <p className="leading-relaxed">Payments are locked securely in escrow. Independent manager and financial approver authorities must provide on-chain approvals before funds release.</p>
            </div>
            <div className="p-3 rounded-xl bg-slate-950/40 border border-white/5">
              <p className="font-semibold text-slate-200 mb-1">3. Philippine Remittance Savings</p>
              <p className="leading-relaxed">Workers receive USDC instantly via Stellar, avoiding traditional bank wires that cost 5.5%+ in intermediate fees. Integratable with Stellar anchors for local fiat out.</p>
            </div>
          </div>
        </footer>
      </main>

      {/* CREATE ESCROW MODAL */}
      {showCreateModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4 animate-fade-in">
          <div className="bg-slate-900 border border-slate-800 rounded-2xl w-full max-w-md p-6 shadow-2xl animate-scale-up">
            <h3 className="text-base font-extrabold text-white mb-4 uppercase tracking-wider">Initialize New Escrow</h3>
            <form onSubmit={handleCreateEscrow} className="space-y-4">
              <div>
                <label className="block text-[10px] uppercase font-bold text-slate-400 mb-1">
                  Worker Public Key (Stellar Address)
                </label>
                <input
                  type="text"
                  required
                  placeholder="G..."
                  value={newWorker}
                  onChange={(e) => setNewWorker(e.target.value)}
                  className={`w-full bg-slate-950 border focus:border-violet-500 rounded-lg px-3 py-2 text-xs font-mono text-slate-200 outline-none ${
                    newWorker && !isMockMode && !/^[GC][A-Z2-7]{55}$/.test(newWorker.trim())
                      ? 'border-rose-500/50'
                      : 'border-slate-800'
                  }`}
                />
                {newWorker && !isMockMode && !/^[GC][A-Z2-7]{55}$/.test(newWorker.trim()) && (
                  <p className="mt-1 text-[10px] text-rose-400 font-medium">
                    ⚠️ Invalid Stellar address. Must be a 56-character string starting with G or C.
                  </p>
                )}
                {!newWorker && (
                  <p className="mt-1 text-[10px] text-slate-500">
                    {isMockMode 
                      ? 'Enter any identifier (e.g. WorkerA) for the mock demo.'
                      : 'Must be a valid 56-character Stellar address (starts with G or C).'}
                  </p>
                )}
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-[10px] uppercase font-bold text-slate-400 mb-1">Max Amount (USDC)</label>
                  <input
                    type="number"
                    step="0.01"
                    min="0.1"
                    required
                    value={newAmount}
                    onChange={(e) => setNewAmount(e.target.value)}
                    className="w-full bg-slate-950 border border-slate-800 focus:border-violet-500 rounded-lg px-3 py-2 text-xs text-slate-200 outline-none"
                  />
                </div>
                <div>
                  <label className="block text-[10px] uppercase font-bold text-slate-400 mb-1">Hourly Rate (USDC/hr)</label>
                  <input
                    type="number"
                    step="0.01"
                    min="0.01"
                    required
                    value={newRate}
                    onChange={(e) => setNewRate(e.target.value)}
                    className="w-full bg-slate-950 border border-slate-800 focus:border-violet-500 rounded-lg px-3 py-2 text-xs text-slate-200 outline-none"
                  />
                </div>
              </div>

              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setShowCreateModal(false)}
                  className="px-3 py-1.5 rounded-lg text-xs font-semibold hover:bg-slate-800 text-slate-400 transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="px-4 py-1.5 rounded-lg text-xs font-semibold bg-violet-600 hover:bg-violet-500 text-white transition-colors"
                >
                  Create Escrow
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* SUBMIT HOURS MODAL */}
      {showHoursModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4 animate-fade-in">
          <div className="bg-slate-900 border border-slate-800 rounded-2xl w-full max-w-md p-6 shadow-2xl animate-scale-up">
            <h3 className="text-base font-extrabold text-white mb-4 uppercase tracking-wider">Submit Oracle Work Proof</h3>
            <form onSubmit={handleSubmitHours} className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-[10px] uppercase font-bold text-slate-400 mb-1">Escrow ID</label>
                  <input
                    type="number"
                    required
                    min="1"
                    value={hoursEscrowId}
                    onChange={(e) => setHoursEscrowId(parseInt(e.target.value))}
                    className="w-full bg-slate-950 border border-slate-800 focus:border-violet-500 rounded-lg px-3 py-2 text-xs text-slate-200 outline-none"
                  />
                </div>
                <div>
                  <label className="block text-[10px] uppercase font-bold text-slate-400 mb-1">Schedule index</label>
                  <input
                    type="number"
                    required
                    min="0"
                    value={hoursPaymentId}
                    onChange={(e) => setHoursPaymentId(parseInt(e.target.value))}
                    className="w-full bg-slate-950 border border-slate-800 focus:border-violet-500 rounded-lg px-3 py-2 text-xs text-slate-200 outline-none"
                  />
                </div>
              </div>

              <div>
                <label className="block text-[10px] uppercase font-bold text-slate-400 mb-1">Hours Logged</label>
                <input
                  type="number"
                  required
                  min="1"
                  value={hoursValue}
                  onChange={(e) => setHoursValue(e.target.value)}
                  className="w-full bg-slate-950 border border-slate-800 focus:border-violet-500 rounded-lg px-3 py-2 text-xs text-slate-200 outline-none"
                />
              </div>

              <div className="p-3 rounded-lg bg-violet-950/20 border border-violet-500/10 text-[10px] text-slate-400 leading-normal">
                💡 Submit will cryptographically verify hours proofs using Ed25519 signature validation matching the smart contract configuration.
              </div>

              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setShowHoursModal(false)}
                  className="px-3 py-1.5 rounded-lg text-xs font-semibold hover:bg-slate-800 text-slate-400 transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="px-4 py-1.5 rounded-lg text-xs font-semibold bg-violet-600 hover:bg-violet-500 text-white transition-colors"
                >
                  Submit Hours
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
