/**
 * GET /api/escrows  — list escrows with their payments
 * POST /api/escrows — record an escrow created on-chain
 *
 * ── Status of this endpoint ──────────────────────────────────────────────────
 * Superseded by /api/batches and /api/payments, which expose the payment domain
 * directly. It is retained, working, because the existing dashboard consumes its
 * shape; it now reads through the Payment model rather than the single-payee
 * columns that used to live on Escrow.
 *
 * The per-escrow response aggregates its payments. A caller wanting per-payment
 * truth should use /api/payments — an escrow-shaped view of a multi-payee batch
 * is exactly the lossiness this phase removed, so it is not reintroduced here as
 * the primary interface.
 */

import { NextRequest, NextResponse } from 'next/server';
import { PaymentState } from '@prisma/client';
import prisma from '@/lib/db/prisma';
import { getUserFromRequest, isAdmin } from '@/lib/auth';
import { MembershipStatus } from '@prisma/client';
import { can } from '@/lib/tenancy/rbac';
import { parseBody, createEscrowSchema } from '@/lib/validation/schemas';
import { audit } from '@/lib/audit';
import { SAC_DECIMALS, formatAmountWithSeparators, sumAmounts } from '@/lib/money';
import { describeState } from '@/lib/payments/state-machine';
import { rollupBatch } from '@/lib/payments/service';

export async function GET(request: NextRequest) {
  const user = await getUserFromRequest(request);
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const { searchParams } = new URL(request.url);
    const limit = Math.min(parseInt(searchParams.get('limit') || '10', 10), 50);
    const cursor = searchParams.get('cursor');

    // TENANT SCOPE FIRST.
    //
    // This previously returned `{}` for a platform ADMIN — every organization's
    // escrows, to anyone holding that flag. Platform-level admin is not a licence
    // to read other tenants' payroll, so the query is scoped to organizations the
    // caller is an ACTIVE member of, and then narrowed by role within them.
    const memberships = await prisma.orgMember.findMany({
      where: { userId: user.userId, status: MembershipStatus.ACTIVE },
      select: { orgId: true, role: true },
    });
    if (memberships.length === 0) {
      return NextResponse.json({ escrows: [], nextCursor: null });
    }

    // Organizations where this caller may read payroll at all. A WORKER holds no
    // organization-wide read, so they see only escrows that pay them.
    const readableOrgIds = memberships.filter((m) => can(m.role, 'escrow:read')).map((m) => m.orgId);
    const payeeOnlyOrgIds = memberships.filter((m) => !can(m.role, 'escrow:read')).map((m) => m.orgId);

    const whereClause: any = {
      OR: [
        ...(readableOrgIds.length ? [{ orgId: { in: readableOrgIds } }] : []),
        ...(payeeOnlyOrgIds.length
          ? [{
              orgId: { in: payeeOnlyOrgIds },
              payments: { some: { recipientAddress: user.walletAddress } },
            }]
          : []),
      ],
    };
    if (whereClause.OR.length === 0) {
      return NextResponse.json({ escrows: [], nextCursor: null });
    }

    if (cursor) {
      whereClause.createdAt = { lt: new Date(cursor) };
    }

    const escrows = await prisma.escrow.findMany({
      where: whereClause,
      take: limit + 1,
      orderBy: { createdAt: 'desc' },
      include: {
        payments: {
          orderBy: { onChainPaymentIndex: 'asc' },
          select: {
            id: true, recipientAddress: true, onChainPaymentIndex: true,
            amountBaseUnits: true, rateBaseUnits: true, hours: true,
            assetDecimals: true, assetCode: true, state: true,
            settlementTxHash: true, settledAt: true,
          },
        },
      },
    });

    const hasNextPage = escrows.length > limit;
    const items = hasNextPage ? escrows.slice(0, limit) : escrows;
    const nextCursor = hasNextPage
      ? items[items.length - 1].createdAt.toISOString()
      : null;

    const mappedEscrows = items.map((e) => {
      const rollup = rollupBatch(e.payments);
      const total = sumAmounts(e.payments.map((p) => p.amountBaseUnits));
      const decimals = e.assetDecimals ?? SAC_DECIMALS;
      const totalHours = e.payments.reduce((acc, p) => acc + p.hours, 0n);

      return {
        id: e.onChainId ?? e.id,
        escrowId: e.id,
        onChainId: e.onChainId,
        contractId: e.contractId,
        network: e.network,
        // Aggregate across payees, rendered at the asset's own precision.
        amount: formatAmountWithSeparators(total, decimals),
        amountBaseUnits: total.toString(),
        currency: e.payments[0]?.assetCode ?? 'USDC',
        paymentCount: e.payments.length,
        hoursLogged: totalHours.toString(),
        // Derived from the payments, never a stored rollup.
        status: rollup.headline,
        manager_approved: e.managerApproved,
        finance_approved: e.financeApproved,
        hours_verified: e.payments.every(
          (p) => p.state !== PaymentState.AWAITING_ORACLE
        ),
        cancelled: e.cancelled,
        created_at: e.createdAt.toISOString(),
        isMock: false,
        payments: e.payments.map((p) => ({
          id: p.id,
          index: p.onChainPaymentIndex,
          recipient: p.recipientAddress,
          amount: formatAmountWithSeparators(p.amountBaseUnits, p.assetDecimals),
          amountBaseUnits: p.amountBaseUnits.toString(),
          hours: p.hours.toString(),
          state: p.state,
          stateLabel: describeState(p.state).label,
          txHash: p.settlementTxHash,
          settledAt: p.settledAt?.toISOString() ?? null,
        })),
      };
    });

    return NextResponse.json({ escrows: mappedEscrows, nextCursor });
  } catch (error) {
    console.error('Failed to list escrows:', error);
    return NextResponse.json({ error: 'Failed to list escrows' }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  const user = await getUserFromRequest(request);
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (!isAdmin(user)) {
    return NextResponse.json(
      { error: 'Forbidden: this action requires the ADMIN role' },
      { status: 403 }
    );
  }

  try {
    const body = await request.json().catch(() => null);
    const parsed = parseBody(createEscrowSchema, body);
    if (!parsed.ok) {
      return NextResponse.json({ error: parsed.error }, { status: 400 });
    }
    const {
      onChainId, workerPubKey, financeApprover,
      amountBaseUnits, rateBaseUnits, assetDecimals, tokenAddress,
    } = parsed.data;

    // A recorded escrow needs an organization and a batch to hold its payment.
    // The membership the caller already has determines which.
    const membership = await prisma.orgMember.findFirst({
      where: { user: { walletAddress: user.walletAddress } },
      orderBy: { createdAt: 'asc' },
      select: { orgId: true },
    });
    if (!membership) {
      return NextResponse.json(
        { error: 'You are not a member of any organization.' },
        { status: 409 }
      );
    }

    const amount = BigInt(amountBaseUnits);
    const rate = BigInt(rateBaseUnits);

    const created = await prisma.$transaction(async (tx) => {
      const escrow = await tx.escrow.create({
        data: {
          orgId: membership.orgId,
          onChainId: onChainId ?? null,
          contractId: process.env.NEXT_PUBLIC_STELLAR_CONTRACT_ID ?? '',
          network: process.env.NEXT_PUBLIC_STELLAR_NETWORK ?? 'testnet',
          managerAddress: user.walletAddress,
          financeApproverAddress: financeApprover ?? '',
          tokenAddress: tokenAddress ?? null,
          assetDecimals,
          totalAmountBaseUnits: amount,
        },
      });

      const reference = `ESC-${String(onChainId ?? 0).padStart(5, '0')}-${escrow.id.slice(-6)}`;
      const batch = await tx.payrollBatch.create({
        data: { orgId: membership.orgId, reference, uploadedBy: user.walletAddress },
      });

      const payment = await tx.payment.create({
        data: {
          orgId: membership.orgId,
          batchId: batch.id,
          escrowId: escrow.id,
          recipientAddress: workerPubKey,
          onChainPaymentIndex: 0,
          assetContractId: tokenAddress ?? null,
          assetDecimals,
          amountBaseUnits: amount,
          rateBaseUnits: rate,
          hours: rate > 0n ? amount / rate : 0n,
          // The client has submitted the on-chain creation; the indexer confirms
          // funding and advances the state. Nothing here asserts settlement.
          state: PaymentState.VALIDATING,
        },
      });

      return { escrow, batch, payment };
    });

    await audit('escrow.create', {
      actor: user.walletAddress,
      target: created.escrow.id,
      metadata: { onChainId: created.escrow.onChainId, paymentId: created.payment.id },
    });

    return NextResponse.json(
      {
        escrow: {
          id: created.escrow.id,
          onChainId: created.escrow.onChainId,
          totalAmountBaseUnits: created.escrow.totalAmountBaseUnits.toString(),
        },
        batch: { id: created.batch.id, reference: created.batch.reference },
        payment: {
          id: created.payment.id,
          state: created.payment.state,
          amountBaseUnits: created.payment.amountBaseUnits.toString(),
        },
      },
      { status: 201 }
    );
  } catch (error: any) {
    if (error?.code === 'P2002') {
      return NextResponse.json({ message: 'Escrow already indexed' }, { status: 200 });
    }
    console.error('Failed to create escrow:', error);
    return NextResponse.json({ error: 'Failed to create escrow' }, { status: 500 });
  }
}
