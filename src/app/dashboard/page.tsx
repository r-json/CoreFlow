'use client';

import { EscrowCard } from '@/components/EscrowCard';
import { TransactionFeed } from '@/components/TransactionFeed';
import { Alert } from '@/components/Alert';
import { ImpactTracker } from '@/components/ImpactTracker';
import { PlusCircle, FileText, AlertCircle } from 'lucide-react';
import { useDashboard } from '@/hooks/useDashboard';
import { useAuth } from '@/hooks/useAuth';
import { DashboardHeader } from '@/components/dashboard/DashboardHeader';
import { DashboardStats } from '@/components/dashboard/DashboardStats';
import { CreateEscrowModal } from '@/components/modals/CreateEscrowModal';
import { SubmitHoursModal } from '@/components/modals/SubmitHoursModal';

export default function DashboardPage() {
  const auth = useAuth();
  const { state, actions } = useDashboard({
    isAuthenticated: auth.isAuthenticated,
    walletAddress: auth.walletAddress,
  });

  const {
    escrows,
    transactions,
    isConnected,
    isLoading,
    error,
    infoMessage,
    showCreateModal,
    showHoursModal,
    isMockMode,
    isContractConfigured,
    stats,
  } = state;

  // Role-based gating applies only to live on-chain/DB writes. In mock demo
  // mode every action stays available for showcase purposes.
  const gateActions = isContractConfigured && !isMockMode;
  const canManage = !gateActions || auth.role === 'manager' || auth.role === 'admin';
  const canFinance = !gateActions || auth.role === 'finance' || auth.role === 'admin';

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-950 via-purple-950/60 to-slate-950 text-slate-100 flex flex-col font-sans">
      
      {/* Header */}
      <DashboardHeader
        isContractConfigured={isContractConfigured}
        isMockMode={isMockMode}
        isLoading={isLoading || auth.isLoading}
        onToggleMode={actions.handleToggleMode}
        onRefresh={() => actions.loadInitialData()}
        // Auth props — now handled by useAuth
        isAuthenticated={auth.isAuthenticated}
        walletAddress={auth.walletAddress}
        role={auth.role}
        onSignIn={auth.signIn}
        onSignOut={auth.signOut}
      />

      {/* Main Content */}
      <main className="flex-1 max-w-7xl w-full mx-auto px-6 py-8">
        
        {/* Auth error */}
        {auth.error && (
          <div className="mb-6 p-3 rounded-xl border border-rose-500/20 bg-rose-950/10 flex items-center gap-2">
            <AlertCircle className="w-4 h-4 text-rose-400 shrink-0" />
            <p className="text-xs text-rose-300 font-medium">{auth.error}</p>
          </div>
        )}

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
        <DashboardStats stats={stats} />

        {/* Action Header bar */}
        <div className="flex items-center justify-between mb-6">
          <h2 className="text-base font-extrabold tracking-tight text-white uppercase tracking-wider">
            Escrow Registers
          </h2>
          <div className="flex gap-2">
            <button
              onClick={() => actions.setShowHoursModal(true)}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold border border-white/10 bg-slate-900/80 hover:bg-slate-800 hover:border-white/20 text-slate-300 transition-colors shadow-sm"
            >
              <FileText className="w-3.5 h-3.5 text-violet-400" />
              Submit Hours
            </button>
            <button
              onClick={() => actions.setShowCreateModal(true)}
              disabled={!canManage}
              title={!canManage ? 'Requires the manager role' : undefined}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-gradient-to-r from-violet-600 to-indigo-600 hover:from-violet-500 hover:to-indigo-500 text-white transition-colors shadow-md shadow-violet-500/15 disabled:opacity-50 disabled:cursor-not-allowed"
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
                <p className="text-xs text-slate-500 mt-1">Deploy contract and sign in with Freighter to initialize.</p>
              </div>
            ) : (
              escrows.map((escrow) => (
                <EscrowCard
                  key={escrow.id}
                  escrow={escrow}
                  onManagerApprove={actions.handleManagerApprove}
                  onFinanceApprove={actions.handleFinanceApprove}
                  onFinalize={actions.handleFinalize}
                  onCancel={actions.handleCancelEscrow}
                  isConnected={isConnected}
                  canManage={canManage}
                  canFinance={canFinance}
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

      {/* MODALS */}
      <CreateEscrowModal 
        isOpen={showCreateModal}
        onClose={() => actions.setShowCreateModal(false)}
        onSubmit={actions.handleCreateEscrow}
        isMockMode={isMockMode}
      />
      
      <SubmitHoursModal
        isOpen={showHoursModal}
        onClose={() => actions.setShowHoursModal(false)}
        onSubmit={actions.handleSubmitHours}
      />
    </div>
  );
}
