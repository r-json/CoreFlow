'use client';

import { useAuth } from '@/hooks/useAuth';
import { useDashboard } from '@/hooks/useDashboard';
import { SubmitHoursModal } from '@/components/modals/SubmitHoursModal';
import {
  Clock,
  FileText,
  AlertCircle,
  RefreshCw,
  CheckCircle2,
  XCircle,
  Timer,
  CalendarDays,
} from 'lucide-react';

export default function EmployeeHoursPage() {
  const auth = useAuth();
  const { state, actions } = useDashboard({
    isAuthenticated: auth.isAuthenticated,
    walletAddress: auth.walletAddress,
  });

  const { escrows, isLoading, error, infoMessage, showHoursModal, selectedEscrowIdForHours } = state;

  // Derive hours data from escrows
  const hoursEntries = escrows
    .filter((e) => parseInt(e.hoursLogged) > 0)
    .map((e) => ({
      escrowId: e.id,
      hours: parseInt(e.hoursLogged),
      amount: e.amount,
      currency: e.currency,
      status: e.status,
      worker: e.worker,
      date: e.created_at,
      rejected: e.status === 'rejected',
      rejectionReason: e.rejectionReason,
      paid: e.status === 'paid',
      verified: e.hours_verified,
    }));

  const totalHours = hoursEntries.reduce((sum, e) => sum + e.hours, 0);
  const approvedHours = hoursEntries
    .filter((e) => e.status === 'pending_finance' || e.status === 'ready' || e.status === 'paid')
    .reduce((sum, e) => sum + e.hours, 0);
  const rejectedHours = hoursEntries
    .filter((e) => e.rejected)
    .reduce((sum, e) => sum + e.hours, 0);

  return (
    <div className="max-w-5xl mx-auto px-8 py-8">
      {/* Page Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-black tracking-tight text-white flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-cyan-500/10 border border-cyan-500/30 flex items-center justify-center">
              <Clock className="w-5 h-5 text-cyan-400" />
            </div>
            Hours Log
          </h1>
          <p className="text-sm text-slate-400 mt-1">
            Track your oracle-verified work hours and submission history
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
            className="flex items-center gap-1.5 px-4 py-2 rounded-xl text-xs font-bold bg-gradient-to-r from-cyan-600 to-blue-600 hover:from-cyan-500 hover:to-blue-500 text-white transition-colors shadow-md shadow-cyan-500/15"
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

      {/* Hours Summary Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-8">
        <div className="p-5 rounded-2xl border border-cyan-500/20 bg-gradient-to-br from-cyan-950/30 via-slate-900/60 to-slate-950 backdrop-blur-xl shadow-xl">
          <div className="flex items-center justify-between mb-2">
            <p className="text-[10px] text-slate-400 uppercase tracking-wider font-extrabold">Total Hours</p>
            <Timer className="w-4 h-4 text-cyan-400" />
          </div>
          <p className="text-3xl font-black bg-gradient-to-r from-cyan-400 to-blue-300 bg-clip-text text-transparent">
            {totalHours} hrs
          </p>
          <p className="text-[10px] text-slate-500 mt-1 font-mono">All submitted hours</p>
        </div>

        <div className="p-5 rounded-2xl border border-emerald-500/20 bg-gradient-to-br from-emerald-950/30 via-slate-900/60 to-slate-950 backdrop-blur-xl shadow-xl">
          <div className="flex items-center justify-between mb-2">
            <p className="text-[10px] text-slate-400 uppercase tracking-wider font-extrabold">Approved</p>
            <CheckCircle2 className="w-4 h-4 text-emerald-400" />
          </div>
          <p className="text-3xl font-black bg-gradient-to-r from-emerald-400 to-teal-300 bg-clip-text text-transparent">
            {approvedHours} hrs
          </p>
          <p className="text-[10px] text-slate-500 mt-1 font-mono">Manager-approved hours</p>
        </div>

        <div className="p-5 rounded-2xl border border-rose-500/20 bg-gradient-to-br from-rose-950/30 via-slate-900/60 to-slate-950 backdrop-blur-xl shadow-xl">
          <div className="flex items-center justify-between mb-2">
            <p className="text-[10px] text-slate-400 uppercase tracking-wider font-extrabold">Rejected</p>
            <XCircle className="w-4 h-4 text-rose-400" />
          </div>
          <p className="text-3xl font-black bg-gradient-to-r from-rose-400 to-pink-300 bg-clip-text text-transparent">
            {rejectedHours} hrs
          </p>
          <p className="text-[10px] text-slate-500 mt-1 font-mono">Needs resubmission</p>
        </div>
      </div>

      {/* Hours Entries */}
      <div className="rounded-2xl border border-white/10 bg-slate-900/40 backdrop-blur-xl overflow-hidden shadow-2xl">
        <div className="px-6 py-4 border-b border-white/5 bg-slate-900/60 flex items-center justify-between">
          <h2 className="text-xs font-extrabold uppercase tracking-wider text-slate-300 flex items-center gap-2">
            <CalendarDays className="w-4 h-4 text-cyan-400" />
            Hours Submission History ({hoursEntries.length})
          </h2>
          <span className="text-[10px] text-slate-500 font-mono">Oracle-verified · Immutable</span>
        </div>

        {isLoading ? (
          <div className="p-12 text-center text-slate-400">
            <RefreshCw className="w-6 h-6 animate-spin mx-auto mb-2 text-violet-400" />
            <p className="text-xs font-medium">Loading hours log...</p>
          </div>
        ) : hoursEntries.length === 0 ? (
          <div className="p-12 text-center text-slate-400">
            <Clock className="w-8 h-8 text-slate-600 mx-auto mb-2" />
            <p className="text-sm font-semibold">No hours submitted yet.</p>
            <p className="text-xs text-slate-500 mt-1">
              Submit your work hours for an active escrow to start tracking.
            </p>
          </div>
        ) : (
          <div className="divide-y divide-white/5">
            {hoursEntries.map((entry) => (
              <div
                key={entry.escrowId}
                className="px-6 py-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3 hover:bg-slate-900/30 transition-colors"
              >
                <div className="flex items-center gap-3">
                  <div
                    className={`p-2 rounded-xl border ${
                      entry.paid
                        ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400'
                        : entry.rejected
                        ? 'bg-rose-500/10 border-rose-500/30 text-rose-400'
                        : 'bg-cyan-500/10 border-cyan-500/30 text-cyan-400'
                    }`}
                  >
                    <Clock className="w-4 h-4" />
                  </div>
                  <div>
                    <p className="text-xs font-bold text-white">
                      Escrow #{entry.escrowId}
                    </p>
                    <p className="text-[10px] text-slate-500 font-mono mt-0.5">
                      {entry.date}
                    </p>
                  </div>
                </div>

                <div className="flex items-center gap-4">
                  <div className="text-right">
                    <p className="text-sm font-bold text-white">{entry.hours} hours</p>
                    <p className="text-[10px] text-slate-500">
                      ${entry.amount} {entry.currency}
                    </p>
                  </div>
                  <span
                    className={`text-[10px] font-bold px-2.5 py-1 rounded-lg border ${
                      entry.paid
                        ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400'
                        : entry.rejected
                        ? 'bg-rose-500/10 border-rose-500/30 text-rose-400'
                        : entry.verified
                        ? 'bg-cyan-500/10 border-cyan-500/30 text-cyan-400'
                        : 'bg-amber-500/10 border-amber-500/30 text-amber-400'
                    }`}
                  >
                    {entry.paid
                      ? '✓ Paid'
                      : entry.rejected
                      ? '✕ Rejected'
                      : entry.verified
                      ? '⏳ Verified'
                      : 'Pending'}
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Submit Hours Modal */}
      <SubmitHoursModal
        isOpen={showHoursModal}
        onClose={() => actions.setShowHoursModal(false)}
        onSubmit={actions.handleSubmitHours}
        selectedEscrowId={selectedEscrowIdForHours}
      />
    </div>
  );
}
