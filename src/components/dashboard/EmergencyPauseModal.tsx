'use client';

import { useState } from 'react';
import { AlertOctagon, ShieldAlert, CheckCircle2, X } from 'lucide-react';

interface EmergencyPauseModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export function EmergencyPauseModal({ isOpen, onClose }: EmergencyPauseModalProps) {
  const [reason, setReason] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [statusMsg, setStatusMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  if (!isOpen) return null;

  const handleTogglePause = async (pauseState: boolean) => {
    if (pauseState && reason.trim().length < 5) {
      setStatusMsg({ type: 'error', text: 'Please provide a valid emergency reason (min 5 characters).' });
      return;
    }

    setIsSubmitting(true);
    setStatusMsg(null);

    try {
      const res = await fetch('/api/admin/contract/pause', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paused: pauseState, reason: reason.trim() || 'Manual Admin toggle' }),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to toggle pause');

      setStatusMsg({ type: 'success', text: data.message });
      setReason('');
      setTimeout(() => {
        onClose();
        window.location.reload();
      }, 1500);
    } catch (err: any) {
      setStatusMsg({ type: 'error', text: err.message || 'An error occurred' });
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-md flex items-center justify-center p-4">
      <div className="max-w-md w-full p-6 rounded-2xl border border-rose-500/40 bg-slate-950 text-slate-100 shadow-2xl relative animate-in fade-in zoom-in-95 duration-200">
        <button
          onClick={onClose}
          className="absolute top-4 right-4 text-slate-400 hover:text-white p-1 rounded-lg hover:bg-slate-900"
        >
          <X className="w-4 h-4" />
        </button>

        <div className="flex items-center gap-3 mb-4 text-rose-500">
          <div className="p-3 bg-rose-500/10 border border-rose-500/30 rounded-xl">
            <AlertOctagon className="w-6 h-6 animate-pulse" />
          </div>
          <div>
            <h3 className="text-lg font-bold text-white">Emergency Contract Controls</h3>
            <p className="text-[11px] text-rose-400 font-mono">Soroban Smart Contract Circuit Breaker</p>
          </div>
        </div>

        {statusMsg && (
          <div
            className={`p-3 rounded-xl mb-4 text-xs font-semibold flex items-center gap-2 ${
              statusMsg.type === 'success'
                ? 'bg-emerald-500/10 border border-emerald-500/30 text-emerald-400'
                : 'bg-rose-500/10 border border-rose-500/30 text-rose-400'
            }`}
          >
            {statusMsg.type === 'success' ? (
              <CheckCircle2 className="w-4 h-4 text-emerald-400 flex-shrink-0" />
            ) : (
              <ShieldAlert className="w-4 h-4 text-rose-400 flex-shrink-0" />
            )}
            <span>{statusMsg.text}</span>
          </div>
        )}

        <div className="space-y-4 mb-6 text-xs text-slate-300">
          <p>
            Activating the emergency stop halts all on-chain payouts and new escrow creation immediately across the CoreFlow protocol.
          </p>
          <div>
            <label className="block text-[10px] uppercase font-bold text-slate-400 mb-1">
              Emergency Reason / Incident Ref <span className="text-rose-400">*</span>
            </label>
            <input
              type="text"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="e.g. Unusual Soroban RPC network degradation detected"
              className="w-full bg-slate-900 border border-slate-700 rounded-xl px-3 py-2 text-white placeholder-slate-500 focus:outline-none focus:border-rose-500"
            />
          </div>
        </div>

        <div className="flex items-center justify-between gap-3 pt-2 border-t border-slate-800">
          <button
            onClick={() => handleTogglePause(false)}
            disabled={isSubmitting}
            className="flex-1 py-2 rounded-xl text-xs font-bold border border-emerald-500/30 bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500/20 transition-colors"
          >
            Resume Protocol
          </button>
          <button
            onClick={() => handleTogglePause(true)}
            disabled={isSubmitting}
            className="flex-1 py-2 rounded-xl text-xs font-bold bg-rose-600 hover:bg-rose-500 text-white transition-colors shadow-lg shadow-rose-600/30 flex items-center justify-center gap-1.5"
          >
            <AlertOctagon className="w-3.5 h-3.5" />
            HALT CONTRACT
          </button>
        </div>
      </div>
    </div>
  );
}
