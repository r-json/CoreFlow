'use client';

import { useAuth } from '@/hooks/useAuth';
import { Sidebar, NavItem } from '@/components/dashboard/Sidebar';
import { Breadcrumbs } from '@/components/dashboard/Breadcrumbs';
import {
  Crown,
  LayoutDashboard,
  Users,
  ShieldCheck,
  ScrollText,
  Settings,
  ShieldAlert,
  Mail,
  ArrowLeft,
  LogIn,
  RefreshCw,
} from 'lucide-react';
import Link from 'next/link';

const ADMIN_NAV_ITEMS: NavItem[] = [
  {
    label: 'Overview',
    href: '/dashboard/admin',
    icon: <LayoutDashboard className="w-4 h-4" />,
  },
  {
    label: 'Escrow Management',
    href: '/dashboard/admin/escrows',
    icon: <ShieldCheck className="w-4 h-4" />,
  },
  {
    label: 'User Management',
    href: '/dashboard/admin/users',
    icon: <Users className="w-4 h-4" />,
  },
  {
    label: 'Invitations',
    href: '/dashboard/admin/invitations',
    icon: <Mail className="w-4 h-4" />,
  },
  {
    label: 'Audit Logs',
    href: '/dashboard/admin/audit-logs',
    icon: <ScrollText className="w-4 h-4" />,
  },
  {
    label: 'Settings',
    href: '/dashboard/admin/settings',
    icon: <Settings className="w-4 h-4" />,
  },
];

export default function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const auth = useAuth();

  // Loading state
  if (auth.isLoading) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-950 via-purple-950/60 to-slate-950 text-slate-100 flex items-center justify-center">
        <div className="text-center">
          <RefreshCw className="w-8 h-8 animate-spin text-amber-400 mx-auto mb-3" />
          <p className="text-sm text-slate-400 font-medium">
            Verifying admin session...
          </p>
        </div>
      </div>
    );
  }

  // Not authenticated
  if (!auth.isAuthenticated) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-950 via-purple-950/60 to-slate-950 text-slate-100 flex items-center justify-center">
        <div className="max-w-md w-full mx-auto px-6">
          <div className="rounded-2xl border border-white/10 bg-slate-900/60 backdrop-blur-2xl p-8 shadow-2xl shadow-black/40 text-center">
            <div className="w-16 h-16 rounded-2xl bg-amber-500/10 border border-amber-500/30 text-amber-400 flex items-center justify-center mx-auto mb-5">
              <Crown className="w-8 h-8" />
            </div>
            <h1 className="text-2xl font-black text-white mb-2">Admin Access</h1>
            <p className="text-sm text-slate-400 mb-6">
              Connect your admin wallet to access full operational controls.
            </p>
            {auth.error && (
              <div className="mb-4 p-3 rounded-xl border border-rose-500/20 bg-rose-950/20">
                <p className="text-xs text-rose-300 font-medium">{auth.error}</p>
              </div>
            )}
            <button
              onClick={auth.signIn}
              disabled={auth.isLoading}
              className="w-full py-3.5 px-4 rounded-xl text-sm font-bold bg-gradient-to-r from-amber-600 to-orange-600 hover:from-amber-500 hover:to-orange-500 text-white transition-all shadow-lg shadow-amber-500/20 flex items-center justify-center gap-2 disabled:opacity-50"
            >
              <LogIn className="w-4 h-4" />
              Connect Freighter Wallet & Sign In
            </button>
            <Link
              href="/"
              className="inline-flex items-center gap-1.5 mt-4 text-xs text-slate-500 hover:text-slate-300 transition-colors"
            >
              <ArrowLeft className="w-3 h-3" />
              Back to role selection
            </Link>
          </div>
        </div>
      </div>
    );
  }

  // Not admin
  if (!auth.isAdmin) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-950 via-purple-950/60 to-slate-950 text-slate-100 flex items-center justify-center">
        <div className="max-w-md w-full mx-auto px-6">
          <div className="rounded-2xl border border-rose-500/20 bg-slate-900/60 backdrop-blur-2xl p-8 shadow-2xl text-center">
            <ShieldAlert className="w-12 h-12 text-rose-400 mx-auto mb-4" />
            <h1 className="text-xl font-extrabold text-white mb-2">
              Access Denied
            </h1>
            <p className="text-sm text-slate-400 mb-2">
              Your wallet{' '}
              <span className="font-mono text-white">
                {auth.walletAddress.slice(0, 8)}...{auth.walletAddress.slice(-4)}
              </span>{' '}
              is registered as{' '}
              <span className="font-bold text-sky-400">EMPLOYEE</span>.
            </p>
            <p className="text-sm text-slate-400 mb-6">
              Admin privileges are required to access this panel.
            </p>
            <div className="flex flex-col gap-3">
              <Link
                href="/dashboard/employee"
                className="w-full py-3 px-4 bg-gradient-to-r from-sky-600 to-blue-600 hover:from-sky-500 hover:to-blue-500 text-white rounded-xl text-sm font-bold transition-all shadow-lg shadow-sky-500/20 flex items-center justify-center gap-2"
              >
                <Users className="w-4 h-4" />
                Continue as Employee
              </Link>
              <Link
                href="/"
                className="text-xs text-slate-500 hover:text-slate-300 transition-colors"
              >
                ← Back to landing page
              </Link>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-950 via-purple-950/60 to-slate-950 text-slate-100 flex font-sans">
      <Sidebar
        title="Admin Panel"
        subtitle="CoreFlow Operations"
        navItems={ADMIN_NAV_ITEMS}
        accentColor="amber"
        roleIcon={<Crown className="w-4.5 h-4.5 text-amber-400" />}
        walletAddress={auth.walletAddress}
        role={auth.role}
        onSignOut={auth.signOut}
      />
      <main className="flex-1 min-h-screen overflow-y-auto pt-4 lg:pt-0">
        <div className="px-8 pt-6">
          <Breadcrumbs />
        </div>
        {children}
      </main>
    </div>
  );
}
