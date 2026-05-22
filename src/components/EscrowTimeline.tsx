'use client';

import { Clock, Check } from 'lucide-react';

interface EscrowTimelineProps {
  status: 'pending_hours' | 'pending_manager' | 'pending_finance' | 'ready' | 'paid' | 'cancelled';
  managerApproved: boolean;
  financeApproved: boolean;
  hoursVerified: boolean;
}

export const EscrowTimeline = ({
  status,
  managerApproved,
  financeApproved,
  hoursVerified,
}: EscrowTimelineProps) => {
  const steps = [
    { label: 'Created', completed: true, active: status !== 'cancelled', color: 'text-slate-400' },
    { label: 'Hours', completed: hoursVerified, active: status === 'pending_hours', color: 'text-fuchsia-400' },
    { label: 'Manager', completed: managerApproved, active: status === 'pending_manager', color: 'text-purple-400' },
    { label: 'Finance', completed: financeApproved, active: status === 'pending_finance', color: 'text-indigo-400' },
    { label: 'Released', completed: status === 'paid', active: status === 'ready', color: 'text-emerald-400' },
  ];

  if (status === 'cancelled') {
    return (
      <div className="mt-4 p-3 rounded-xl bg-rose-500/10 border border-rose-500/20 text-center">
        <p className="text-xs font-semibold text-rose-400">Escrow Contract Cancelled</p>
      </div>
    );
  }

  return (
    <div className="mt-4 border-t border-white/5 pt-4">
      <p className="text-[10px] text-slate-500 uppercase tracking-wider mb-3 font-semibold">Workflow Status</p>
      <div className="flex items-center justify-between">
        {steps.map((step, idx) => {
          const isCompleted = step.completed;
          const isActive = step.active;

          return (
            <div key={idx} className="flex items-center flex-1">
              <div className="flex flex-col items-center relative">
                {/* Dot */}
                <div
                  className={`w-5 h-5 rounded-full flex items-center justify-center border transition-all duration-300 ${
                    isCompleted
                      ? 'bg-violet-500/20 border-violet-500 text-violet-400 shadow-md shadow-violet-500/20'
                      : isActive
                      ? 'bg-slate-900 border-violet-400 text-violet-400 animate-pulse'
                      : 'bg-slate-950 border-slate-800 text-slate-600'
                  }`}
                >
                  {isCompleted ? (
                    <Check className="w-3 h-3 stroke-[3]" />
                  ) : isActive ? (
                    <Clock className="w-2.5 h-2.5 animate-spin" style={{ animationDuration: '4s' }} />
                  ) : (
                    <span className="w-1.5 h-1.5 rounded-full bg-slate-700" />
                  )}
                </div>
                {/* Label */}
                <span className={`text-[10px] mt-1 font-semibold transition-colors duration-300 ${
                  isCompleted ? 'text-slate-300' : isActive ? 'text-violet-400 font-bold' : 'text-slate-600'
                }`}>
                  {step.label}
                </span>
              </div>

              {/* Connecting line */}
              {idx < steps.length - 1 && (
                <div className="flex-1 mx-2 -mt-4 relative h-0.5">
                  <div className="absolute inset-0 bg-slate-800 rounded" />
                  <div
                    className="absolute inset-0 bg-gradient-to-r from-violet-500 to-indigo-500 rounded transition-all duration-500"
                    style={{
                      width: isCompleted ? '100%' : '0%',
                    }}
                  />
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
};
