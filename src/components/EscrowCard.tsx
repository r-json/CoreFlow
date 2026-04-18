'use client';

import { useState } from 'react';
import { Button } from './Button';
import { Alert } from './Alert';
import { CheckCircle2, Clock, FileCheck, ShieldCheck, DollarSign } from 'lucide-react';

export interface EscrowData {
  id: number;
  worker: string;
  amount: string;
  currency: string;
  hoursLogged: string;
  status: 'pending_hours' | 'pending_manager' | 'pending_finance' | 'ready' | 'paid';
  manager_approved: boolean;
  finance_approved: boolean;
  hours_verified: boolean;
  created_at: string;
  transaction_hash?: string;
}

interface EscrowCardProps {
  escrow: EscrowData;
  onManagerApprove?: (escrowId: number) => Promise<void>;
  onFinanceApprove?: (escrowId: number) => Promise<void>;
  onFinalize?: (escrowId: number) => Promise<void>;
  isConnected?: boolean;
}

export const EscrowCard = ({
  escrow,
  onManagerApprove,
  onFinanceApprove,
  onFinalize,
  isConnected = false,
}: EscrowCardProps) => {
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

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
      default: 
        return { label: 'Pending Hours', color: 'bg-fuchsia-500/10 text-fuchsia-400 border-fuchsia-500/20' };
    }
  };

  const statusConfig = getStatusConfig();

  // Progress steps
  const steps = [
    { label: 'Hours', completed: escrow.hours_verified, icon: FileCheck },
    { label: 'Manager', completed: escrow.manager_approved, icon: ShieldCheck },
    { label: 'Finance', completed: escrow.finance_approved, icon: CheckCircle2 },
  ];

  const handleAction = async (action: 'manager' | 'finance' | 'finalize') => {
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
        setSuccess('✓ Payment finalized!');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Transaction failed');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="card-hover relative overflow-hidden rounded-2xl border border-white/5 bg-gradient-to-br from-slate-900/90 via-slate-900/80 to-violet-900/40 backdrop-blur-xl p-6 shadow-2xl shadow-black/20">
      {/* Subtle glow behind active cards */}
      {escrow.status === 'ready' && (
        <div className="absolute -top-20 -right-20 w-40 h-40 bg-violet-500/10 rounded-full blur-3xl animate-pulse-glow" />
      )}

      <div className="relative z-10">
        {/* Header */}
        <div className="flex items-start justify-between mb-5">
          <div>
            <div className="flex items-center gap-3 mb-1">
              <h3 className="text-lg font-semibold tracking-tight text-white">
                Escrow #{escrow.id}
              </h3>
              <span className={`text-xs px-3 py-1 rounded-full font-medium border ${statusConfig.color}`}>
                {statusConfig.label}
              </span>
            </div>
            <p className="text-sm text-slate-400 flex items-center gap-2">
              <span className="font-mono text-slate-500">Worker:</span> 
              <span className="font-mono text-slate-300">{escrow.worker}</span>
              <span className="w-1 h-1 rounded-full bg-slate-600" />
              <span className="text-slate-500">{escrow.created_at}</span>
            </p>
          </div>
          <div className="text-right">
            <p className="text-2xl font-bold tracking-tight text-white">
              ${escrow.amount} <span className="text-sm font-medium text-slate-400">{escrow.currency}</span>
            </p>
            <p className="text-xs text-slate-500">{escrow.hoursLogged} hours logged</p>
          </div>
        </div>

        {/* Progress Stepper */}
        <div className="mb-6">
          <div className="flex items-center justify-between">
            {steps.map((step, idx) => {
              const Icon = step.icon;
              return (
                <div key={idx} className="flex items-center flex-1">
                  <div className="flex flex-col items-center">
                    <div className={`w-8 h-8 rounded-full flex items-center justify-center border-2 transition-colors duration-500 ${
                      step.completed 
                        ? 'bg-violet-500/20 border-violet-500 text-violet-400' 
                        : 'bg-slate-800 border-slate-700 text-slate-500'
                    }`}>
                      <Icon className="w-4 h-4" />
                    </div>
                    <span className="text-xs mt-1 font-medium text-slate-400">{step.label}</span>
                  </div>
                  {idx < steps.length - 1 && (
                    <div className={`h-0.5 flex-1 mx-2 transition-colors duration-500 ${
                      step.completed && steps[idx + 1].completed ? 'bg-violet-500/50' : 
                      step.completed ? 'bg-violet-500/30' : 'bg-slate-700'
                    }`} />
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {/* Alerts */}
        {error && <Alert variant="destructive" className="mb-4 text-sm">{error}</Alert>}
        {success && <Alert variant="success" className="mb-4 text-sm">{success}</Alert>}

        {/* Action Buttons */}
        <div className="flex items-center justify-between border-t border-white/5 pt-4">
          <div className="flex gap-2">
            {escrow.status === 'pending_manager' && (
              <Button 
                onClick={() => handleAction('manager')}
                disabled={!isConnected || isLoading}
                className="bg-gradient-to-r from-purple-600 to-purple-500 hover:from-purple-500 hover:to-purple-400 text-white shadow-lg shadow-purple-500/20"
              >
                <ShieldCheck className="w-4 h-4 mr-2" />
                Manager Approve
              </Button>
            )}
            {escrow.status === 'pending_finance' && (
              <Button 
                onClick={() => handleAction('finance')}
                disabled={!isConnected || isLoading}
                className="bg-gradient-to-r from-indigo-600 to-indigo-500 hover:from-indigo-500 hover:to-indigo-400 text-white shadow-lg shadow-indigo-500/20"
              >
                <CheckCircle2 className="w-4 h-4 mr-2" />
                Finance Approve
              </Button>
            )}
            {escrow.status === 'ready' && (
              <Button 
                onClick={() => handleAction('finalize')}
                disabled={!isConnected || isLoading}
                className="bg-gradient-to-r from-violet-500 to-violet-600 hover:from-violet-400 hover:to-violet-500 text-white shadow-lg shadow-violet-500/20"
              >
                <DollarSign className="w-4 h-4 mr-2" />
                Release Payment
              </Button>
            )}
            {escrow.status === 'paid' && (
              <Button disabled className="bg-slate-700 text-slate-400 cursor-default">
                ✓ Completed
              </Button>
            )}
          </div>
          {escrow.transaction_hash && (
            <a 
              href={`https://stellar.expert/explorer/testnet/tx/${escrow.transaction_hash}`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs text-slate-500 hover:text-emerald-400 transition-colors"
            >
              View on Explorer →
            </a>
          )}
        </div>
      </div>
    </div>
  );
};
