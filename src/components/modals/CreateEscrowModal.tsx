import { useState } from 'react';

interface CreateEscrowModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSubmit: (workerPubKey: string, amountCents: number, rateCents: number) => Promise<void>;
  isMockMode: boolean;
}

export function CreateEscrowModal({ isOpen, onClose, onSubmit, isMockMode }: CreateEscrowModalProps) {
  const [newWorker, setNewWorker] = useState('');
  const [newAmount, setNewAmount] = useState('100');
  const [newRate, setNewRate] = useState('2.5');

  if (!isOpen) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const amountCents = Math.floor(parseFloat(newAmount) * 100);
    const rateCents = Math.floor(parseFloat(newRate) * 100);
    await onSubmit(newWorker.trim(), amountCents, rateCents);
    
    // Reset form after submit
    setNewWorker('');
    setNewAmount('100');
    setNewRate('2.5');
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4 animate-fade-in">
      <div className="bg-slate-900 border border-slate-800 rounded-2xl w-full max-w-md p-6 shadow-2xl animate-scale-up">
        <h3 className="text-base font-extrabold text-white mb-4 uppercase tracking-wider">Initialize New Escrow</h3>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-[10px] uppercase font-bold text-slate-400 mb-1">
              Worker Public Key (Stellar Address)
            </label>
            <input
              type="text"
              required
              placeholder="G..."
              value={newWorker}
              onChange={(e) => setNewWorker(e.target.value)}
              className={`w-full bg-slate-950 border focus:border-violet-500 rounded-lg px-3 py-2 text-xs font-mono text-slate-200 outline-none ${
                newWorker && !isMockMode && !/^[GC][A-Z2-7]{55}$/.test(newWorker.trim())
                  ? 'border-rose-500/50'
                  : 'border-slate-800'
              }`}
            />
            {newWorker && !isMockMode && !/^[GC][A-Z2-7]{55}$/.test(newWorker.trim()) && (
              <p className="mt-1 text-[10px] text-rose-400 font-medium">
                ⚠️ Invalid Stellar address. Must be a 56-character string starting with G or C.
              </p>
            )}
            {!newWorker && (
              <p className="mt-1 text-[10px] text-slate-500">
                {isMockMode 
                  ? 'Enter any identifier (e.g. WorkerA) for the mock demo.'
                  : 'Must be a valid 56-character Stellar address (starts with G or C).'}
              </p>
            )}
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-[10px] uppercase font-bold text-slate-400 mb-1">Max Amount (USDC)</label>
              <input
                type="number"
                step="0.01"
                min="0.1"
                required
                value={newAmount}
                onChange={(e) => setNewAmount(e.target.value)}
                className="w-full bg-slate-950 border border-slate-800 focus:border-violet-500 rounded-lg px-3 py-2 text-xs text-slate-200 outline-none"
              />
            </div>
            <div>
              <label className="block text-[10px] uppercase font-bold text-slate-400 mb-1">Hourly Rate (USDC/hr)</label>
              <input
                type="number"
                step="0.01"
                min="0.01"
                required
                value={newRate}
                onChange={(e) => setNewRate(e.target.value)}
                className="w-full bg-slate-950 border border-slate-800 focus:border-violet-500 rounded-lg px-3 py-2 text-xs text-slate-200 outline-none"
              />
            </div>
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
              Create Escrow
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
