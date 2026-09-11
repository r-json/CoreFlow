'use client';

/**
 * Funding a payroll batch: review, disclose, sign once, verify.
 *
 * Three rules this component is built around.
 *
 * 1. EVERY FIGURE COMES FROM THE SERVER. The plan is issued and frozen server-side
 *    and rendered verbatim. Nothing here adds, converts or formats money — a total
 *    computed in a browser is a second opinion about what is being signed.
 *
 * 2. ONE TRANSACTION. `initialize_multi_sig_escrow` creates the escrow and moves
 *    custody atomically, so the UI must not imply two steps. There is no
 *    "create escrow" button anywhere.
 *
 * 3. AN UNCERTAIN TRANSACTION MUST NEVER INVITE A SECOND ONE. The contract is not
 *    idempotent: signing again funds a second escrow with the same money. So while
 *    an attempt is unresolved there is no funding button at all — only "Check
 *    status" — and on mount the existing intent is recovered rather than replaced.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/Button';
import { NetworkBadge } from '@/components/NetworkBadge';
import {
  abandonFunding,
  confirmFunding,
  getFundingState,
  openFundingIntent,
  planReference,
  planToContractArguments,
  recordSubmitted,
  FundingRequestError,
  type ConfirmResult,
  type FundingAttemptView,
  type FundingPlan,
  type FundingStateView,
} from '@/lib/funding/client';

/**
 * What the screen is doing. Derived from server state plus the in-flight wallet
 * interaction — never a status the client invented about money.
 */
type Phase =
  | 'LOADING'
  | 'BLOCKED'
  | 'READY'
  | 'DISCLOSING'
  | 'AWAITING_SIGNATURE'
  | 'SUBMITTING'
  | 'CONFIRMING'
  | 'VERIFYING'
  | 'FUNDED'
  | 'USER_REJECTED'
  | 'RPC_FAILED'
  | 'CONTRACT_REJECTED'
  | 'MISMATCH';

/** Phases in which a funding action must not be offered. */
const NO_FUNDING_BUTTON: readonly Phase[] = [
  'AWAITING_SIGNATURE',
  'SUBMITTING',
  'CONFIRMING',
  'VERIFYING',
  'FUNDED',
  'MISMATCH',
];

function truncate(address: string): string {
  return address.length > 14 ? `${address.slice(0, 6)}…${address.slice(-6)}` : address;
}

const EXPLORER = 'https://stellar.expert/explorer/testnet';

export interface FundingPanelProps {
  batchId: string;
  orgId?: string;
  /** Called after funding is confirmed, so the host page can refresh. */
  onFunded?: () => void;
}

export function FundingPanel({ batchId, orgId, onFunded }: FundingPanelProps) {
  const [phase, setPhase] = useState<Phase>('LOADING');
  const [state, setState] = useState<FundingStateView | null>(null);
  const [plan, setPlan] = useState<FundingPlan | null>(null);
  // The attempt itself, not just its id: the disclosure needs its planDigest, and
  // reading it back off the pre-intent `state` meant the plan reference never
  // appeared — the state loaded before the intent existed.
  const [attempt, setAttempt] = useState<FundingAttemptView | null>(null);
  const attemptId = attempt?.id ?? null;
  const [message, setMessage] = useState<string | null>(null);
  const [differences, setDifferences] = useState<string[]>([]);
  const [txHash, setTxHash] = useState<string | null>(null);
  const [escrowId, setEscrowId] = useState<number | null>(null);
  const [showTechnical, setShowTechnical] = useState(false);
  const [busy, setBusy] = useState(false);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  /**
   * Load server state and adopt whatever attempt already exists.
   *
   * This is the reload-recovery path. A refresh mid-submission must land on the
   * SAME attempt — never a fresh one.
   */
  const load = useCallback(async () => {
    try {
      const next = await getFundingState(batchId, orgId);
      if (!mounted.current) return;
      setState(next);
      setPlan(next.plan);
      setAttempt(next.attempt);
      setTxHash(next.attempt?.hash ?? null);
      setEscrowId(next.escrow?.onChainId ?? null);

      const status = next.attempt?.status;
      if (status === 'CONFIRMED') {
        setPhase('FUNDED');
      } else if (status === 'SUBMITTED') {
        // A transaction exists and its outcome is unknown to us.
        setPhase('VERIFYING');
        setMessage(next.attempt?.errorMessage ?? null);
      } else if (status === 'AWAITING_SIGNATURE' && next.plan) {
        setPhase('DISCLOSING');
      } else if (!next.assessment.eligible) {
        setPhase('BLOCKED');
      } else {
        setPhase('READY');
      }
    } catch (e) {
      if (!mounted.current) return;
      setPhase('BLOCKED');
      setMessage(e instanceof Error ? e.message : 'Funding state could not be loaded.');
    }
  }, [batchId, orgId]);

  useEffect(() => {
    void load();
  }, [load]);

  /** Open (or recover) the intent, freezing the plan, then disclose it. */
  async function beginFunding() {
    setBusy(true);
    setMessage(null);
    try {
      const result = await openFundingIntent(batchId, orgId);
      setAttempt(result.attempt);
      setPlan(result.plan);
      setTxHash(result.attempt.hash ?? null);
      setPhase(result.attempt.status === 'SUBMITTED' ? 'VERIFYING' : 'DISCLOSING');
    } catch (e) {
      if (e instanceof FundingRequestError && e.status === 409) {
        // Either the batch became unfundable or an attempt is already open; reload
        // rather than guessing, so the screen reflects the server.
        setMessage(e.message);
        await load();
      } else {
        setMessage(e instanceof Error ? e.message : 'The funding intent could not be opened.');
      }
    } finally {
      setBusy(false);
    }
  }

  /** Step back from the disclosure, releasing the intent so the batch is not stuck. */
  async function cancelDisclosure() {
    if (!attemptId) {
      setPhase('READY');
      return;
    }
    setBusy(true);
    try {
      await abandonFunding(batchId, {
        attemptId,
        reason: 'Returned from the funding review without signing.',
        userRejected: true,
        orgId,
      });
    } catch {
      // Even if releasing fails, reloading shows the true state.
    } finally {
      setBusy(false);
      await load();
    }
  }

  /**
   * Sign and submit. One transaction.
   *
   * The hash is persisted by `onSubmitted`, the instant the network accepts it and
   * BEFORE confirmation is polled — otherwise a failure while waiting would leave a
   * transaction that may have moved money with no record of its hash, and the
   * obvious recovery would be to sign another one.
   */
  async function signAndSubmit() {
    if (!plan || !attemptId) return;
    setBusy(true);
    setMessage(null);
    setPhase('AWAITING_SIGNATURE');

    try {
      const { CoreFlowClient } = await import('@/lib/contracts');
      const client = new CoreFlowClient();
      const args = planToContractArguments(plan);

      const result = await client.submitInitializeEscrow(
        args.manager,
        args.financeApprover,
        args.oraclePublicKeyHex,
        args.payments,
        async (hash) => {
          if (mounted.current) {
            setTxHash(hash);
            setPhase('SUBMITTING');
          }
          await recordSubmitted(batchId, { attemptId, transactionHash: hash, orgId });
          if (mounted.current) setPhase('CONFIRMING');
        },
      );

      const returned = Number(result.returnValue);
      if (!Number.isInteger(returned) || returned <= 0) {
        // The return value was unreadable. The hash is recorded, and the server can
        // resolve the escrow from it, so verification still proceeds — signing again
        // is never the recovery.
        setPhase('CONFIRMING');
        await verify(attemptId);
        return;
      }

      setEscrowId(returned);
      await verify(attemptId, returned);
    } catch (e) {
      const text = e instanceof Error ? e.message : String(e);
      // A declined signature is the one failure where nothing reached the network,
      // so it is the only one that is plainly safe to retry.
      const declined = /reject|denied|cancel|user declined/i.test(text);

      if (declined && !txHash) {
        setPhase('USER_REJECTED');
        setMessage('Signing was cancelled. Nothing was submitted and no funds moved.');
        if (attemptId) {
          await abandonFunding(batchId, {
            attemptId,
            reason: 'Signature declined in the wallet.',
            userRejected: true,
            orgId,
          }).catch(() => {});
        }
        await load();
      } else if (txHash) {
        // Submitted, then something went wrong while waiting. The outcome is unknown.
        setPhase('VERIFYING');
        setMessage(
          'The transaction was submitted, but we could not confirm it. ' +
            'Its outcome is unknown.',
        );
      } else if (/simulat|contract|HostError|trap/i.test(text)) {
        setPhase('CONTRACT_REJECTED');
        setMessage(text.slice(0, 300));
      } else {
        setPhase('RPC_FAILED');
        setMessage(text.slice(0, 300));
      }
    } finally {
      setBusy(false);
    }
  }

  /** Ask the server to verify against the frozen plan, and reflect the verdict. */
  const verify = useCallback(
    async (attempt: string, onChainEscrowId?: number) => {
      setBusy(true);
      try {
        const result: ConfirmResult = await confirmFunding(batchId, {
          attemptId: attempt,
          // May be undefined: the server resolves the escrow from the transaction
          // hash, so a return value we could not parse does not block recovery.
          onChainEscrowId,
          orgId,
        });
        setDifferences(result.differences ?? []);

        switch (result.outcome) {
          case 'CONFIRMED':
            setPhase('FUNDED');
            setMessage(null);
            onFunded?.();
            break;
          case 'FAILED':
            setPhase('CONTRACT_REJECTED');
            setMessage(result.reason ?? 'The transaction failed on-chain. No funds moved.');
            break;
          case 'UNVERIFIABLE':
            // NOT a failure. Saying "failed" here would be a claim about money we
            // have not established.
            setPhase('VERIFYING');
            setMessage(result.reason ?? 'The transaction could not be verified yet.');
            break;
          case 'MISMATCH':
            setPhase('MISMATCH');
            setMessage(
              'The transaction does not match this payroll’s funding plan, so the escrow ' +
                'was not attached to this batch.',
            );
            break;
        }
        await load();
      } catch (e) {
        setPhase('VERIFYING');
        setMessage(e instanceof Error ? e.message : 'Verification could not be completed.');
      } finally {
        setBusy(false);
      }
    },
    [batchId, orgId, onFunded, load],
  );

  async function checkStatus() {
    // Verification only needs the attempt: the escrow is resolved from the
    // transaction hash server-side. Passing the id when we have it lets the server
    // cross-check the two agree.
    if (attemptId) {
      await verify(attemptId, escrowId ?? undefined);
    } else {
      await load();
    }
  }

  const reference = planReference(attempt?.planDigest);

  return (
    <section
      aria-labelledby="funding-heading"
      className="rounded-xl border border-slate-700/60 bg-slate-900/60 p-5"
    >
      <header className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 id="funding-heading" className="text-lg font-semibold text-slate-100">
            Fund payroll
          </h2>
          <p className="mt-0.5 text-sm text-slate-400">
            Creating the escrow and funding it happen in the same Stellar transaction.
          </p>
        </div>
        <NetworkBadge />
      </header>

      {/* Every state change is announced, so a screen reader follows the transaction. */}
      <p role="status" aria-live="polite" className="sr-only">
        {phaseAnnouncement(phase)}
      </p>

      {phase === 'LOADING' && <p className="text-sm text-slate-400">Checking funding status…</p>}

      {phase === 'BLOCKED' && state && (
        <Blockers blockers={state.assessment.blockers} message={message} />
      )}

      {(phase === 'READY' || phase === 'USER_REJECTED' || phase === 'RPC_FAILED' ||
        phase === 'CONTRACT_REJECTED') && state && (
        <Summary state={state} />
      )}

      {phase === 'DISCLOSING' && plan && (
        <Disclosure
          plan={plan}
          reference={reference}
          showTechnical={showTechnical}
          onToggleTechnical={() => setShowTechnical((v) => !v)}
        />
      )}

      {(phase === 'AWAITING_SIGNATURE' ||
        phase === 'SUBMITTING' ||
        phase === 'CONFIRMING' ||
        phase === 'VERIFYING') && (
        <Progress phase={phase} txHash={txHash} message={message} />
      )}

      {phase === 'FUNDED' && state && (
        <Funded state={state} txHash={txHash} />
      )}

      {phase === 'MISMATCH' && (
        <Mismatch message={message} differences={differences} txHash={txHash} />
      )}

      {message && ['USER_REJECTED', 'RPC_FAILED', 'CONTRACT_REJECTED'].includes(phase) && (
        <FailureNotice phase={phase} message={message} />
      )}

      <footer className="mt-5 flex flex-wrap gap-3">
        {!NO_FUNDING_BUTTON.includes(phase) && phase !== 'LOADING' && phase !== 'DISCLOSING' && (
          <Button
            onClick={beginFunding}
            isLoading={busy}
            disabled={busy || phase === 'BLOCKED'}
          >
            {phase === 'READY' ? 'Review and fund' : 'Try again'}
          </Button>
        )}

        {phase === 'DISCLOSING' && (
          <>
            <Button variant="outline" onClick={cancelDisclosure} disabled={busy}>
              Back
            </Button>
            <Button onClick={signAndSubmit} isLoading={busy} disabled={busy}>
              Fund escrow
            </Button>
          </>
        )}

        {/*
          No funding button while an outcome is unknown. The contract is not
          idempotent, so offering one here is offering to move the money twice.
        */}
        {(phase === 'VERIFYING' || phase === 'CONFIRMING') && (
          <Button variant="outline" onClick={checkStatus} isLoading={busy} disabled={busy}>
            Check status
          </Button>
        )}
      </footer>
    </section>
  );
}

function phaseAnnouncement(phase: Phase): string {
  switch (phase) {
    case 'AWAITING_SIGNATURE':
      return 'Waiting for your wallet to sign the funding transaction.';
    case 'SUBMITTING':
      return 'Submitting the funding transaction to Stellar.';
    case 'CONFIRMING':
      return 'Confirming the funding transaction on Stellar.';
    case 'VERIFYING':
      return 'Still verifying whether the funding transaction completed. Do not fund again.';
    case 'FUNDED':
      return 'The payroll escrow is funded.';
    case 'MISMATCH':
      return 'The transaction did not match the funding plan. The escrow was not attached.';
    case 'USER_REJECTED':
      return 'Signing was cancelled. Nothing was submitted.';
    default:
      return '';
  }
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-1.5">
      <dt className="text-sm text-slate-400">{label}</dt>
      <dd className="text-sm font-medium text-slate-100 text-right">{children}</dd>
    </div>
  );
}

function Summary({ state }: { state: FundingStateView }) {
  return (
    <dl className="divide-y divide-slate-700/40">
      <Row label="Payments">{state.assessment.paymentCount}</Row>
      <Row label="Total">
        {state.assessment.total} {state.plan?.asset.code ?? ''}
      </Row>
      <Row label="Escrow">{state.escrow ? `#${state.escrow.onChainId}` : 'New escrow'}</Row>
      <Row label="Blockchain transactions">One</Row>
    </dl>
  );
}

function Blockers({
  blockers,
  message,
}: {
  blockers: FundingStateView['assessment']['blockers'];
  message: string | null;
}) {
  return (
    <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-4">
      <h3 className="text-sm font-semibold text-amber-200">
        This payroll cannot be funded yet
      </h3>
      {message && <p className="mt-1 text-sm text-amber-100/80">{message}</p>}
      <ul className="mt-3 space-y-2">
        {blockers.map((b, i) => (
          <li key={`${b.code}-${i}`} className="text-sm text-amber-100/90">
            {b.position !== undefined && (
              <span className="mr-2 rounded bg-amber-500/15 px-1.5 py-0.5 text-xs font-semibold text-amber-200">
                Row {b.position}
              </span>
            )}
            {b.message}
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Everything the signer is entitled to know, before the wallet opens.
 *
 * Rendered from the frozen plan. A signature request that does not say what is
 * being signed is the problem the attestation format solves at the protocol level;
 * this is the same problem at the human level.
 */
function Disclosure({
  plan,
  reference,
  showTechnical,
  onToggleTechnical,
}: {
  plan: FundingPlan;
  reference: string | null;
  showTechnical: boolean;
  onToggleTechnical: () => void;
}) {
  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-4">
        <p className="text-sm text-slate-200">
          You are funding <strong className="text-slate-50">payroll batch {plan.batch.reference}</strong>{' '}
          from your wallet into a CoreFlow escrow.
        </p>
        <p className="mt-2 text-xs text-slate-400">
          The escrow is created and funded by one transaction. Funds are held by the
          contract until verified work is approved by two separate people.
        </p>
      </div>

      <dl className="divide-y divide-slate-700/40">
        <Row label="Total to fund">
          <span className="text-base">
            {plan.total} {plan.asset.code}
          </span>
        </Row>
        <Row label="Recipients">{plan.batch.paymentCount}</Row>
        <Row label="Network">{plan.network.label}</Row>
        <Row label="Destination">
          <code className="text-xs">{truncate(plan.custodyDestination)}</code>
        </Row>
        <Row label="Manager (you)">
          <code className="text-xs">{truncate(plan.manager)}</code>
        </Row>
        <Row label="Finance approver">
          <code className="text-xs">{truncate(plan.financeApprover)}</code>
        </Row>
        {reference && <Row label="Plan">{reference}</Row>}
      </dl>

      <details className="rounded-lg border border-slate-700/60 bg-slate-950/40">
        <summary className="cursor-pointer px-4 py-2.5 text-sm text-slate-300">
          Payments ({plan.schedule.length})
        </summary>
        <div className="overflow-x-auto px-4 pb-4">
          <table className="w-full text-left text-xs">
            <caption className="sr-only">
              Every payment this funding transaction covers
            </caption>
            <thead className="text-slate-400">
              <tr>
                <th scope="col" className="py-2 pr-4 font-medium">Recipient</th>
                <th scope="col" className="py-2 pr-4 font-medium text-right">Amount (base units)</th>
                <th scope="col" className="py-2 font-medium">Period</th>
              </tr>
            </thead>
            <tbody className="text-slate-200">
              {plan.schedule.map((row) => (
                <tr key={row.paymentId} className="border-t border-slate-800">
                  <td className="py-2 pr-4">
                    <code>{truncate(row.worker)}</code>
                  </td>
                  {/* The exact value that will be signed, unformatted. */}
                  <td className="py-2 pr-4 text-right tabular-nums">{row.amountBaseUnits}</td>
                  <td className="py-2 text-slate-400">
                    {new Date(row.startDate * 1000).toISOString().slice(0, 10)} →{' '}
                    {new Date(row.endDate * 1000).toISOString().slice(0, 10)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>

      <div>
        <button
          type="button"
          onClick={onToggleTechnical}
          aria-expanded={showTechnical}
          className="text-xs text-slate-400 underline hover:text-slate-200"
        >
          {showTechnical ? 'Hide technical details' : 'Technical details'}
        </button>
        {showTechnical && (
          <dl className="mt-2 space-y-1 rounded-lg border border-slate-700/60 bg-slate-950/40 p-3 text-xs">
            <Row label="Contract">
              <code className="break-all">{plan.contractId}</code>
            </Row>
            <Row label="Settlement asset (SAC)">
              <code className="break-all">{plan.asset.contractId}</code>
            </Row>
            <Row label="Oracle public key">
              <code className="break-all">{plan.oraclePublicKey.slice(0, 16)}…</code>
            </Row>
            <Row label="Total (base units)">
              <code>{plan.totalBaseUnits}</code>
            </Row>
          </dl>
        )}
      </div>
    </div>
  );
}

function Progress({
  phase,
  txHash,
  message,
}: {
  phase: Phase;
  txHash: string | null;
  message: string | null;
}) {
  const steps: { key: Phase; label: string }[] = [
    { key: 'AWAITING_SIGNATURE', label: 'Waiting for your wallet' },
    { key: 'SUBMITTING', label: 'Submitting to Stellar' },
    { key: 'CONFIRMING', label: 'Confirming on Stellar' },
  ];
  const index = steps.findIndex((s) => s.key === phase);
  const uncertain = phase === 'VERIFYING';

  return (
    <div className="space-y-4">
      <ol className="space-y-2">
        {steps.map((step, i) => {
          const done = index > i || phase === 'VERIFYING';
          const current = index === i;
          return (
            <li key={step.key} className="flex items-center gap-3 text-sm">
              <span
                aria-hidden
                className={`flex h-5 w-5 items-center justify-center rounded-full text-[10px] ${
                  done
                    ? 'bg-emerald-500/20 text-emerald-300'
                    : current
                      ? 'bg-slate-700 text-slate-200'
                      : 'bg-slate-800 text-slate-500'
                }`}
              >
                {done ? '✓' : i + 1}
              </span>
              <span className={current ? 'text-slate-100' : 'text-slate-400'}>{step.label}</span>
            </li>
          );
        })}
      </ol>

      {uncertain && (
        <div
          role="alert"
          className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-4"
        >
          <h3 className="text-sm font-semibold text-amber-100">
            We’re checking whether your funding transaction completed.
          </h3>
          {/*
            The most important sentence in this component. Funding is not
            idempotent on-chain: a second signature creates a second escrow and
            moves the money again.
          */}
          <p className="mt-1 text-sm font-semibold text-amber-200">
            Do not fund this payroll again.
          </p>
          {message && <p className="mt-2 text-xs text-amber-100/80">{message}</p>}
        </div>
      )}

      {txHash && (
        <p className="text-xs text-slate-400">
          Transaction{' '}
          <a
            href={`${EXPLORER}/tx/${txHash}`}
            target="_blank"
            rel="noreferrer"
            className="underline hover:text-slate-200"
          >
            <code>{truncate(txHash)}</code>
          </a>
        </p>
      )}
    </div>
  );
}

function Funded({ state, txHash }: { state: FundingStateView; txHash: string | null }) {
  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-emerald-500/40 bg-emerald-500/10 p-4">
        <h3 className="text-sm font-semibold text-emerald-200">Escrow funded</h3>
        <p className="mt-1 text-xs text-emerald-100/80">
          Verified against the chain: the escrow exists, matches this payroll’s plan, and the
          funds reached the contract.
        </p>
      </div>
      <dl className="divide-y divide-slate-700/40">
        <Row label="Escrow">{state.escrow ? `#${state.escrow.onChainId}` : '—'}</Row>
        <Row label="Funded">
          {state.assessment.total} {state.plan?.asset.code ?? ''}
        </Row>
        {txHash && (
          <Row label="Transaction">
            <a
              href={`${EXPLORER}/tx/${txHash}`}
              target="_blank"
              rel="noreferrer"
              className="underline hover:text-slate-200"
            >
              <code className="text-xs">{truncate(txHash)}</code>
            </a>
          </Row>
        )}
      </dl>
      <p className="text-xs text-slate-400">
        Next: work is verified by the oracle, then approved by a manager and a separate
        finance approver before settlement.
      </p>
    </div>
  );
}

function Mismatch({
  message,
  differences,
  txHash,
}: {
  message: string | null;
  differences: string[];
  txHash: string | null;
}) {
  return (
    <div role="alert" className="rounded-lg border border-red-500/40 bg-red-500/10 p-4">
      <h3 className="text-sm font-semibold text-red-200">
        Transaction details did not match the funding plan
      </h3>
      <p className="mt-1 text-sm text-red-100/90">{message}</p>
      {differences.length > 0 && (
        <ul className="mt-3 space-y-1 text-xs text-red-100/80">
          {differences.map((d, i) => (
            <li key={i}>• {d}</li>
          ))}
        </ul>
      )}
      <p className="mt-3 text-xs text-red-100/70">
        This has been recorded for investigation. Do not fund again until it is resolved.
      </p>
      {txHash && (
        <p className="mt-2 text-xs">
          <a
            href={`${EXPLORER}/tx/${txHash}`}
            target="_blank"
            rel="noreferrer"
            className="underline text-red-200"
          >
            <code>{truncate(txHash)}</code>
          </a>
        </p>
      )}
    </div>
  );
}

function FailureNotice({ phase, message }: { phase: Phase; message: string }) {
  const titles: Partial<Record<Phase, string>> = {
    USER_REJECTED: 'Signing was cancelled',
    RPC_FAILED: 'We couldn’t reach the network',
    CONTRACT_REJECTED: 'The Stellar contract rejected the transaction',
  };
  return (
    <div role="alert" className="mt-4 rounded-lg border border-slate-600 bg-slate-800/50 p-4">
      <h3 className="text-sm font-semibold text-slate-100">{titles[phase]}</h3>
      <p className="mt-1 text-sm text-slate-300">{message}</p>
      {phase === 'USER_REJECTED' && (
        <p className="mt-2 text-xs text-slate-400">
          No funds moved. This payroll is editable again.
        </p>
      )}
    </div>
  );
}
