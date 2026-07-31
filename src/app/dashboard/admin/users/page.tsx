'use client';

import { useState, useEffect } from 'react';
import { useAuth } from '@/hooks/useAuth';
import { ArrowLeft, Crown, ShieldCheck, UserCheck, ShieldAlert, AlertCircle, RefreshCw } from 'lucide-react';
import Link from 'next/link';

interface UserRecord {
  id: string;
  walletAddress: string;
  role: 'ADMIN' | 'EMPLOYEE';
  createdAt: string;
}

export default function AdminUsersPage() {
  const auth = useAuth();
  const [users, setUsers] = useState<UserRecord[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [updatingId, setUpdatingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  const fetchUsers = async () => {
    setIsLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/admin/users');
      if (!res.ok) throw new Error('Failed to load user directory');
      const data = await res.json();
      setUsers(data.users || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error loading users');
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    if (auth.isAuthenticated && auth.isAdmin) {
      fetchUsers();
    }
  }, [auth.isAuthenticated, auth.isAdmin]);

  const handleRoleChange = async (userId: string, newRole: 'ADMIN' | 'EMPLOYEE') => {
    setUpdatingId(userId);
    setError(null);
    setSuccessMsg(null);
    try {
      const res = await fetch(`/api/admin/users/${userId}/role`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role: newRole }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'Failed to update user role');
      }

      setUsers((prev) =>
        prev.map((u) => (u.id === userId ? { ...u, role: newRole } : u))
      );
      setSuccessMsg(`✓ Successfully updated role to ${newRole}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update role');
    } finally {
      setUpdatingId(null);
    }
  };

  if (auth.isLoading) {
    return (
      <div className="min-h-screen bg-slate-950 text-slate-100 flex items-center justify-center">
        <RefreshCw className="w-6 h-6 animate-spin text-violet-400" />
      </div>
    );
  }

  if (!auth.isAuthenticated || !auth.isAdmin) {
    return (
      <div className="min-h-screen bg-slate-950 text-slate-100 p-8 flex flex-col items-center justify-center">
        <ShieldAlert className="w-12 h-12 text-rose-500 mb-4" />
        <h1 className="text-xl font-bold mb-2 text-white">Access Denied</h1>
        <p className="text-sm text-slate-400 mb-6">Admin privileges required to access User Management.</p>
        <Link
          href="/dashboard"
          className="px-4 py-2 bg-violet-600 hover:bg-violet-500 rounded-xl text-xs font-semibold text-white transition-colors"
        >
          Return to Dashboard
        </Link>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-950 via-purple-950/60 to-slate-950 text-slate-100 flex flex-col font-sans">
      <header className="sticky top-0 z-40 border-b border-violet-500/10 bg-slate-950/85 backdrop-blur-xl px-6 py-4">
        <div className="max-w-6xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Link
              href="/dashboard"
              className="p-2 rounded-lg border border-slate-800 hover:border-slate-700 bg-slate-900/60 text-slate-400 hover:text-slate-200 transition-colors"
            >
              <ArrowLeft className="w-4 h-4" />
            </Link>
            <div>
              <h1 className="text-lg font-extrabold tracking-tight text-white flex items-center gap-2">
                User Management &amp; Self-Service RBAC
                <span className="text-[10px] bg-amber-500/10 border border-amber-500/30 text-amber-400 font-bold px-2 py-0.5 rounded uppercase">
                  Admin Guarded
                </span>
              </h1>
              <p className="text-[10px] text-slate-400">Manage user roles, authorizations, and team permissions</p>
            </div>
          </div>

          <button
            onClick={fetchUsers}
            disabled={isLoading}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold border border-slate-700 bg-slate-900/80 hover:bg-slate-800 text-slate-300 transition-colors"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${isLoading ? 'animate-spin' : ''}`} />
            Refresh Directory
          </button>
        </div>
      </header>

      <main className="flex-1 max-w-6xl w-full mx-auto px-6 py-8">
        {error && (
          <div className="mb-6 p-3 rounded-xl border border-rose-500/20 bg-rose-950/10 flex items-center gap-2">
            <AlertCircle className="w-4 h-4 text-rose-400 shrink-0" />
            <p className="text-xs text-rose-300 font-medium">{error}</p>
          </div>
        )}

        {successMsg && (
          <div className="mb-6 p-3 rounded-xl border border-emerald-500/20 bg-emerald-950/10 flex items-center gap-2">
            <UserCheck className="w-4 h-4 text-emerald-400 shrink-0" />
            <p className="text-xs text-emerald-300 font-medium">{successMsg}</p>
          </div>
        )}

        <div className="rounded-2xl border border-white/10 bg-slate-900/40 backdrop-blur-xl overflow-hidden shadow-2xl">
          <div className="px-6 py-4 border-b border-white/5 bg-slate-900/60 flex items-center justify-between">
            <h2 className="text-xs font-extrabold uppercase tracking-wider text-slate-300">
              Registered Accounts ({users.length})
            </h2>
            <span className="text-[10px] text-slate-500 font-mono">Changes apply immediately in real-time</span>
          </div>

          {isLoading ? (
            <div className="p-12 text-center text-slate-400">
              <RefreshCw className="w-6 h-6 animate-spin mx-auto mb-2 text-violet-400" />
              <p className="text-xs font-medium">Loading registered users...</p>
            </div>
          ) : users.length === 0 ? (
            <div className="p-12 text-center text-slate-400">
              <p className="text-sm font-semibold">No registered users found.</p>
            </div>
          ) : (
            <div className="divide-y divide-white/5">
              {users.map((user) => {
                const isCurrentAdmin = user.walletAddress === auth.walletAddress;
                const isUpdating = updatingId === user.id;

                return (
                  <div
                    key={user.id}
                    className="px-6 py-4 flex flex-col md:flex-row md:items-center justify-between gap-4 hover:bg-slate-900/30 transition-colors"
                  >
                    <div className="flex items-center gap-3">
                      <div className={`p-2 rounded-xl border ${
                        user.role === 'ADMIN'
                          ? 'bg-amber-500/10 border-amber-500/30 text-amber-400'
                          : 'bg-sky-500/10 border-sky-500/30 text-sky-400'
                      }`}>
                        {user.role === 'ADMIN' ? <Crown className="w-4 h-4" /> : <ShieldCheck className="w-4 h-4" />}
                      </div>
                      <div>
                        <div className="flex items-center gap-2">
                          <span className="text-xs font-mono font-bold text-white select-all">
                            {user.walletAddress}
                          </span>
                          {isCurrentAdmin && (
                            <span className="text-[9px] bg-violet-500/20 border border-violet-500/30 text-violet-300 px-1.5 py-0.5 rounded font-bold">
                              You
                            </span>
                          )}
                        </div>
                        <p className="text-[10px] text-slate-500 mt-0.5">
                          Registered: {new Date(user.createdAt).toLocaleDateString()}
                        </p>
                      </div>
                    </div>

                    <div className="flex items-center gap-3">
                      <span className={`text-[10px] font-bold px-2.5 py-1 rounded-lg border ${
                        user.role === 'ADMIN'
                          ? 'bg-amber-500/10 border-amber-500/30 text-amber-400'
                          : 'bg-sky-500/10 border-sky-500/30 text-sky-400'
                      }`}>
                        {user.role}
                      </span>

                      {!isCurrentAdmin ? (
                        user.role === 'EMPLOYEE' ? (
                          <button
                            onClick={() => handleRoleChange(user.id, 'ADMIN')}
                            disabled={isUpdating}
                            className="px-3 py-1.5 bg-gradient-to-r from-amber-600 to-amber-500 hover:from-amber-500 hover:to-amber-400 text-white rounded-lg text-xs font-bold transition-all shadow-md disabled:opacity-50"
                          >
                            {isUpdating ? 'Promoting...' : 'Promote to Admin'}
                          </button>
                        ) : (
                          <button
                            onClick={() => handleRoleChange(user.id, 'EMPLOYEE')}
                            disabled={isUpdating}
                            className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white border border-slate-700 rounded-lg text-xs font-bold transition-all disabled:opacity-50"
                          >
                            {isUpdating ? 'Demoting...' : 'Demote to Employee'}
                          </button>
                        )
                      ) : (
                        <span className="text-[10px] text-slate-500 italic">Self-demotion disabled</span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
