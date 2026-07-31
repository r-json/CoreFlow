'use client';

import { useState, useEffect } from 'react';
import { useAuth } from '@/hooks/useAuth';
import { ArrowLeft, Mail, Send, CheckCircle2, ShieldAlert, AlertCircle, RefreshCw, Copy, ExternalLink } from 'lucide-react';
import Link from 'next/link';

interface InvitationRecord {
  id: string;
  email: string;
  role: 'ADMIN' | 'EMPLOYEE';
  token: string;
  expiresAt: string;
  usedAt: string | null;
  createdAt: string;
}

export default function AdminInvitationsPage() {
  const auth = useAuth();
  const [invitations, setInvitations] = useState<InvitationRecord[]>([]);
  const [emailInput, setEmailInput] = useState('');
  const [roleInput, setRoleInput] = useState<'ADMIN' | 'EMPLOYEE'>('EMPLOYEE');
  const [isLoading, setIsLoading] = useState(true);
  const [isSending, setIsSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const [copiedToken, setCopiedToken] = useState<string | null>(null);

  const fetchInvitations = async () => {
    setIsLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/admin/invitations');
      if (!res.ok) throw new Error('Failed to load invitations');
      const data = await res.json();
      setInvitations(data.invitations || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error loading invitations');
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    if (auth.isAuthenticated && auth.isAdmin) {
      fetchInvitations();
    }
  }, [auth.isAuthenticated, auth.isAdmin]);

  const handleSendInvite = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!emailInput) return;

    setIsSending(true);
    setError(null);
    setSuccessMsg(null);

    try {
      const res = await fetch('/api/admin/invitations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: emailInput, role: roleInput }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'Failed to create invitation');
      }

      await res.json();
      setSuccessMsg(`✓ Invitation created for ${emailInput}`);
      setEmailInput('');
      fetchInvitations();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to send invitation');
    } finally {
      setIsSending(false);
    }
  };

  const handleCopyLink = (token: string) => {
    const inviteUrl = `${window.location.origin}/invite/${token}`;
    navigator.clipboard.writeText(inviteUrl);
    setCopiedToken(token);
    setTimeout(() => setCopiedToken(null), 2500);
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
        <p className="text-sm text-slate-400 mb-6">Admin privileges required to access Invitation Manager.</p>
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
                Employee Onboarding &amp; Invitations
                <span className="text-[10px] bg-amber-500/10 border border-amber-500/30 text-amber-400 font-bold px-2 py-0.5 rounded uppercase">
                  Admin Panel
                </span>
              </h1>
              <p className="text-[10px] text-slate-400">Generate secure onboarding links for new team members</p>
            </div>
          </div>

          <button
            onClick={fetchInvitations}
            disabled={isLoading}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold border border-slate-700 bg-slate-900/80 hover:bg-slate-800 text-slate-300 transition-colors"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${isLoading ? 'animate-spin' : ''}`} />
            Refresh List
          </button>
        </div>
      </header>

      <main className="flex-1 max-w-6xl w-full mx-auto px-6 py-8 space-y-8">
        {error && (
          <div className="p-3 rounded-xl border border-rose-500/20 bg-rose-950/10 flex items-center gap-2">
            <AlertCircle className="w-4 h-4 text-rose-400 shrink-0" />
            <p className="text-xs text-rose-300 font-medium">{error}</p>
          </div>
        )}

        {successMsg && (
          <div className="p-3 rounded-xl border border-emerald-500/20 bg-emerald-950/10 flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
            <p className="text-xs text-emerald-300 font-medium">{successMsg}</p>
          </div>
        )}

        {/* Create Invitation Form */}
        <div className="rounded-2xl border border-white/10 bg-slate-900/40 backdrop-blur-xl p-6 shadow-2xl">
          <h2 className="text-xs font-extrabold uppercase tracking-wider text-slate-300 mb-4 flex items-center gap-2">
            <Mail className="w-4 h-4 text-violet-400" />
            Send New Team Invitation
          </h2>

          <form onSubmit={handleSendInvite} className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div className="sm:col-span-1">
              <label className="block text-[10px] font-bold uppercase text-slate-400 mb-1">Employee Email</label>
              <input
                type="email"
                required
                value={emailInput}
                onChange={(e) => setEmailInput(e.target.value)}
                placeholder="colleague@company.com"
                className="w-full text-xs px-3 py-2.5 rounded-xl bg-slate-950 border border-slate-800 text-white placeholder-slate-500 focus:outline-none focus:border-violet-500"
              />
            </div>

            <div>
              <label className="block text-[10px] font-bold uppercase text-slate-400 mb-1">Pre-Assigned Role</label>
              <select
                value={roleInput}
                onChange={(e) => setRoleInput(e.target.value as 'ADMIN' | 'EMPLOYEE')}
                className="w-full text-xs px-3 py-2.5 rounded-xl bg-slate-950 border border-slate-800 text-white focus:outline-none focus:border-violet-500"
              >
                <option value="EMPLOYEE">EMPLOYEE (Standard)</option>
                <option value="ADMIN">ADMIN (Privileged)</option>
              </select>
            </div>

            <div className="flex items-end">
              <button
                type="submit"
                disabled={isSending || !emailInput}
                className="w-full py-2.5 px-4 bg-gradient-to-r from-violet-600 to-indigo-600 hover:from-violet-500 hover:to-indigo-500 text-white rounded-xl text-xs font-bold transition-all shadow-md shadow-violet-500/20 disabled:opacity-50 flex items-center justify-center gap-2"
              >
                <Send className="w-3.5 h-3.5" />
                {isSending ? 'Generating Link...' : 'Generate Onboarding Link'}
              </button>
            </div>
          </form>
        </div>

        {/* Invitations Table */}
        <div className="rounded-2xl border border-white/10 bg-slate-900/40 backdrop-blur-xl overflow-hidden shadow-2xl">
          <div className="px-6 py-4 border-b border-white/5 bg-slate-900/60 flex items-center justify-between">
            <h2 className="text-xs font-extrabold uppercase tracking-wider text-slate-300">
              Active &amp; Redeemed Invitations ({invitations.length})
            </h2>
            <span className="text-[10px] text-slate-500 font-mono">Tokens expire after 7 days</span>
          </div>

          {isLoading ? (
            <div className="p-12 text-center text-slate-400">
              <RefreshCw className="w-6 h-6 animate-spin mx-auto mb-2 text-violet-400" />
              <p className="text-xs font-medium">Loading invitation records...</p>
            </div>
          ) : invitations.length === 0 ? (
            <div className="p-12 text-center text-slate-400">
              <p className="text-sm font-semibold">No invitations created yet.</p>
            </div>
          ) : (
            <div className="divide-y divide-white/5">
              {invitations.map((inv) => {
                const isRedeemed = !!inv.usedAt;
                const isExpired = !isRedeemed && new Date(inv.expiresAt) < new Date();
                const isCopied = copiedToken === inv.token;

                return (
                  <div
                    key={inv.id}
                    className="px-6 py-4 flex flex-col md:flex-row md:items-center justify-between gap-4 hover:bg-slate-900/30 transition-colors"
                  >
                    <div className="flex items-center gap-3">
                      <div className={`p-2 rounded-xl border ${
                        isRedeemed
                          ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400'
                          : isExpired
                          ? 'bg-rose-500/10 border-rose-500/30 text-rose-400'
                          : 'bg-violet-500/10 border-violet-500/30 text-violet-400'
                      }`}>
                        <Mail className="w-4 h-4" />
                      </div>
                      <div>
                        <div className="flex items-center gap-2">
                          <span className="text-xs font-bold text-white">{inv.email}</span>
                          <span className="text-[9px] bg-slate-800 border border-slate-700 text-slate-300 font-mono px-1.5 py-0.5 rounded">
                            Role: {inv.role}
                          </span>
                        </div>
                        <p className="text-[10px] text-slate-500 mt-0.5 font-mono">
                          Created: {new Date(inv.createdAt).toLocaleDateString()}
                        </p>
                      </div>
                    </div>

                    <div className="flex items-center gap-3">
                      {isRedeemed ? (
                        <span className="text-[10px] font-bold px-2.5 py-1 rounded-lg border bg-emerald-500/10 border-emerald-500/30 text-emerald-400 flex items-center gap-1">
                          <CheckCircle2 className="w-3 h-3" /> Redeemed
                        </span>
                      ) : isExpired ? (
                        <span className="text-[10px] font-bold px-2.5 py-1 rounded-lg border bg-rose-500/10 border-rose-500/30 text-rose-400">
                          Expired
                        </span>
                      ) : (
                        <div className="flex items-center gap-2">
                          <button
                            onClick={() => handleCopyLink(inv.token)}
                            className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 rounded-lg text-xs font-bold transition-all flex items-center gap-1.5"
                          >
                            <Copy className="w-3 h-3 text-violet-400" />
                            {isCopied ? 'Link Copied!' : 'Copy Invite Link'}
                          </button>
                          <Link
                            href={`/invite/${inv.token}`}
                            target="_blank"
                            className="p-1.5 bg-slate-800 hover:bg-slate-700 text-slate-400 hover:text-white rounded-lg border border-slate-700 transition-colors"
                            title="Preview Link"
                          >
                            <ExternalLink className="w-3.5 h-3.5" />
                          </Link>
                        </div>
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
