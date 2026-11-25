'use client';

import { STELLAR_CONFIG } from '@/lib/config';

/**
 * Persistent, unmissable label for the chain CoreFlow is pointed at.
 *
 * Every figure in this product is a monetary amount, and the same screen means
 * something completely different depending on whether the funds behind it are
 * real. Testnet is styled as an advisory; Mainnet is styled as a warning,
 * because that is the state where a mistaken click costs money.
 *
 * An unconfigured contract is called out rather than hidden: the app cannot
 * transact at all in that state, and a silent read failure looks identical to
 * "no data yet".
 */
export function NetworkBadge({ className = '' }: { className?: string }) {
  const configured = STELLAR_CONFIG.isConfigured();
  const mainnet = STELLAR_CONFIG.isMainnet();

  if (!configured) {
    return (
      <span
        role="status"
        title="NEXT_PUBLIC_STELLAR_CONTRACT_ID is not set — on-chain actions are unavailable."
        className={`inline-flex items-center gap-1.5 rounded-full border border-amber-500/40 bg-amber-500/10 px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider text-amber-300 ${className}`}
      >
        <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-amber-400" />
        Chain not configured
      </span>
    );
  }

  return (
    <span
      role="status"
      title={
        mainnet
          ? 'Live network. Transactions move real funds.'
          : 'Test network. No real funds can move.'
      }
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider ${
        mainnet
          ? 'border-rose-500/40 bg-rose-500/10 text-rose-300'
          : 'border-sky-500/40 bg-sky-500/10 text-sky-300'
      } ${className}`}
    >
      <span
        aria-hidden
        className={`h-1.5 w-1.5 rounded-full ${mainnet ? 'bg-rose-400' : 'bg-sky-400'}`}
      />
      {STELLAR_CONFIG.networkLabel()}
      {mainnet && <span className="sr-only"> — transactions move real funds</span>}
    </span>
  );
}
