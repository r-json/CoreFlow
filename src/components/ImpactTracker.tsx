'use client';

import { useEffect, useState } from 'react';
import { TrendingUp, Users, DollarSign, Wallet } from 'lucide-react';

interface ImpactStats {
  totalPaidUsd: number;
  totalSavedUsd: number;
  totalWorkersPaid: number;
}

const INITIAL_STATS: ImpactStats = {
  totalPaidUsd: 5600, // Starts with some seed stats from the initialized mock list (e.g. final payment was $2,100)
  totalSavedUsd: 308,
  totalWorkersPaid: 3,
};

export const ImpactTracker = () => {
  const [stats, setStats] = useState<ImpactStats>(INITIAL_STATS);

  const USD_TO_PHP = 56.50;

  useEffect(() => {
    // Load from localStorage or set defaults
    const loadStats = () => {
      const stored = localStorage.getItem('coreflow_impact_stats');
      if (stored) {
        try {
          setStats(JSON.parse(stored));
        } catch (e) {
          // Keep default seed stats
          setStats(INITIAL_STATS);
        }
      } else {
        // Save initial seed stats
        localStorage.setItem('coreflow_impact_stats', JSON.stringify(INITIAL_STATS));
        setStats(INITIAL_STATS);
      }
    };

    loadStats();

    // Listen for storage updates
    window.addEventListener('storage', loadStats);
    // Custom event to update from dashboard page immediately
    window.addEventListener('coreflow_stats_updated', loadStats);

    return () => {
      window.removeEventListener('storage', loadStats);
      window.removeEventListener('coreflow_stats_updated', loadStats);
    };
  }, []);

  const totalPaidPhp = stats.totalPaidUsd * USD_TO_PHP;
  const totalSavedPhp = stats.totalSavedUsd * USD_TO_PHP;

  return (
    <div className="rounded-2xl border border-violet-500/20 bg-gradient-to-br from-slate-900/90 via-violet-950/10 to-slate-900/90 p-5 shadow-xl">
      <div className="flex items-center justify-between gap-2 mb-4">
        <div className="flex items-center gap-2">
          <TrendingUp className="w-5 h-5 text-violet-400" aria-hidden="true" />
          <h3 className="text-sm font-semibold text-slate-200 tracking-tight">Cumulative Remittance Impact</h3>
        </div>
        <span
          className="text-[9px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded border border-amber-500/40 bg-amber-500/10 text-amber-300"
          title="Illustrative figures seeded for demonstration; updates locally as you finalize payments."
        >
          Illustrative
        </span>
      </div>

      <div className="space-y-4">
        {/* Total Processed */}
        <div className="flex items-center justify-between border-b border-white/5 pb-3">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-violet-500/10 flex items-center justify-center text-violet-400">
              <DollarSign className="w-4 h-4" />
            </div>
            <div>
              <p className="text-[10px] text-slate-500 uppercase font-medium">Total Volume Released</p>
              <p className="text-sm font-bold text-slate-200">${stats.totalPaidUsd.toLocaleString()}</p>
            </div>
          </div>
          <div className="text-right">
            <p className="text-[10px] text-slate-500 uppercase font-medium">PHP Value</p>
            <p className="text-sm font-bold text-violet-400">₱{totalPaidPhp.toLocaleString('en-US', { maximumFractionDigits: 0 })}</p>
          </div>
        </div>

        {/* Fees Saved */}
        <div className="flex items-center justify-between border-b border-white/5 pb-3">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-emerald-500/10 flex items-center justify-center text-emerald-400">
              <Wallet className="w-4 h-4" />
            </div>
            <div>
              <p className="text-[10px] text-slate-500 uppercase font-medium">Total Remittance Savings</p>
              <p className="text-sm font-bold text-emerald-400">${stats.totalSavedUsd.toFixed(2)}</p>
            </div>
          </div>
          <div className="text-right">
            <p className="text-[10px] text-slate-500 uppercase font-medium">Saved PHP</p>
            <p className="text-sm font-bold text-emerald-400">₱{totalSavedPhp.toLocaleString('en-US', { maximumFractionDigits: 2 })}</p>
          </div>
        </div>

        {/* Workers Paid */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-indigo-500/10 flex items-center justify-center text-indigo-400">
              <Users className="w-4 h-4" />
            </div>
            <div>
              <p className="text-[10px] text-slate-500 uppercase font-medium">Active Workers Paid</p>
              <p className="text-sm font-bold text-slate-200">{stats.totalWorkersPaid}</p>
            </div>
          </div>
          <div className="text-right">
            <span className="text-[10px] bg-indigo-500/10 text-indigo-400 px-2 py-1 rounded-full font-medium border border-indigo-500/20">
              Freighter Wallet
            </span>
          </div>
        </div>
      </div>
    </div>
  );
};
