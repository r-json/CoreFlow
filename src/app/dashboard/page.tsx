'use client';

import { Suspense, useEffect } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import { useAuth } from '@/hooks/useAuth';
import { ShieldAlert, ArrowLeft, Crown, Users, LogIn, RefreshCw } from 'lucide-react';
import Link from 'next/link';

function DashboardContent() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const auth = useAuth();

  const accessParam = searchParams.get('access');

  // Once authenticated, redirect to role-specific dashboard
  useEffect(() => {
    if (!auth.isLoading && auth.isAuthenticated) {
      if (accessParam === 'admin' && auth.isAdmin) {
        router.replace('/dashboard/admin');
      } else if (accessParam === 'admin' && !auth.isAdmin) {
        // Role mismatch — stay on this page to show the mismatch screen
        return;
      } else {
        // Employee access or default
        router.replace('/dashboard/employee');
      }
    }
  }, [auth.isLoading, auth.isAuthenticated, auth.isAdmin, accessParam, router]);

  // No access param and not authenticated → redirect to landing
  if (!accessParam && !auth.isAuthenticated && !auth.isLoading) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-950 via-purple-950/60 to-slate-950 text-slate-100 flex items-center justify-center">
        <div className="text-center max-w-md mx-auto px-6">
          <ShieldAlert className="w-12 h-12 text-violet-400 mx-auto mb-4" />
          <h1 className="text-xl font-extrabold text-white mb-2">Select Access Mode</h1>
          <p className="text-sm text-slate-400 mb-6">Please choose your access type from the landing page.</p>
          <Link
            href="/"
            className="inline-flex items-center gap-2 px-5 py-3 rounded-xl font-semibold bg-gradient-to-r from-violet-600 to-indigo-600 hover:from-violet-500 hover:to-indigo-500 text-white transition-colors shadow-lg shadow-violet-500/20"
          >
            <ArrowLeft className="w-4 h-4" />
            Go to Landing Page
          </Link>
        </div>
      </div>
    );
  }

  // Sign-in gate
  if (!auth.isAuthenticated && !auth.isLoading) {
    const isAdminMode = accessParam === 'admin';
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-950 via-purple-950/60 to-slate-950 text-slate-100 flex items-center justify-center">
        <div className="max-w-md w-full mx-auto px-6">
          <div className="rounded-2xl border border-white/10 bg-slate-900/60 backdrop-blur-2xl p-8 shadow-2xl shadow-black/40 text-center">
            {/* Role icon */}
            <div className={`w-16 h-16 rounded-2xl border flex items-center justify-center mx-auto mb-5 ${
              isAdminMode
                ? 'bg-amber-500/10 border-amber-500/30 text-amber-400'
                : 'bg-sky-500/10 border-sky-500/30 text-sky-400'
            }`}>
              {isAdminMode ? <Crown className="w-8 h-8" /> : <Users className="w-8 h-8" />}
            </div>

            <h1 className="text-2xl font-black text-white mb-2">
              {isAdminMode ? 'Admin Access' : 'Employee Access'}
            </h1>
            <p className="text-sm text-slate-400 mb-6">
              {isAdminMode
                ? 'Connect your admin wallet to access full operational controls — escrow creation, role management, approvals, and payouts.'
                : 'Connect your employee wallet to view escrows, submit work hours, and track your payment status.'}
            </p>

            {auth.error && (
              <div className="mb-4 p-3 rounded-xl border border-rose-500/20 bg-rose-950/20">
                <p className="text-xs text-rose-300 font-medium">{auth.error}</p>
              </div>
            )}

            <button
              onClick={auth.signIn}
              disabled={auth.isLoading}
              className={`w-full py-3.5 px-4 rounded-xl text-sm font-bold transition-all shadow-lg flex items-center justify-center gap-2 disabled:opacity-50 ${
                isAdminMode
                  ? 'bg-gradient-to-r from-amber-600 to-orange-600 hover:from-amber-500 hover:to-orange-500 text-white shadow-amber-500/20'
                  : 'bg-gradient-to-r from-sky-600 to-blue-600 hover:from-sky-500 hover:to-blue-500 text-white shadow-sky-500/20'
              }`}
            >
              <LogIn className="w-4 h-4" />
              {auth.isLoading ? 'Connecting...' : 'Connect Freighter Wallet & Sign In'}
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

  // Loading state
  if (auth.isLoading) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-950 via-purple-950/60 to-slate-950 text-slate-100 flex items-center justify-center">
        <div className="text-center">
          <RefreshCw className="w-8 h-8 animate-spin text-violet-400 mx-auto mb-3" />
          <p className="text-sm text-slate-400 font-medium">Verifying session...</p>
        </div>
      </div>
    );
  }

  // Role mismatch: user requested admin but wallet is EMPLOYEE
  if (auth.isAuthenticated && accessParam === 'admin' && !auth.isAdmin) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-950 via-purple-950/60 to-slate-950 text-slate-100 flex items-center justify-center">
        <div className="max-w-md w-full mx-auto px-6">
          <div className="rounded-2xl border border-rose-500/20 bg-slate-900/60 backdrop-blur-2xl p-8 shadow-2xl text-center">
            <ShieldAlert className="w-12 h-12 text-rose-400 mx-auto mb-4" />
            <h1 className="text-xl font-extrabold text-white mb-2">Access Denied</h1>
            <p className="text-sm text-slate-400 mb-2">
              Your wallet <span className="font-mono text-white">{auth.walletAddress.slice(0, 8)}...{auth.walletAddress.slice(-4)}</span> is registered as <span className="font-bold text-sky-400">EMPLOYEE</span>.
            </p>
            <p className="text-sm text-slate-400 mb-6">
              Admin privileges are required to access this panel. Contact your organization&apos;s admin for role elevation.
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

  // Default: loading/redirect state
  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-950 via-purple-950/60 to-slate-950 text-slate-100 flex items-center justify-center">
      <div className="text-center">
        <RefreshCw className="w-8 h-8 animate-spin text-violet-400 mx-auto mb-3" />
        <p className="text-sm text-slate-400 font-medium">Redirecting to dashboard...</p>
      </div>
    </div>
  );
}

export default function DashboardPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen bg-gradient-to-br from-slate-950 via-purple-950/60 to-slate-950 text-slate-100 flex items-center justify-center">
          <div className="text-center">
            <RefreshCw className="w-8 h-8 animate-spin text-violet-400 mx-auto mb-3" />
            <p className="text-sm text-slate-400 font-medium">Loading dashboard...</p>
          </div>
        </div>
      }
    >
      <DashboardContent />
    </Suspense>
  );
}
