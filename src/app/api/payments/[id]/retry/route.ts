/**
 * POST /api/payments/:id/retry
 *
 * A business action. The server decides the resulting state — see
 * src/lib/payments/state-machine.ts for the transition table, and
 * docs/PAYMENT_STATE_MACHINE.md for who may do what.
 */
import { NextRequest } from 'next/server';
import { retryPayment } from '@/lib/payments/actions';
import { runPaymentAction } from '@/lib/payments/http';

export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  return runPaymentAction(request, params.id, retryPayment);
}
