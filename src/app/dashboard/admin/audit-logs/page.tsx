'use client';

import { useState, useEffect, useCallback } from 'react';
import { useAuth } from '@/hooks/useAuth';
import {
  ScrollText,
  AlertCircle,
  RefreshCw,
  User,
  Target,
  Clock,
  Filter,
} from 'lucide-react';

interface AuditLogEntry {
  id: string;
  action: string;
  actor: string | null;
  target: string | null;
  metadata: Record<string, any> | null;
  createdAt: string;
}

const ACTION_COLORS: Record<string, string> = {
  'role.grant': 'bg-amber-500/10 border-amber-500/30 text-amber-400',
  'role.update': 'bg-amber-500/10 border-amber-500/30 text-amber-400',
  'role.seed': 'bg-violet-500/10 border-violet-500/30 text-violet-400',
  'invitation.create': 'bg-sky-500/10 border-sky-500/30 text-sky-400',
  'invitation.accept': 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400',
  'invitation.revoke': 'bg-rose-500/10 border-rose-500/30 text-rose-400',
  'escrow.create': 'bg-indigo-500/10 border-indigo-500/30 text-indigo-400',
  'escrow.status_update': 'bg-purple-500/10 border-purple-500/30 text-purple-400',
  'escrow.reject': 'bg-rose-500/10 border-rose-500/30 text-rose-400',
  'auth.logout': 'bg-slate-500/10 border-slate-500/30 text-slate-400',
  'admin.bootstrap': 'bg-amber-500/10 border-amber-500/30 text-amber-400',
  'contract.pause': 'bg-rose-500/10 border-rose-500/30 text-rose-400',
  'contract.resume': 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400',
  'hours.submit': 'bg-cyan-500/10 border-cyan-500/30 text-cyan-400',
};

const ACTION_FILTERS = [
  'all',
  'role.grant',
  'role.update',
  'invitation.create',
  'invitation.accept',
  'invitation.revoke',
  'escrow.create',
  'escrow.status_update',
  'escrow.reject',
  'auth.logout',
  'contract.pause',
  'contract.resume',
  'hours.submit',
];

export default function AdminAuditLogsPage() {
  const auth = useAuth();
  const [logs, setLogs] = useState<AuditLogEntry[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionFilter, setActionFilter] = useState('all');

  const fetchLogs = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const url =
        actionFilter === 'all'
          ? '/api/admin/audit-logs?limit=100'
          : `/api/admin/audit-logs?action=${actionFilter}&limit=100`;
      const res = await fetch(url);
      if (!res.ok) throw new Error('Failed to load audit logs');
      const data = await res.json();
      setLogs(data.logs || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error loading audit logs');
    } finally {
      setIsLoading(false);
    }
  }, [actionFilter]);

  useEffect(() => {
    if (auth.isAuthenticated && auth.isAdmin) {
      fetchLogs();
    }
  }, [auth.isAuthenticated, auth.isAdmin, fetchLogs]);

  const formatTime = (isoString: string) => {
    const date = new Date(isoString);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);

    if (diffMins < 1) return 'just now';
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    if (diffDays < 7) return `${diffDays}d ago`;
    return date.toLocaleDateString();
  };

  return (
    <div className="max-w-6xl mx-auto px-8 py-8">
      {/* Page Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-black tracking-tight text-white flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-slate-700/20 border border-slate-600/30 flex items-center justify-center">
              <ScrollText className="w-5 h-5 text-slate-400" />
            </div>
            Audit Logs & Security Trail
          </h1>
          <p className="text-sm text-slate-400 mt-1">
            Immutable record of all security-sensitive actions
          </p>
        </div>
        <button
          onClick={fetchLogs}
          disabled={isLoading}
          className="flex items-center gap-1.5 px-4 py-2 rounded-xl text-xs font-bold border border-slate-700 bg-slate-900/80 hover:bg-slate-800 text-slate-300 transition-colors"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${isLoading ? 'animate-spin' : ''}`} />
          Refresh Logs
        </button>
      </div>

      {error && (
        <div className="mb-6 p-3 rounded-xl border border-rose-500/20 bg-rose-950/10 flex items-center gap-2">
          <AlertCircle className="w-4 h-4 text-rose-400 shrink-0" />
          <p className="text-xs text-rose-300 font-medium">{error}</p>
        </div>
      )}

      {/* Action Filter */}
      <div className="mb-6 flex items-center gap-2 flex-wrap">
        <div className="flex items-center gap-1.5 text-xs font-bold text-slate-400 uppercase tracking-wider mr-2">
          <Filter className="w-3.5 h-3.5" />
          Filter:
        </div>
        {ACTION_FILTERS.map((action) => (
          <button
            key={action}
            onClick={() => setActionFilter(action)}
            className={`px-3 py-1.5 rounded-lg text-[10px] font-bold border transition-colors ${
              actionFilter === action
                ? 'bg-violet-600 border-violet-500 text-white'
                : 'bg-slate-900/80 border-slate-700 text-slate-400 hover:text-slate-200 hover:border-slate-600'
            }`}
          >
            {action === 'all' ? 'All Actions' : action}
          </button>
        ))}
      </div>

      {/* Audit Logs Table */}
      <div className="rounded-2xl border border-white/10 bg-slate-900/40 backdrop-blur-xl overflow-hidden shadow-2xl">
        <div className="px-6 py-4 border-b border-white/5 bg-slate-900/60 flex items-center justify-between">
          <h2 className="text-xs font-extrabold uppercase tracking-wider text-slate-300 flex items-center gap-2">
            <ScrollText className="w-4 h-4 text-violet-400" />
            Security Events ({logs.length})
          </h2>
          <span className="text-[10px] text-slate-500 font-mono">
            Append-only · Tamper-evident
          </span>
        </div>

        {isLoading ? (
          <div className="p-12 text-center text-slate-400">
            <RefreshCw className="w-6 h-6 animate-spin mx-auto mb-2 text-violet-400" />
            <p className="text-xs font-medium">Loading audit trail...</p>
          </div>
        ) : logs.length === 0 ? (
          <div className="p-12 text-center text-slate-400">
            <ScrollText className="w-8 h-8 text-slate-600 mx-auto mb-2" />
            <p className="text-sm font-semibold">No audit log entries found.</p>
          </div>
        ) : (
          <div className="divide-y divide-white/5">
            {logs.map((log) => {
              const colorClass =
                ACTION_COLORS[log.action] ||
                'bg-slate-500/10 border-slate-500/30 text-slate-400';

              return (
                <div
                  key={log.id}
                  className="px-6 py-4 hover:bg-slate-900/30 transition-colors"
                >
                  <div className="flex flex-col md:flex-row md:items-start justify-between gap-3">
                    <div className="flex items-start gap-3 flex-1">
                      <div
                        className={`p-2 rounded-xl border ${colorClass} shrink-0`}
                      >
                        <ScrollText className="w-3.5 h-3.5" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap mb-1">
                          <span
                            className={`text-[10px] font-bold px-2 py-0.5 rounded border ${colorClass}`}
                          >
                            {log.action}
                          </span>
                          <span className="text-[10px] text-slate-500 font-mono flex items-center gap-1">
                            <Clock className="w-3 h-3" />
                            {formatTime(log.createdAt)}
                          </span>
                        </div>

                        <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
                          {log.actor && (
                            <div className="flex items-center gap-1">
                              <User className="w-3 h-3 text-slate-500" />
                              <span className="text-slate-500">Actor:</span>
                              <span className="font-mono text-slate-300">
                                {log.actor.length > 12
                                  ? `${log.actor.slice(0, 6)}...${log.actor.slice(-4)}`
                                  : log.actor}
                              </span>
                            </div>
                          )}
                          {log.target && (
                            <div className="flex items-center gap-1">
                              <Target className="w-3 h-3 text-slate-500" />
                              <span className="text-slate-500">Target:</span>
                              <span className="font-mono text-slate-300">
                                {log.target.length > 20
                                  ? `${log.target.slice(0, 8)}...${log.target.slice(-4)}`
                                  : log.target}
                              </span>
                            </div>
                          )}
                        </div>

                        {log.metadata && (
                          <div className="mt-2 p-2 rounded-lg bg-slate-950/60 border border-white/5">
                            <pre className="text-[10px] text-slate-400 font-mono overflow-x-auto whitespace-pre-wrap break-all">
                              {JSON.stringify(log.metadata, null, 2)}
                            </pre>
                          </div>
                        )}
                      </div>
                    </div>
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