'use client';

import { Sparkles } from 'lucide-react';

interface FeeSavingsProps {
  amountUsdc: number;
}

export const FeeSavings = ({ amountUsdc }: FeeSavingsProps) => {
  const USD_TO_PHP = 56.50;
  
  // Calculations
  const traditionalFeePercent = 0.055; // 5.5% traditional fee
  const traditionalFeeUsd = amountUsdc * traditionalFeePercent;
  const traditionalFeePhp = traditionalFeeUsd * USD_TO_PHP;
  
  const coreFlowFeeUsd = 0.001; // $0.001 equivalent (approx 0.01 XLM)
  const coreFlowFeePhp = coreFlowFeeUsd * USD_TO_PHP;
  
  const savedUsd = traditionalFeeUsd - coreFlowFeeUsd;
  const savedPhp = savedUsd * USD_TO_PHP;
  
  const savingsPercent = ((traditionalFeeUsd - coreFlowFeeUsd) / traditionalFeeUsd) * 100;

  return (
    <div className="rounded-2xl border border-emerald-500/20 bg-gradient-to-br from-slate-900/90 via-emerald-950/10 to-slate-900/90 p-4 shadow-xl">
      <div className="flex items-center gap-2 mb-3">
        <Sparkles className="w-5 h-5 text-emerald-400 animate-pulse" />
        <h4 className="text-sm font-semibold text-emerald-400 tracking-tight">Remittance Fee Savings</h4>
      </div>

      <div className="grid grid-cols-2 gap-4 mb-3">
        <div className="p-3 rounded-xl bg-slate-950/40 border border-white/5">
          <p className="text-[10px] uppercase text-slate-500 font-medium mb-1">Traditional Cost (5.5%)</p>
          <p className="text-sm font-bold text-rose-400">${traditionalFeeUsd.toFixed(2)}</p>
          <p className="text-[10px] text-rose-400/80">₱{traditionalFeePhp.toLocaleString('en-US', { maximumFractionDigits: 2 })} PHP</p>
        </div>
        <div className="p-3 rounded-xl bg-emerald-950/20 border border-emerald-500/10">
          <p className="text-[10px] uppercase text-emerald-500/70 font-medium mb-1">CoreFlow on Stellar</p>
          <p className="text-sm font-bold text-emerald-400">${coreFlowFeeUsd.toFixed(3)}</p>
          <p className="text-[10px] text-emerald-400/80">₱{coreFlowFeePhp.toFixed(2)} PHP</p>
        </div>
      </div>

      <div className="flex items-center justify-between p-3 rounded-xl bg-emerald-500/10 border border-emerald-500/20">
        <div>
          <p className="text-[10px] text-emerald-300 font-medium uppercase">Net Amount Saved</p>
          <p className="text-lg font-extrabold text-emerald-400">
            ${savedUsd.toFixed(2)} <span className="text-xs font-semibold text-emerald-300">({savingsPercent.toFixed(1)}%)</span>
          </p>
        </div>
        <div className="text-right">
          <p className="text-[10px] text-emerald-300 font-medium uppercase">PHP Value</p>
          <p className="text-lg font-extrabold text-emerald-400">
            ₱{savedPhp.toLocaleString('en-US', { maximumFractionDigits: 2 })}
          </p>
        </div>
      </div>
    </div>
  );
};
