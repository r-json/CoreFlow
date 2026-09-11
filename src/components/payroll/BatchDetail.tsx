'use client';

/**
 * Batch detail — where a finance user understands a payroll.
 *
 * What is being paid, to whom, how much, what is waiting, what happened, whether
 * funds have moved, and what evidence proves it.
 *
 * Two standing rules:
 *
 * 1. EVERY STATEMENT HAS A SOURCE. Money comes from the server already formatted,
 *    with the exact base-unit value alongside it. The activity timeline is rendered
 *    from real `AuditEvent` rows and nothing else — it will look sparse early in a
 *    batch's life, and that is correct. Padding it with plausible entries nobody
 *    recorded would make the one screen whose job is to show what happened the least
 *    trustworthy thing in the product.
 * 2. APPROVAL IS READ FROM APPROVAL RECORDS, never inferred from a payment's state.
 *    A payment can be AWAITING_FINANCE for reasons unrelated to who signed what.
 */

import { Fragment, useMemo, useState } from 'react';
import { NetworkBadge } from '@/components/NetworkBadge';
import { FundingPanel } from '@/components/funding/FundingPanel';

export interface BatchDetailPayment {
  id: string;
  recipient: string;
  amount: string;
  amountBaseUnits: string;
  /** Formatted by the server. The exact value is rateBaseUnits. */
  rate: string;
  rateBaseUnits: string;
  hours: string;
  asset: string | null;
  state: string;
  stateLabel: string;
  tone: string;
  needsAttention: boolean;
  stateReason: string | null;
  reference: string | null;
  transactionHash: string | null;
  settledAt: string | null;
  onChainPaymentIndex: number | null;
  approvals: {
    role: string;
    decision: string;
    actorAddress: string;
    createdAt: string | null;
  }[];
}

export interface BatchDetailData {
  batch: {
    id: string;
    reference: string;
    projectId: string | null;
    periodStart: string | null;
    periodEnd: string | null;
    createdAt: string | null;
    source: {
      filename: string | null;
      rowsSeen: number | null;
      checksum: string | null;
      uploadedBy: string | null;
    };
    total: string;
    totalBaseUnits: string;
    asset: string | null;
    paymentCount: number;
    standing: {
      headline: string;
      byState: Record<string, number>;
      needsAttention: number;
      totalAmountBaseUnits: string;
      paidAmountBaseUnits: string;
      paid: string;
    };
    payments: BatchDetailPayment[];
  };
  activity: {
    id: string;
    type: string;
    at: string | null;
    actor: { kind: 'user'; address: string } | { kind: 'system'; system: string } | null;
    previousState: string | null;
    newState: string | null;
    txHash: string | null;
    paymentId: string | null;
    metadata: Record<string, unknown> | null;
  }[];
  findings: {
    id: string;
    kind: string;
    severity: string;
    status: string;
    detail: string;
    paymentId: string | null;
    firstDetectedAt: string | null;
    lastObservedAt: string | null;
    observationCount: number | null;
    remediation: string | null;
  }[];
}

/**
 * Internal state → the words a finance user reads.
 *
 * A mapping only. The UI never derives a financial state of its own, and
 * deliberately never renders an unverified outcome as "Failed": "still verifying"
 * and "failed" are different claims about somebody's money.
 */
const STATE_LABELS: Record<string, string> = {
  DRAFT: 'Draft',
  VALIDATING: 'Preparing to fund',
  AWAITING_ORACLE: 'Awaiting work verification',
  ORACLE_VERIFIED: 'Work verified',
  AWAITING_MANAGER: 'Awaiting manager approval',
  AWAITING_FINANCE: 'Awaiting finance approval',
  READY_TO_SETTLE: 'Ready to settle',
  SUBMITTING: 'Submitting',
  CONFIRMING: 'Confirming on Stellar',
  PAID: 'Paid',
  REJECTED: 'Rejected',
  CANCELLED: 'Cancelled',
  EXPIRED: 'Expired',
  SUBMISSION_FAILED: 'Submission failed',
  SETTLEMENT_FAILED: 'Settlement failed',
  RECONCILIATION_REQUIRED: 'Needs attention',
};

/** Audit event types → readable lines. Unknown types render their own type. */
const EVENT_LABELS: Record<string, string> = {
  'payroll.batch.created': 'Payroll batch created',
  'funding.intent.opened': 'Funding prepared',
  'funding.submitted': 'Funding transaction submitted',
  'funding.confirmed': 'Funding confirmed on Stellar',
  'funding.failed': 'Funding failed',
  'funding.declined': 'Funding signature declined',
  'funding.mismatch': 'Funding could not be verified',
  'payment.state.changed': 'Payment state changed',
  'approval.granted': 'Approval recorded',
  'payment.indexed': 'Payment observed on-chain',
};

const EXPLORER = 'https://stellar.expert/explorer/testnet';

function truncate(value: string, head = 6, tail = 6): string {
  return value.length > head + tail + 2 ? `${value.slice(0, head)}…${value.slice(-tail)}` : value;
}

function formatWhen(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toISOString().replace('T', ' ').slice(0, 16);
}

function formatDay(iso: string | null): string {
  return iso ? iso.slice(0, 10) : '—';
}

export interface BatchDetailProps {
  data: BatchDetailData;
  orgId?: string;
  /** Called after funding confirms, so the host can refetch. */
  onChanged?: () => void;
}

export function BatchDetail({ data, orgId, onChanged }: BatchDetailProps) {
  const { batch, activity, findings } = data;
  const [expanded, setExpanded] = useState<string | null>(null);
  const [showTechnical, setShowTechnical] = useState(false);

  const headline = STATE_LABELS[batch.standing.headline] ?? batch.standing.headline;

  /** Approvals across the batch, from Approval records rather than payment state. */
  const approvalSummary = useMemo(() => {
    const byRole = new Map<string, { actorAddress: string; createdAt: string | null }>();
    for (const p of batch.payments) {
      for (const a of p.approvals) {
        if (a.decision === 'APPROVED' && !byRole.has(a.role)) {
          byRole.set(a.role, { actorAddress: a.actorAddress, createdAt: a.createdAt });
        }
      }
    }
    return byRole;
  }, [batch.payments]);

  const findingsByPayment = useMemo(() => {
    const map = new Map<string, BatchDetailData['findings']>();
    for (const f of findings) {
      if (!f.paymentId) continue;
      map.set(f.paymentId, [...(map.get(f.paymentId) ?? []), f]);
    }
    return map;
  }, [findings]);

  return (
    <div className="mx-auto max-w-6xl space-y-6 px-4 py-8">
      <header>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="text-xs font-semibold uppercase tracking-widest text-slate-500">
              Payroll batch
            </p>
            <h1 className="mt-1 font-mono text-3xl font-semibold tracking-tight text-slate-50">
              {batch.reference}
            </h1>
            <p className="mt-2 text-sm text-slate-400">
              <span className="font-medium text-slate-200">{headline}</span>
              {batch.standing.needsAttention > 0 && (
                <span className="ml-2 text-amber-300">
                  · {batch.standing.needsAttention} need attention
                </span>
              )}
            </p>
          </div>
          <div className="flex flex-col items-end gap-2">
            <NetworkBadge />
            <p className="text-xs text-slate-500">
              CoreFlow v2 on Stellar Testnet
            </p>
          </div>
        </div>
      </header>

      {findings.length > 0 && <Findings findings={findings} />}

      {/* Summary. Figures come from the server; nothing is totalled here. */}
      <section
        aria-label="Batch summary"
        className="grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-slate-700/60 bg-slate-700/40 sm:grid-cols-3 lg:grid-cols-6"
      >
        <Figure label="Total" value={`${batch.total}`} sub={batch.asset ?? ''} emphasis />
        <Figure label="Payments" value={String(batch.paymentCount)} />
        <Figure label="Paid" value={batch.standing.paid} sub={batch.asset ?? ''} />
        <Figure
          label="Pay period"
          value={formatDay(batch.periodStart)}
          sub={`to ${formatDay(batch.periodEnd)}`}
        />
        <Figure label="Created" value={formatDay(batch.createdAt)} />
        <Figure label="Source" value={batch.source.filename ?? '—'} />
      </section>

      <FundingPanel batchId={batch.id} orgId={orgId} onFunded={onChanged} />

      <Approvals summary={approvalSummary} />

      <section aria-labelledby="payments-heading">
        <h2 id="payments-heading" className="mb-3 text-lg font-semibold text-slate-100">
          Payments
        </h2>
        {batch.payments.length === 0 ? (
          <Empty>This batch has no payments.</Empty>
        ) : (
          <PaymentsTable
            payments={batch.payments}
            expanded={expanded}
            onToggle={(id) => setExpanded((current) => (current === id ? null : id))}
            findingsByPayment={findingsByPayment}
          />
        )}
      </section>

      <Timeline activity={activity} />

      <section aria-labelledby="technical-heading">
        <button
          type="button"
          id="technical-heading"
          onClick={() => setShowTechnical((v) => !v)}
          aria-expanded={showTechnical}
          className="text-sm text-slate-400 underline hover:text-slate-200"
        >
          {showTechnical ? 'Hide technical details' : 'Technical details'}
        </button>
        {showTechnical && (
          <dl className="mt-3 grid gap-2 rounded-xl border border-slate-700/60 bg-slate-950/40 p-4 text-xs sm:grid-cols-2">
            <Detail label="Network">Stellar Testnet</Detail>
            <Detail label="Batch id">
              <code>{batch.id}</code>
            </Detail>
            <Detail label="Total (base units)">
              <code>{batch.totalBaseUnits}</code>
            </Detail>
            <Detail label="Paid (base units)">
              <code>{batch.standing.paidAmountBaseUnits}</code>
            </Detail>
            <Detail label="Source rows seen">{batch.source.rowsSeen ?? '—'}</Detail>
            <Detail label="Source checksum">
              <code>{batch.source.checksum ? truncate(batch.source.checksum, 10, 6) : '—'}</code>
            </Detail>
          </dl>
        )}
      </section>
    </div>
  );
}

function Figure({
  label,
  value,
  sub,
  emphasis,
}: {
  label: string;
  value: string;
  sub?: string;
  emphasis?: boolean;
}) {
  return (
    <div className="bg-slate-900/80 px-4 py-3">
      <dt className="text-[11px] font-medium uppercase tracking-wider text-slate-500">{label}</dt>
      <dd
        className={`mt-1 tabular-nums ${
          emphasis ? 'text-xl font-semibold text-slate-50' : 'text-sm text-slate-200'
        }`}
      >
        {value}
        {sub && <span className="ml-1 text-xs font-normal text-slate-500">{sub}</span>}
      </dd>
    </div>
  );
}

function Detail({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-slate-500">{label}</dt>
      <dd className="break-all text-right text-slate-300">{children}</dd>
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <p className="rounded-xl border border-dashed border-slate-700 bg-slate-900/40 px-4 py-8 text-center text-sm text-slate-400">
      {children}
    </p>
  );
}

/**
 * Dual control, from Approval records.
 *
 * Both halves are always shown, including the one that is missing: "waiting for
 * finance approval" is the fact a reviewer needs, and a UI that only lists
 * approvals that exist hides it.
 */
function Approvals({
  summary,
}: {
  summary: Map<string, { actorAddress: string; createdAt: string | null }>;
}) {
  const roles: { role: string; label: string }[] = [
    { role: 'MANAGER', label: 'Manager' },
    { role: 'FINANCE', label: 'Finance' },
  ];

  return (
    <section
      aria-labelledby="approvals-heading"
      className="rounded-xl border border-slate-700/60 bg-slate-900/60 p-5"
    >
      <h2 id="approvals-heading" className="text-lg font-semibold text-slate-100">
        Approvals
      </h2>
      <p className="mt-0.5 text-sm text-slate-400">
        Two separate people must approve before funds are released.
      </p>
      <dl className="mt-4 grid gap-4 sm:grid-cols-2">
        {roles.map(({ role, label }) => {
          const given = summary.get(role);
          return (
            <div
              key={role}
              className="rounded-lg border border-slate-700/60 bg-slate-950/40 px-4 py-3"
            >
              <dt className="text-xs font-medium uppercase tracking-wider text-slate-500">
                {label}
              </dt>
              <dd className="mt-1.5 text-sm">
                {given ? (
                  <>
                    <span className="font-medium text-emerald-300">Approved</span>
                    <span className="mt-1 block text-xs text-slate-400">
                      <code>{truncate(given.actorAddress)}</code> · {formatWhen(given.createdAt)}
                    </span>
                  </>
                ) : (
                  <span className="text-slate-400">Waiting for approval</span>
                )}
              </dd>
            </div>
          );
        })}
      </dl>
    </section>
  );
}

function PaymentsTable({
  payments,
  expanded,
  onToggle,
  findingsByPayment,
}: {
  payments: BatchDetailPayment[];
  expanded: string | null;
  onToggle: (id: string) => void;
  findingsByPayment: Map<string, BatchDetailData['findings']>;
}) {
  return (
    <div className="overflow-hidden rounded-xl border border-slate-700/60">
      {/* One row per Payment. A multi-payee payroll is never shown as a single total. */}
      <table className="w-full border-collapse text-left text-sm">
        <caption className="sr-only">
          Every payment in this batch, one row each, with its own state
        </caption>
        <thead className="bg-slate-900/80 text-xs uppercase tracking-wider text-slate-500">
          <tr>
            <th scope="col" className="px-4 py-3 font-medium">Recipient</th>
            <th scope="col" className="px-4 py-3 text-right font-medium">Amount</th>
            <th scope="col" className="hidden px-4 py-3 text-right font-medium sm:table-cell">Hours</th>
            <th scope="col" className="hidden px-4 py-3 text-right font-medium sm:table-cell">Rate</th>
            <th scope="col" className="px-4 py-3 font-medium">Status</th>
            <th scope="col" className="px-4 py-3 font-medium">
              <span className="sr-only">Payment details</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {payments.map((p) => {
            const open = expanded === p.id;
            const rowFindings = findingsByPayment.get(p.id) ?? [];
            return (
              // A keyed Fragment, because each payment renders two sibling rows and
              // React needs the key on their common parent.
              <Fragment key={p.id}>
                <tr className="border-t border-slate-800 bg-slate-900/40 hover:bg-slate-900/70">
                  <td className="px-4 py-3">
                    <code className="text-xs text-slate-200">{truncate(p.recipient, 8, 6)}</code>
                    {p.reference && (
                      <span className="mt-0.5 block text-xs text-slate-500">{p.reference}</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums text-slate-100">
                    {p.amount}
                    <span className="ml-1 text-xs text-slate-500">{p.asset}</span>
                  </td>
                  <td className="hidden px-4 py-3 text-right tabular-nums text-slate-300 sm:table-cell">
                    {p.hours}h
                  </td>
                  <td className="hidden px-4 py-3 text-right tabular-nums text-slate-300 sm:table-cell">
                    {p.rate}
                    <span className="ml-1 text-xs text-slate-500">/h</span>
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${
                        p.needsAttention
                          ? 'bg-amber-500/15 text-amber-200'
                          : p.state === 'PAID'
                            ? 'bg-emerald-500/15 text-emerald-200'
                            : 'bg-slate-700/60 text-slate-300'
                      }`}
                    >
                      {STATE_LABELS[p.state] ?? p.stateLabel}
                    </span>
                    {rowFindings.length > 0 && (
                      <span className="ml-2 text-xs text-amber-300">needs attention</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <button
                      type="button"
                      onClick={() => onToggle(p.id)}
                      aria-expanded={open}
                      aria-controls={`payment-${p.id}`}
                      className="text-xs text-slate-400 underline hover:text-slate-200"
                    >
                      {open ? 'Hide' : 'Details'}
                    </button>
                  </td>
                </tr>
                {open && (
                  <tr className="border-t border-slate-800 bg-slate-950/60">
                    <td colSpan={6} className="px-4 py-4" id={`payment-${p.id}`}>
                      <dl className="grid gap-2 text-xs sm:grid-cols-2">
                        <Detail label="Recipient">
                          <code className="break-all">{p.recipient}</code>
                        </Detail>
                        <Detail label="Amount (base units)">
                          <code>{p.amountBaseUnits}</code>
                        </Detail>
                        <Detail label="Rate (base units)">
                          <code>{p.rateBaseUnits}</code>
                        </Detail>
                        <Detail label="Hours">{p.hours}</Detail>
                        <Detail label="On-chain index">
                          {p.onChainPaymentIndex ?? 'not funded'}
                        </Detail>
                        <Detail label="Settled">{formatWhen(p.settledAt)}</Detail>
                        <Detail label="Approvals">
                          {p.approvals.length === 0
                            ? 'none yet'
                            : p.approvals
                                .map((a) => `${a.role} ${a.decision.toLowerCase()}`)
                                .join(', ')}
                        </Detail>
                        <Detail label="Transaction">
                          {/* Only where the state allows one to exist. */}
                          {p.transactionHash ? (
                            <a
                              href={`${EXPLORER}/tx/${p.transactionHash}`}
                              target="_blank"
                              rel="noreferrer"
                              className="underline"
                            >
                              <code>{truncate(p.transactionHash)}</code>
                            </a>
                          ) : (
                            'not yet available'
                          )}
                        </Detail>
                      </dl>
                      {p.stateReason && (
                        <p className="mt-3 text-xs text-amber-200">{p.stateReason}</p>
                      )}
                      {rowFindings.map((f) => (
                        <p key={f.id} className="mt-2 text-xs text-amber-200">
                          {f.severity} · {f.detail}
                        </p>
                      ))}
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/**
 * The activity timeline, from real audit rows only.
 *
 * Sparse by design. An empty or short timeline is a true statement about what has
 * been recorded; a padded one is not.
 */
function Timeline({ activity }: { activity: BatchDetailData['activity'] }) {
  const [open, setOpen] = useState<string | null>(null);

  return (
    <section aria-labelledby="activity-heading">
      <h2 id="activity-heading" className="mb-3 text-lg font-semibold text-slate-100">
        Activity
      </h2>
      {activity.length === 0 ? (
        <Empty>No activity has been recorded for this batch yet.</Empty>
      ) : (
        <ol className="space-y-1">
          {activity.map((e) => {
            const isOpen = open === e.id;
            return (
              <li
                key={e.id}
                className="rounded-lg border border-slate-800 bg-slate-900/40 px-4 py-2.5"
              >
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="text-sm text-slate-200">
                    {EVENT_LABELS[e.type] ?? e.type}
                    {e.previousState && e.newState && (
                      <span className="ml-2 text-xs text-slate-500">
                        {STATE_LABELS[e.previousState] ?? e.previousState} →{' '}
                        {STATE_LABELS[e.newState] ?? e.newState}
                      </span>
                    )}
                  </span>
                  <span className="flex items-center gap-3">
                    <time className="text-xs tabular-nums text-slate-500">{formatWhen(e.at)}</time>
                    <button
                      type="button"
                      onClick={() => setOpen(isOpen ? null : e.id)}
                      aria-expanded={isOpen}
                      className="text-xs text-slate-500 underline hover:text-slate-300"
                    >
                      {isOpen ? 'Less' : 'More'}
                    </button>
                  </span>
                </div>
                <p className="mt-0.5 text-xs text-slate-500">
                  {e.actor?.kind === 'user' ? (
                    <code>{truncate(e.actor.address)}</code>
                  ) : e.actor?.kind === 'system' ? (
                    <>by {e.actor.system}</>
                  ) : (
                    'system'
                  )}
                </p>
                {isOpen && (
                  <dl className="mt-2 grid gap-1 border-t border-slate-800 pt-2 text-xs sm:grid-cols-2">
                    <Detail label="Event">
                      <code>{e.type}</code>
                    </Detail>
                    {e.txHash && (
                      <Detail label="Transaction">
                        <a
                          href={`${EXPLORER}/tx/${e.txHash}`}
                          target="_blank"
                          rel="noreferrer"
                          className="underline"
                        >
                          <code>{truncate(e.txHash)}</code>
                        </a>
                      </Detail>
                    )}
                    {e.metadata &&
                      Object.entries(e.metadata)
                        .filter(([, v]) => v !== null && typeof v !== 'object')
                        .map(([k, v]) => (
                          <Detail key={k} label={k}>
                            <code className="break-all">{String(v)}</code>
                          </Detail>
                        ))}
                  </dl>
                )}
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}

function Findings({ findings }: { findings: BatchDetailData['findings'] }) {
  return (
    <section
      role="alert"
      aria-labelledby="findings-heading"
      className="rounded-xl border border-amber-500/40 bg-amber-500/5 p-5"
    >
      <h2 id="findings-heading" className="text-sm font-semibold text-amber-100">
        Payment verification needs attention
      </h2>
      <ul className="mt-3 space-y-3">
        {findings.map((f) => (
          <li key={f.id} className="text-sm text-amber-100/90">
            <span className="mr-2 rounded bg-amber-500/15 px-1.5 py-0.5 text-xs font-semibold text-amber-200">
              {f.severity}
            </span>
            {f.detail}
            <span className="mt-1 block text-xs text-amber-100/60">
              {f.kind} · first seen {formatWhen(f.firstDetectedAt)}
              {f.lastObservedAt && <> · last checked {formatWhen(f.lastObservedAt)}</>}
              {f.observationCount !== null && <> · seen {f.observationCount}×</>}
            </span>
            {f.remediation && (
              <span className="mt-1 block text-xs text-amber-100/80">{f.remediation}</span>
            )}
          </li>
        ))}
      </ul>
      {/*
        A finding is a disagreement to investigate, not proof a payment failed.
        Nothing here restates it as failure.
      */}
      <p className="mt-3 text-xs text-amber-100/60">
        A finding records that the database and the chain disagree. It does not by
        itself mean a payment failed.
      </p>
    </section>
  );
}
