'use client';

import { useState, useEffect } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useAuth } from '@/hooks/useAuth';
import { ShieldCheck, CheckCircle2, AlertCircle, LogIn, RefreshCw, Crown } from 'lucide-react';

interface InvitationDetails {
  email: string;
  role: 'ADMIN' | 'EMPLOYEE';
  expiresAt: string;
}

export default function PublicInvitePage() {
  const params = useParams();
  const token = params.token as string;
  const router = useRouter();
  const auth = useAuth();

  const [invitation, setInvitation] = useState<InvitationDetails | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isAccepting, setIsAccepting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  useEffect(() => {
    const fetchInvite = async () => {
      setIsLoading(true);
      setError(null);
      try {
        const res = await fetch(`/api/invitations/${token}`);
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data.error || 'Invalid or expired invitation link');
        }
        const data = await res.json();
        setInvitation(data.invitation);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Error validating invitation');
      } finally {
        setIsLoading(false);
      }
    };

    if (token) fetchInvite();
  }, [token]);

  const handleAcceptInvite = async () => {
    if (!auth.isAuthenticated) {
      auth.signIn();
      return;
    }

    setIsAccepting(true);
    setError(null);
    try {
      const res = await fetch(`/api/invitations/${token}`, {
        method: 'POST',
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'Failed to redeem invitation');
      }

      const data = await res.json();
      setSuccessMsg(data.message || 'Invitation accepted! Redirecting to dashboard...');
      setTimeout(() => {
        router.push('/dashboard');
      }, 1500);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to redeem invitation');
    } finally {
      setIsAccepting(false);
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-950 via-purple-950/60 to-slate-950 text-slate-100 flex items-center justify-center p-6">
      <div className="max-w-md w-full rounded-2xl border border-white/10 bg-slate-900/60 backdrop-blur-2xl p-8 shadow-2xl shadow-black/40 text-center">
        
        {/* Logo / Header icon */}
        <div className="w-12 h-12 rounded-2xl bg-violet-600/20 border border-violet-500/30 flex items-center justify-center mx-auto mb-4 text-violet-400">
          <ShieldCheck className="w-6 h-6 animate-pulse" />
        </div>

        <h1 className="text-xl font-black text-white tracking-tight mb-1">
          CoreFlow Workspace Invitation
        </h1>
        <p className="text-xs text-slate-400 mb-6">
          Onboarding link for decentralized accounts payable &amp; payroll
        </p>

        {isLoading ? (
          <div className="py-8">
            <RefreshCw className="w-6 h-6 animate-spin mx-auto mb-2 text-violet-400" />
            <p className="text-xs text-slate-400">Verifying invitation token...</p>
          </div>
        ) : error ? (
          <div className="p-4 rounded-xl border border-rose-500/20 bg-rose-950/20 mb-6">
            <AlertCircle className="w-6 h-6 text-rose-400 mx-auto mb-2" />
            <p className="text-xs font-semibold text-rose-300">{error}</p>
          </div>
        ) : invitation ? (
          <div className="space-y-6">
            <div className="p-4 rounded-xl border border-violet-500/20 bg-violet-950/20 text-left">
              <p className="text-[10px] text-slate-400 uppercase font-bold tracking-wider mb-1">Invited Account</p>
              <p className="text-sm font-bold text-white font-mono">{invitation.email}</p>
              <div className="mt-3 flex items-center justify-between border-t border-white/5 pt-2">
                <span className="text-[10px] text-slate-400 uppercase font-bold">Assigned Role</span>
                <span className={`text-[10px] font-bold px-2 py-0.5 rounded border ${
                  invitation.role === 'ADMIN'
                    ? 'bg-amber-500/10 border-amber-500/30 text-amber-400'
                    : 'bg-sky-500/10 border-sky-500/30 text-sky-400'
                }`}>
                  {invitation.role === 'ADMIN' && <Crown className="w-3 h-3 inline mr-1" />}
                  {invitation.role}
                </span>
              </div>
            </div>

            {successMsg && (
              <div className="p-3 rounded-xl border border-emerald-500/20 bg-emerald-950/20 flex items-center gap-2">
                <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
                <p className="text-xs text-emerald-300 font-medium">{successMsg}</p>
              </div>
            )}

            {!auth.isAuthenticated ? (
              <div className="space-y-3">
                <p className="text-xs text-slate-400">
                  Connect your Freighter wallet to accept this invitation and activate your account.
                </p>
                <button
                  onClick={auth.signIn}
                  className="w-full py-3 px-4 bg-gradient-to-r from-violet-600 to-indigo-600 hover:from-violet-500 hover:to-indigo-500 text-white rounded-xl text-xs font-bold transition-all shadow-lg shadow-violet-500/20 flex items-center justify-center gap-2"
                >
                  <LogIn className="w-4 h-4" />
                  Connect Freighter &amp; Activate Role
                </button>
              </div>
            ) : (
              <div className="space-y-3">
                <p className="text-xs text-slate-400">
                  Connected wallet: <span className="font-mono text-white font-bold">{auth.walletAddress.slice(0, 6)}...{auth.walletAddress.slice(-4)}</span>
                </p>
                <button
                  onClick={handleAcceptInvite}
                  disabled={isAccepting}
                  className="w-full py-3 px-4 bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-500 hover:to-teal-500 text-white rounded-xl text-xs font-bold transition-all shadow-lg shadow-emerald-500/20 flex items-center justify-center gap-2 disabled:opacity-50"
                >
                  <CheckCircle2 className="w-4 h-4" />
                  {isAccepting ? 'Activating Account...' : `Accept & Assign ${invitation.role} Role`}
                </button>
              </div>
            )}
          </div>
        ) : null}
      </div>
    </div>
  );
}
