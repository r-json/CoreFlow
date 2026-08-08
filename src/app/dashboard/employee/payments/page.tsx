'use client';

import { useAuth } from '@/hooks/useAuth';
import { useDashboard } from '@/hooks/useDashboard';
import {
  DollarSign,
  AlertCircle,
  RefreshCw,
  CheckCircle2,
  ExternalLink,
  TrendingUp,
  ArrowDownToLine,
  Wallet,
  Banknote,
} from 'lucide-react';

export default function EmployeePaymentsPage() {
  const auth = useAuth();
  const { state, actions } = useDashboard({
    isAuthenticated: auth.isAuthenticated,
    walletAddress: auth.walletAddress,
  });

  const { escrows, isLoading, error, infoMessage } = state;

  const USD_TO_PHP = 56.5;

  // Filter paid escrows for payment history
  const paidEscrows = escrows.filter((e) => e.status === 'paid');
  const pendingEscrows = escrows.filter(
    (e) => e.status === 'ready' || e.status === 'pending_finance'
  );

  const totalEarnedUsd = paidEscrows.reduce(
    (sum, e) => sum + (parseFloat(e.amount.replace(/,/g, '')) || 0),
    0
  );
  const totalEarnedPhp = totalEarnedUsd * USD_TO_PHP;
  const totalFeeSaved = totalEarnedUsd * 0.055 - 0.001 * paidEscrows.length;
  const pendingAmount = pendingEscrows.reduce(
    (sum, e) => sum + (parseFloat(e.amount.replace(/,/g, '')) || 0),
    0
  );

  return (
    <div className="max-w-5xl mx-auto px-8 py-8">
      {/* Page Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-black tracking-tight text-white flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-emerald-500/10 border border-emerald-500/30 flex items-center justify-center">
              <DollarSign className="w-5 h-5 text-emerald-400" />
            </div>
            Payment History
          </h1>
          <p className="text-sm text-slate-400 mt-1">
            Track your on-chain payment receipts and remittance savings
          </p>
        </div>
        <button
          onClick={() => actions.loadInitialData()}
          disabled={isLoading}
          className="flex items-center gap-1.5 px-4 py-2 rounded-xl text-xs font-bold border border-slate-700 bg-slate-900/80 hover:bg-slate-800 text-slate-300 transition-colors"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${isLoading ? 'animate-spin' : ''}`} />
          Refresh
        </button>
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

      {/* Earnings Summary */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
        <div className="p-5 rounded-2xl border border-emerald-500/20 bg-gradient-to-br from-emerald-950/30 via-slate-900/60 to-slate-950 backdrop-blur-xl shadow-xl group hover:border-white/20 transition-all">
          <div className="flex items-center justify-between mb-2">
            <p className="text-[10px] text-slate-400 uppercase tracking-wider font-extrabold">Total Earned</p>
            <DollarSign className="w-4 h-4 text-emerald-400" />
          </div>
          <p className="text-2xl font-black bg-gradient-to-r from-emerald-400 to-teal-300 bg-clip-text text-transparent">
            ${totalEarnedUsd.toLocaleString(undefined, { minimumFractionDigits: 2 })}
          </p>
          <p className="text-[10px] text-slate-500 mt-1 font-mono">USDC settled on-chain</p>
        </div>

        <div className="p-5 rounded-2xl border border-violet-500/20 bg-gradient-to-br from-violet-950/30 via-slate-900/60 to-slate-950 backdrop-blur-xl shadow-xl group hover:border-white/20 transition-all">
          <div className="flex items-center justify-between mb-2">
            <p className="text-[10px] text-slate-400 uppercase tracking-wider font-extrabold">PHP Value</p>
            <Banknote className="w-4 h-4 text-violet-400" />
          </div>
          <p className="text-2xl font-black bg-gradient-to-r from-violet-400 to-purple-300 bg-clip-text text-transparent">
            ₱{totalEarnedPhp.toLocaleString(undefined, { maximumFractionDigits: 0 })}
          </p>
          <p className="text-[10px] text-slate-500 mt-1 font-mono">At 1 USDC = ₱{USD_TO_PHP}</p>
        </div>

        <div className="p-5 rounded-2xl border border-sky-500/20 bg-gradient-to-br from-sky-950/30 via-slate-900/60 to-slate-950 backdrop-blur-xl shadow-xl group hover:border-white/20 transition-all">
          <div className="flex items-center justify-between mb-2">
            <p className="text-[10px] text-slate-400 uppercase tracking-wider font-extrabold">Pending</p>
            <ArrowDownToLine className="w-4 h-4 text-sky-400" />
          </div>
          <p className="text-2xl font-black bg-gradient-to-r from-sky-400 to-blue-300 bg-clip-text text-transparent">
            ${pendingAmount.toLocaleString(undefined, { minimumFractionDigits: 2 })}
          </p>
          <p className="text-[10px] text-slate-500 mt-1 font-mono">Awaiting finalization</p>
        </div>

        <div className="p-5 rounded-2xl border border-amber-500/20 bg-gradient-to-br from-amber-950/30 via-slate-900/60 to-slate-950 backdrop-blur-xl shadow-xl group hover:border-white/20 transition-all">
          <div className="flex items-center justify-between mb-2">
            <p className="text-[10px] text-slate-400 uppercase tracking-wider font-extrabold">Fees Saved</p>
            <Wallet className="w-4 h-4 text-amber-400" />
          </div>
          <p className="text-2xl font-black bg-gradient-to-r from-amber-400 to-orange-300 bg-clip-text text-transparent">
            ${totalFeeSaved > 0 ? totalFeeSaved.toFixed(2) : '0.00'}
          </p>
          <p className="text-[10px] text-slate-500 mt-1 font-mono">vs. traditional wire fees</p>
        </div>
      </div>

      {/* Pending Payments */}
      {pendingEscrows.length > 0 && (
        <div className="mb-8">
          <h2 className="text-xs font-extrabold uppercase tracking-wider text-amber-400 mb-3 flex items-center gap-2">
            <ArrowDownToLine className="w-3.5 h-3.5" />
            Incoming Payments ({pendingEscrows.length})
          </h2>
          <div className="rounded-2xl border border-amber-500/20 bg-slate-900/40 backdrop-blur-xl overflow-hidden">
            <div className="divide-y divide-white/5">
              {pendingEscrows.map((escrow) => {
                const amount = parseFloat(escrow.amount.replace(/,/g, ''));
                const phpValue = amount * USD_TO_PHP;
                return (
                  <div
                    key={escrow.id}
                    className="px-6 py-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3 hover:bg-slate-900/30 transition-colors"
                  >
                    <div className="flex items-center gap-3">
                      <div className="p-2 rounded-xl bg-amber-500/10 border border-amber-500/30 text-amber-400">
                        <ArrowDownToLine className="w-4 h-4" />
                      </div>
                      <div>
                        <p className="text-xs font-bold text-white">Escrow #{escrow.id}</p>
                        <p className="text-[10px] text-slate-500 font-mono mt-0.5">
                          {escrow.status === 'ready' ? 'Ready for Release' : 'Awaiting Finance Approval'}
                        </p>
                      </div>
                    </div>
                    <div className="text-right">
                      <p className="text-sm font-bold text-white">
                        ${escrow.amount} {escrow.currency}
                      </p>
                      <p className="text-[10px] text-emerald-400 font-bold">
                        ≈ ₱{phpValue.toLocaleString(undefined, { maximumFractionDigits: 0 })}
                      </p>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {/* Payment History */}
      <div className="rounded-2xl border border-white/10 bg-slate-900/40 backdrop-blur-xl overflow-hidden shadow-2xl">
        <div className="px-6 py-4 border-b border-white/5 bg-slate-900/60 flex items-center justify-between">
          <h2 className="text-xs font-extrabold uppercase tracking-wider text-slate-300 flex items-center gap-2">
            <TrendingUp className="w-4 h-4 text-emerald-400" />
            Completed Payments ({paidEscrows.length})
          </h2>
          <span className="text-[10px] text-slate-500 font-mono">
            On-chain · Immutable · Auditable
          </span>
        </div>

        {isLoading ? (
          <div className="p-12 text-center text-slate-400">
            <RefreshCw className="w-6 h-6 animate-spin mx-auto mb-2 text-violet-400" />
            <p className="text-xs font-medium">Loading payment history...</p>
          </div>
        ) : paidEscrows.length === 0 ? (
          <div className="p-12 text-center text-slate-400">
            <DollarSign className="w-8 h-8 text-slate-600 mx-auto mb-2" />
            <p className="text-sm font-semibold">No payments received yet.</p>
            <p className="text-xs text-slate-500 mt-1">
              Completed escrow payouts will appear here.
            </p>
          </div>
        ) : (
          <div className="divide-y divide-white/5">
            {paidEscrows.map((escrow) => {
              const amount = parseFloat(escrow.amount.replace(/,/g, ''));
              const phpValue = amount * USD_TO_PHP;
              const feeSaved = amount * 0.055 - 0.001;

              return (
                <div
                  key={escrow.id}
                  className="px-6 py-5 hover:bg-slate-900/30 transition-colors"
                >
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                    <div className="flex items-center gap-3">
                      <div className="p-2.5 rounded-xl bg-emerald-500/10 border border-emerald-500/30 text-emerald-400">
                        <CheckCircle2 className="w-5 h-5" />
                      </div>
                      <div>
                        <p className="text-sm font-bold text-white">
                          Escrow #{escrow.id}
                        </p>
                        <p className="text-[10px] text-slate-500 font-mono mt-0.5">
                          {escrow.created_at} · {escrow.hoursLogged} hours worked
                        </p>
                      </div>
                    </div>
                    <div className="text-left sm:text-right">
                      <p className="text-xl font-black text-white">
                        ${escrow.amount}{' '}
                        <span className="text-xs font-medium text-slate-400">USDC</span>
                      </p>
                      <p className="text-xs text-emerald-400 font-bold">
                        ≈ ₱{phpValue.toLocaleString(undefined, { maximumFractionDigits: 0 })} PHP
                      </p>
                      {feeSaved > 0 && (
                        <p className="text-[10px] text-amber-400 mt-0.5">
                          Saved ~${feeSaved.toFixed(2)} in remittance fees
                        </p>
                      )}
                    </div>
                  </div>
                  {escrow.transaction_hash && (
                    <div className="mt-3 flex items-center gap-2">
                      <span className="text-[10px] text-slate-500 font-mono">
                        TX: {escrow.transaction_hash.slice(0, 12)}...
                      </span>
                      <a
                        href={`https://stellar.expert/explorer/public/tx/${escrow.transaction_hash}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-[10px] font-bold text-violet-400 hover:text-violet-300 transition-colors flex items-center gap-1"
                      >
                        View on Explorer
                        <ExternalLink className="w-3 h-3" />
                      </a>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
