'use client';

import { useState, useEffect } from 'react';
import { useAuth } from '@/hooks/useAuth';
import { Crown, ShieldCheck, UserCheck, AlertCircle, RefreshCw } from 'lucide-react';

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

  return (
    <div className="max-w-6xl mx-auto px-8 py-8">
      {/* Page Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-black tracking-tight text-white flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-amber-500/10 border border-amber-500/30 flex items-center justify-center">
              <Crown className="w-5 h-5 text-amber-400" />
            </div>
            User Management
          </h1>
          <p className="text-sm text-slate-400 mt-1">
            Manage user roles, authorizations, and team permissions
          </p>
        </div>
        <button
          onClick={fetchUsers}
          disabled={isLoading}
          className="flex items-center gap-1.5 px-4 py-2 rounded-xl text-xs font-bold border border-slate-700 bg-slate-900/80 hover:bg-slate-800 text-slate-300 transition-colors"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${isLoading ? 'animate-spin' : ''}`} />
          Refresh Directory
        </button>
      </div>

      {/* Alerts */}
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

      {/* Users Table */}
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
    </div>
  );
}
