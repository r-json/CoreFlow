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
import { resolveTenant, findEscrowByOnChainId, requirePermission } from '@/lib/tenancy/resolve';
import { signHoursProof, getOraclePublicKeyHex, type ProofContext } from '@/lib/oracle';
import { CoreFlowClient } from '@/lib/contracts';
import { STELLAR_CONFIG } from '@/lib/config';
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

    // ── Tenant scope ────────────────────────────────────────────────────────
    // An attestation unlocks settlement, so it must be scoped to an organization
    // the caller actually belongs to. Without this, a member of any organization
    // could request signatures for another's escrow simply by naming its id.
    const orgId =
      request.headers.get('x-organization-id') ??
      new URL(request.url).searchParams.get('orgId') ??
      (await prisma.orgMember
        .findMany({ where: { userId: user.userId, status: 'ACTIVE' }, select: { orgId: true }, take: 2 })
        .then((m) => (m.length === 1 ? m[0].orgId : null)));

    const tenant = await resolveTenant(prisma, user.userId, orgId);
    if (!tenant.ok) {
      return NextResponse.json({ error: tenant.message }, { status: tenant.status });
    }
    const denied = requirePermission(tenant.value, 'oracle:attest:request');
    if (denied) {
      return NextResponse.json({ error: denied.message, code: denied.code }, { status: 403 });
    }

    // The escrow must be one of THIS organization's. Escrow ids come from the
    // contract, so the same id exists in other tenants on other deployments.
    const owned = await findEscrowByOnChainId(prisma, tenant.value, onChainId);
    if (!owned.ok) {
      return NextResponse.json({ error: owned.message }, { status: owned.status });
    }

    // Idempotency: never sign the same (escrow, payment, nonce) twice.
    const existing = await prisma.oracleAttestation.findUnique({
      where: {
        escrowOnChainId_onChainPaymentIndex_nonce: {
          escrowOnChainId: onChainId,
          onChainPaymentIndex: paymentId,
          nonce: BigInt(nonce),
        },
      },
    });
    if (existing) {
      return NextResponse.json(
        { signature: existing.signature, pubkey, nonce, reused: true },
        { status: 200 }
      );
    }

    // Schema v2 binds the attestation to the payee, asset, amount, period,
    // contract and network. Those come from the on-chain payment row, never
    // from the request, so a caller cannot steer a signature onto a payment
    // the oracle was not asked about.
    let escrow: Awaited<ReturnType<CoreFlowClient['getEscrow']>>;
    try {
      escrow = await new CoreFlowClient().getEscrow(onChainId);
    } catch {
      return NextResponse.json(
        { error: `Could not read escrow ${onChainId} on this network.` },
        { status: 502 }
      );
    }

    if (escrow.manager !== user.walletAddress) {
      return NextResponse.json(
        { error: 'Only the escrow manager can request attestations for this escrow.' },
        { status: 403 }
      );
    }

    const payment = escrow.payments[paymentId];
    if (!payment) {
      return NextResponse.json(
        { error: `Escrow ${onChainId} has no payment ${paymentId}.` },
        { status: 400 }
      );
    }

    // The contract enforces `hours x rate == amount`; signing anything else
    // produces a signature that can only ever be rejected on chain.
    const expectedHours = payment.amount / payment.rate_per_hour;
    if (BigInt(hoursLogged) !== expectedHours) {
      return NextResponse.json(
        {
          error:
            `Escrow ${onChainId} payment ${paymentId} is funded for ${payment.amount} ` +
            `at ${payment.rate_per_hour}/hour, which is ${expectedHours} hours, not ${hoursLogged}.`,
        },
        { status: 409 }
      );
    }

    const ctx: ProofContext = {
      networkPassphrase: STELLAR_CONFIG.getNetworkPassphrase(),
      contractId: STELLAR_CONFIG.contract.id,
      worker: payment.worker,
      token: payment.token,
      amount: payment.amount,
      startDate: BigInt(payment.start_date),
      endDate: BigInt(payment.end_date),
    };

    const signature = signHoursProof(ctx, onChainId, paymentId, hoursLogged, nonce);

    await prisma.oracleAttestation.create({
      data: {
        orgId: tenant.value.orgId,
        escrowOnChainId: onChainId,
        onChainPaymentIndex: paymentId,
        hours: BigInt(hoursLogged),
        nonce: BigInt(nonce),
        signature,
        schema: 'CFWP-v2',
        contractId: STELLAR_CONFIG.contract.id,
        createdBy: user.walletAddress,
      },
    });

    return NextResponse.json({ signature, pubkey, nonce }, { status: 201 });
  } catch (error) {
    console.error('[oracle/attest] Error:', error);
    return NextResponse.json({ error: 'Failed to produce attestation' }, { status: 500 });
  }
}
