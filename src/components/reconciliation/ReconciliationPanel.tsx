'use client';

import { FindingSeverity, FindingStatus, RunStatus } from '@prisma/client';

/**
 * Operational reconciliation view.
 *
 * ── Two audiences, two vocabularies ──────────────────────────────────────────
 * An ordinary finance user needs to know whether they can trust a payment record.
 * An operator needs the RPC condition, the finding kind and the transaction. The
 * same screen serves both: plain language at the top, detail behind `detailed`.
 *
 * ── Why "no findings" is not automatically green ──────────────────────────────
 * If the last run failed, or never happened, an empty findings list means nothing
 * was checked — not that everything is correct. Silence is reported as DEGRADED,
 * because a reconciler whose last run died is more dangerous than none: the
 * absence of findings reads as health.
 */

export interface RunSummaryView {
  id: string;
  correlationId: string;
  status: RunStatus | string;
  startedAt: string;
  completedAt: string | null;
  paymentsExamined: number;
  agreed: number;
  mismatched: number;
  unreadable: number;
  findingsOpened: number;
  correctionsApplied: number;
  errorMessage: string | null;
}

export interface FindingView {
  id: string;
  kind: string;
  status: FindingStatus | string;
  severity: FindingSeverity | string;
  detail: string | null;
  remediation: string | null;
  dbState: string | null;
  chainState: string | null;
  escrowOnChainId: number | null;
  paymentIndex: number | null;
  transaction: { hash: string; explorerUrl: string } | null;
  payment: {
    id: string;
    recipient: string;
    amount: string;
    assetCode: string;
    state: string;
    batch: { id: string; reference: string } | null;
  } | null;
  detectedAt: string;
  lastObservedAt: string;
  observationCount: number;
  acknowledgedBy: string | null;
  resolvedBy: string | null;
  resolution: string | null;
}

export interface ReconciliationPanelProps {
  health: {
    lastRun: RunSummaryView | null;
    openFindings: number;
    criticalFindings: number;
    oldestUnresolvedHours: number | null;
    degraded: boolean;
    degradedReason?: string;
  };
  findings: readonly FindingView[];
  /** Operator mode: infrastructure terms, finding kinds, correlation ids. */
  detailed?: boolean;
  onResolve?: (findingId: string) => void;
  onAcknowledge?: (findingId: string) => void;
  onRunNow?: () => void;
  isRunning?: boolean;
}

const SEVERITY_STYLE: Record<string, string> = {
  CRITICAL: 'border-rose-500/50 bg-rose-500/10 text-rose-300',
  HIGH: 'border-orange-500/50 bg-orange-500/10 text-orange-300',
  MEDIUM: 'border-amber-500/40 bg-amber-500/10 text-amber-300',
  LOW: 'border-slate-600/40 bg-slate-500/10 text-slate-300',
};

/**
 * Plain-language summaries for non-operators.
 *
 * Deliberately never reassuring about an unverified payment: a finance user seeing
 * "Payment verification delayed" for a DB_PAID_CHAIN_NOT would be misled, so that
 * one says plainly that the record cannot be relied on.
 */
const PLAIN_LANGUAGE: Record<string, string> = {
  DB_PAID_CHAIN_NOT: 'This payment is shown as paid but could not be confirmed. Do not rely on it yet.',
  FAILED_TX_ACTUALLY_SUCCEEDED: 'This payment may already have gone through. Do not send it again.',
  AMOUNT_MISMATCH: 'The amount paid does not match the amount recorded.',
  RECIPIENT_MISMATCH: 'The payment reached a different account than recorded.',
  ASSET_MISMATCH: 'The payment was made in a different currency than recorded.',
  DUPLICATE_PAYMENT_EVENT: 'This worker may have been paid more than once.',
  MISSING_PAYMENT_EVENT: 'We could not confirm this payment actually reached the recipient.',
  CHAIN_PAID_DB_NOT: 'Payment confirmation is still catching up.',
  MISSING_ON_CHAIN: 'This payment record has no matching on-chain payment.',
  ORPHAN_ON_CHAIN: 'An on-chain payment is not yet shown in CoreFlow.',
  UNKNOWN_ON_CHAIN_OBJECT: 'An escrow on Stellar is not linked to this workspace.',
  CHAIN_UNREADABLE: 'Payment verification delayed — Stellar could not be reached.',
  OTHER: 'This payment needs manual review.',
};

function ago(iso: string): string {
  const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export function ReconciliationPanel({
  health, findings, detailed = false,
  onResolve, onAcknowledge, onRunNow, isRunning = false,
}: ReconciliationPanelProps) {
  const { lastRun } = health;
  const healthy = !health.degraded && health.criticalFindings === 0;

  return (
    <section className="space-y-4">
      {/* ── Status ───────────────────────────────────────────────────── */}
      <div
        className={`rounded-xl border p-4 ${
          health.degraded
            ? 'border-rose-500/40 bg-rose-500/5'
            : health.criticalFindings > 0
              ? 'border-orange-500/40 bg-orange-500/5'
              : 'border-emerald-500/30 bg-emerald-500/5'
        }`}
      >
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-sm font-bold uppercase tracking-wider text-slate-200">
              Payment verification
            </h2>
            <p
              className={`mt-1 text-xs ${
                health.degraded ? 'text-rose-300' : healthy ? 'text-emerald-300' : 'text-orange-300'
              }`}
              role="status"
            >
              {health.degraded
                ? // An empty findings list after a failed run means nothing was
                  // checked, which must never read as "all clear".
                  health.degradedReason ?? 'Verification is not running normally.'
                : health.criticalFindings > 0
                  ? `${health.criticalFindings} payment${health.criticalFindings === 1 ? '' : 's'} need urgent attention.`
                  : 'All payments verified against Stellar.'}
            </p>
          </div>

          {onRunNow && (
            <button
              type="button"
              onClick={onRunNow}
              disabled={isRunning}
              className="rounded-lg border border-slate-700 bg-slate-800 px-3 py-1.5 text-xs font-semibold text-slate-200 hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {isRunning ? 'Checking…' : 'Check now'}
            </button>
          )}
        </div>

        {lastRun ? (
          <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-1 text-[11px] sm:grid-cols-4">
            <div>
              <dt className="text-slate-500">Last check</dt>
              <dd className="font-mono text-slate-200">
                {ago(lastRun.startedAt)}
                {lastRun.status !== RunStatus.COMPLETED && (
                  <span className="ml-1 text-rose-400">({String(lastRun.status).toLowerCase()})</span>
                )}
              </dd>
            </div>
            <div>
              <dt className="text-slate-500">Payments checked</dt>
              <dd className="font-mono text-slate-200">{lastRun.paymentsExamined}</dd>
            </div>
            <div>
              <dt className="text-slate-500">Verified</dt>
              <dd className="font-mono text-slate-200">{lastRun.agreed}</dd>
            </div>
            <div>
              <dt className="text-slate-500">Needs attention</dt>
              <dd className="font-mono text-slate-200">{health.openFindings}</dd>
            </div>
            {detailed && (
              <>
                <div>
                  <dt className="text-slate-500">Could not check</dt>
                  <dd className="font-mono text-slate-200">{lastRun.unreadable}</dd>
                </div>
                <div>
                  <dt className="text-slate-500">Corrections applied</dt>
                  <dd className="font-mono text-slate-200">{lastRun.correctionsApplied}</dd>
                </div>
                <div className="col-span-2">
                  <dt className="text-slate-500">Run id</dt>
                  <dd className="truncate font-mono text-[10px] text-slate-400">
                    {lastRun.correlationId}
                  </dd>
                </div>
              </>
            )}
          </dl>
        ) : (
          <p className="mt-3 text-[11px] text-slate-400">
            No verification has run yet for this workspace.
          </p>
        )}

        {detailed && lastRun?.errorMessage && (
          <p className="mt-2 rounded-lg border border-rose-500/30 bg-rose-950/30 p-2 font-mono text-[10px] text-rose-300">
            {lastRun.errorMessage}
          </p>
        )}
      </div>

      {/* ── Findings ─────────────────────────────────────────────────── */}
      {findings.length === 0 ? (
        <div className="rounded-xl border border-slate-800 bg-slate-950/50 p-6 text-center">
          <p className="text-xs font-semibold text-slate-300">
            {health.degraded ? 'Nothing to show' : 'No issues found'}
          </p>
          <p className="mt-1 text-[11px] text-slate-500">
            {health.degraded
              ? 'Verification has not completed, so no payments were checked.'
              : 'Every payment matches its on-chain settlement.'}
          </p>
        </div>
      ) : (
        <ul className="space-y-3">
          {findings.map((f) => (
            <li
              key={f.id}
              className={`rounded-xl border p-4 ${SEVERITY_STYLE[String(f.severity)] ?? SEVERITY_STYLE.LOW}`}
            >
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-xs font-bold uppercase tracking-wider">
                    {String(f.severity)}
                    {detailed && (
                      <span className="ml-2 font-mono text-[10px] font-normal opacity-80">
                        {f.kind}
                      </span>
                    )}
                  </p>
                  <p className="mt-1 text-xs text-slate-200">
                    {PLAIN_LANGUAGE[f.kind] ?? f.detail ?? 'Needs review.'}
                  </p>
                </div>
                <span className="shrink-0 rounded-full border border-current/30 px-2 py-0.5 text-[10px] font-bold uppercase">
                  {String(f.status)}
                </span>
              </div>

              {f.payment && (
                <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-[11px] sm:grid-cols-4">
                  <div>
                    <dt className="text-slate-500">Payment</dt>
                    <dd className="font-mono text-slate-300">
                      {f.payment.batch?.reference ?? f.payment.id.slice(0, 10)}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-slate-500">Recipient</dt>
                    <dd className="font-mono text-slate-300">
                      {f.payment.recipient.slice(0, 6)}…{f.payment.recipient.slice(-4)}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-slate-500">Amount</dt>
                    <dd className="font-mono tabular-nums text-slate-300">
                      {f.payment.amount} {f.payment.assetCode}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-slate-500">CoreFlow says</dt>
                    <dd className="font-mono text-slate-300">{f.payment.state}</dd>
                  </div>
                </dl>
              )}

              {detailed && (
                <dl className="mt-3 space-y-1 border-t border-current/20 pt-3 text-[11px]">
                  {f.dbState && (
                    <div className="flex gap-2">
                      <dt className="w-24 shrink-0 text-slate-500">Database</dt>
                      <dd className="font-mono text-slate-300">{f.dbState}</dd>
                    </div>
                  )}
                  {f.chainState && (
                    <div className="flex gap-2">
                      <dt className="w-24 shrink-0 text-slate-500">Chain</dt>
                      <dd className="font-mono text-slate-300">{f.chainState}</dd>
                    </div>
                  )}
                  {f.escrowOnChainId !== null && (
                    <div className="flex gap-2">
                      <dt className="w-24 shrink-0 text-slate-500">Escrow</dt>
                      <dd className="font-mono text-slate-300">
                        #{f.escrowOnChainId}
                        {f.paymentIndex !== null && ` · slot ${f.paymentIndex}`}
                      </dd>
                    </div>
                  )}
                  {f.transaction && (
                    <div className="flex gap-2">
                      <dt className="w-24 shrink-0 text-slate-500">Transaction</dt>
                      <dd>
                        <a
                          href={f.transaction.explorerUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="font-mono text-violet-300 underline decoration-dotted"
                        >
                          {f.transaction.hash.slice(0, 10)}…
                        </a>
                      </dd>
                    </div>
                  )}
                  <div className="flex gap-2">
                    <dt className="w-24 shrink-0 text-slate-500">First seen</dt>
                    <dd className="text-slate-300">
                      {ago(f.detectedAt)}
                      {f.observationCount > 1 && (
                        <span className="text-slate-500">
                          {' '}· still present after {f.observationCount} checks
                        </span>
                      )}
                    </dd>
                  </div>
                </dl>
              )}

              {f.remediation && (
                <p className="mt-3 rounded-lg border border-current/20 bg-black/20 p-2 text-[11px] text-slate-300">
                  <span className="font-bold uppercase tracking-wider">What to do: </span>
                  {f.remediation}
                </p>
              )}

              {f.resolution && (
                <p className="mt-2 text-[11px] text-slate-400">
                  <span className="font-bold">Resolved</span>
                  {f.resolvedBy && ` by ${f.resolvedBy.slice(0, 6)}…`}: {f.resolution}
                </p>
              )}

              {(onAcknowledge || onResolve) && f.status !== FindingStatus.RESOLVED && (
                <div className="mt-3 flex gap-2">
                  {onAcknowledge && f.status === FindingStatus.OPEN && (
                    <button
                      type="button"
                      onClick={() => onAcknowledge(f.id)}
                      className="rounded-lg border border-slate-700 bg-slate-800/60 px-2.5 py-1 text-[11px] font-semibold text-slate-200 hover:bg-slate-700"
                    >
                      Acknowledge
                    </button>
                  )}
                  {onResolve && (
                    <button
                      type="button"
                      onClick={() => onResolve(f.id)}
                      className="rounded-lg border border-slate-700 bg-slate-800/60 px-2.5 py-1 text-[11px] font-semibold text-slate-200 hover:bg-slate-700"
                    >
                      Resolve…
                    </button>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
