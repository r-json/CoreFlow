/**
 * POST /api/organizations/:id/escrows/claim — attribute an on-chain escrow to this
 * organization.
 *
 * ── Why a claim exists at all ────────────────────────────────────────────────
 * The chain knows nothing about CoreFlow organizations. An escrow created outside
 * the app — by the CLI, a validation script, or another client — has no tenant
 * mapping, so the indexer records its events as unattributed and projects nothing.
 * This is how such an escrow becomes visible, deliberately, to a named
 * organization.
 *
 * ── What makes the claim safe ────────────────────────────────────────────────
 * The caller must prove, against LIVE CONTRACT STATE, that their wallet is the
 * escrow's on-chain manager. Without that check, any organization could claim any
 * escrow by naming its id and gain the payroll of whoever actually created it —
 * the exact leak the unattributed-by-default rule exists to prevent.
 *
 * An escrow already claimed by another organization is reported as a conflict and
 * never reassigned: silently moving it would transfer one tenant's financial
 * records to another.
 */

import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/db/prisma';
import { withTenant } from '@/lib/tenancy/http';
import { writeMembershipAudit } from '@/lib/tenancy/membership';
import { CoreFlowClient } from '@/lib/contracts';
import { STELLAR_CONFIG } from '@/lib/config';
import { SAC_DECIMALS } from '@/lib/money';

export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  return withTenant(request, { permission: 'escrow:create' }, async ({ ctx, body }) => {
    if (ctx.orgId !== params.id) {
      return NextResponse.json({ error: 'Organization not found.' }, { status: 404 });
    }

    const onChainId = Number(body?.onChainId);
    if (!Number.isInteger(onChainId) || onChainId < 1) {
      return NextResponse.json(
        { error: 'onChainId must be a positive integer.' },
        { status: 400 }
      );
    }

    const contractId = STELLAR_CONFIG.contract.id;
    const network = STELLAR_CONFIG.contract.network;
    if (!contractId) {
      return NextResponse.json(
        { error: 'No contract is configured for this deployment.' },
        { status: 503 }
      );
    }

    // Already mapped? Report it rather than reassigning.
    const existing = await prisma.escrow.findFirst({
      where: { onChainId, contractId, network },
      select: { id: true, orgId: true },
    });
    if (existing) {
      if (existing.orgId === ctx.orgId) {
        return NextResponse.json(
          { claimed: true, escrowId: existing.id, alreadyClaimed: true },
          { status: 200 }
        );
      }
      // Deliberately vague: confirming that ANOTHER organization holds it would
      // disclose that a tenant we must not name exists and uses this escrow.
      return NextResponse.json(
        {
          error: `Escrow ${onChainId} is not available to claim.`,
          code: 'ESCROW_UNAVAILABLE',
        },
        { status: 409 }
      );
    }

    // The proof: live contract state must name this caller as manager.
    let chainEscrow: Awaited<ReturnType<CoreFlowClient['getEscrow']>>;
    try {
      chainEscrow = await new CoreFlowClient().getEscrow(onChainId);
    } catch {
      return NextResponse.json(
        { error: `Escrow ${onChainId} could not be read from ${network}.` },
        { status: 502 }
      );
    }

    if (chainEscrow.manager !== ctx.walletAddress) {
      return NextResponse.json(
        {
          error:
            'Only the escrow’s on-chain manager can claim it. Sign in with the ' +
            'wallet that created the escrow.',
          code: 'NOT_ON_CHAIN_MANAGER',
        },
        { status: 403 }
      );
    }

    const total = chainEscrow.payments.reduce((a, p) => a + p.amount, 0n);

    const escrow = await prisma.$transaction(async (tx) => {
      const created = await tx.escrow.create({
        data: {
          orgId: ctx.orgId,
          onChainId,
          contractId,
          network,
          managerAddress: chainEscrow.manager,
          financeApproverAddress: chainEscrow.finance_approver,
          oraclePublicKey: chainEscrow.oracle_pubkey ?? null,
          tokenAddress: chainEscrow.payments[0]?.token ?? null,
          assetDecimals: SAC_DECIMALS,
          totalAmountBaseUnits: total,
          managerApproved: chainEscrow.manager_approved,
          financeApproved: chainEscrow.finance_approved,
          cancelled: chainEscrow.cancelled,
          oracleRotations: chainEscrow.oracle_rotations,
        },
      });

      await writeMembershipAudit(tx, {
        orgId: ctx.orgId,
        type: 'escrow.claimed',
        actorAddress: ctx.walletAddress,
        metadata: {
          onChainId, contractId, network,
          paymentCount: chainEscrow.payments.length,
          totalAmountBaseUnits: total.toString(),
        },
      });

      return created;
    });

    return NextResponse.json(
      {
        claimed: true,
        escrowId: escrow.id,
        onChainId,
        paymentCount: chainEscrow.payments.length,
        // Events that arrived before the claim were recorded unattributed; the
        // next indexer run applies them now that a mapping exists.
        note:
          'Run the indexer to project this escrow’s history. Events recorded ' +
          'before the claim are replayed, not lost.',
      },
      { status: 201 }
    );
  });
}
