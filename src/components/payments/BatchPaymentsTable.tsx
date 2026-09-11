'use client';

import { PaymentStateBadge, PaymentTransactionRef } from './PaymentStateBadge';
import { txUrl } from '@/lib/explorer';

/**
 * Per-payment breakdown of a batch.
 *
 * A batch is NOT a payment. It was previously rendered as one row carrying the
 * first payee's figures, so a twelve-contractor payroll looked like a single
 * $800 payment and eleven people were invisible. Each payment gets its own row,
 * its own amount, and its own state.
 *
 * The summary line reports the batch as broken if ANY payment is broken, rather
 * than by majority: the one failed payment in an otherwise-paid batch is exactly
 * the one a finance team needs to see.
 */

export interface BatchPaymentRow {
  id: string;
  index?: number | null;
  recipient: string;
  /** Pre-formatted at the asset's own precision — never re-derived here. */
  amount: string;
  hours?: string;
  state: string;
  txHash?: string | null;
}

export interface BatchPaymentsTableProps {
  reference?: string;
  payments: readonly BatchPaymentRow[];
  /** Pre-formatted batch total. */
  total?: string;
  assetCode?: string;
  className?: string;
}

const short = (addr: string) =>
  addr.length > 14 ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : addr;

export function BatchPaymentsTable({
  reference,
  payments,
  total,
  assetCode = 'USDC',
  className = '',
}: BatchPaymentsTableProps) {
  if (payments.length === 0) {
    return (
      <div className={`rounded-xl border border-slate-800 bg-slate-950/50 p-6 text-center ${className}`}>
        <p className="text-xs font-semibold text-slate-300">No payments in this batch</p>
        <p className="mt-1 text-[11px] text-slate-500">
          Payments appear here once the escrow is funded on-chain and indexed.
        </p>
      </div>
    );
  }

  return (
    <div className={className}>
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-xs font-bold uppercase tracking-wider text-slate-300">
          {reference ? `Batch ${reference}` : 'Payments'}
          <span className="ml-2 font-normal normal-case tracking-normal text-slate-500">
            {payments.length} payment{payments.length === 1 ? '' : 's'}
          </span>
        </h3>
        {total && (
          <p className="font-mono text-xs text-slate-200">
            {total} <span className="text-slate-500">{assetCode}</span>
          </p>
        )}
      </div>

      {/* Wide content scrolls inside its own container so the page never does. */}
      <div className="overflow-x-auto rounded-xl border border-slate-800">
        <table className="w-full min-w-[560px] border-collapse text-left">
          <caption className="sr-only">
            {reference ? `Payments in batch ${reference}` : 'Payments'}, with
            recipient, amount and current lifecycle state.
          </caption>
          <thead>
            <tr className="bg-slate-900/60 text-[10px] uppercase tracking-wider text-slate-400">
              <th scope="col" className="px-3 py-2 font-bold">#</th>
              <th scope="col" className="px-3 py-2 font-bold">Recipient</th>
              <th scope="col" className="px-3 py-2 text-right font-bold">Amount</th>
              <th scope="col" className="px-3 py-2 text-right font-bold">Hours</th>
              <th scope="col" className="px-3 py-2 font-bold">State</th>
              <th scope="col" className="px-3 py-2 font-bold">Transaction</th>
            </tr>
          </thead>
          <tbody>
            {payments.map((p, i) => (
              <tr
                key={p.id}
                className="border-t border-slate-800/70 text-xs text-slate-200 hover:bg-slate-900/40"
              >
                <td className="px-3 py-2 text-slate-500">{(p.index ?? i) + 1}</td>
                <td className="px-3 py-2">
                  <span className="font-mono text-[11px]" title={p.recipient}>
                    {short(p.recipient)}
                  </span>
                </td>
                <td className="px-3 py-2 text-right font-mono tabular-nums">{p.amount}</td>
                <td className="px-3 py-2 text-right font-mono tabular-nums text-slate-400">
                  {p.hours ?? '—'}
                </td>
                <td className="px-3 py-2">
                  <PaymentStateBadge state={p.state} />
                </td>
                <td className="px-3 py-2">
                  {/* Only rendered where a transaction can actually exist. */}
                  <PaymentTransactionRef
                    state={p.state}
                    hash={p.txHash}
                    href={p.txHash ? txUrl(p.txHash) : undefined}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
