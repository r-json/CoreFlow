'use client';

import { useState } from 'react';
import { useAuth } from '@/hooks/useAuth';
import { useDashboard } from '@/hooks/useDashboard';
import { EscrowCard } from '@/components/EscrowCard';
import { SubmitHoursModal } from '@/components/modals/SubmitHoursModal';
import {
  ShieldCheck,
  FileText,
  AlertCircle,
  RefreshCw,
  Filter,
  LayoutGrid,
} from 'lucide-react';

type StatusFilter = 'all' | 'pending_manager' | 'pending_finance' | 'ready' | 'paid' | 'rejected' | 'cancelled';

const FILTERS: { value: StatusFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'pending_manager', label: 'Awaiting Manager' },
  { value: 'pending_finance', label: 'Awaiting Finance' },
  { value: 'ready', label: 'Ready' },
  { value: 'paid', label: 'Settled' },
  { value: 'rejected', label: 'Rejected' },
  { value: 'cancelled', label: 'Cancelled' },
];

export default function EmployeeEscrowsPage() {
  const auth = useAuth();
  const { state, actions } = useDashboard({
    isAuthenticated: auth.isAuthenticated,
    walletAddress: auth.walletAddress,
  });

  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');

  const {
    escrows,
    isConnected,
    isLoading,
    error,
    infoMessage,
    showHoursModal,
    selectedEscrowIdForHours,
  } = state;

  const filteredEscrows =
    statusFilter === 'all'
      ? escrows
      : escrows.filter((e) => e.status === statusFilter);

  return (
    <div className="max-w-5xl mx-auto px-8 py-8">
      {/* Page Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-black tracking-tight text-white flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-sky-500/10 border border-sky-500/30 flex items-center justify-center">
              <ShieldCheck className="w-5 h-5 text-sky-400" />
            </div>
            My Escrows
          </h1>
          <p className="text-sm text-slate-400 mt-1">
            View and track all escrows assigned to your wallet
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => actions.loadInitialData()}
            disabled={isLoading}
            className="flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-bold border border-slate-700 bg-slate-900/80 hover:bg-slate-800 text-slate-300 transition-colors"
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

      {/* Alerts */}
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

      {/* Filter Bar */}
      <div className="mb-6 flex items-center gap-2 flex-wrap">
        <div className="flex items-center gap-1.5 text-xs font-bold text-slate-400 uppercase tracking-wider mr-2">
          <Filter className="w-3.5 h-3.5" />
          Status:
        </div>
        {FILTERS.map((f) => (
          <button
            key={f.value}
            onClick={() => setStatusFilter(f.value)}
            className={`px-3 py-1.5 rounded-lg text-[10px] font-bold border transition-colors ${
              statusFilter === f.value
                ? 'bg-sky-600 border-sky-500 text-white'
                : 'bg-slate-900/80 border-slate-700 text-slate-400 hover:text-slate-200 hover:border-slate-600'
            }`}
          >
            {f.label}
            {f.value !== 'all' && (
              <span className="ml-1 opacity-60">
                ({escrows.filter((e) => e.status === f.value).length})
              </span>
            )}
          </button>
        ))}
      </div>

      {/* Escrow List */}
      <div className="space-y-5">
        {isLoading && filteredEscrows.length === 0 ? (
          <div className="space-y-4">
            {[1, 2].map((i) => (
              <div
                key={i}
                className="h-56 rounded-2xl bg-gradient-to-br from-slate-900 to-slate-900/60 animate-pulse border border-white/5"
              />
            ))}
          </div>
        ) : filteredEscrows.length === 0 ? (
          <div className="text-center py-16 border border-dashed border-white/10 rounded-2xl bg-slate-900/20">
            <LayoutGrid className="w-8 h-8 text-slate-500 mx-auto mb-2" />
            <p className="text-sm font-semibold text-slate-400">
              {statusFilter === 'all'
                ? 'No escrows assigned to your wallet yet.'
                : `No escrows with status "${statusFilter}"`}
            </p>
            {statusFilter === 'all' && (
              <p className="text-xs text-slate-500 mt-1">
                Your admin will create escrows and assign them to your wallet.
              </p>
            )}
          </div>
        ) : (
          filteredEscrows.map((escrow) => (
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
