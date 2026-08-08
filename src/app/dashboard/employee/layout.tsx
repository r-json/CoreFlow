'use client';

import { useAuth } from '@/hooks/useAuth';
import { Sidebar, NavItem } from '@/components/dashboard/Sidebar';
import { Breadcrumbs } from '@/components/dashboard/Breadcrumbs';
import {
  Users,
  LayoutDashboard,
  ShieldCheck,
  Clock,
  DollarSign,
  User,
  ArrowLeft,
  LogIn,
  RefreshCw,
} from 'lucide-react';
import Link from 'next/link';

const EMPLOYEE_NAV_ITEMS: NavItem[] = [
  {
    label: 'Overview',
    href: '/dashboard/employee',
    icon: <LayoutDashboard className="w-4 h-4" />,
  },
  {
    label: 'My Escrows',
    href: '/dashboard/employee/escrows',
    icon: <ShieldCheck className="w-4 h-4" />,
  },
  {
    label: 'Hours Log',
    href: '/dashboard/employee/hours',
    icon: <Clock className="w-4 h-4" />,
  },
  {
    label: 'Payments',
    href: '/dashboard/employee/payments',
    icon: <DollarSign className="w-4 h-4" />,
  },
  {
    label: 'My Profile',
    href: '/dashboard/employee/profile',
    icon: <User className="w-4 h-4" />,
  },
];

export default function EmployeeLayout({
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
          <RefreshCw className="w-8 h-8 animate-spin text-sky-400 mx-auto mb-3" />
          <p className="text-sm text-slate-400 font-medium">
            Verifying employee session...
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
            <div className="w-16 h-16 rounded-2xl bg-sky-500/10 border border-sky-500/30 text-sky-400 flex items-center justify-center mx-auto mb-5">
              <Users className="w-8 h-8" />
            </div>
            <h1 className="text-2xl font-black text-white mb-2">
              Employee Access
            </h1>
            <p className="text-sm text-slate-400 mb-6">
              Connect your employee wallet to view escrows, submit work hours,
              and track your payment status.
            </p>
            {auth.error && (
              <div className="mb-4 p-3 rounded-xl border border-rose-500/20 bg-rose-950/20">
                <p className="text-xs text-rose-300 font-medium">{auth.error}</p>
              </div>
            )}
            <button
              onClick={auth.signIn}
              disabled={auth.isLoading}
              className="w-full py-3.5 px-4 rounded-xl text-sm font-bold bg-gradient-to-r from-sky-600 to-blue-600 hover:from-sky-500 hover:to-blue-500 text-white transition-all shadow-lg shadow-sky-500/20 flex items-center justify-center gap-2 disabled:opacity-50"
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

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-950 via-purple-950/60 to-slate-950 text-slate-100 flex font-sans">
      <Sidebar
        title="Employee Portal"
        subtitle="CoreFlow Worker Hub"
        navItems={EMPLOYEE_NAV_ITEMS}
        accentColor="sky"
        roleIcon={<Users className="w-4.5 h-4.5 text-sky-400" />}
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
