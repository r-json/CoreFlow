'use client';

import { useState } from 'react';
import { Button } from './Button';
import { Alert } from './Alert';
import { CheckCircle2, ShieldCheck, DollarSign, XCircle } from 'lucide-react';
import { EscrowTimeline } from './EscrowTimeline';
import { FeeSavings } from './FeeSavings';
import { PaymentReceipt } from './PaymentReceipt';

export interface EscrowData {
  id: number;
  worker: string;
  amount: string;
  currency: string;
  hoursLogged: string;
  status: 'pending_hours' | 'pending_manager' | 'pending_finance' | 'ready' | 'paid' | 'cancelled';
  manager_approved: boolean;
  finance_approved: boolean;
  hours_verified: boolean;
  created_at: string;
  transaction_hash?: string;
  isMock?: boolean;
}

interface EscrowCardProps {
  escrow: EscrowData;
  onManagerApprove?: (escrowId: number) => Promise<void>;
  onFinanceApprove?: (escrowId: number) => Promise<void>;
  onFinalize?: (escrowId: number) => Promise<void>;
  onCancel?: (escrowId: number) => Promise<void>;
  isConnected?: boolean;
}

export const EscrowCard = ({
  escrow,
  onManagerApprove,
  onFinanceApprove,
  onFinalize,
  onCancel,
  isConnected = false,
}: EscrowCardProps) => {
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const USD_TO_PHP = 56.50;
  // Parse amount string (remove commas) to float
  const numericAmount = parseFloat(escrow.amount.replace(/,/g, ''));
  const amountPhp = numericAmount * USD_TO_PHP;
  const feeSavedUsd = numericAmount * 0.055 - 0.001;

  const getStatusConfig = () => {
    switch (escrow.status) {
      case 'pending_manager':
        return { label: 'Awaiting Manager', color: 'bg-purple-500/10 text-purple-400 border-purple-500/20' };
      case 'pending_finance':
        return { label: 'Awaiting Finance', color: 'bg-indigo-500/10 text-indigo-400 border-indigo-500/20' };
      case 'ready':
        return { label: 'Ready for Release', color: 'bg-violet-500/10 text-violet-400 border-violet-500/20' };
      case 'paid':
        return { label: 'Settled', color: 'bg-slate-500/10 text-slate-400 border-slate-500/20' };
      case 'cancelled':
        return { label: 'Cancelled', color: 'bg-rose-500/10 text-rose-400 border-rose-500/20' };
      default:
        return { label: 'Pending Hours', color: 'bg-fuchsia-500/10 text-fuchsia-400 border-fuchsia-500/20' };
    }
  };

  const statusConfig = getStatusConfig();

  const handleAction = async (action: 'manager' | 'finance' | 'finalize' | 'cancel') => {
    if (!isConnected) {
      setError('Please connect your wallet first');
      return;
    }

    try {
      setIsLoading(true);
      setError(null);
      setSuccess(null);

      if (action === 'manager' && onManagerApprove) {
        await onManagerApprove(escrow.id);
        setSuccess('✓ Manager approval submitted!');
      } else if (action === 'finance' && onFinanceApprove) {
        await onFinanceApprove(escrow.id);
        setSuccess('✓ Finance approval submitted!');
      } else if (action === 'finalize' && onFinalize) {
        await onFinalize(escrow.id);
        setSuccess('✓ Payment finalized & released!');
      } else if (action === 'cancel' && onCancel) {
        await onCancel(escrow.id);
        setSuccess('✓ Escrow successfully cancelled!');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Transaction failed');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className={`card-hover relative overflow-hidden rounded-2xl border transition-all duration-300 ${
      escrow.status === 'paid' 
        ? 'border-slate-800 bg-slate-950/40' 
        : escrow.status === 'cancelled'
        ? 'border-rose-950/30 bg-slate-950/40 opacity-70'
        : 'border-white/5 bg-gradient-to-br from-slate-900/95 via-slate-900/80 to-violet-900/40'
    } backdrop-blur-xl p-6 shadow-2xl shadow-black/20`}>
      
      {/* Subtle glow behind active cards */}
      {escrow.status === 'ready' && (
        <div className="absolute -top-20 -right-20 w-40 h-40 bg-violet-500/15 rounded-full blur-3xl animate-pulse-glow" />
      )}

      <div className="relative z-10">
        {/* Header */}
        <div className="flex flex-col md:flex-row md:items-start justify-between gap-4 mb-5">
          <div>
            <div className="flex flex-wrap items-center gap-3 mb-1">
              <h3 className="text-lg font-bold tracking-tight text-white">
                Escrow #{escrow.id}
              </h3>
              <span className={`text-[10px] px-2.5 py-0.5 rounded-full font-semibold border ${statusConfig.color}`}>
                {statusConfig.label}
              </span>
            </div>
            <p className="text-xs text-slate-400 flex flex-wrap items-center gap-x-2 gap-y-1 font-mono">
              <span className="text-slate-500">Worker:</span>
              <span className="text-slate-300 select-all">{escrow.worker}</span>
              <span className="w-1.5 h-1.5 rounded-full bg-slate-700 hidden md:inline" />
              <span className="text-slate-500">{escrow.created_at}</span>
            </p>
          </div>
          <div className="text-left md:text-right">
            <p className="text-2xl font-black tracking-tight text-white">
              ${escrow.amount} <span className="text-sm font-medium text-slate-400">{escrow.currency}</span>
            </p>
            <p className="text-xs text-emerald-400 font-bold">
              ≈ ₱{amountPhp.toLocaleString('en-US', { maximumFractionDigits: 2 })} PHP
            </p>
            <p className="text-[10px] text-slate-500 mt-0.5">{escrow.hoursLogged} hours logged</p>
          </div>
        </div>

        {/* Remittance Savings Component (Shown for active, unfinalized escrows) */}
        {escrow.status !== 'paid' && escrow.status !== 'cancelled' && (
          <div className="mb-5">
            <FeeSavings amountUsdc={numericAmount} />
          </div>
        )}

        {/* Workflow Timeline */}
        <EscrowTimeline
          status={escrow.status}
          managerApproved={escrow.manager_approved}
          financeApproved={escrow.finance_approved}
          hoursVerified={escrow.hours_verified}
        />

        {/* Alerts */}
        {error && <Alert variant="destructive" className="mt-4 text-xs font-mono">{error}</Alert>}
        {success && <Alert variant="success" className="mt-4 text-xs font-mono">{success}</Alert>}

        {/* Finalized Payment Receipt */}
        {escrow.status === 'paid' && escrow.transaction_hash && (
          <PaymentReceipt
            escrowId={escrow.id}
            workerAddress={escrow.worker}
            amountUsdc={numericAmount}
            amountPhp={amountPhp}
            feeSavedUsd={feeSavedUsd}
            transactionHash={escrow.transaction_hash}
            timestamp={escrow.created_at === 'now' ? 'Just Now' : escrow.created_at}
          />
        )}

        {/* Action Buttons */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between border-t border-white/5 pt-4 mt-5 gap-4">
          <div className="flex flex-wrap gap-2">
            {escrow.status === 'pending_manager' && (
              <>
                <Button
                  onClick={() => handleAction('manager')}
                  disabled={!isConnected || isLoading}
                  className="bg-gradient-to-r from-purple-600 to-purple-500 hover:from-purple-500 hover:to-purple-400 text-white font-semibold text-xs py-2 px-4 shadow-lg shadow-purple-500/20 active:scale-95 transition-transform"
                >
                  <ShieldCheck className="w-4 h-4 mr-1.5" />
                  Manager Approve
                </Button>
                <Button
                  onClick={() => handleAction('cancel')}
                  disabled={!isConnected || isLoading}
                  className="bg-slate-900 hover:bg-rose-950/40 text-slate-400 hover:text-rose-400 font-semibold text-xs py-2 px-4 border border-white/5 hover:border-rose-950/50 active:scale-95 transition-transform"
                >
                  <XCircle className="w-4 h-4 mr-1.5" />
                  Cancel Escrow
                </Button>
              </>
            )}
            {escrow.status === 'pending_finance' && (
              <>
                <Button
                  onClick={() => handleAction('finance')}
                  disabled={!isConnected || isLoading}
                  className="bg-gradient-to-r from-indigo-600 to-indigo-500 hover:from-indigo-500 hover:to-indigo-400 text-white font-semibold text-xs py-2 px-4 shadow-lg shadow-indigo-500/20 active:scale-95 transition-transform"
                >
                  <CheckCircle2 className="w-4 h-4 mr-1.5" />
                  Finance Approve
                </Button>
                <Button
                  onClick={() => handleAction('cancel')}
                  disabled={!isConnected || isLoading}
                  className="bg-slate-900 hover:bg-rose-950/40 text-slate-400 hover:text-rose-400 font-semibold text-xs py-2 px-4 border border-white/5 hover:border-rose-950/50 active:scale-95 transition-transform"
                >
                  <XCircle className="w-4 h-4 mr-1.5" />
                  Cancel Escrow
                </Button>
              </>
            )}
            {escrow.status === 'ready' && (
              <>
                <Button
                  onClick={() => handleAction('finalize')}
                  disabled={!isConnected || isLoading}
                  className="bg-gradient-to-r from-violet-500 to-indigo-600 hover:from-violet-400 hover:to-indigo-500 text-white font-semibold text-xs py-2 px-4 shadow-lg shadow-violet-500/20 active:scale-95 transition-transform"
                >
                  <DollarSign className="w-4 h-4 mr-1.5 animate-bounce" style={{ animationDuration: '2s' }} />
                  Release Payment
                </Button>
                <Button
                  onClick={() => handleAction('cancel')}
                  disabled={!isConnected || isLoading}
                  className="bg-slate-900 hover:bg-rose-950/40 text-slate-400 hover:text-rose-400 font-semibold text-xs py-2 px-4 border border-white/5 hover:border-rose-950/50 active:scale-95 transition-transform"
                >
                  <XCircle className="w-4 h-4 mr-1.5" />
                  Cancel Escrow
                </Button>
              </>
            )}
            {escrow.status === 'paid' && (
              <span className="inline-flex items-center text-xs font-semibold text-slate-500 border border-slate-800 bg-slate-900 px-3 py-1.5 rounded-lg cursor-default">
                ✓ Completed
              </span>
            )}
            {escrow.status === 'cancelled' && (
              <span className="inline-flex items-center text-xs font-semibold text-rose-500 border border-rose-950/30 bg-rose-950/10 px-3 py-1.5 rounded-lg cursor-default">
                ✕ Cancelled
              </span>
            )}
          </div>
          {escrow.transaction_hash && (
            <a
              href={`https://stellar.expert/explorer/public/tx/${escrow.transaction_hash}`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs font-semibold text-slate-500 hover:text-violet-400 transition-colors self-end md:self-auto"
            >
              View Explorer →
            </a>
          )}
        </div>
      </div>
    </div>
  );
};
