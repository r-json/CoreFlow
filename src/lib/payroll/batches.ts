/**
 * Creating a payroll batch from validated CSV rows.
 *
 * Two properties carry most of the weight here:
 *
 * 1. ONE PAYMENT PER ROW. A three-payee payroll is three Payment rows, each with
 *    its own state, approvals, attestation and settlement evidence. Collapsing it
 *    into one aggregate would make "11 paid, 1 needs attention" unrepresentable,
 *    and that is the normal outcome of a real batch, not an edge case.
 *
 * 2. CREATION IS IDEMPOTENT. A double-click, a refresh after a gateway timeout, a
 *    second tab, or a client retry must not produce a second payroll. The
 *    guarantee is a UNIQUE INDEX on (orgId, idempotencyKey), not a read-then-write
 *    in this file: check-then-insert loses exactly the race it is meant to cover.
 *
 * Everything created here starts in DRAFT. Nothing in this module can move a
 * payment toward settlement, and nothing here touches the chain.
 */

import { createHash } from 'node:crypto';
import { PaymentState } from '@prisma/client';
import { recordAuditEvent } from '@/lib/payments/service';
import { sumAmounts } from '@/lib/money';
import type { TenantContext } from '@/lib/tenancy/resolve';
import type { ParsedPayrollRow } from './csv';
import type { SettlementAsset } from './assets';

/**
 * How recently an identical file counts as "probably a re-submit".
 *
 * Only ever used to WARN. Uploading the same figures next period is legitimate
 * payroll, so this must not block: a system that refuses a valid second payroll
 * is worse than one that asks.
 */
export const DUPLICATE_UPLOAD_WINDOW_MS = 60 * 60 * 1000;

/** Longest a generated reference may collide before we stop retrying. */
const MAX_REFERENCE_ATTEMPTS = 5;

const REFERENCE_FORMAT = /^[A-Za-z0-9][A-Za-z0-9._\-/ ]{0,62}$/;

/** SHA-256 of the uploaded bytes, for "have I already uploaded this?" */
export function checksumCsv(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export interface CreateDraftBatchInput {
  rows: readonly ParsedPayrollRow[];
  /** Asset every row settles in. Narrowed by the caller from configuration. */
  asset: SettlementAsset;
  /** Client-chosen label. Generated when absent. */
  reference?: string | null;
  projectId?: string | null;
  sourceFilename?: string | null;
  /** Rows SEEN in the file, including rejected ones. Provenance, not a count of payments. */
  sourceRowCount?: number | null;
  sourceChecksum?: string | null;
  idempotencyKey?: string | null;
}

export interface CreatedBatch {
  id: string;
  reference: string;
  paymentCount: number;
  periodStart: Date | null;
  periodEnd: Date | null;
  totalBaseUnits: bigint;
  /** Payees with no Worker record in this organization yet. */
  unlinkedRecipients: number;
}

export type CreateDraftBatchResult =
  | {
      ok: true;
      /** False when an earlier identical request already created this batch. */
      created: boolean;
      batch: CreatedBatch;
      note?: string;
    }
  | { ok: false; status: 400 | 409; message: string; code?: string };

/** Earliest start and latest end across the rows, for the batch header. */
export function deriveBatchPeriod(rows: readonly ParsedPayrollRow[]): {
  periodStart: Date | null;
  periodEnd: Date | null;
} {
  let start: Date | null = null;
  let end: Date | null = null;
  for (const r of rows) {
    if (r.periodStart && (start === null || r.periodStart < start)) start = r.periodStart;
    if (r.periodEnd && (end === null || r.periodEnd > end)) end = r.periodEnd;
  }
  return { periodStart: start, periodEnd: end };
}

/**
 * Next sequential reference for this organization, e.g. CF-00042.
 *
 * Derived from a count, so two concurrent uploads can propose the same one. That
 * is handled by the unique index and a retry rather than by locking: a contended
 * human-facing label is not worth serializing payroll creation over.
 */
async function generateReference(db: any, orgId: string, attempt: number): Promise<string> {
  const existing = await db.payrollBatch.count({ where: { orgId } });
  return `CF-${String(existing + 1 + attempt).padStart(5, '0')}`;
}

/** A recent batch built from byte-identical input, if there is one. */
export async function findDuplicateUpload(
  db: any,
  orgId: string,
  checksum: string,
  now: Date = new Date(),
): Promise<{ id: string; reference: string; createdAt: Date } | null> {
  if (!checksum) return null;
  const since = new Date(now.getTime() - DUPLICATE_UPLOAD_WINDOW_MS);
  const found = await db.payrollBatch.findFirst({
    where: { orgId, sourceChecksum: checksum, createdAt: { gte: since } },
    orderBy: { createdAt: 'desc' },
    select: { id: true, reference: true, createdAt: true },
  });
  return found ?? null;
}

/** Shape an existing batch into the success result, for the idempotent replay path. */
async function describeExisting(
  db: any,
  orgId: string,
  batch: { id: string; reference: string; periodStart: Date | null; periodEnd: Date | null },
): Promise<CreatedBatch> {
  const payments = await db.payment.findMany({
    where: { orgId, batchId: batch.id },
    select: { amountBaseUnits: true, workerId: true },
  });
  return {
    id: batch.id,
    reference: batch.reference,
    paymentCount: payments.length,
    periodStart: batch.periodStart ?? null,
    periodEnd: batch.periodEnd ?? null,
    totalBaseUnits: sumAmounts(payments.map((p: any) => p.amountBaseUnits)),
    unlinkedRecipients: payments.filter((p: any) => p.workerId === null).length,
  };
}

/**
 * Create a DRAFT batch and one DRAFT payment per row.
 *
 * The caller is responsible for authorization (`withTenant` + `payroll:create`)
 * and for having parsed and validated the rows. This function does not re-validate
 * the money: `parsePayrollCsv` already refused anything ambiguous, and a second,
 * subtly different set of rules in a second place is how the two drift apart.
 */
export async function createDraftBatch(
  db: any,
  ctx: TenantContext,
  input: CreateDraftBatchInput,
): Promise<CreateDraftBatchResult> {
  const rows = input.rows;
  if (rows.length === 0) {
    return { ok: false, status: 400, message: 'A batch needs at least one payroll row.' };
  }

  const suppliedReference = input.reference?.trim() || null;
  if (suppliedReference !== null && !REFERENCE_FORMAT.test(suppliedReference)) {
    return {
      ok: false,
      status: 400,
      message:
        'A batch reference may use letters, digits, spaces and . _ - / only, ' +
        'and must start with a letter or digit.',
      code: 'INVALID_REFERENCE',
    };
  }

  const idempotencyKey = input.idempotencyKey?.trim() || null;

  // Fast path: this exact request already succeeded. Checked before doing any
  // work, but NOT relied upon for correctness — the unique index below is.
  if (idempotencyKey !== null) {
    const prior = await db.payrollBatch.findFirst({
      where: { orgId: ctx.orgId, idempotencyKey },
      select: { id: true, reference: true, periodStart: true, periodEnd: true },
    });
    if (prior) {
      return {
        ok: true,
        created: false,
        batch: await describeExisting(db, ctx.orgId, prior),
        note: 'This batch was already created by an earlier request with the same idempotency key.',
      };
    }
  }

  const { periodStart, periodEnd } = deriveBatchPeriod(rows);

  // Link payees to existing Worker records where one exists. A payee without a
  // Worker row is reported, not invented: creating personnel records as a side
  // effect of a file upload is a surprise, and the count lets the UI offer it as
  // a choice instead.
  const recipients = Array.from(new Set(rows.map((r) => r.recipient)));
  const workers = await db.worker.findMany({
    where: { orgId: ctx.orgId, walletAddress: { in: recipients } },
    select: { id: true, walletAddress: true },
  });
  const workerByAddress = new Map<string, string>(
    workers.map((w: any) => [w.walletAddress, w.id]),
  );

  const totalBaseUnits = sumAmounts(rows.map((r) => r.amountBaseUnits));

  for (let attempt = 0; attempt < MAX_REFERENCE_ATTEMPTS; attempt++) {
    const reference = suppliedReference ?? (await generateReference(db, ctx.orgId, attempt));

    try {
      const batchId: string = await db.$transaction(async (tx: any) => {
        const batch = await tx.payrollBatch.create({
          data: {
            orgId: ctx.orgId,
            projectId: input.projectId ?? null,
            reference,
            periodStart,
            periodEnd,
            sourceFilename: input.sourceFilename ?? null,
            sourceRowCount: input.sourceRowCount ?? rows.length,
            sourceChecksum: input.sourceChecksum ?? null,
            idempotencyKey,
            uploadedBy: ctx.userId,
          },
          select: { id: true },
        });

        // One row in, one payment out. Created individually rather than with
        // createMany so each carries its own period and worker link, and so the
        // composite (orgId, batchId) foreign key is exercised per row.
        for (const row of rows) {
          await tx.payment.create({
            data: {
              orgId: ctx.orgId,
              batchId: batch.id,
              projectId: input.projectId ?? null,
              workerId: workerByAddress.get(row.recipient) ?? null,
              recipientAddress: row.recipient,
              assetCode: input.asset.code,
              assetContractId: input.asset.contractId,
              assetDecimals: input.asset.decimals,
              amountBaseUnits: row.amountBaseUnits,
              rateBaseUnits: row.rateBaseUnits,
              hours: row.hours,
              periodStart: row.periodStart,
              periodEnd: row.periodEnd,
              sourceReference: row.reference,
              // Explicit, though it is also the column default: a payment's
              // starting state is a decision, not an accident of schema.
              state: PaymentState.DRAFT,
            },
            select: { id: true },
          });
        }

        await recordAuditEvent(tx, {
          orgId: ctx.orgId,
          type: 'payroll.batch.created',
          actor: { kind: 'user', role: ctx.role, address: ctx.walletAddress },
          batchId: batch.id,
          metadata: {
            reference,
            paymentCount: rows.length,
            // Strings: JSON cannot carry a bigint, and a Number would be the
            // very rounding this codebase refuses everywhere else.
            totalBaseUnits: totalBaseUnits.toString(),
            asset: input.asset.code,
            assetContractId: input.asset.contractId,
            sourceFilename: input.sourceFilename ?? null,
            sourceRowCount: input.sourceRowCount ?? rows.length,
            sourceChecksum: input.sourceChecksum ?? null,
            uploadedByUserId: ctx.userId,
            idempotencyKey,
          },
        });

        return batch.id;
      });

      return {
        ok: true,
        created: true,
        batch: {
          id: batchId,
          reference,
          paymentCount: rows.length,
          periodStart,
          periodEnd,
          totalBaseUnits,
          unlinkedRecipients: recipients.filter((r) => !workerByAddress.has(r)).length,
        },
      };
    } catch (e: any) {
      if (e?.code !== 'P2002') throw e;
      const target: string[] = Array.isArray(e?.meta?.target)
        ? e.meta.target
        : typeof e?.meta?.target === 'string'
          ? [e.meta.target]
          : [];
      const hit = (col: string) => target.some((t) => t.includes(col));

      // Lost the idempotency race: a concurrent identical request committed
      // first. Its batch is the answer, so report that rather than an error —
      // the caller asked for this batch to exist, and it does.
      if (hit('idempotencyKey') && idempotencyKey !== null) {
        const prior = await db.payrollBatch.findFirst({
          where: { orgId: ctx.orgId, idempotencyKey },
          select: { id: true, reference: true, periodStart: true, periodEnd: true },
        });
        if (prior) {
          return {
            ok: true,
            created: false,
            batch: await describeExisting(db, ctx.orgId, prior),
            note:
              'An identical request created this batch concurrently. No second ' +
              'payroll was created.',
          };
        }
      }

      if (hit('reference')) {
        // A reference the CALLER chose is their decision to fix; a generated one
        // is ours, so try the next number.
        if (suppliedReference !== null) {
          return {
            ok: false,
            status: 409,
            message: `This organization already has a batch referenced "${suppliedReference}".`,
            code: 'REFERENCE_TAKEN',
          };
        }
        continue;
      }

      throw e;
    }
  }

  return {
    ok: false,
    status: 409,
    message:
      'Could not allocate a batch reference after several attempts. Retry, or ' +
      'supply a reference explicitly.',
    code: 'REFERENCE_EXHAUSTED',
  };
}
