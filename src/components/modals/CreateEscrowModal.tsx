import { useMemo, useState } from 'react';
import { parseAmount, formatAmount, hoursForAmount, MoneyParseError, SAC_DECIMALS } from '@/lib/money';

interface CreateEscrowModalProps {
  isOpen: boolean;
  onClose: () => void;
  /**
   * Amounts are base units (bigint), never dollars-as-number. See lib/money.
   * `financeApprover` is required on-chain: the contract rejects an escrow whose
   * manager and finance approver are the same key.
   */
  onSubmit: (
    workerPubKey: string,
    financeApprover: string,
    amountUnits: bigint,
    rateUnits: bigint
  ) => Promise<void>;
  isMockMode: boolean;
  /** The connected wallet — it becomes the escrow manager. */
  managerAddress?: string;
}

const STELLAR_ADDRESS = /^[GC][A-Z2-7]{55}$/;

export function CreateEscrowModal({
  isOpen,
  onClose,
  onSubmit,
  isMockMode,
  managerAddress,
}: CreateEscrowModalProps) {
  const [newWorker, setNewWorker] = useState('');
  const [financeApprover, setFinanceApprover] = useState('');
  const [newAmount, setNewAmount] = useState('100');
  const [newRate, setNewRate] = useState('2.5');
  const [formError, setFormError] = useState<string | null>(null);

  /**
   * Preview the exact on-chain figures before the user commits funds.
   *
   * The contract enforces `hours × rate_per_hour == amount` and refuses
   * anything else, so an amount that is not a whole multiple of the rate would
   * fund custody into an escrow that can never settle. Surfacing it here turns
   * a stuck escrow into a form message.
   */
  type Preview =
    | { error: string }
    | { error?: undefined; amountUnits: bigint; rateUnits: bigint; hours: bigint };

  const preview: Preview = useMemo((): Preview => {
    try {
      const amountUnits = parseAmount(newAmount, SAC_DECIMALS);
      const rateUnits = parseAmount(newRate, SAC_DECIMALS);
      if (amountUnits <= 0n) return { error: 'Amount must be greater than zero.' };
      if (rateUnits <= 0n) return { error: 'Hourly rate must be greater than zero.' };

      const hours = hoursForAmount(amountUnits, rateUnits);
      if (hours === null) {
        return {
          error:
            `${newAmount} is not a whole number of hours at ${newRate}/hr. ` +
            `Adjust the amount to a multiple of the rate.`,
        };
      }
      return { amountUnits, rateUnits, hours };
    } catch (e) {
      return { error: e instanceof MoneyParseError ? e.message : 'Invalid amount.' };
    }
  }, [newAmount, newRate]);

  if (!isOpen) return null;

  const workerValid = isMockMode || STELLAR_ADDRESS.test(newWorker.trim());
  const financeValid = isMockMode || STELLAR_ADDRESS.test(financeApprover.trim());
  const financeIsManager =
    !!managerAddress && financeApprover.trim() === managerAddress;
  const financeIsWorker =
    !!financeApprover.trim() && financeApprover.trim() === newWorker.trim();

  const canSubmit =
    workerValid &&
    financeValid &&
    !financeIsManager &&
    !financeIsWorker &&
    preview.error === undefined;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);

    if (preview.error !== undefined) {
      setFormError(preview.error);
      return;
    }
    if (financeIsManager) {
      setFormError('Finance approver must be a different person from the manager.');
      return;
    }

    await onSubmit(
      newWorker.trim(),
      financeApprover.trim(),
      preview.amountUnits,
      preview.rateUnits
    );

    setNewWorker('');
    setFinanceApprover('');
    setNewAmount('100');
    setNewRate('2.5');
  };

  const inputCls = (invalid: boolean) =>
    `w-full bg-slate-950 border focus:border-violet-500 rounded-lg px-3 py-2 text-xs font-mono text-slate-200 outline-none ${
      invalid ? 'border-rose-500/50' : 'border-slate-800'
    }`;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4 animate-fade-in"
      role="dialog"
      aria-modal="true"
      aria-labelledby="create-escrow-title"
    >
      <div className="bg-slate-900 border border-slate-800 rounded-2xl w-full max-w-md p-6 shadow-2xl animate-scale-up">
        <h3
          id="create-escrow-title"
          className="text-base font-extrabold text-white mb-4 uppercase tracking-wider"
        >
          Initialize New Escrow
        </h3>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label
              htmlFor="worker-address"
              className="block text-[10px] uppercase font-bold text-slate-400 mb-1"
            >
              Worker Public Key (Stellar Address)
            </label>
            <input
              id="worker-address"
              type="text"
              required
              placeholder="G..."
              value={newWorker}
              onChange={(e) => setNewWorker(e.target.value)}
              className={inputCls(!!newWorker && !workerValid)}
            />
            {newWorker && !workerValid && (
              <p className="mt-1 text-[10px] text-rose-400 font-medium">
                Invalid Stellar address. Must be 56 characters starting with G or C.
              </p>
            )}
          </div>

          <div>
            <label
              htmlFor="finance-approver"
              className="block text-[10px] uppercase font-bold text-slate-400 mb-1"
            >
              Finance Approver (Stellar Address)
            </label>
            <input
              id="finance-approver"
              type="text"
              required
              placeholder="G..."
              value={financeApprover}
              onChange={(e) => setFinanceApprover(e.target.value)}
              className={inputCls(
                (!!financeApprover && !financeValid) || financeIsManager || financeIsWorker
              )}
            />
            {financeIsManager ? (
              <p className="mt-1 text-[10px] text-rose-400 font-medium">
                Separation of duties: the finance approver cannot be the manager
                creating this escrow. The contract rejects it.
              </p>
            ) : financeIsWorker ? (
              <p className="mt-1 text-[10px] text-rose-400 font-medium">
                The worker being paid cannot approve their own payment.
              </p>
            ) : financeApprover && !financeValid ? (
              <p className="mt-1 text-[10px] text-rose-400 font-medium">
                Invalid Stellar address.
              </p>
            ) : (
              <p className="mt-1 text-[10px] text-slate-500">
                A second signer. Funds move only after both this key and the
                manager approve on-chain.
              </p>
            )}
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label
                htmlFor="escrow-amount"
                className="block text-[10px] uppercase font-bold text-slate-400 mb-1"
              >
                Amount (USDC)
              </label>
              <input
                id="escrow-amount"
                type="text"
                inputMode="decimal"
                required
                value={newAmount}
                onChange={(e) => setNewAmount(e.target.value)}
                className="w-full bg-slate-950 border border-slate-800 focus:border-violet-500 rounded-lg px-3 py-2 text-xs text-slate-200 outline-none"
              />
            </div>
            <div>
              <label
                htmlFor="escrow-rate"
                className="block text-[10px] uppercase font-bold text-slate-400 mb-1"
              >
                Hourly Rate (USDC/hr)
              </label>
              <input
                id="escrow-rate"
                type="text"
                inputMode="decimal"
                required
                value={newRate}
                onChange={(e) => setNewRate(e.target.value)}
                className="w-full bg-slate-950 border border-slate-800 focus:border-violet-500 rounded-lg px-3 py-2 text-xs text-slate-200 outline-none"
              />
            </div>
          </div>

          {/* What will actually be funded, in the asset's own units. */}
          <div
            className="rounded-lg border border-slate-800 bg-slate-950/60 px-3 py-2"
            aria-live="polite"
          >
            {preview.error !== undefined ? (
              <p className="text-[10px] text-rose-400 font-medium">{preview.error}</p>
            ) : (
              <dl className="space-y-1 text-[10px]">
                <div className="flex justify-between">
                  <dt className="text-slate-400 uppercase font-bold">Escrowed</dt>
                  <dd className="text-slate-200 font-mono">
                    {formatAmount(preview.amountUnits, SAC_DECIMALS)} USDC
                  </dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-slate-400 uppercase font-bold">Verified hours</dt>
                  <dd className="text-slate-200 font-mono">
                    {preview.hours.toString()} h @ {formatAmount(preview.rateUnits, SAC_DECIMALS)}/h
                  </dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-slate-400 uppercase font-bold">Base units</dt>
                  <dd className="text-slate-500 font-mono">
                    {preview.amountUnits.toString()}
                  </dd>
                </div>
              </dl>
            )}
          </div>

          {formError && (
            <p role="alert" className="text-[10px] text-rose-400 font-medium">
              {formError}
            </p>
          )}

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
              disabled={!canSubmit}
              className="px-4 py-1.5 rounded-lg text-xs font-semibold bg-violet-600 hover:bg-violet-500 disabled:bg-slate-700 disabled:text-slate-500 disabled:cursor-not-allowed text-white transition-colors"
            >
              Create Escrow
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
