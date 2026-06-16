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

export async function POST(request: NextRequest) {
  const user = await getUserFromRequest(request);
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let pubkey: string;
  try {
    pubkey = getOraclePublicKeyHex();
  } catch {
    return NextResponse.json({ error: 'Oracle is not configured' }, { status: 503 });
  }

  try {
    const body = await request.json();
    const { onChainId, paymentId, hoursLogged, nonce } = body;

    if (
      !Number.isInteger(onChainId) ||
      !Number.isInteger(paymentId) ||
      !Number.isInteger(hoursLogged) ||
      !Number.isInteger(nonce) ||
      onChainId < 0 ||
      paymentId < 0 ||
      hoursLogged <= 0 ||
      nonce < 0
    ) {
      return NextResponse.json({ error: 'Invalid attestation request' }, { status: 400 });
    }

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
