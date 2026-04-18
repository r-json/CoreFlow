'use client';

/**
 * CoreFlow Dashboard - Professional Fintech UI
 * On-Chain Accounts Payable for Remote Teams
 */

import { useState, useEffect } from 'react';
import { WalletButton } from '@/components/WalletButton';
import { EscrowCard, EscrowData } from '@/components/EscrowCard';
import { TransactionFeed, Transaction } from '@/components/TransactionFeed';
import { Alert } from '@/components/Alert';

export default function DashboardPage() {
  const [escrows, setEscrows] = useState<EscrowData[]>([]);
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [isConnected, setIsConnected] = useState(false);
  const [signingAddress, setSigningAddress] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Initialize with mock data
  useEffect(() => {
    setEscrows([
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
      },
    ]);

    setTransactions([
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
    ]);
  }, []);

  const handleWalletConnect = (address: string) => {
    setSigningAddress(address);
    setIsConnected(true);
    setError(null);
  };

  const handleWalletDisconnect = () => {
    setSigningAddress(null);
    setIsConnected(false);
  };

  const handleManagerApprove = async (escrowId: number) => {
    try {
      setIsLoading(true);
      setError(null);
      
      // Simulate transaction delay
      await new Promise(resolve => setTimeout(resolve, 1500));
      
      // Update local state
      setEscrows((prev) =>
        prev.map((e) =>
          e.id === escrowId
            ? { ...e, manager_approved: true, status: 'pending_finance' }
            : e
        )
      );

      // Add transaction to feed
      const txHash = '0x' + Math.random().toString(16).slice(2, 18);
      setTransactions((prev) => [
        {
          id: Date.now().toString(),
          type: 'approval',
          escrowId,
          hash: txHash,
          status: 'success',
          timestamp: 'now',
          details: 'Manager approved escrow',
        },
        ...prev,
      ]);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to approve');
    } finally {
      setIsLoading(false);
    }
  };

  const handleFinanceApprove = async (escrowId: number) => {
    try {
      setIsLoading(true);
      setError(null);
      
      // Simulate transaction delay
      await new Promise(resolve => setTimeout(resolve, 1500));
      
      // Update local state
      setEscrows((prev) =>
        prev.map((e) =>
          e.id === escrowId
            ? { ...e, finance_approved: true, status: 'ready' }
            : e
        )
      );

      // Add transaction to feed
      const txHash = '0x' + Math.random().toString(16).slice(2, 18);
      setTransactions((prev) => [
        {
          id: Date.now().toString(),
          type: 'approval',
          escrowId,
          hash: txHash,
          status: 'success',
          timestamp: 'now',
          details: 'Finance approved escrow',
        },
        ...prev,
      ]);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to approve');
    } finally {
      setIsLoading(false);
    }
  };

  const handleFinalize = async (escrowId: number) => {
    try {
      setIsLoading(true);
      setError(null);
      
      // Simulate transaction delay
      await new Promise(resolve => setTimeout(resolve, 1500));
      
      // Update local state
      setEscrows((prev) =>
        prev.map((e) =>
          e.id === escrowId
            ? { ...e, status: 'paid' }
            : e
        )
      );

      // Add transaction to feed
      const txHash = '0x' + Math.random().toString(16).slice(2, 18);
      setTransactions((prev) => [
        {
          id: Date.now().toString(),
          type: 'payment',
          escrowId,
          hash: txHash,
          status: 'success',
          timestamp: 'now',
          details: 'Payment released to worker',
        },
        ...prev,
      ]);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to finalize');
    } finally {
      setIsLoading(false);
    }
  };

  const stats = {
    total: escrows.length,
    pending: escrows.filter((e) => e.status !== 'paid').length,
    approved: escrows.filter((e) => e.status === 'ready').length,
    released: escrows.filter((e) => e.status === 'paid').length,
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-950 via-purple-950 to-orange-950/30">
      {/* Header */}
      <header className="sticky top-0 z-50 border-b border-violet-500/20 bg-gradient-to-r from-slate-950/80 via-slate-900/60 to-orange-950/50 backdrop-blur-xl shadow-lg shadow-black/20">
        <div className="max-w-7xl mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-gradient-to-br from-violet-500 to-purple-600 flex items-center justify-center text-white font-bold text-lg">
              ₅
            </div>
            <div>
              <h1 className="text-xl font-bold tracking-tight text-slate-100">CoreFlow</h1>
              <p className="text-xs text-slate-500">On-Chain Accounts Payable</p>
            </div>
          </div>

          <WalletButton onConnect={handleWalletConnect} onDisconnect={handleWalletDisconnect} />
        </div>
      </header>

      {/* Main Content */}
      <main className="max-w-7xl mx-auto px-6 py-8">
        {error && (
          <Alert variant="destructive" className="mb-6">
            <p className="text-sm">{error}</p>
          </Alert>
        )}

        {/* Stats Grid */}
        <div className="grid grid-cols-4 gap-4 mb-8">
          {[
            { label: 'Total Escrows', value: stats.total, color: 'from-violet-600', bgColor: 'from-violet-900/20 via-slate-800/30 to-slate-800/20' },
            { label: 'Pending Review', value: stats.pending, color: 'from-purple-600', bgColor: 'from-purple-900/20 via-slate-800/30 to-slate-800/20' },
            { label: 'Ready to Release', value: stats.approved, color: 'from-indigo-600', bgColor: 'from-indigo-900/20 via-slate-800/30 to-slate-800/20' },
            { label: 'Released', value: stats.released, color: 'from-slate-600', bgColor: 'from-slate-800/40 via-slate-700/30 to-slate-800/20' },
          ].map((stat, i) => (
            <div
              key={i}
              className={`p-4 rounded-lg border border-violet-500/20 bg-gradient-to-br ${stat.bgColor} backdrop-blur-lg hover:border-violet-500/40 transition-all duration-300`}
            >
              <p className="text-xs text-slate-400 uppercase tracking-wide mb-1 font-medium">{stat.label}</p>
              <p className={`text-2xl font-bold bg-gradient-to-r ${stat.color} to-slate-400 bg-clip-text text-transparent`}>
                {stat.value}
              </p>
            </div>
          ))}
        </div>

        {/* Main Grid: Escrows + Activity */}
        <div className="grid grid-cols-3 gap-6">
          {/* Escrow Cards */}
          <div className="col-span-2 space-y-4">
            <h2 className="text-lg font-semibold tracking-tight text-slate-100 mb-4">Active Escrows</h2>
            {isLoading && escrows.length === 0 ? (
              <div className="space-y-4">
                {[1, 2, 3].map((i) => (
                  <div key={i} className="h-48 rounded-2xl bg-gradient-to-br from-slate-800/50 via-slate-800/30 to-slate-800/20 animate-pulse border border-white/5" />
                ))}
              </div>
            ) : escrows.length === 0 ? (
              <div className="text-center py-12 text-slate-400">
                <p>No escrows yet. Create one to get started.</p>
              </div>
            ) : (
              escrows.map((escrow) => (
                <EscrowCard
                  key={escrow.id}
                  escrow={escrow}
                  onManagerApprove={handleManagerApprove}
                  onFinanceApprove={handleFinanceApprove}
                  onFinalize={handleFinalize}
                  isConnected={isConnected}
                />
              ))
            )}
          </div>

          {/* Activity Sidebar */}
          <div>
            <h2 className="text-lg font-semibold tracking-tight bg-gradient-to-r from-violet-400 to-purple-400 bg-clip-text text-transparent mb-4">Activity</h2>
            <TransactionFeed transactions={transactions} />
          </div>
        </div>

        {/* Footer Info */}
        <div className="mt-12 p-6 rounded-2xl border border-violet-500/20 bg-gradient-to-br from-violet-900/20 via-slate-800/30 to-slate-800/20 backdrop-blur-lg shadow-2xl shadow-black/10">
          <h3 className="text-sm font-semibold text-slate-200 mb-2">🚀 How CoreFlow Works</h3>
          <div className="grid grid-cols-3 gap-6 mt-4 text-xs text-slate-400">
            <div>
              <p className="font-medium text-slate-300 mb-1">1. Submit Hours</p>
              <p>Worker submits hours proof with oracle signature</p>
            </div>
            <div>
              <p className="font-medium text-slate-300 mb-1">2. Multi-Sig Approval</p>
              <p>Manager and Finance must both approve payment</p>
            </div>
            <div>
              <p className="font-medium text-slate-300 mb-1">3. Release Payment</p>
              <p>Once approved, release USDC to worker wallet</p>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
