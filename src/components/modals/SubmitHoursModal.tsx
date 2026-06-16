import { useState } from 'react';

interface SubmitHoursModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSubmit: (escrowId: number, paymentId: number, hoursValue: string) => Promise<void>;
}

export function SubmitHoursModal({ isOpen, onClose, onSubmit }: SubmitHoursModalProps) {
  const [hoursEscrowId, setHoursEscrowId] = useState<number>(1);
  const [hoursPaymentId, setHoursPaymentId] = useState<number>(0);
  const [hoursValue, setHoursValue] = useState('40');

  if (!isOpen) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    await onSubmit(hoursEscrowId, hoursPaymentId, hoursValue);
    
    // reset defaults on close
    setHoursEscrowId(1);
    setHoursPaymentId(0);
    setHoursValue('40');
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4 animate-fade-in">
      <div className="bg-slate-900 border border-slate-800 rounded-2xl w-full max-w-md p-6 shadow-2xl animate-scale-up">
        <h3 className="text-base font-extrabold text-white mb-4 uppercase tracking-wider">Submit Oracle Work Proof</h3>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-[10px] uppercase font-bold text-slate-400 mb-1">Escrow ID</label>
              <input
                type="number"
                required
                min="1"
                value={hoursEscrowId}
                onChange={(e) => setHoursEscrowId(parseInt(e.target.value))}
                className="w-full bg-slate-950 border border-slate-800 focus:border-violet-500 rounded-lg px-3 py-2 text-xs text-slate-200 outline-none"
              />
            </div>
            <div>
              <label className="block text-[10px] uppercase font-bold text-slate-400 mb-1">Schedule index</label>
              <input
                type="number"
                required
                min="0"
                value={hoursPaymentId}
                onChange={(e) => setHoursPaymentId(parseInt(e.target.value))}
                className="w-full bg-slate-950 border border-slate-800 focus:border-violet-500 rounded-lg px-3 py-2 text-xs text-slate-200 outline-none"
              />
            </div>
          </div>

          <div>
            <label className="block text-[10px] uppercase font-bold text-slate-400 mb-1">Hours Logged</label>
            <input
              type="number"
              required
              min="1"
              value={hoursValue}
              onChange={(e) => setHoursValue(e.target.value)}
              className="w-full bg-slate-950 border border-slate-800 focus:border-violet-500 rounded-lg px-3 py-2 text-xs text-slate-200 outline-none"
            />
          </div>

          <div className="p-3 rounded-lg bg-violet-950/20 border border-violet-500/10 text-[10px] text-slate-400 leading-normal">
            💡 Submit will cryptographically verify hours proofs using Ed25519 signature validation matching the smart contract configuration.
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="px-3 py-1.5 rounded-lg text-xs font-semibold hover:bg-slate-800 text-slate-400 transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              className="px-4 py-1.5 rounded-lg text-xs font-semibold bg-violet-600 hover:bg-violet-500 text-white transition-colors"
            >
              Submit Hours
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
