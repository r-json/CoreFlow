'use client';


import { useAuth } from '@/hooks/useAuth';
import { useDashboard } from '@/hooks/useDashboard';

import { ImpactTracker } from '@/components/ImpactTracker';
import { EscrowCard } from '@/components/EscrowCard';
import { TransactionFeed } from '@/components/TransactionFeed';
import { SubmitHoursModal } from '@/components/modals/SubmitHoursModal';
import {
  Users,
  FileText,
  AlertCircle,
  RefreshCw,
  Clock,
  DollarSign,
  CheckCircle2,

  ArrowUpRight,
  ShieldCheck,
} from 'lucide-react';
import Link from 'next/link';

export default function EmployeeOverviewPage() {
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
    showHoursModal,
    selectedEscrowIdForHours,
  } = state;

  // Employee sees only pending escrows for quick action
  const pendingEscrows = escrows.filter(
    (e) =>
      e.status === 'pending_hours' ||
      e.status === 'pending_manager' ||
      e.status === 'pending_finance' ||
      e.status === 'rejected'
  );
  const recentEscrows = escrows.slice(0, 3);

  const totalEarned = escrows
    .filter((e) => e.status === 'paid')
    .reduce((sum, e) => sum + (parseFloat(e.amount.replace(/,/g, '')) || 0), 0);

  const totalHoursWorked = escrows.reduce(
    (sum, e) => sum + (parseInt(e.hoursLogged) || 0),
    0
  );

  return (
    <div className="max-w-7xl mx-auto px-8 py-8">
      {/* Page Header */}
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-black tracking-tight text-white flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-sky-500/10 border border-sky-500/30 flex items-center justify-center">
              <Users className="w-5 h-5 text-sky-400" />
            </div>
            Employee Dashboard
          </h1>
          <p className="text-sm text-slate-400 mt-1">
            Welcome back — here&apos;s your work summary at a glance
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => actions.loadInitialData()}
            disabled={isLoading}
            className="flex items-center gap-1.5 px-4 py-2 rounded-xl text-xs font-bold border border-slate-700 bg-slate-900/80 hover:bg-slate-800 text-slate-300 transition-colors"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${isLoading ? 'animate-spin' : ''}`} />
            Refresh
          </button>
          <button
            onClick={() => actions.setShowHoursModal(true)}
            className="flex items-center gap-1.5 px-4 py-2 rounded-xl text-xs font-bold bg-gradient-to-r from-sky-600 to-blue-600 hover:from-sky-500 hover:to-blue-500 text-white transition-colors shadow-md shadow-sky-500/15"
          >
            <FileText className="w-3.5 h-3.5" />
            Submit Hours
          </button>
        </div>
      </div>

      {/* Info/Error alerts */}
      {infoMessage && (
        <div className="mb-6 p-3 rounded-xl border border-violet-500/20 bg-violet-950/10 flex items-center gap-2">
          <AlertCircle className="w-4 h-4 text-violet-400 shrink-0" />
          <p className="text-xs text-violet-300 font-medium">{infoMessage}</p>
        </div>
      )}
      {error && (
        <div className="mb-6 p-3 rounded-xl border border-rose-500/20 bg-rose-950/10 flex items-center gap-2">
          <AlertCircle className="w-4 h-4 text-rose-400 shrink-0" />
          <p className="text-xs text-rose-300 font-medium">{error}</p>
        </div>
      )}

      {/* Personal KPI Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
        <KpiCard
          label="Total Earned"
          value={`$${totalEarned.toLocaleString(undefined, { minimumFractionDigits: 2 })} USDC`}
          subtitle="Settled on-chain payments"
          icon={<DollarSign className="w-4 h-4" />}
          gradient="from-emerald-400 to-teal-300"
          bgGradient="from-emerald-950/30 via-slate-900/60 to-slate-950"
          borderColor="border-emerald-500/20"
        />
        <KpiCard
          label="Hours Logged"
          value={`${totalHoursWorked} hrs`}
          subtitle="Oracle-verified work hours"
          icon={<Clock className="w-4 h-4" />}
          gradient="from-sky-400 to-blue-300"
          bgGradient="from-sky-950/30 via-slate-900/60 to-slate-950"
          borderColor="border-sky-500/20"
        />
        <KpiCard
          label="Active Escrows"
          value={escrows.filter((e) => e.status !== 'paid' && e.status !== 'cancelled').length.toString()}
          subtitle="Pending or in-progress"
          icon={<ShieldCheck className="w-4 h-4" />}
          gradient="from-violet-400 to-indigo-300"
          bgGradient="from-violet-950/30 via-slate-900/60 to-slate-950"
          borderColor="border-violet-500/20"
        />
        <KpiCard
          label="Completed"
          value={escrows.filter((e) => e.status === 'paid').length.toString()}
          subtitle="Finalized payouts"
          icon={<CheckCircle2 className="w-4 h-4" />}
          gradient="from-purple-400 to-violet-300"
          bgGradient="from-purple-950/30 via-slate-900/60 to-slate-950"
          borderColor="border-purple-500/20"
        />
      </div>

      {/* Action Required Section */}
      {pendingEscrows.length > 0 && (
        <div className="mb-8">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-xs font-extrabold uppercase tracking-wider text-amber-400 flex items-center gap-2">
              <AlertCircle className="w-3.5 h-3.5" />
              Action Required ({pendingEscrows.length})
            </h2>
          </div>
          <div className="grid grid-cols-1 gap-4">
            {pendingEscrows.map((escrow) => (
              <div
                key={escrow.id}
                className="p-4 rounded-xl border border-amber-500/20 bg-amber-950/10 flex flex-col sm:flex-row sm:items-center justify-between gap-3"
              >
                <div>
                  <p className="text-sm font-bold text-white">
                    Escrow #{escrow.id}
                  </p>
                  <p className="text-[11px] text-slate-400">
                    ${escrow.amount} {escrow.currency} ·{' '}
                    <span className={
                      escrow.status === 'rejected' ? 'text-rose-400 font-bold' : 'text-amber-400'
                    }>
                      {escrow.status === 'rejected'
                        ? `Hours Rejected${escrow.rejectionReason ? `: ${escrow.rejectionReason}` : ''}`
                        : escrow.status === 'pending_hours'
                        ? 'Awaiting your hours log'
                        : escrow.status === 'pending_manager'
                        ? 'Awaiting Manager Approval'
                        : 'Awaiting Finance Approval'}
                    </span>
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  {(escrow.status === 'rejected' || escrow.status === 'pending_hours') && (
                    <button
                      onClick={() => actions.handleOpenResubmit(escrow.id)}
                      className="px-3 py-1.5 rounded-lg text-xs font-bold bg-gradient-to-r from-fuchsia-600 to-violet-600 hover:from-fuchsia-500 hover:to-violet-500 text-white transition-colors shadow-md"
                    >
                      {escrow.status === 'rejected' ? 'Resubmit Hours' : 'Submit Hours'}
                    </button>
                  )}
                  <Link
                    href="/dashboard/employee/escrows"
                    className="px-3 py-1.5 rounded-lg text-xs font-bold border border-slate-700 bg-slate-900/80 hover:bg-slate-800 text-slate-300 transition-colors flex items-center gap-1"
                  >
                    View Details
                    <ArrowUpRight className="w-3 h-3" />
                  </Link>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Main Grid: Recent Escrows + Activity */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
        <div className="lg:col-span-2 space-y-5">
          <div className="flex items-center justify-between">
            <h2 className="text-xs font-extrabold uppercase tracking-wider text-slate-400">
              Recent Escrows
            </h2>
            <Link
              href="/dashboard/employee/escrows"
              className="text-[10px] font-bold text-sky-400 hover:text-sky-300 transition-colors flex items-center gap-1"
            >
              View All
              <ArrowUpRight className="w-3 h-3" />
            </Link>
          </div>
          {isLoading && recentEscrows.length === 0 ? (
            <div className="space-y-4">
              {[1, 2].map((i) => (
                <div
                  key={i}
                  className="h-48 rounded-2xl bg-gradient-to-br from-slate-900 to-slate-900/60 animate-pulse border border-white/5"
                />
              ))}
            </div>
          ) : recentEscrows.length === 0 ? (
            <div className="text-center py-16 border border-dashed border-white/10 rounded-2xl bg-slate-900/20">
              <ShieldCheck className="w-8 h-8 text-slate-500 mx-auto mb-2" />
              <p className="text-sm font-semibold text-slate-400">
                No escrows assigned to your wallet yet.
              </p>
              <p className="text-xs text-slate-500 mt-1">
                Your admin will create escrows and assign them to your wallet address.
              </p>
            </div>
          ) : (
            recentEscrows.map((escrow) => (
              <EscrowCard
                key={escrow.id}
                escrow={escrow}
                onResubmitHours={actions.handleOpenResubmit}
                onSubmitHours={actions.handleOpenResubmit}
                isConnected={isConnected}
                canManage={false}
                canFinance={false}
              />
            ))
          )}
        </div>

        {/* Sidebar */}
        <div className="space-y-6">
          <ImpactTracker />
          <div>
            <h3 className="text-xs font-extrabold tracking-wider uppercase text-slate-400 mb-3">
              On-Chain Activity
            </h3>
            <TransactionFeed transactions={transactions} />
          </div>
        </div>
      </div>

      {/* Modals */}
      <SubmitHoursModal
        isOpen={showHoursModal}
        onClose={() => actions.setShowHoursModal(false)}
        onSubmit={actions.handleSubmitHours}
        selectedEscrowId={selectedEscrowIdForHours}
      />
    </div>
  );
}

function KpiCard({
  label,
  value,
  subtitle,
  icon,
  gradient,
  bgGradient,
  borderColor,
}: {
  label: string;
  value: string;
  subtitle: string;
  icon: React.ReactNode;
  gradient: string;
  bgGradient: string;
  borderColor: string;
}) {
  return (
    <div
      className={`p-5 rounded-2xl border ${borderColor} bg-gradient-to-br ${bgGradient} backdrop-blur-xl shadow-xl shadow-black/20 hover:border-white/20 transition-all duration-300 group`}
    >
      <div className="flex items-center justify-between mb-2">
        <p className="text-[10px] text-slate-400 uppercase tracking-wider font-extrabold">
          {label}
        </p>
        <div className="p-1.5 rounded-lg bg-slate-900/80 border border-white/5 text-slate-300 group-hover:scale-110 transition-transform">
          {icon}
        </div>
      </div>
      <p
        className={`text-2xl font-black tracking-tight bg-gradient-to-r ${gradient} bg-clip-text text-transparent`}
      >
        {value}
      </p>
      <p className="text-[10px] text-slate-500 mt-1 font-mono">{subtitle}</p>
    </div>
  );
}
