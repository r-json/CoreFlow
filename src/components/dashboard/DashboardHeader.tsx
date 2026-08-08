import { RefreshCw, LogOut, LogIn, ShieldCheck, Crown, Users, Mail, ScrollText } from 'lucide-react';
import type { UserRole } from '@/hooks/useAuth';
import { STELLAR_CONFIG } from '@/lib/config';
import Link from 'next/link';

interface DashboardHeaderProps {
  isContractConfigured: boolean;
  isMockMode: boolean;
  isLoading: boolean;
  onToggleMode: (useMock: boolean) => void;
  onRefresh: () => void;
  isAuthenticated: boolean;
  walletAddress: string;
  role: UserRole;
  onSignIn: () => void;
  onSignOut: () => void;
}

const ROLE_LABELS: Record<UserRole, string> = {
  ADMIN: 'Admin',
  EMPLOYEE: 'Employee',
};

const ROLE_COLORS: Record<UserRole, string> = {
  ADMIN: 'text-amber-400 border-amber-500/30 bg-amber-500/10',
  EMPLOYEE: 'text-sky-400 border-sky-500/30 bg-sky-500/10',
};

const ROLE_ICONS: Record<UserRole, typeof ShieldCheck> = {
  ADMIN: Crown,
  EMPLOYEE: ShieldCheck,
};

export function DashboardHeader({
  isContractConfigured,
  isMockMode,
  isLoading,
  onToggleMode,
  onRefresh,
  isAuthenticated,
  walletAddress,
  role,
  onSignIn,
  onSignOut,
}: DashboardHeaderProps) {
  const companyName = process.env.NEXT_PUBLIC_COMPANY_NAME || 'CoreFlow';
  const networkName = (STELLAR_CONFIG.contract.network || 'public').toUpperCase();

  const truncatedAddress = walletAddress
    ? `${walletAddress.slice(0, 6)}...${walletAddress.slice(-4)}`
    : '';

  const RoleIcon = ROLE_ICONS[role];

  return (
    <header className="sticky top-0 z-40 border-b border-violet-500/10 bg-slate-950/85 backdrop-blur-xl shadow-md shadow-black/10">
      <div className="max-w-7xl mx-auto px-6 py-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="relative w-9 h-9 flex items-center justify-center">
            <div className="absolute inset-0 bg-violet-600/20 blur-md rounded-full animate-pulse-glow" />
            <svg
              className="w-9 h-9 text-violet-500 relative z-10 animate-float"
              viewBox="0 0 32 32"
              fill="none"
              xmlns="http://www.w3.org/2000/svg"
            >
              <defs>
                <linearGradient id="logo-grad-1" x1="0%" y1="0%" x2="100%" y2="100%">
                  <stop offset="0%" stopColor="#8b5cf6" />
                  <stop offset="100%" stopColor="#3b82f6" />
                </linearGradient>
                <linearGradient id="logo-grad-2" x1="100%" y1="0%" x2="0%" y2="100%">
                  <stop offset="0%" stopColor="#10b981" />
                  <stop offset="100%" stopColor="#06b6d4" />
                </linearGradient>
              </defs>
              <circle cx="16" cy="16" r="13" className="stroke-slate-800/80 fill-slate-900/60" strokeWidth="1.5" />
              <path
                d="M10 12C12 9 17 9 20 12C23 15 23 17 20 20C17 23 12 23 10 20"
                stroke="url(#logo-grad-1)"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
              <path
                d="M22 20C20 23 15 23 12 20C9 17 9 15 12 12C15 9 20 9 22 12"
                stroke="url(#logo-grad-2)"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeDasharray="4 2"
              />
              <circle cx="16" cy="16" r="3" className="fill-violet-400 animate-pulse" />
            </svg>
          </div>
          <div>
            <h1 className="text-lg font-extrabold tracking-tight text-white flex items-center gap-1.5">
              {companyName}
              <span className="text-[9px] bg-violet-500/10 border border-violet-500/20 text-violet-400 font-bold px-1.5 py-0.5 rounded uppercase tracking-wide">
                Soroban Escrow
              </span>
              {/* Network Indicator */}
              <span className="text-[9px] bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 font-mono font-bold px-1.5 py-0.5 rounded">
                Network: {networkName}
              </span>
            </h1>
            <p className="text-[10px] text-slate-400">On-Chain Accounts Payable &amp; Remittance</p>
          </div>
        </div>

        <div className="flex items-center gap-3">
          {/* Admin Links */}
          {isAuthenticated && role === 'ADMIN' && (
            <div className="flex items-center gap-2">
              <Link
                href="/dashboard/admin/invitations"
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold border border-violet-500/30 bg-violet-500/10 hover:bg-violet-500/20 text-violet-300 transition-colors shadow-sm"
                title="Send Employee Invitations"
              >
                <Mail className="w-3.5 h-3.5 text-violet-400" />
                Invite Team
              </Link>
              <Link
                href="/dashboard/admin/users"
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold border border-amber-500/30 bg-amber-500/10 hover:bg-amber-500/20 text-amber-300 transition-colors shadow-sm"
                title="Admin User Management Panel"
              >
                <Users className="w-3.5 h-3.5 text-amber-400" />
                User Directory
              </Link>
              <Link
                href="/dashboard/admin/audit-logs"
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold border border-slate-600/30 bg-slate-700/10 hover:bg-slate-700/20 text-slate-300 transition-colors shadow-sm"
                title="View Audit Logs"
              >
                <ScrollText className="w-3.5 h-3.5 text-slate-400" />
                Audit Logs
              </Link>
            </div>
          )}

          {isContractConfigured && (
            <div className="flex items-center gap-1 bg-slate-900/80 border border-slate-800 rounded-xl p-1 text-xs">
              <button
                type="button"
                onClick={() => onToggleMode(false)}
                className={`px-3 py-1.5 rounded-lg font-medium transition-all ${
                  !isMockMode
                    ? 'bg-violet-600 text-white shadow-md'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                Live On-Chain
              </button>
              <button
                type="button"
                onClick={() => onToggleMode(true)}
                className={`px-3 py-1.5 rounded-lg font-medium transition-all ${
                  isMockMode
                    ? 'bg-amber-600/90 text-white shadow-md'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                Mock Demo
              </button>
            </div>
          )}

          <button
            type="button"
            onClick={onRefresh}
            aria-label="Refresh contract records"
            className="p-2 rounded-lg border border-slate-800 hover:border-slate-700 bg-slate-900/60 text-slate-400 hover:text-slate-200 transition-colors"
            title="Refresh contract records"
          >
            <RefreshCw className={`w-4 h-4 ${isLoading ? 'animate-spin' : ''}`} aria-hidden="true" />
          </button>

          {isAuthenticated ? (
            <div className="flex items-center gap-2">
              <span className={`text-[10px] font-bold px-2 py-1 rounded-lg border ${ROLE_COLORS[role]}`}>
                <RoleIcon className="w-3 h-3 inline mr-1" />
                {ROLE_LABELS[role]}
              </span>
              <span className="text-xs font-mono text-slate-400 bg-slate-900/80 border border-slate-700 px-2.5 py-1.5 rounded-lg">
                {truncatedAddress}
              </span>
              <button
                onClick={onSignOut}
                disabled={isLoading}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold border border-slate-700 bg-slate-900/80 hover:bg-rose-950/30 hover:border-rose-500/30 text-slate-400 hover:text-rose-400 transition-colors"
              >
                <LogOut className="w-3.5 h-3.5" />
                Sign Out
              </button>
            </div>
          ) : (
            <button
              onClick={onSignIn}
              disabled={isLoading}
              className="flex items-center gap-1.5 px-4 py-2 rounded-xl text-xs font-bold bg-gradient-to-r from-violet-600 to-indigo-600 hover:from-violet-500 hover:to-indigo-500 text-white transition-colors shadow-md shadow-violet-500/20 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <LogIn className="w-3.5 h-3.5" />
              {isLoading ? 'Signing in…' : 'Connect & Sign In'}
            </button>
          )}
        </div>
      </div>
    </header>
  );
}
