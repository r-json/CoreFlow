/**
 * POST /api/submit-batch
 *
 * Produces the oracle attestations a batch needs before `pay_batch` will settle.
 * This is the one step that MUST run server-side: ORACLE_SECRET_KEY never
 * reaches the browser.
 *
 * Request:  { escrow_id: number, payees: [{ address, amount, token }] }
 * Response: { escrowId, oraclePublicKey, startNonce, signatures: [...] }
 *
 * The client submits each signature via `submit_hours_proof`, then the two
 * signers approve, then anyone calls `pay_batch`.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getOraclePublicKeyHex, signHoursProof } from '@/lib/oracle';
import { CoreFlowClient } from '@/lib/contracts';
import { getUserFromRequest, isAdmin } from '@/lib/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface PayeeInput {
  address: string;
  amount: string | number;
  token: string;
}

const G_ADDRESS = /^G[A-Z2-7]{55}$/;

export async function POST(request: NextRequest) {
  const user = await getUserFromRequest(request);
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: { escrow_id?: number; payees?: PayeeInput[] };

  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Body must be valid JSON' }, { status: 400 });
  }

  const escrowId = Number(body.escrow_id);
  const payees = body.payees;

  if (!Number.isInteger(escrowId) || escrowId < 1) {
    return NextResponse.json({ error: 'escrow_id must be a positive integer' }, { status: 400 });
  }
  if (!Array.isArray(payees) || payees.length === 0) {
    return NextResponse.json({ error: 'payees must be a non-empty array' }, { status: 400 });
  }
  if (payees.length > 100) {
    return NextResponse.json({ error: 'Batch is limited to 100 payees' }, { status: 400 });
  }

  for (const [i, p] of payees.entries()) {
    if (!p || !G_ADDRESS.test(String(p.address))) {
      return NextResponse.json({ error: `Row ${i + 1}: invalid Stellar address` }, { status: 400 });
    }
    if (!(Number(p.amount) > 0)) {
      return NextResponse.json({ error: `Row ${i + 1}: amount must be > 0` }, { status: 400 });
    }
  }

  let oraclePublicKey: string;
  try {
    oraclePublicKey = getOraclePublicKeyHex();
  } catch {
    return NextResponse.json({ error: 'Oracle is not configured' }, { status: 503 });
  }

  const client = new CoreFlowClient();

  // Only an ADMIN, or the escrow's on-chain manager, may obtain attestations
  // for it. Anything that prevents the check (RPC failure, unknown escrow)
  // refuses rather than signing.
  if (!isAdmin(user)) {
    let manager: string;
    try {
      manager = (await client.getEscrow(escrowId)).manager;
    } catch {
      return NextResponse.json(
        { error: `Could not read escrow ${escrowId} to check its manager.` },
        { status: 502 }
      );
    }
    if (manager !== user.walletAddress) {
      return NextResponse.json(
        { error: 'Forbidden: only an ADMIN or the escrow manager can request attestations' },
        { status: 403 }
      );
    }
  }

  // The contract accepts only the next expected nonce, so signatures must start
  // from the live on-chain watermark rather than zero — a batch signed from 0
  // against an escrow that already has proofs would be rejected with #9.
  let startNonce = 0;
  try {
    startNonce = await client.getNonce(escrowId);
  } catch {
    return NextResponse.json(
      { error: `Could not read nonce for escrow ${escrowId}. Does it exist on this network?` },
      { status: 502 }
    );
  }

  const signatures = payees.map((payee, i) => {
    const nonce = startNonce + i;
    // Hours are the attested unit; amount is fixed at escrow creation.
    const hours = Math.max(1, Math.round(Number(payee.amount)));
    return {
      paymentId: i,
      address: payee.address,
      token: payee.token,
      hours,
      nonce,
      signature: signHoursProof(escrowId, i, hours, nonce),
    };
  });

  return NextResponse.json(
    { escrowId, oraclePublicKey, startNonce, signatures },
    { status: 200 }
  );
}
