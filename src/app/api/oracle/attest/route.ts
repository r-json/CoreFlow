/**
 * POST /api/oracle/attest
 *
 * The oracle signs a verified work-hours proof for a given escrow/payment at a
 * specific nonce. The client first reads the on-chain nonce (get_nonce), then
 * requests an attestation, then submits the signature to the contract.
 *
 * Auth: requires an authenticated session.
 * Idempotency: a given (escrow, payment, nonce) is signed at most once — a
 * repeat request returns the previously issued signature, so a retried submit
 * never produces a second signature for a consumed nonce.
 */

import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/db/prisma';
import { getUserFromRequest } from '@/lib/auth';
import { signHoursProof, getOraclePublicKeyHex } from '@/lib/oracle';
import { parseBody, attestSchema } from '@/lib/validation/schemas';
import { rateLimit } from '@/lib/ratelimit';

export async function POST(request: NextRequest) {
  const user = await getUserFromRequest(request);
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const rl = rateLimit(`attest:${user.walletAddress}`, 30, 60_000);
  if (!rl.ok) {
    return NextResponse.json(
      { error: 'Too many requests' },
      { status: 429, headers: { 'Retry-After': String(rl.retryAfter) } }
    );
  }

  let pubkey: string;
  try {
    pubkey = getOraclePublicKeyHex();
  } catch {
    return NextResponse.json({ error: 'Oracle is not configured' }, { status: 503 });
  }

  try {
    const body = await request.json().catch(() => null);
    const parsed = parseBody(attestSchema, body);
    if (!parsed.ok) {
      return NextResponse.json({ error: parsed.error }, { status: 400 });
    }
    const { onChainId, paymentId, hoursLogged, nonce } = parsed.data;

    // Idempotency: never sign the same (escrow, payment, nonce) twice.
    const existing = await prisma.oracleAttestation.findUnique({
      where: {
        escrowOnChainId_paymentId_nonce: { escrowOnChainId: onChainId, paymentId, nonce },
      },
    });
    if (existing) {
      return NextResponse.json(
        { signature: existing.signature, pubkey, nonce, reused: true },
        { status: 200 }
      );
    }

    const signature = signHoursProof(onChainId, paymentId, hoursLogged, nonce);

    await prisma.oracleAttestation.create({
      data: {
        escrowOnChainId: onChainId,
        paymentId,
        hoursLogged,
        nonce,
        signature,
        createdBy: user.walletAddress,
      },
    });

    return NextResponse.json({ signature, pubkey, nonce }, { status: 201 });
  } catch (error) {
    console.error('[oracle/attest] Error:', error);
    return NextResponse.json({ error: 'Failed to produce attestation' }, { status: 500 });
  }
}
