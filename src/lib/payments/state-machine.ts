/**
 * CoreFlow payment state machine.
 *
 * ── The rule this file exists to enforce ─────────────────────────────────────
 * A payment's state is a PROJECTION of chain truth, never an assertion about it.
 * The single most important consequence: **only the indexer may move a payment
 * to PAID**, and it does so only after observing a confirmed `payment/paid`
 * event in the contract's log. No user action, API call, or optimistic UI update
 * can reach PAID. `SUBMITTING` does not mean paid. `CONFIRMING` does not mean
 * paid. A payroll system that lets the frontend manufacture "settled" is worse
 * than one with no status at all, because it is confidently wrong.
 *
 * Every transition declares WHO may perform it. That is not decoration: it is
 * how "the frontend cannot manufacture a successful state" becomes a property
 * the type system and tests can check, rather than a convention.
 *
 * Documented in full in docs/PAYMENT_STATE_MACHINE.md.
 */

import { PaymentState, OrgRole } from '@prisma/client';

/**
 * Who is performing a transition.
 *
 * `indexer` and `reconciler` are distinct even though both are machines: the
 * indexer reports what the log says, while the reconciler adjudicates a
 * disagreement between the log and this database. Collapsing them would let
 * routine ingestion silently resolve discrepancies that a human should see.
 */
export type ActorKind = 'user' | 'indexer' | 'reconciler' | 'system';

export interface Actor {
  kind: ActorKind;
  /** Organization role, required when `kind` is 'user'. */
  role?: OrgRole;
  /** Wallet address, for audit attribution. */
  address?: string;
  /** Names the machine actor, e.g. 'indexer' | 'reconciler' | 'validator'. */
  system?: string;
}

export interface Transition {
  from: PaymentState;
  to: PaymentState;
  /** Actor kinds permitted to perform this transition. */
  actors: readonly ActorKind[];
  /** When a user may do it, the org roles allowed. Empty = no user path. */
  roles?: readonly OrgRole[];
  /** Why this transition exists, in domain terms. */
  reason: string;
}

/** Roles that can act on behalf of the organization generally. */
const ADMINISTRATIVE: readonly OrgRole[] = [OrgRole.OWNER, OrgRole.ADMIN];

/**
 * The two actors whose authority is "the chain says so".
 *
 * The indexer reads the event log; the reconciler reads live contract state.
 * Both report chain truth, so any transition justified by chain evidence is
 * available to both — and to neither user nor system. Listing only the indexer
 * would leave reconciliation unable to record what it just verified, which is
 * the entire point of running it.
 */
const CHAIN_OBSERVERS: readonly ActorKind[] = ['indexer', 'reconciler'];

/**
 * The complete transition table. Anything absent from this list is invalid.
 *
 * Deliberately exhaustive and declarative rather than a switch statement: a
 * table can be enumerated by tests, rendered as a diagram, and audited by
 * reading. Control flow spread across branches cannot.
 */
export const TRANSITIONS: readonly Transition[] = [
  // ── Authoring ──────────────────────────────────────────────────────────────
  {
    from: PaymentState.DRAFT, to: PaymentState.VALIDATING,
    actors: ['user'], roles: [...ADMINISTRATIVE, OrgRole.MANAGER],
    reason: 'Submitted for validation by whoever is preparing the batch.',
  },
  {
    from: PaymentState.DRAFT, to: PaymentState.CANCELLED,
    actors: ['user'], roles: [...ADMINISTRATIVE, OrgRole.MANAGER],
    reason: 'A draft row is discarded before anything is funded.',
  },
  {
    from: PaymentState.VALIDATING, to: PaymentState.DRAFT,
    actors: ['system'],
    reason: 'Validation failed; the row returns to editable rather than stalling.',
  },
  {
    from: PaymentState.VALIDATING, to: PaymentState.AWAITING_ORACLE,
    actors: CHAIN_OBSERVERS,
    reason:
      'The escrow is funded on-chain. Only the indexer asserts this, because it ' +
      'means custody actually moved.',
  },
  {
    from: PaymentState.VALIDATING, to: PaymentState.REJECTED,
    actors: ['user'], roles: [...ADMINISTRATIVE, OrgRole.MANAGER, OrgRole.FINANCE],
    reason: 'Declined during review, before funding.',
  },
  {
    from: PaymentState.VALIDATING, to: PaymentState.CANCELLED,
    actors: ['user'], roles: [...ADMINISTRATIVE, OrgRole.MANAGER],
    reason: 'Withdrawn during review.',
  },

  // ── Oracle ─────────────────────────────────────────────────────────────────
  {
    from: PaymentState.AWAITING_ORACLE, to: PaymentState.ORACLE_VERIFIED,
    actors: CHAIN_OBSERVERS,
    reason:
      'A `hours/submit` event was observed, meaning the contract ACCEPTED an ' +
      'Ed25519 attestation for this payment. Requesting an attestation is not ' +
      'the same as the chain verifying one.',
  },
  {
    from: PaymentState.AWAITING_ORACLE, to: PaymentState.CANCELLED,
    actors: CHAIN_OBSERVERS, reason: 'The escrow was cancelled on-chain; custody refunded.',
  },
  {
    from: PaymentState.AWAITING_ORACLE, to: PaymentState.EXPIRED,
    actors: ['system'], reason: 'The attestation window lapsed without a proof.',
  },
  {
    from: PaymentState.ORACLE_VERIFIED, to: PaymentState.AWAITING_MANAGER,
    actors: ['system', 'indexer'],
    reason: 'Proof in hand; the payment enters the approval chain.',
  },
  {
    from: PaymentState.ORACLE_VERIFIED, to: PaymentState.CANCELLED,
    actors: CHAIN_OBSERVERS, reason: 'The escrow was cancelled on-chain.',
  },

  // ── Dual approval ──────────────────────────────────────────────────────────
  {
    from: PaymentState.AWAITING_MANAGER, to: PaymentState.AWAITING_FINANCE,
    actors: CHAIN_OBSERVERS,
    reason:
      'An `approve/manager` event was observed. The approval is the on-chain ' +
      'signature, not the API call that prompted it.',
  },
  {
    from: PaymentState.AWAITING_MANAGER, to: PaymentState.REJECTED,
    actors: ['user'], roles: [...ADMINISTRATIVE, OrgRole.MANAGER],
    reason: 'The manager declined.',
  },
  {
    from: PaymentState.AWAITING_MANAGER, to: PaymentState.CANCELLED,
    actors: CHAIN_OBSERVERS, reason: 'The escrow was cancelled on-chain.',
  },
  {
    from: PaymentState.AWAITING_MANAGER, to: PaymentState.EXPIRED,
    actors: ['system'], reason: 'The approval window lapsed.',
  },
  {
    from: PaymentState.AWAITING_FINANCE, to: PaymentState.READY_TO_SETTLE,
    actors: CHAIN_OBSERVERS,
    reason: 'An `approve/finance` event was observed from the distinct finance key.',
  },
  {
    from: PaymentState.AWAITING_FINANCE, to: PaymentState.REJECTED,
    actors: ['user'], roles: [...ADMINISTRATIVE, OrgRole.FINANCE],
    reason:
      'Finance declined. MANAGER is absent here on purpose: a manager who could ' +
      'exercise the finance decision would collapse the separation of duties.',
  },
  {
    from: PaymentState.AWAITING_FINANCE, to: PaymentState.CANCELLED,
    actors: CHAIN_OBSERVERS, reason: 'The escrow was cancelled on-chain.',
  },
  {
    from: PaymentState.AWAITING_FINANCE, to: PaymentState.EXPIRED,
    actors: ['system'], reason: 'The approval window lapsed.',
  },

  // ── Settlement ─────────────────────────────────────────────────────────────
  {
    from: PaymentState.READY_TO_SETTLE, to: PaymentState.SUBMITTING,
    actors: ['user'], roles: [...ADMINISTRATIVE, OrgRole.MANAGER, OrgRole.FINANCE],
    reason: 'A settlement transaction is being built and signed.',
  },
  {
    from: PaymentState.READY_TO_SETTLE, to: PaymentState.CANCELLED,
    actors: CHAIN_OBSERVERS, reason: 'The escrow was cancelled before settlement.',
  },
  {
    from: PaymentState.SUBMITTING, to: PaymentState.CONFIRMING,
    actors: ['system'],
    reason: 'The network accepted the transaction; it awaits ledger close.',
  },
  {
    from: PaymentState.SUBMITTING, to: PaymentState.SUBMISSION_FAILED,
    actors: ['system'],
    reason:
      'The transaction never reached the network (build, simulate, sign or RPC ' +
      'failure). Nothing was submitted, so a retry cannot double-pay.',
  },
  {
    from: PaymentState.CONFIRMING, to: PaymentState.PAID,
    actors: CHAIN_OBSERVERS,
    reason:
      'A confirmed `payment/paid` event was observed in the contract log, which ' +
      'the contract emits only after the SAC transfer for that payee succeeded.',
  },
  {
    from: PaymentState.READY_TO_SETTLE, to: PaymentState.PAID,
    actors: CHAIN_OBSERVERS,
    reason:
      'Settled without this application driving the submission — by the CLI, a ' +
      'validation script, or another client. The chain is authoritative for ' +
      'settlement, so a `payment/paid` event is accepted from an approved ' +
      'payment even though we never recorded a SUBMITTING step. Refusing would ' +
      'strand every externally-settled payment in RECONCILIATION_REQUIRED, which ' +
      'is noise rather than safety.',
  },
  {
    from: PaymentState.SUBMITTING, to: PaymentState.PAID,
    actors: CHAIN_OBSERVERS,
    reason:
      'Confirmation arrived before our own SUBMITTING → CONFIRMING update landed. ' +
      'A real race, and the log is the side that knows.',
  },
  {
    from: PaymentState.CONFIRMING, to: PaymentState.SETTLEMENT_FAILED,
    actors: ['indexer', 'system'],
    reason: 'The transaction reached the chain and failed there.',
  },
  {
    from: PaymentState.CONFIRMING, to: PaymentState.RECONCILIATION_REQUIRED,
    actors: ['reconciler', 'system'],
    reason:
      'Confirmation timed out or the result was ambiguous. The outcome is ' +
      'genuinely unknown, and saying so beats guessing either way.',
  },

  // ── Recovery ───────────────────────────────────────────────────────────────
  {
    from: PaymentState.SUBMISSION_FAILED, to: PaymentState.READY_TO_SETTLE,
    actors: ['user'], roles: [...ADMINISTRATIVE, OrgRole.MANAGER, OrgRole.FINANCE],
    reason:
      'Retry. Safe without reconciliation precisely because nothing reached the ' +
      'chain; the approvals that authorized it are still on-chain and intact.',
  },
  {
    from: PaymentState.SUBMISSION_FAILED, to: PaymentState.CANCELLED,
    actors: ['user'], roles: [...ADMINISTRATIVE, OrgRole.MANAGER],
    reason: 'Abandoned after a failed submission.',
  },
  {
    from: PaymentState.SUBMISSION_FAILED, to: PaymentState.RECONCILIATION_REQUIRED,
    actors: ['reconciler'],
    reason:
      'Reconciliation found chain activity for a submission we recorded as ' +
      'never sent — our record of "never submitted" was wrong.',
  },
  {
    from: PaymentState.SETTLEMENT_FAILED, to: PaymentState.RECONCILIATION_REQUIRED,
    actors: ['reconciler', 'system'],
    reason: 'Establish what the chain actually did before anything is retried.',
  },
  {
    from: PaymentState.SETTLEMENT_FAILED, to: PaymentState.PAID,
    actors: CHAIN_OBSERVERS,
    reason:
      'A `payment/paid` event arrived for a payment we had recorded as failed. ' +
      'The log wins: our failure record was wrong.',
  },
  {
    from: PaymentState.SETTLEMENT_FAILED, to: PaymentState.READY_TO_SETTLE,
    actors: ['reconciler'],
    reason:
      'Reconciliation confirmed the chain did NOT settle. Deliberately not a ' +
      'user transition: retrying a transaction that reached the chain requires ' +
      'first establishing what it did, and a human clicking retry has not.',
  },

  // ── Reconciliation outcomes ────────────────────────────────────────────────
  {
    from: PaymentState.RECONCILIATION_REQUIRED, to: PaymentState.PAID,
    actors: ['reconciler', 'indexer'],
    reason: 'Chain evidence confirms settlement.',
  },
  {
    from: PaymentState.RECONCILIATION_REQUIRED, to: PaymentState.READY_TO_SETTLE,
    actors: ['reconciler'],
    reason: 'Chain evidence confirms no settlement occurred; approvals still stand.',
  },
  {
    from: PaymentState.RECONCILIATION_REQUIRED, to: PaymentState.SETTLEMENT_FAILED,
    actors: ['reconciler'],
    reason: 'Chain evidence confirms the settlement attempt failed.',
  },
  {
    from: PaymentState.RECONCILIATION_REQUIRED, to: PaymentState.CANCELLED,
    actors: ['user', 'reconciler'], roles: ADMINISTRATIVE,
    reason: 'An administrator closes out an unrecoverable payment.',
  },
];

/** States from which no further transition is defined. */
export const TERMINAL_STATES: readonly PaymentState[] = [
  PaymentState.PAID,
  PaymentState.REJECTED,
  PaymentState.CANCELLED,
  PaymentState.EXPIRED,
];

export function isTerminal(state: PaymentState): boolean {
  return TERMINAL_STATES.includes(state);
}

/** Every transition defined out of `state`. */
export function transitionsFrom(state: PaymentState): readonly Transition[] {
  return TRANSITIONS.filter((t) => t.from === state);
}

export function findTransition(
  from: PaymentState,
  to: PaymentState
): Transition | undefined {
  return TRANSITIONS.find((t) => t.from === from && t.to === to);
}

export type TransitionCheck =
  | { ok: true; transition: Transition }
  | { ok: false; code: TransitionErrorCode; message: string };

export type TransitionErrorCode =
  | 'SAME_STATE'
  | 'TERMINAL'
  | 'INVALID_TRANSITION'
  | 'ACTOR_NOT_PERMITTED'
  | 'ROLE_NOT_PERMITTED'
  | 'ROLE_REQUIRED';

/**
 * Decide whether `actor` may move a payment from `from` to `to`.
 *
 * Returns a result rather than throwing, so callers can map the code onto an
 * HTTP status and an operator-readable message instead of a generic 500.
 */
export function checkTransition(
  from: PaymentState,
  to: PaymentState,
  actor: Actor
): TransitionCheck {
  if (from === to) {
    return {
      ok: false,
      code: 'SAME_STATE',
      message: `Payment is already ${from}.`,
    };
  }

  if (isTerminal(from)) {
    return {
      ok: false,
      code: 'TERMINAL',
      message: `${from} is a terminal state; a payment cannot leave it.`,
    };
  }

  const transition = findTransition(from, to);
  if (!transition) {
    return {
      ok: false,
      code: 'INVALID_TRANSITION',
      message: `${from} → ${to} is not a defined transition.`,
    };
  }

  if (!transition.actors.includes(actor.kind)) {
    return {
      ok: false,
      code: 'ACTOR_NOT_PERMITTED',
      message:
        `${from} → ${to} may only be performed by ` +
        `${transition.actors.join(' or ')}, not ${actor.kind}.`,
    };
  }

  if (actor.kind === 'user') {
    const allowed = transition.roles ?? [];
    if (allowed.length === 0) {
      return {
        ok: false,
        code: 'ROLE_NOT_PERMITTED',
        message: `${from} → ${to} has no user-initiated path.`,
      };
    }
    if (!actor.role) {
      return {
        ok: false,
        code: 'ROLE_REQUIRED',
        message: 'An organization role is required to act as a user.',
      };
    }
    if (!allowed.includes(actor.role)) {
      return {
        ok: false,
        code: 'ROLE_NOT_PERMITTED',
        message:
          `${from} → ${to} requires one of ${allowed.join(', ')}; ` +
          `you hold ${actor.role}.`,
      };
    }
  }

  return { ok: true, transition };
}

export class InvalidTransitionError extends Error {
  constructor(
    readonly code: TransitionErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'InvalidTransitionError';
  }
}

/** Throwing form of {@link checkTransition}, for service-layer call sites. */
export function assertTransition(
  from: PaymentState,
  to: PaymentState,
  actor: Actor
): Transition {
  const result = checkTransition(from, to, actor);
  if (!result.ok) throw new InvalidTransitionError(result.code, result.message);
  return result.transition;
}

// ── Presentation ─────────────────────────────────────────────────────────────

export interface StateDescriptor {
  /** Label for operators. Never a generic "Processing". */
  label: string;
  /** One line explaining what is actually true right now. */
  description: string;
  /** Visual family, for consistent treatment across the UI. */
  tone: 'neutral' | 'progress' | 'pending' | 'success' | 'warning' | 'danger';
  /**
   * Whether a settlement transaction plausibly exists in this state. The UI
   * shows transaction details only when this is true AND a hash is present —
   * rendering an explorer link for a payment that was never submitted invites a
   * reader to believe something settled.
   */
  mayHaveTransaction: boolean;
  /** Whether an operator needs to act.  */
  needsAttention: boolean;
}

export const STATE_DESCRIPTORS: Record<PaymentState, StateDescriptor> = {
  [PaymentState.DRAFT]: {
    label: 'Draft',
    description: 'Not yet submitted. Still editable.',
    tone: 'neutral', mayHaveTransaction: false, needsAttention: false,
  },
  [PaymentState.VALIDATING]: {
    label: 'Validating',
    description: 'Checking recipient, amount, asset and hours.',
    tone: 'progress', mayHaveTransaction: false, needsAttention: false,
  },
  [PaymentState.AWAITING_ORACLE]: {
    label: 'Awaiting oracle verification',
    description: 'Funded on-chain. Waiting for a signed work attestation.',
    tone: 'pending', mayHaveTransaction: false, needsAttention: false,
  },
  [PaymentState.ORACLE_VERIFIED]: {
    label: 'Work verified',
    description: 'The contract accepted the oracle attestation for this payment.',
    tone: 'progress', mayHaveTransaction: true, needsAttention: false,
  },
  [PaymentState.AWAITING_MANAGER]: {
    label: 'Awaiting manager approval',
    description: 'Needs the manager’s on-chain signature.',
    tone: 'pending', mayHaveTransaction: true, needsAttention: true,
  },
  [PaymentState.AWAITING_FINANCE]: {
    label: 'Awaiting finance approval',
    description: 'Manager approved. Needs the separate finance signature.',
    tone: 'pending', mayHaveTransaction: true, needsAttention: true,
  },
  [PaymentState.READY_TO_SETTLE]: {
    label: 'Ready to settle',
    description: 'Both approvals are on-chain. Settlement can be submitted.',
    tone: 'progress', mayHaveTransaction: true, needsAttention: true,
  },
  [PaymentState.SUBMITTING]: {
    label: 'Submitting to Stellar',
    description: 'Building and signing the settlement transaction. Not yet paid.',
    tone: 'progress', mayHaveTransaction: true, needsAttention: false,
  },
  [PaymentState.CONFIRMING]: {
    label: 'Confirming on Stellar',
    description: 'Submitted to the network. Awaiting ledger confirmation — not yet paid.',
    tone: 'progress', mayHaveTransaction: true, needsAttention: false,
  },
  [PaymentState.PAID]: {
    label: 'Paid',
    description: 'Settled on-chain and confirmed. Funds reached the recipient.',
    tone: 'success', mayHaveTransaction: true, needsAttention: false,
  },
  [PaymentState.REJECTED]: {
    label: 'Rejected',
    description: 'An approver declined this payment.',
    tone: 'danger', mayHaveTransaction: false, needsAttention: false,
  },
  [PaymentState.CANCELLED]: {
    label: 'Cancelled',
    description: 'Cancelled before settlement. Escrowed funds were refunded.',
    tone: 'neutral', mayHaveTransaction: true, needsAttention: false,
  },
  [PaymentState.EXPIRED]: {
    label: 'Expired',
    description: 'The approval or attestation window lapsed before settlement.',
    tone: 'warning', mayHaveTransaction: false, needsAttention: true,
  },
  [PaymentState.SUBMISSION_FAILED]: {
    label: 'Submission failed',
    description: 'The transaction never reached Stellar. Safe to retry.',
    tone: 'danger', mayHaveTransaction: false, needsAttention: true,
  },
  [PaymentState.SETTLEMENT_FAILED]: {
    label: 'Settlement failed',
    description: 'The transaction reached Stellar and failed. Needs reconciliation before retry.',
    tone: 'danger', mayHaveTransaction: true, needsAttention: true,
  },
  [PaymentState.RECONCILIATION_REQUIRED]: {
    label: 'Reconciliation required',
    description: 'CoreFlow’s records and the chain disagree. An operator must resolve it.',
    tone: 'danger', mayHaveTransaction: true, needsAttention: true,
  },
};

export function describeState(state: PaymentState): StateDescriptor {
  return STATE_DESCRIPTORS[state];
}
