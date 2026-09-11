/**
 * PATCH /api/organizations/:id/findings/:findingId — advance a finding's lifecycle.
 *
 * OPEN → ACKNOWLEDGED → INVESTIGATING → RESOLVED
 *
 * ── Why resolution needs a reason ────────────────────────────────────────────
 * A "mark resolved" button with no explanation turns the findings queue into a
 * dismiss button. The next person to look at a resolved CRITICAL finding — quite
 * possibly during an incident — needs to know what was established and by whom.
 * Resolution therefore requires a substantive reason and records the actor.
 *
 * ── What this endpoint cannot do ─────────────────────────────────────────────
 * It cannot change a payment's state, amount, recipient or transaction hash.
 * Resolving a finding records a human judgement ABOUT a discrepancy; it does not
 * alter the financial record, and it certainly cannot manufacture a settlement.
 */

import { NextRequest, NextResponse } from 'next/server';
import { FindingStatus } from '@prisma/client';
import prisma from '@/lib/db/prisma';
import { withTenant } from '@/lib/tenancy/http';
import { recordAuditEvent } from '@/lib/payments/service';

/** Valid lifecycle moves. RESOLVED is terminal; reopening is a new finding. */
const TRANSITIONS: Record<FindingStatus, readonly FindingStatus[]> = {
  [FindingStatus.OPEN]: [FindingStatus.ACKNOWLEDGED, FindingStatus.INVESTIGATING, FindingStatus.RESOLVED],
  [FindingStatus.ACKNOWLEDGED]: [FindingStatus.INVESTIGATING, FindingStatus.RESOLVED],
  [FindingStatus.INVESTIGATING]: [FindingStatus.RESOLVED, FindingStatus.ACKNOWLEDGED],
  [FindingStatus.RESOLVED]: [],
};

const MIN_RESOLUTION_LENGTH = 10;

export async function PATCH(
  request: NextRequest,
  { params }: { params: { id: string; findingId: string } }
) {
  return withTenant(
    request,
    { permission: 'reconciliation:resolve' },
    async ({ ctx, body }) => {
      if (ctx.orgId !== params.id) {
        return NextResponse.json({ error: 'Organization not found.' }, { status: 404 });
      }

      const target = body?.status as FindingStatus | undefined;
      if (!target || !(Object.values(FindingStatus) as string[]).includes(target)) {
        return NextResponse.json(
          { error: `status must be one of ${Object.values(FindingStatus).join(', ')}.` },
          { status: 400 }
        );
      }

      // Scoped lookup: a finding id from another tenant is a 404.
      const finding = await prisma.reconciliationFinding.findFirst({
        where: { id: params.findingId, orgId: ctx.orgId },
      });
      if (!finding) {
        return NextResponse.json({ error: 'Finding not found.' }, { status: 404 });
      }

      if (finding.status === target) {
        return NextResponse.json({ changed: false, status: finding.status });
      }

      if (!TRANSITIONS[finding.status].includes(target)) {
        return NextResponse.json(
          {
            error:
              `A ${finding.status} finding cannot become ${target}. ` +
              `Valid next states: ${TRANSITIONS[finding.status].join(', ') || 'none'}.`,
            code: 'INVALID_FINDING_TRANSITION',
          },
          { status: 409 }
        );
      }

      const reason = typeof body?.resolution === 'string' ? body.resolution.trim() : '';
      if (target === FindingStatus.RESOLVED && reason.length < MIN_RESOLUTION_LENGTH) {
        return NextResponse.json(
          {
            error:
              'Resolving a finding requires an explanation of what was established. ' +
              'The next person to read this — possibly during an incident — needs to ' +
              'know why it was closed.',
            code: 'RESOLUTION_REASON_REQUIRED',
          },
          { status: 400 }
        );
      }

      const now = new Date();
      const updated = await prisma.$transaction(async (tx) => {
        const row = await tx.reconciliationFinding.update({
          where: { id: finding.id },
          data: {
            status: target,
            ...(target === FindingStatus.ACKNOWLEDGED
              ? { acknowledgedAt: now, acknowledgedBy: ctx.walletAddress }
              : {}),
            ...(target === FindingStatus.RESOLVED
              ? { resolvedAt: now, resolvedBy: ctx.walletAddress, resolution: reason }
              : {}),
          },
        });

        await recordAuditEvent(tx, {
          orgId: ctx.orgId,
          type: `reconciliation.finding.${target.toLowerCase()}`,
          actor: { kind: 'user', role: ctx.role, address: ctx.walletAddress },
          paymentId: finding.paymentId ?? undefined,
          txHash: finding.txHash ?? undefined,
          metadata: {
            findingId: finding.id,
            kind: finding.kind,
            severity: finding.severity,
            previousStatus: finding.status,
            newStatus: target,
            ...(reason ? { resolution: reason } : {}),
          },
        });

        return row;
      });

      return NextResponse.json({
        changed: true,
        finding: {
          id: updated.id,
          status: updated.status,
          acknowledgedBy: updated.acknowledgedBy,
          resolvedBy: updated.resolvedBy,
          resolution: updated.resolution,
        },
      });
    }
  );
}
