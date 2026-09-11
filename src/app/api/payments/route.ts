/**
 * GET /api/payments — list payments, scoped to the caller's organization.
 *
 * Tenant scoping is part of the query, not a check after the fact: a payment id
 * belonging to another organization is indistinguishable from one that does not
 * exist.
 */

import { NextRequest, NextResponse } from 'next/server';
import { PaymentState } from '@prisma/client';
import prisma from '@/lib/db/prisma';
import { getUserFromRequest } from '@/lib/auth';
import { resolveMembership, canRead } from '@/lib/payments/authz';
import { describeState } from '@/lib/payments/state-machine';
import { formatAmountWithSeparators } from '@/lib/money';

const VALID_STATES = new Set<string>(Object.values(PaymentState));

export async function GET(request: NextRequest) {
  const user = await getUserFromRequest(request);
  if (!user) {
    return NextResponse.json({ error: 'Authentication required.' }, { status: 401 });
  }

  const url = new URL(request.url);
  const orgId = request.headers.get('x-organization-id') ?? url.searchParams.get('orgId');
  if (!orgId) {
    return NextResponse.json(
      { error: 'An organization is required (X-Organization-Id header or ?orgId).' },
      { status: 400 }
    );
  }

  const membership = await resolveMembership(prisma, user.userId, orgId);
  if (!membership.ok) {
    return NextResponse.json({ error: membership.message }, { status: membership.status });
  }
  if (!canRead(membership.value.role)) {
    return NextResponse.json(
      { error: 'Your role cannot read payment data.' },
      { status: 403 }
    );
  }

  const stateParam = url.searchParams.get('state');
  if (stateParam && !VALID_STATES.has(stateParam)) {
    return NextResponse.json({ error: `Unknown state "${stateParam}".` }, { status: 400 });
  }

  const limit = Math.min(parseInt(url.searchParams.get('limit') || '50', 10), 200);
  const batchId = url.searchParams.get('batchId');

  const payments = await prisma.payment.findMany({
    where: {
      orgId: membership.value.orgId,
      ...(stateParam ? { state: stateParam as PaymentState } : {}),
      ...(batchId ? { batchId } : {}),
    },
    orderBy: [{ createdAt: 'desc' }],
    take: limit,
    include: {
      batch: { select: { id: true, reference: true } },
      escrow: { select: { onChainId: true, contractId: true, network: true } },
      approvals: { select: { role: true, decision: true, actorAddress: true, createdAt: true } },
      _count: { select: { attestations: true, transactions: true } },
    },
  });

  return NextResponse.json({
    payments: payments.map((p) => {
      const d = describeState(p.state);
      return {
        id: p.id,
        batch: p.batch,
        escrowOnChainId: p.escrow?.onChainId ?? null,
        network: p.escrow?.network ?? null,
        recipient: p.recipientAddress,
        onChainPaymentIndex: p.onChainPaymentIndex,
        asset: { code: p.assetCode, contractId: p.assetContractId, decimals: p.assetDecimals },
        amount: formatAmountWithSeparators(p.amountBaseUnits, p.assetDecimals),
        amountBaseUnits: p.amountBaseUnits.toString(),
        rateBaseUnits: p.rateBaseUnits.toString(),
        hours: p.hours.toString(),
        state: p.state,
        stateLabel: d.label,
        stateDescription: d.description,
        tone: d.tone,
        needsAttention: d.needsAttention,
        stateReason: p.stateReason,
        // A transaction reference is surfaced only where one can actually exist.
        // Showing an explorer link for an unsubmitted payment invites a reader to
        // believe something settled.
        transactionHash: d.mayHaveTransaction ? p.settlementTxHash : null,
        settledAt: p.settledAt?.toISOString() ?? null,
        approvals: p.approvals,
        counts: p._count,
        createdAt: p.createdAt.toISOString(),
      };
    }),
  });
}
