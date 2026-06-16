/**
 * Parsing of CoreFlow contract events into typed domain events.
 *
 * The contract emits these (topic0, topic1) symbol pairs:
 *   ("escrow",  "created") -> (escrow_id, manager, total_amount)
 *   ("hours",   "submit")  -> (escrow_id, payment_id, hours_logged)
 *   ("approve", "manager") -> escrow_id
 *   ("approve", "finance") -> escrow_id
 *   ("payment", "final")   -> (escrow_id, total_amount, count)
 *   ("escrow",  "cancel")  -> escrow_id
 */

export type CoreFlowEvent =
  | { kind: 'created'; escrowId: number }
  | { kind: 'hours'; escrowId: number; paymentId: number; hours: number }
  | { kind: 'manager_approved'; escrowId: number }
  | { kind: 'finance_approved'; escrowId: number }
  | { kind: 'finalized'; escrowId: number }
  | { kind: 'cancelled'; escrowId: number };

/** Coerce a possibly-bigint scalar to a JS number. */
function toNum(v: unknown): number {
  if (typeof v === 'bigint') return Number(v);
  if (Array.isArray(v)) return Number(v[0]);
  return Number(v);
}

/**
 * Map a decoded contract event to a typed CoreFlowEvent, or null if it is not
 * a recognized CoreFlow event. `value` is the event's data already decoded by
 * scValToNative (a scalar or tuple/array).
 */
export function parseCoreFlowEvent(
  topic0: string,
  topic1: string,
  value: unknown
): CoreFlowEvent | null {
  const tuple = Array.isArray(value) ? value : [value];
  const key = `${topic0}:${topic1}`;

  switch (key) {
    case 'escrow:created':
      return { kind: 'created', escrowId: toNum(tuple[0]) };
    case 'hours:submit':
      return {
        kind: 'hours',
        escrowId: toNum(tuple[0]),
        paymentId: toNum(tuple[1]),
        hours: toNum(tuple[2]),
      };
    case 'approve:manager':
      return { kind: 'manager_approved', escrowId: toNum(tuple[0]) };
    case 'approve:finance':
      return { kind: 'finance_approved', escrowId: toNum(tuple[0]) };
    case 'payment:final':
      return { kind: 'finalized', escrowId: toNum(tuple[0]) };
    case 'escrow:cancel':
      return { kind: 'cancelled', escrowId: toNum(tuple[0]) };
    default:
      return null;
  }
}
