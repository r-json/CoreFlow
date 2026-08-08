'use client';

import { useState, useEffect } from 'react';
import { useAuth } from '@/hooks/useAuth';
import { useDashboard } from '@/hooks/useDashboard';
import {
  User,
  Wallet,
  ShieldCheck,
  Clock,
  DollarSign,
  Copy,
  CheckCircle2,
  ExternalLink,
  CalendarDays,
  TrendingUp,
  RefreshCw,
} from 'lucide-react';

interface UserProfile {
  id: string;
  walletAddress: string;
  role: string;
  createdAt: string;
  updatedAt: string;
}

export default function EmployeeProfilePage() {
  const auth = useAuth();
  const { state } = useDashboard({
    isAuthenticated: auth.isAuthenticated,
    walletAddress: auth.walletAddress,
  });

  const { escrows } = state;

  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [copiedField, setCopiedField] = useState<string | null>(null);

  const fetchProfile = async () => {
    setIsLoading(true);
    try {
      const res = await fetch('/api/auth/profile');
      if (res.ok) {
        const data = await res.json();
        setProfile(data.user);
      }
    } catch (err) {
      console.error('Failed to load profile:', err);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    if (auth.isAuthenticated) {
      fetchProfile();
    }
  }, [auth.isAuthenticated]);

  const handleCopy = (text: string, field: string) => {
    navigator.clipboard.writeText(text);
    setCopiedField(field);
    setTimeout(() => setCopiedField(null), 2000);
  };

  const USD_TO_PHP = 56.5;

  // Compute stats from escrow data
  const totalEscrows = escrows.length;
  const totalPaid = escrows.filter((e) => e.status === 'paid').length;
  const totalHours = escrows.reduce((sum, e) => sum + (parseInt(e.hoursLogged) || 0), 0);
  const totalEarned = escrows
    .filter((e) => e.status === 'paid')
    .reduce((sum, e) => sum + (parseFloat(e.amount.replace(/,/g, '')) || 0), 0);
  const totalFeeSaved = totalEarned * 0.055 - 0.001 * totalPaid;

  const memberSince = profile
    ? new Date(profile.createdAt).toLocaleDateString('en-US', {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
      })
    : '—';

  return (
    <div className="max-w-4xl mx-auto px-8 py-8">
      {/* Page Header */}
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-black tracking-tight text-white flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-violet-500/10 border border-violet-500/30 flex items-center justify-center">
              <User className="w-5 h-5 text-violet-400" />
            </div>
            My Profile
          </h1>
          <p className="text-sm text-slate-400 mt-1">
            Account details, wallet info, and career summary
          </p>
        </div>
        <button
          onClick={fetchProfile}
          disabled={isLoading}
          className="flex items-center gap-1.5 px-4 py-2 rounded-xl text-xs font-bold border border-slate-700 bg-slate-900/80 hover:bg-slate-800 text-slate-300 transition-colors"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${isLoading ? 'animate-spin' : ''}`} />
          Refresh
        </button>
      </div>

      <div className="space-y-6">
        {/* Identity Card */}
        <div className="rounded-2xl border border-white/10 bg-slate-900/40 backdrop-blur-xl overflow-hidden shadow-2xl">
          <div className="px-6 py-4 border-b border-white/5 bg-slate-900/60 flex items-center gap-2">
            <Wallet className="w-4 h-4 text-sky-400" />
            <h2 className="text-xs font-extrabold uppercase tracking-wider text-slate-300">
              Wallet & Identity
            </h2>
          </div>
          <div className="p-6 space-y-4">
            {isLoading ? (
              <div className="space-y-3">
                {[1, 2, 3].map((i) => (
                  <div key={i} className="h-6 bg-slate-800/50 rounded-lg animate-pulse" />
                ))}
              </div>
            ) : (
              <>
                <ProfileRow
                  label="Wallet Address"
                  value={auth.walletAddress || '—'}
                  mono
                  onCopy={() => handleCopy(auth.walletAddress, 'wallet')}
                  isCopied={copiedField === 'wallet'}
                  explorerLink={
                    auth.walletAddress
                      ? `https://stellar.expert/explorer/public/account/${auth.walletAddress}`
                      : undefined
                  }
                />
                <ProfileRow
                  label="Assigned Role"
                  value={auth.role}
                  badge
                  badgeColor={
                    auth.role === 'ADMIN'
                      ? 'bg-amber-500/10 border-amber-500/30 text-amber-400'
                      : 'bg-sky-500/10 border-sky-500/30 text-sky-400'
                  }
                />
                <ProfileRow
                  label="Account ID"
                  value={profile?.id || '—'}
                  mono
                />
                <ProfileRow
                  label="Member Since"
                  value={memberSince}
                  icon={<CalendarDays className="w-3.5 h-3.5 text-slate-500" />}
                />
              </>
            )}
          </div>
        </div>

        {/* Career Summary */}
        <div className="rounded-2xl border border-white/10 bg-slate-900/40 backdrop-blur-xl overflow-hidden shadow-2xl">
          <div className="px-6 py-4 border-b border-white/5 bg-slate-900/60 flex items-center gap-2">
            <TrendingUp className="w-4 h-4 text-emerald-400" />
            <h2 className="text-xs font-extrabold uppercase tracking-wider text-slate-300">
              Career Summary
            </h2>
          </div>
          <div className="p-6">
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
              <SummaryCard
                label="Total Escrows"
                value={totalEscrows.toString()}
                icon={<ShieldCheck className="w-4 h-4 text-violet-400" />}
                gradient="from-violet-400 to-indigo-300"
              />
              <SummaryCard
                label="Payments Received"
                value={totalPaid.toString()}
                icon={<CheckCircle2 className="w-4 h-4 text-emerald-400" />}
                gradient="from-emerald-400 to-teal-300"
              />
              <SummaryCard
                label="Hours Logged"
                value={`${totalHours}`}
                icon={<Clock className="w-4 h-4 text-sky-400" />}
                gradient="from-sky-400 to-blue-300"
              />
              <SummaryCard
                label="Total Earned"
                value={`$${totalEarned.toLocaleString(undefined, { minimumFractionDigits: 2 })}`}
                icon={<DollarSign className="w-4 h-4 text-amber-400" />}
                gradient="from-amber-400 to-orange-300"
              />
            </div>

            {/* Extended Stats */}
            <div className="mt-6 grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="p-4 rounded-xl border border-white/5 bg-slate-900/30">
                <p className="text-[10px] text-slate-500 uppercase font-bold tracking-wider mb-1">
                  PHP Equivalent Earned
                </p>
                <p className="text-lg font-black text-white">
                  ₱{(totalEarned * USD_TO_PHP).toLocaleString(undefined, { maximumFractionDigits: 0 })}
                </p>
                <p className="text-[10px] text-slate-500 font-mono">at 1 USDC = ₱{USD_TO_PHP}</p>
              </div>
              <div className="p-4 rounded-xl border border-white/5 bg-slate-900/30">
                <p className="text-[10px] text-slate-500 uppercase font-bold tracking-wider mb-1">
                  Remittance Fees Saved
                </p>
                <p className="text-lg font-black text-emerald-400">
                  ${totalFeeSaved > 0 ? totalFeeSaved.toFixed(2) : '0.00'}
                </p>
                <p className="text-[10px] text-slate-500 font-mono">vs. traditional wire transfer</p>
              </div>
            </div>
          </div>
        </div>

        {/* Security Info */}
        <div className="rounded-2xl border border-white/10 bg-slate-900/40 backdrop-blur-xl overflow-hidden shadow-2xl">
          <div className="px-6 py-4 border-b border-white/5 bg-slate-900/60 flex items-center gap-2">
            <ShieldCheck className="w-4 h-4 text-violet-400" />
            <h2 className="text-xs font-extrabold uppercase tracking-wider text-slate-300">
              Security & Session
            </h2>
          </div>
          <div className="p-6 space-y-3">
            <div className="p-4 rounded-xl border border-violet-500/20 bg-violet-950/10">
              <p className="text-xs text-violet-300 font-medium leading-relaxed">
                🔒 Your session is secured via JWT cookie with Ed25519 wallet signature verification.
                All transactions are cryptographically signed via your Freighter wallet.
                Your private key never leaves your browser.
              </p>
            </div>
            <ProfileRow
              label="Auth Method"
              value="Freighter Wallet (Ed25519)"
              badge
              badgeColor="bg-violet-500/10 border-violet-500/30 text-violet-400"
            />
            <ProfileRow
              label="Session Status"
              value={auth.isAuthenticated ? 'Active' : 'Inactive'}
              badge
              badgeColor={
                auth.isAuthenticated
                  ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400'
                  : 'bg-rose-500/10 border-rose-500/30 text-rose-400'
              }
            />
          </div>
        </div>
      </div>
    </div>
  );
}

function ProfileRow({
  label,
  value,
  mono,
  badge,
  badgeColor,
  icon,
  onCopy,
  isCopied,
  explorerLink,
}: {
  label: string;
  value: string;
  mono?: boolean;
  badge?: boolean;
  badgeColor?: string;
  icon?: React.ReactNode;
  onCopy?: () => void;
  isCopied?: boolean;
  explorerLink?: string;
}) {
  return (
    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 py-2 border-b border-white/5 last:border-0">
      <p className="text-xs text-slate-500 font-bold uppercase tracking-wider shrink-0 flex items-center gap-1.5">
        {icon}
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
            {value.length > 40
              ? `${value.slice(0, 20)}...${value.slice(-10)}`
              : value}
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

function SummaryCard({
  label,
  value,
  icon,
  gradient,
}: {
  label: string;
  value: string;
  icon: React.ReactNode;
  gradient: string;
}) {
  return (
    <div className="p-4 rounded-xl border border-white/5 bg-slate-900/30 hover:border-white/10 transition-colors group">
      <div className="flex items-center justify-between mb-1.5">
        <div className="p-1.5 rounded-lg bg-slate-900/80 border border-white/5 group-hover:scale-110 transition-transform">
          {icon}
        </div>
      </div>
      <p
        className={`text-xl font-black tracking-tight bg-gradient-to-r ${gradient} bg-clip-text text-transparent`}
      >
        {value}
      </p>
      <p className="text-[9px] text-slate-500 uppercase font-bold tracking-wider mt-0.5">
        {label}
      </p>
    </div>
  );
}
