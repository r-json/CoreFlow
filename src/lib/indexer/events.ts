/**
 * Parsing of CoreFlow contract events into typed domain events.
 *
 * ── Escrow-level events ──────────────────────────────────────────────────────
 *   ("escrow",  "created") -> (escrow_id, manager, total_amount)
 *   ("approve", "manager") -> escrow_id
 *   ("approve", "finance") -> escrow_id
 *   ("payment", "final")   -> (escrow_id, total_amount, count)
 *   ("escrow",  "cancel")  -> escrow_id
 *   ("hours",   "submit")  -> (escrow_id, payment_id, hours_logged)
 *
 * ── Per-payment events ───────────────────────────────────────────────────────
 *   ("payment", "add")    -> (escrow_id, index, worker, token, amount, rate, start, end)
 *   ("payment", "paid")   -> (escrow_id, index, worker, token, amount, hours)
 *   ("payment", "cancel") -> (escrow_id, index)
 *
 * The per-payment events are what make a multi-payee batch indexable. Without
 * them the log says only how much moved in aggregate, so a projection would have
 * to read `get_escrow` at index time — returning CURRENT state, not state at
 * that ledger, which makes re-indexing produce different answers. With them the
 * projection is a pure function of the log.
 *
 * Money stays `bigint` throughout. `scValToNative` yields bigint for i128, and
 * coercing through `Number` silently loses precision above 2^53-1.
 */

export type CoreFlowEvent =
  | { kind: 'created'; escrowId: number; manager: string; totalAmount: bigint }
  | {
      kind: 'payment_added';
      escrowId: number;
      paymentIndex: number;
      worker: string;
      token: string;
      amountBaseUnits: bigint;
      rateBaseUnits: bigint;
      periodStart: bigint;
      periodEnd: bigint;
    }
  | { kind: 'hours'; escrowId: number; paymentIndex: number; hours: bigint }
  | { kind: 'manager_approved'; escrowId: number }
  | { kind: 'finance_approved'; escrowId: number }
  | {
      kind: 'payment_paid';
      escrowId: number;
      paymentIndex: number;
      worker: string;
      token: string;
      amountBaseUnits: bigint;
      hours: bigint;
    }
  | { kind: 'payment_cancelled'; escrowId: number; paymentIndex: number }
  | { kind: 'finalized'; escrowId: number; totalAmount: bigint; count: number }
  | { kind: 'cancelled'; escrowId: number }
  | { kind: 'oracle_rotated'; escrowId: number; rotations: number };

/** Coerce a u32/u64-ish scalar to a JS number. Safe: these are counters/ids. */
function toNum(v: unknown): number {
  if (typeof v === 'bigint') return Number(v);
  if (Array.isArray(v)) return Number(v[0]);
  return Number(v);
}

/** Coerce an i128 to bigint WITHOUT passing through Number. */
function toBig(v: unknown): bigint {
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number') return BigInt(Math.trunc(v));
  if (typeof v === 'string') return BigInt(v);
  if (Array.isArray(v)) return toBig(v[0]);
  return 0n;
}

function toAddr(v: unknown): string {
  return typeof v === 'string' ? v : String(v);
}

/**
 * Map a decoded contract event to a typed CoreFlowEvent, or null if it is not a
 * recognized CoreFlow event. `value` is the event data already decoded by
 * `scValToNative` (a scalar or tuple/array).
 *
 * Unknown events return null rather than throwing: a future contract version
 * emitting something new must not halt ingestion of the events we do understand.
 */
export function parseCoreFlowEvent(
  topic0: string,
  topic1: string,
  value: unknown
): CoreFlowEvent | null {
  const t = Array.isArray(value) ? value : [value];
  const key = `${topic0}:${topic1}`;

  switch (key) {
    case 'escrow:created':
      return {
        kind: 'created',
        escrowId: toNum(t[0]),
        manager: toAddr(t[1]),
        totalAmount: toBig(t[2]),
      };

    case 'payment:add':
      return {
        kind: 'payment_added',
        escrowId: toNum(t[0]),
        paymentIndex: toNum(t[1]),
        worker: toAddr(t[2]),
        token: toAddr(t[3]),
        amountBaseUnits: toBig(t[4]),
        rateBaseUnits: toBig(t[5]),
        periodStart: toBig(t[6]),
        periodEnd: toBig(t[7]),
      };

    case 'hours:submit':
      return {
        kind: 'hours',
        escrowId: toNum(t[0]),
        paymentIndex: toNum(t[1]),
        hours: toBig(t[2]),
      };

    case 'approve:manager':
      return { kind: 'manager_approved', escrowId: toNum(t[0]) };

    case 'approve:finance':
      return { kind: 'finance_approved', escrowId: toNum(t[0]) };

    case 'payment:paid':
      return {
        kind: 'payment_paid',
        escrowId: toNum(t[0]),
        paymentIndex: toNum(t[1]),
        worker: toAddr(t[2]),
        token: toAddr(t[3]),
        amountBaseUnits: toBig(t[4]),
        hours: toBig(t[5]),
      };

    case 'payment:cancel':
      return {
        kind: 'payment_cancelled',
        escrowId: toNum(t[0]),
        paymentIndex: toNum(t[1]),
      };

    case 'payment:final':
      return {
        kind: 'finalized',
        escrowId: toNum(t[0]),
        totalAmount: toBig(t[1]),
        count: toNum(t[2]),
      };

    case 'escrow:cancel':
      return { kind: 'cancelled', escrowId: toNum(t[0]) };

    case 'oracle:rotate':
      return { kind: 'oracle_rotated', escrowId: toNum(t[0]), rotations: toNum(t[1]) };

    default:
      return null;
  }
}

/** The payment slot an event refers to, when it refers to one. */
export function paymentIndexOf(ev: CoreFlowEvent): number | null {
  return 'paymentIndex' in ev ? ev.paymentIndex : null;
}
