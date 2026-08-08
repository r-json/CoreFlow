'use client';

import { useState } from 'react';
import { useAuth } from '@/hooks/useAuth';
import { STELLAR_CONFIG } from '@/lib/config';
import {
  Settings,
  Globe,
  Key,
  Shield,
  AlertOctagon,
  CheckCircle2,
  ExternalLink,
  Copy,
  AlertCircle,
} from 'lucide-react';

export default function AdminSettingsPage() {
  const auth = useAuth();
  const [isPauseLoading, setIsPauseLoading] = useState(false);
  const [pauseResult, setPauseResult] = useState<string | null>(null);
  const [copiedField, setCopiedField] = useState<string | null>(null);

  const contractId = STELLAR_CONFIG.contract.id || 'Not configured';
  const networkName = (STELLAR_CONFIG.contract.network || 'public').toUpperCase();
  const tokenId = STELLAR_CONFIG.token?.id || 'Not configured';
  const rpcUrl = STELLAR_CONFIG.getRpcUrl() || 'Not configured';

  const handleCopy = (text: string, field: string) => {
    navigator.clipboard.writeText(text);
    setCopiedField(field);
    setTimeout(() => setCopiedField(null), 2000);
  };

  const handleEmergencyPause = async () => {
    if (!confirm('⚠️ Are you sure you want to PAUSE the contract? This will halt all escrow operations until resumed.')) {
      return;
    }
    setIsPauseLoading(true);
    setPauseResult(null);
    try {
      const res = await fetch('/api/admin/contract/pause', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          paused: true,
          reason: 'Emergency pause requested from admin settings',
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'Failed to pause contract');
      }
      setPauseResult('Contract paused successfully');
    } catch (err) {
      setPauseResult(err instanceof Error ? err.message : 'Failed to pause');
    } finally {
      setIsPauseLoading(false);
    }
  };

  return (
    <div className="max-w-4xl mx-auto px-8 py-8">
      {/* Page Header */}
      <div className="mb-8">
        <h1 className="text-2xl font-black tracking-tight text-white flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-slate-700/20 border border-slate-600/30 flex items-center justify-center">
            <Settings className="w-5 h-5 text-slate-400" />
          </div>
          System Settings
        </h1>
        <p className="text-sm text-slate-400 mt-1">
          Contract configuration, network details, and emergency controls
        </p>
      </div>

      <div className="space-y-6">
        {/* Network Configuration */}
        <div className="rounded-2xl border border-white/10 bg-slate-900/40 backdrop-blur-xl overflow-hidden shadow-2xl">
          <div className="px-6 py-4 border-b border-white/5 bg-slate-900/60 flex items-center gap-2">
            <Globe className="w-4 h-4 text-emerald-400" />
            <h2 className="text-xs font-extrabold uppercase tracking-wider text-slate-300">
              Network & Contract Configuration
            </h2>
          </div>
          <div className="p-6 space-y-4">
            <ConfigRow
              label="Stellar Network"
              value={networkName}
              badge
              badgeColor={networkName === 'PUBLIC' ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400' : 'bg-amber-500/10 border-amber-500/30 text-amber-400'}
            />
            <ConfigRow
              label="Contract ID"
              value={contractId}
              mono
              onCopy={() => handleCopy(contractId, 'contractId')}
              isCopied={copiedField === 'contractId'}
              explorerLink={
                contractId !== 'Not configured'
                  ? `https://stellar.expert/explorer/public/contract/${contractId}`
                  : undefined
              }
            />
            <ConfigRow
              label="Settlement Token (USDC)"
              value={tokenId}
              mono
              onCopy={() => handleCopy(tokenId, 'tokenId')}
              isCopied={copiedField === 'tokenId'}
            />
            <ConfigRow
              label="RPC Endpoint"
              value={rpcUrl}
              mono
              onCopy={() => handleCopy(rpcUrl, 'rpcUrl')}
              isCopied={copiedField === 'rpcUrl'}
            />
          </div>
        </div>

        {/* Session Info */}
        <div className="rounded-2xl border border-white/10 bg-slate-900/40 backdrop-blur-xl overflow-hidden shadow-2xl">
          <div className="px-6 py-4 border-b border-white/5 bg-slate-900/60 flex items-center gap-2">
            <Key className="w-4 h-4 text-violet-400" />
            <h2 className="text-xs font-extrabold uppercase tracking-wider text-slate-300">
              Session & Identity
            </h2>
          </div>
          <div className="p-6 space-y-4">
            <ConfigRow
              label="Wallet Address"
              value={auth.walletAddress || 'Not connected'}
              mono
              onCopy={auth.walletAddress ? () => handleCopy(auth.walletAddress, 'wallet') : undefined}
              isCopied={copiedField === 'wallet'}
            />
            <ConfigRow
              label="Assigned Role"
              value={auth.role}
              badge
              badgeColor={
                auth.role === 'ADMIN'
                  ? 'bg-amber-500/10 border-amber-500/30 text-amber-400'
                  : 'bg-sky-500/10 border-sky-500/30 text-sky-400'
              }
            />
            <ConfigRow
              label="Auth Status"
              value={auth.isAuthenticated ? 'Authenticated' : 'Not authenticated'}
              badge
              badgeColor={
                auth.isAuthenticated
                  ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400'
                  : 'bg-rose-500/10 border-rose-500/30 text-rose-400'
              }
            />
          </div>
        </div>

        {/* Emergency Controls */}
        <div className="rounded-2xl border border-rose-500/20 bg-slate-900/40 backdrop-blur-xl overflow-hidden shadow-2xl">
          <div className="px-6 py-4 border-b border-rose-500/10 bg-rose-950/10 flex items-center gap-2">
            <Shield className="w-4 h-4 text-rose-400" />
            <h2 className="text-xs font-extrabold uppercase tracking-wider text-rose-300">
              Emergency Controls
            </h2>
          </div>
          <div className="p-6">
            <div className="p-4 rounded-xl border border-rose-500/20 bg-rose-950/10 mb-4">
              <div className="flex items-start gap-3">
                <AlertOctagon className="w-5 h-5 text-rose-500 shrink-0 mt-0.5" />
                <div>
                  <p className="text-xs font-bold text-rose-300 mb-1">
                    Emergency Contract Pause
                  </p>
                  <p className="text-[11px] text-slate-400 leading-relaxed">
                    Immediately halts all escrow operations on the Soroban contract.
                    This is an irreversible action that requires admin intervention
                    to resume. Use only in case of security breach or critical bug.
                  </p>
                </div>
              </div>
            </div>

            {pauseResult && (
              <div className="mb-4 p-3 rounded-xl border border-amber-500/20 bg-amber-950/10 flex items-center gap-2">
                <AlertCircle className="w-4 h-4 text-amber-400 shrink-0" />
                <p className="text-xs text-amber-300 font-medium">{pauseResult}</p>
              </div>
            )}

            <button
              onClick={handleEmergencyPause}
              disabled={isPauseLoading}
              className="flex items-center gap-2 px-5 py-3 rounded-xl text-sm font-bold text-rose-400 hover:text-white bg-rose-950/30 hover:bg-rose-600 border border-rose-500/30 hover:border-rose-500 transition-all shadow-lg disabled:opacity-50"
            >
              <AlertOctagon className={`w-4 h-4 ${isPauseLoading ? 'animate-spin' : 'animate-pulse'}`} />
              {isPauseLoading ? 'Pausing...' : '🚨 Emergency Pause Contract'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function ConfigRow({
  label,
  value,
  mono,
  badge,
  badgeColor,
  onCopy,
  isCopied,
  explorerLink,
}: {
  label: string;
  value: string;
  mono?: boolean;
  badge?: boolean;
  badgeColor?: string;
  onCopy?: () => void;
  isCopied?: boolean;
  explorerLink?: string;
}) {
  return (
    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 py-2 border-b border-white/5 last:border-0">
      <p className="text-xs text-slate-500 font-bold uppercase tracking-wider shrink-0">
        {label}
      </p>
      <div className="flex items-center gap-2">
        {badge ? (
          <span
            className={`text-[10px] font-bold px-2.5 py-1 rounded-lg border ${
              badgeColor || 'bg-slate-500/10 border-slate-500/30 text-slate-400'
            }`}
          >
            {value}
          </span>
        ) : (
          <span
            className={`text-xs text-slate-300 select-all break-all ${
              mono ? 'font-mono' : ''
            }`}
          >
            {value.length > 40 ? `${value.slice(0, 20)}...${value.slice(-10)}` : value}
          </span>
        )}
        {onCopy && (
          <button
            onClick={onCopy}
            className="p-1 rounded-lg hover:bg-slate-800 text-slate-500 hover:text-slate-300 transition-colors"
            title="Copy to clipboard"
          >
            {isCopied ? (
              <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
            ) : (
              <Copy className="w-3.5 h-3.5" />
            )}
          </button>
        )}
        {explorerLink && (
          <a
            href={explorerLink}
            target="_blank"
            rel="noopener noreferrer"
            className="p-1 rounded-lg hover:bg-slate-800 text-slate-500 hover:text-violet-400 transition-colors"
            title="View on Stellar Expert"
          >
            <ExternalLink className="w-3.5 h-3.5" />
          </a>
        )}
      </div>
    </div>
  );
}
