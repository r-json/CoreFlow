// @vitest-environment node
/**
 * Payment state machine tests.
 *
 * The table is enumerated rather than spot-checked: every declared transition is
 * exercised, and every UNDECLARED pair is asserted invalid. That second half is
 * the one that matters — a state machine tested only on its happy paths will
 * happily accept DRAFT → PAID.
 */
import { describe, it, expect } from 'vitest';
import { PaymentState, OrgRole } from '@prisma/client';
import {
  TRANSITIONS,
  TERMINAL_STATES,
  isTerminal,
  transitionsFrom,
  findTransition,
  checkTransition,
  assertTransition,
  InvalidTransitionError,
  describeState,
  STATE_DESCRIPTORS,
  type Actor,
} from '../state-machine';

const ALL_STATES = Object.values(PaymentState);

const indexer: Actor = { kind: 'indexer', system: 'indexer' };
const reconciler: Actor = { kind: 'reconciler', system: 'reconciler' };
const system: Actor = { kind: 'system', system: 'validator' };
const asUser = (role: OrgRole): Actor => ({ kind: 'user', role, address: 'GUSER' });

describe('transition table integrity', () => {
  it('declares no duplicate from→to pairs', () => {
    const seen = new Set<string>();
    for (const t of TRANSITIONS) {
      const key = `${t.from}->${t.to}`;
      expect(seen.has(key), `duplicate transition ${key}`).toBe(false);
      seen.add(key);
    }
  });

  it('never declares a transition out of a terminal state', () => {
    for (const t of TRANSITIONS) {
      expect(TERMINAL_STATES).not.toContain(t.from);
    }
  });

  it('gives every non-terminal state at least one way out', () => {
    // A non-terminal state with no exit is a trap: a payment entering it can
    // never be resolved, by anyone, ever.
    for (const state of ALL_STATES) {
      if (isTerminal(state)) continue;
      expect(transitionsFrom(state).length, `${state} is a dead end`).toBeGreaterThan(0);
    }
  });

  it('gives every state a non-generic descriptor', () => {
    for (const state of ALL_STATES) {
      const d = describeState(state);
      expect(d.label.length).toBeGreaterThan(0);
      expect(d.description.length).toBeGreaterThan(0);
      // "Processing" for everything is exactly what this model replaces.
      expect(d.label).not.toBe('Processing');
    }
  });

  it('gives every state a distinct label', () => {
    const labels = ALL_STATES.map((s) => STATE_DESCRIPTORS[s].label);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it('declares a user path only where roles are listed', () => {
    for (const t of TRANSITIONS) {
      if (t.actors.includes('user')) {
        expect(t.roles?.length ?? 0, `${t.from}->${t.to} allows user but lists no roles`)
          .toBeGreaterThan(0);
      }
    }
  });

  it('states a reason for every transition', () => {
    for (const t of TRANSITIONS) {
      expect(t.reason.length, `${t.from}->${t.to} has no reason`).toBeGreaterThan(10);
    }
  });
});

describe('every declared transition is accepted for its permitted actors', () => {
  for (const t of TRANSITIONS) {
    it(`${t.from} → ${t.to} (${t.actors.join('/')})`, () => {
      for (const kind of t.actors) {
        if (kind === 'user') {
          for (const role of t.roles ?? []) {
            const r = checkTransition(t.from, t.to, asUser(role));
            expect(r.ok, `${role} should be allowed`).toBe(true);
          }
        } else {
          const r = checkTransition(t.from, t.to, { kind });
          expect(r.ok, `${kind} should be allowed`).toBe(true);
        }
      }
    });
  }
});

describe('every undeclared pair is rejected', () => {
  it('rejects all from→to pairs absent from the table, for every actor kind', () => {
    const kinds = ['user', 'indexer', 'reconciler', 'system'] as const;
    let checked = 0;
    for (const from of ALL_STATES) {
      for (const to of ALL_STATES) {
        if (from === to) continue;
        if (findTransition(from, to)) continue;
        for (const kind of kinds) {
          const actor: Actor = kind === 'user' ? asUser(OrgRole.OWNER) : { kind };
          const r = checkTransition(from, to, actor);
          expect(r.ok, `${from} → ${to} must be invalid for ${kind}`).toBe(false);
          checked++;
        }
      }
    }
    // Guards against the loop silently not running.
    expect(checked).toBeGreaterThan(500);
  });
});

describe('PAID is reachable only by the indexer', () => {
  it('has no user- or system-initiated path to PAID', () => {
    // This is the central safety property: the frontend must not be able to
    // manufacture a successful payment.
    const intoPaid = TRANSITIONS.filter((t) => t.to === PaymentState.PAID);
    expect(intoPaid.length).toBeGreaterThan(0);
    for (const t of intoPaid) {
      expect(t.actors).not.toContain('user');
      expect(t.actors).not.toContain('system');
      expect(t.actors.some((a) => a === 'indexer' || a === 'reconciler')).toBe(true);
    }
  });

  it.each([
    OrgRole.OWNER, OrgRole.ADMIN, OrgRole.MANAGER, OrgRole.FINANCE, OrgRole.WORKER, OrgRole.VIEWER,
  ])('refuses %s attempting CONFIRMING → PAID', (role) => {
    const r = checkTransition(PaymentState.CONFIRMING, PaymentState.PAID, asUser(role));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('ACTOR_NOT_PERMITTED');
  });

  it('refuses the shortcut DRAFT → PAID outright', () => {
    const r = checkTransition(PaymentState.DRAFT, PaymentState.PAID, indexer);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('INVALID_TRANSITION');
  });

  it.each([
    PaymentState.SUBMITTING,
    PaymentState.READY_TO_SETTLE,
    PaymentState.CONFIRMING,
  ])('refuses any USER reaching PAID from %s', (from) => {
    // The indexer MAY reach PAID from these, because settlement can be driven
    // outside this application and the chain is authoritative. What must never
    // exist is a user-initiated path: "I submitted it" is not "it settled".
    for (const role of [OrgRole.OWNER, OrgRole.ADMIN, OrgRole.MANAGER, OrgRole.FINANCE]) {
      expect(checkTransition(from, PaymentState.PAID, asUser(role)).ok).toBe(false);
    }
    expect(checkTransition(from, PaymentState.PAID, system).ok).toBe(false);
    expect(checkTransition(from, PaymentState.PAID, indexer).ok).toBe(true);
  });

  it('refuses PAID from any state before both approvals exist on-chain', () => {
    // An approved payment may settle; an unapproved one reaching PAID would mean
    // the dual-approval gate was bypassed, so the log disagreeing with our record
    // must surface as a finding rather than be absorbed as a valid transition.
    for (const from of [
      PaymentState.DRAFT, PaymentState.VALIDATING, PaymentState.AWAITING_ORACLE,
      PaymentState.ORACLE_VERIFIED, PaymentState.AWAITING_MANAGER, PaymentState.AWAITING_FINANCE,
    ]) {
      expect(checkTransition(from, PaymentState.PAID, indexer).ok).toBe(false);
    }
  });
});

describe('separation of duties', () => {
  it('does not let a MANAGER exercise the finance rejection', () => {
    const r = checkTransition(
      PaymentState.AWAITING_FINANCE, PaymentState.REJECTED, asUser(OrgRole.MANAGER)
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('ROLE_NOT_PERMITTED');
  });

  it('does let FINANCE exercise it', () => {
    expect(
      checkTransition(PaymentState.AWAITING_FINANCE, PaymentState.REJECTED, asUser(OrgRole.FINANCE)).ok
    ).toBe(true);
  });

  it('does not let a WORKER advance their own payment', () => {
    for (const to of ALL_STATES) {
      if (to === PaymentState.AWAITING_MANAGER) continue;
      const r = checkTransition(PaymentState.ORACLE_VERIFIED, to, asUser(OrgRole.WORKER));
      expect(r.ok, `WORKER must not drive ORACLE_VERIFIED → ${to}`).toBe(false);
    }
  });

  it('does not let a VIEWER change anything', () => {
    for (const t of TRANSITIONS) {
      const r = checkTransition(t.from, t.to, asUser(OrgRole.VIEWER));
      expect(r.ok, `VIEWER must not perform ${t.from} → ${t.to}`).toBe(false);
    }
  });
});

describe('retry semantics', () => {
  it('lets a user retry a SUBMISSION_FAILED payment — nothing reached the chain', () => {
    expect(
      checkTransition(PaymentState.SUBMISSION_FAILED, PaymentState.READY_TO_SETTLE, asUser(OrgRole.MANAGER)).ok
    ).toBe(true);
  });

  it('does NOT let a user retry a SETTLEMENT_FAILED payment', () => {
    // It reached the chain. What it did there must be established first, and a
    // human clicking "retry" has not established anything.
    const r = checkTransition(
      PaymentState.SETTLEMENT_FAILED, PaymentState.READY_TO_SETTLE, asUser(OrgRole.OWNER)
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('ACTOR_NOT_PERMITTED');
  });

  it('lets the reconciler clear SETTLEMENT_FAILED once the chain is known', () => {
    expect(
      checkTransition(PaymentState.SETTLEMENT_FAILED, PaymentState.READY_TO_SETTLE, reconciler).ok
    ).toBe(true);
  });

  it('lets a late paid event correct a SETTLEMENT_FAILED record', () => {
    // The log wins over our failure record.
    expect(
      checkTransition(PaymentState.SETTLEMENT_FAILED, PaymentState.PAID, indexer).ok
    ).toBe(true);
  });
});

describe('duplicate and terminal transitions', () => {
  it.each(ALL_STATES)('rejects a no-op transition on %s', (state) => {
    const r = checkTransition(state, state, indexer);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('SAME_STATE');
  });

  it.each(TERMINAL_STATES)('rejects any transition out of terminal %s', (state) => {
    for (const to of ALL_STATES) {
      if (to === state) continue;
      const r = checkTransition(state, to, reconciler);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe('TERMINAL');
    }
  });

  it('rejects re-paying an already PAID payment', () => {
    const r = checkTransition(PaymentState.PAID, PaymentState.SUBMITTING, asUser(OrgRole.OWNER));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('TERMINAL');
  });
});

describe('assertTransition', () => {
  it('returns the transition when valid', () => {
    const t = assertTransition(PaymentState.CONFIRMING, PaymentState.PAID, indexer);
    expect(t.to).toBe(PaymentState.PAID);
  });

  it('throws InvalidTransitionError carrying the code', () => {
    try {
      assertTransition(PaymentState.DRAFT, PaymentState.PAID, indexer);
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(InvalidTransitionError);
      expect((e as InvalidTransitionError).code).toBe('INVALID_TRANSITION');
    }
  });

  it('requires a role when acting as a user', () => {
    const r = checkTransition(PaymentState.DRAFT, PaymentState.VALIDATING, { kind: 'user' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('ROLE_REQUIRED');
  });
});

describe('transaction display safety', () => {
  it('does not claim a transaction may exist before submission', () => {
    // Rendering an explorer link for a payment that was never submitted invites
    // a reader to believe something settled.
    for (const s of [PaymentState.DRAFT, PaymentState.VALIDATING, PaymentState.AWAITING_ORACLE]) {
      expect(describeState(s).mayHaveTransaction).toBe(false);
    }
    expect(describeState(PaymentState.SUBMISSION_FAILED).mayHaveTransaction).toBe(false);
  });

  it('marks only PAID as a success tone', () => {
    const success = ALL_STATES.filter((s) => STATE_DESCRIPTORS[s].tone === 'success');
    expect(success).toEqual([PaymentState.PAID]);
  });

  it('flags every failure state as needing attention', () => {
    for (const s of [
      PaymentState.SUBMISSION_FAILED,
      PaymentState.SETTLEMENT_FAILED,
      PaymentState.RECONCILIATION_REQUIRED,
      PaymentState.EXPIRED,
    ]) {
      expect(describeState(s).needsAttention, `${s}`).toBe(true);
    }
  });
});
