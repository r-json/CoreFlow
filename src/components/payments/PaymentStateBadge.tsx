'use client';

import { PaymentState } from '@prisma/client';
import { describeState, type StateDescriptor } from '@/lib/payments/state-machine';

/**
 * Renders a payment's real lifecycle state.
 *
 * ── Why there is no "Processing" ──────────────────────────────────────────────
 * Collapsing AWAITING_ORACLE, AWAITING_MANAGER, AWAITING_FINANCE, SUBMITTING and
 * CONFIRMING into one spinner tells an operator nothing about what to do next —
 * and three of those five are waiting on a *person*, not on a machine. Each state
 * carries its own label and its own one-line explanation of what is actually true
 * right now.
 *
 * Tone comes from the state descriptor, so a state cannot be styled as success in
 * one view and danger in another. Only PAID is ever green.
 */

const TONE_CLASSES: Record<StateDescriptor['tone'], string> = {
  neutral: 'border-slate-600/40 bg-slate-500/10 text-slate-300',
  progress: 'border-violet-500/40 bg-violet-500/10 text-violet-300',
  pending: 'border-amber-500/40 bg-amber-500/10 text-amber-300',
  success: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300',
  warning: 'border-orange-500/40 bg-orange-500/10 text-orange-300',
  danger: 'border-rose-500/40 bg-rose-500/10 text-rose-300',
};

/** States where something is genuinely in flight, so a pulse is honest. */
const IN_FLIGHT: readonly PaymentState[] = [
  PaymentState.VALIDATING,
  PaymentState.SUBMITTING,
  PaymentState.CONFIRMING,
];

export interface PaymentStateBadgeProps {
  state: PaymentState | string;
  /** Show the explanatory line beneath the label. */
  withDescription?: boolean;
  className?: string;
}

export function PaymentStateBadge({
  state,
  withDescription = false,
  className = '',
}: PaymentStateBadgeProps) {
  // An unrecognized state is surfaced, not normalised into something benign:
  // rendering an unknown value as "Pending" would hide a real data problem.
  const known = (Object.values(PaymentState) as string[]).includes(state as string);
  if (!known) {
    return (
      <span
        role="status"
        title={`Unrecognized payment state: ${state}`}
        className={`inline-flex items-center gap-1.5 rounded-full border border-rose-500/40 bg-rose-500/10 px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider text-rose-300 ${className}`}
      >
        Unknown state
      </span>
    );
  }

  const s = state as PaymentState;
  const d = describeState(s);
  const inFlight = IN_FLIGHT.includes(s);

  return (
    <span className={`inline-flex flex-col gap-0.5 ${className}`}>
      <span
        role="status"
        title={d.description}
        className={`inline-flex items-center gap-1.5 self-start rounded-full border px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider ${TONE_CLASSES[d.tone]}`}
      >
        <span
          aria-hidden
          className={`h-1.5 w-1.5 rounded-full bg-current ${inFlight ? 'animate-pulse' : ''}`}
        />
        {d.label}
        {d.needsAttention && <span className="sr-only"> — needs attention</span>}
      </span>
      {withDescription && (
        <span className="text-[10px] leading-snug text-slate-400">{d.description}</span>
      )}
    </span>
  );
}

/**
 * A payment's transaction reference, shown only where one can exist.
 *
 * Two conditions, both required: the state must be one where a transaction is
 * plausible, AND a hash must actually be present. Rendering an explorer link for
 * a payment that was never submitted invites a reader to believe something
 * settled — and a link for SUBMISSION_FAILED would point at nothing at all.
 */
export function PaymentTransactionRef({
  state,
  hash,
  href,
}: {
  state: PaymentState | string;
  hash: string | null | undefined;
  href?: string;
}) {
  const known = (Object.values(PaymentState) as string[]).includes(state as string);
  if (!known || !hash) return null;
  if (!describeState(state as PaymentState).mayHaveTransaction) return null;

  const short = `${hash.slice(0, 8)}…${hash.slice(-6)}`;
  return href ? (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="font-mono text-[10px] text-violet-300 underline decoration-dotted hover:text-violet-200"
    >
      {short}
    </a>
  ) : (
    <span className="font-mono text-[10px] text-slate-400">{short}</span>
  );
}
