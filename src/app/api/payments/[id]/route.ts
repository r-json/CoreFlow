/**
 * GET /api/payments/:id — one payment, with its full history.
 *
 * Returns the audit trail alongside current state. A "current status only" view
 * cannot answer how a payment reached that status, which is the question asked
 * whenever something has gone wrong.
 */

import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/db/prisma';
import { getUserFromRequest } from '@/lib/auth';
import { resolveMembership, canRead, findPaymentForMember } from '@/lib/payments/authz';
import { describeState, transitionsFrom } from '@/lib/payments/state-machine';
import { formatAmountWithSeparators } from '@/lib/money';

export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
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
    return NextResponse.json({ error: 'Your role cannot read payment data.' }, { status: 403 });
  }

  const found = await findPaymentForMember(prisma, membership.value, params.id, {
    batch: true,
    escrow: true,
    worker: true,
    approvals: { orderBy: { createdAt: 'asc' } },
    attestations: { orderBy: { createdAt: 'asc' } },
    transactions: { orderBy: { createdAt: 'asc' } },
    auditEvents: { orderBy: { createdAt: 'asc' } },
    findings: { orderBy: { detectedAt: 'desc' } },
  });
  if (!found.ok) {
    return NextResponse.json({ error: found.message }, { status: found.status });
  }

  const p = found.value;
  const d = describeState(p.state);

  return NextResponse.json({
    payment: {
      id: p.id,
      recipient: p.recipientAddress,
      onChainPaymentIndex: p.onChainPaymentIndex,
      asset: { code: p.assetCode, contractId: p.assetContractId, decimals: p.assetDecimals },
      amount: formatAmountWithSeparators(p.amountBaseUnits, p.assetDecimals),
      amountBaseUnits: p.amountBaseUnits.toString(),
      rateBaseUnits: p.rateBaseUnits.toString(),
      hours: p.hours.toString(),
      periodStart: p.periodStart?.toISOString() ?? null,
      periodEnd: p.periodEnd?.toISOString() ?? null,
      state: p.state,
      stateLabel: d.label,
      stateDescription: d.description,
      tone: d.tone,
      needsAttention: d.needsAttention,
      stateReason: p.stateReason,
      transactionHash: d.mayHaveTransaction ? p.settlementTxHash : null,
      settledAt: p.settledAt?.toISOString() ?? null,
      createdAt: p.createdAt.toISOString(),
    },
    batch: p.batch
      ? { id: p.batch.id, reference: p.batch.reference }
      : null,
    escrow: p.escrow
      ? {
          id: p.escrow.id,
          onChainId: p.escrow.onChainId,
          contractId: p.escrow.contractId,
          network: p.escrow.network,
          managerApproved: p.escrow.managerApproved,
          financeApproved: p.escrow.financeApproved,
          cancelled: p.escrow.cancelled,
        }
      : null,
    approvals: p.approvals,
    attestations: p.attestations.map((a: any) => ({
      id: a.id,
      schema: a.schema,
      hours: a.hours.toString(),
      nonce: a.nonce.toString(),
      preimageSha256: a.preimageSha256,
      createdAt: a.createdAt.toISOString(),
    })),
    transactions: p.transactions.map((t: any) => ({
      id: t.id, kind: t.kind, status: t.status, hash: t.hash,
      attempt: t.attempt, ledger: t.ledger, errorMessage: t.errorMessage,
      createdAt: t.createdAt.toISOString(),
    })),
    history: p.auditEvents.map((e: any) => ({
      id: e.id, type: e.type,
      actor: e.actorAddress ?? e.actorSystem,
      previousState: e.previousState, newState: e.newState,
      txHash: e.txHash, metadata: e.metadata,
      at: e.createdAt.toISOString(),
    })),
    findings: p.findings.map((f: any) => ({
      id: f.id, kind: f.kind, dbState: f.dbState, chainState: f.chainState,
      detail: f.detail, detectedAt: f.detectedAt.toISOString(),
      resolvedAt: f.resolvedAt?.toISOString() ?? null,
    })),
    /** What this caller may do next, so the UI need not re-derive the rules. */
    availableActions: transitionsFrom(p.state)
      .filter((t) => t.actors.includes('user') && t.roles?.includes(membership.value.role))
      .map((t) => ({ to: t.to, reason: t.reason })),
  });
}
