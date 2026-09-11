/**
 * Orchestration for the Bulk Pay API.
 *
 * Routes are thin on purpose: they decode the request, call one function here,
 * and render the result. Business rules live in the domain services this module
 * composes — the CSV parser, the settlement asset registry, the batch service,
 * the payment actions and the state machine. Logic duplicated in a route handler
 * eventually disagrees with the service it shadows, and the route is the copy
 * nobody tests against the database.
 *
 * Nothing here can move a payment toward settlement on its own. Approval is
 * delegated to `approvePayment`, which derives the approver's role from
 * membership and records the audit trail; state changes are the state machine's.
 */

import { createHash } from 'node:crypto';
import { OrgRole, PaymentState } from '@prisma/client';
import { ApiError } from '@/lib/api/errors';
import { formatAmount, formatAmountWithSeparators, SAC_DECIMALS } from '@/lib/money';
import { approvePayment } from '@/lib/payments/actions';
import { describeState } from '@/lib/payments/state-machine';
import { rollupBatch } from '@/lib/payments/service';
import type { TenantContext } from '@/lib/tenancy/resolve';
import { parsePayrollCsv, summarizeParse, type CsvIssue, type CsvParseResult } from './csv';
import { settlementAsset, settleableAssetCodes, type SettlementAsset } from './assets';
import {
  checksumCsv,
  createDraftBatch,
  findDuplicateUpload,
  type CreateDraftBatchResult,
} from './batches';
import type { FieldIssue } from './schemas';

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export interface ValidationReport {
  valid: boolean;
  /** Blocking problems. Nothing is created while any remain. */
  errors: FieldIssue[];
  /** Worth reading, but not blocking. */
  warnings: FieldIssue[];
  summary: {
    rowsSeen: number;
    paymentsToCreate: number;
    recipientCount: number;
    totalHours: string;
    totals: { asset: string; amount: string }[];
  };
  asset: { code: string; contractId: string | null; configured: boolean };
}

/** CSV issues carry a line number; request issues carry a field path. */
function toFieldIssue(issue: CsvIssue): FieldIssue {
  return {
    ...(issue.line > 0 ? { row: issue.line } : {}),
    ...(issue.column ? { field: issue.column } : {}),
    code: issue.code,
    message: issue.message,
  };
}

/**
 * Parse and validate an uploaded file against this deployment's settlement asset.
 *
 * Pure with respect to the database: it reads configuration and the file, and
 * writes nothing. Safe to call on every keystroke of a preview.
 */
export function validateCsv(
  csv: string,
  opts: { rejectDuplicateRecipients?: boolean } = {},
): { report: ValidationReport; parsed: CsvParseResult; asset: SettlementAsset } {
  const asset = settlementAsset();
  const parsed = parsePayrollCsv(csv, {
    supportedAssets: settleableAssetCodes(),
    rejectDuplicateRecipients: opts.rejectDuplicateRecipients,
  });
  const summary = summarizeParse(parsed);

  return {
    parsed,
    asset,
    report: {
      valid: parsed.issues.length === 0 && parsed.rows.length > 0,
      errors: parsed.issues.map(toFieldIssue),
      warnings: parsed.warnings.map(toFieldIssue),
      summary: {
        rowsSeen: parsed.rowCount,
        paymentsToCreate: parsed.rows.length,
        recipientCount: summary.recipientCount,
        totalHours: summary.totalHours.toString(),
        totals: summary.totals,
      },
      asset: {
        code: asset.code,
        contractId: asset.contractId,
        // Surfaced rather than fatal: a batch can be prepared and reviewed before
        // the operator has finished wiring the asset. Funding is where it becomes
        // a hard requirement.
        configured: asset.contractId !== null,
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Creation
// ---------------------------------------------------------------------------

/**
 * Fingerprint the parts of a creation request that change WHAT gets created.
 *
 * Deliberately excludes the filename: re-uploading identical rows from
 * `september-final.csv` instead of `september.csv` is the same payroll, and a
 * retry should not be rejected over a renamed file. Includes the asset code,
 * because the same rows settled in a different asset is a different payroll.
 */
export function fingerprintCreateRequest(input: {
  csv: string;
  reference?: string | null;
  projectId?: string | null;
  assetCode: string;
  rejectDuplicateRecipients: boolean;
}): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        checksumCsv(input.csv),
        input.reference ?? null,
        input.projectId ?? null,
        input.assetCode,
        input.rejectDuplicateRecipients,
      ]),
    )
    .digest('hex');
}

export interface CreateBatchOutcome {
  created: boolean;
  batch: {
    id: string;
    reference: string;
    paymentCount: number;
    periodStart: string | null;
    periodEnd: string | null;
    total: string;
    totalBaseUnits: string;
    asset: string;
    unlinkedRecipients: number;
  };
  warnings: FieldIssue[];
  note?: string;
  /** A recent byte-identical upload, so the client can ask rather than assume. */
  possibleDuplicateOf?: { id: string; reference: string; createdAt: string };
}

/**
 * Validate, then create a draft batch with one payment per valid row.
 *
 * Validation failures raise a 422 carrying every row issue, because a finance user
 * fixing a 40-row file one error per upload cannot work. Nothing is written until
 * the file is wholly valid.
 */
export async function createBatch(
  db: any,
  ctx: TenantContext,
  input: {
    csv: string;
    filename?: string | null;
    reference?: string | null;
    projectId?: string | null;
    rejectDuplicateRecipients?: boolean;
    idempotencyKey?: string | null;
  },
): Promise<CreateBatchOutcome> {
  const rejectDuplicateRecipients = input.rejectDuplicateRecipients ?? true;
  const { report, parsed, asset } = validateCsv(input.csv, { rejectDuplicateRecipients });

  if (!report.valid) {
    throw new ApiError(
      422,
      parsed.rows.length === 0 && parsed.issues.length === 0 ? 'VALIDATION_FAILED' : 'CSV_INVALID',
      parsed.issues.length === 1
        ? 'The payroll file has a problem that must be fixed before a batch can be created.'
        : `The payroll file has ${parsed.issues.length} problems that must be fixed before a batch can be created.`,
      { errors: report.errors, warnings: report.warnings, summary: report.summary },
    );
  }

  const checksum = checksumCsv(input.csv);
  const fingerprint = fingerprintCreateRequest({
    csv: input.csv,
    reference: input.reference ?? null,
    projectId: input.projectId ?? null,
    assetCode: asset.code,
    rejectDuplicateRecipients,
  });

  const result: CreateDraftBatchResult = await createDraftBatch(db, ctx, {
    rows: parsed.rows,
    asset,
    reference: input.reference ?? null,
    projectId: input.projectId ?? null,
    sourceFilename: input.filename ?? null,
    sourceRowCount: parsed.rowCount,
    sourceChecksum: checksum,
    idempotencyKey: input.idempotencyKey ?? null,
    idempotencyFingerprint: fingerprint,
  });

  if (!result.ok) {
    throw new ApiError(
      result.status === 400 ? 422 : 409,
      (result.code as any) ?? 'STATE_CONFLICT',
      result.message,
    );
  }

  // Only worth mentioning on a NEW batch. On a replay the client already has its
  // answer, and "this looks like a duplicate" would describe the batch itself.
  let possibleDuplicateOf: CreateBatchOutcome['possibleDuplicateOf'];
  if (result.created) {
    const dup = await findDuplicateUpload(db, ctx.orgId, checksum, {
      excludeId: result.batch.id,
    });
    if (dup) {
      possibleDuplicateOf = {
        id: dup.id,
        reference: dup.reference,
        createdAt: new Date(dup.createdAt).toISOString(),
      };
    }
  }

  return {
    created: result.created,
    batch: {
      id: result.batch.id,
      reference: result.batch.reference,
      paymentCount: result.batch.paymentCount,
      periodStart: result.batch.periodStart?.toISOString() ?? null,
      periodEnd: result.batch.periodEnd?.toISOString() ?? null,
      total: formatAmountWithSeparators(result.batch.totalBaseUnits, asset.decimals),
      // Exact value alongside the display string, so a client never has to parse
      // a formatted number back into money.
      totalBaseUnits: result.batch.totalBaseUnits.toString(),
      asset: asset.code,
      unlinkedRecipients: result.batch.unlinkedRecipients,
    },
    warnings: report.warnings,
    ...(result.created ? {} : { note: result.note }),
    ...(possibleDuplicateOf ? { possibleDuplicateOf } : {}),
  };
}

// ---------------------------------------------------------------------------
// Re-validation of an existing draft
// ---------------------------------------------------------------------------

/**
 * The payment fields re-validation reads.
 *
 * Declared explicitly rather than taking `any`, because TypeScript types `any *
 * any` as NUMBER — so an untyped payment would have silently turned the
 * hours x rate invariant into floating-point arithmetic, in the one check whose
 * entire purpose is exactness.
 */
export interface RevalidationPayment {
  recipientAddress: string;
  assetCode: string;
  assetDecimals: number;
  amountBaseUnits: bigint;
  rateBaseUnits: bigint;
  hours: bigint;
}

export interface RevalidationReport {
  valid: boolean;
  batch: { id: string; reference: string; paymentCount: number };
  errors: FieldIssue[];
  asset: { code: string; contractId: string | null; configured: boolean };
}

/**
 * Re-check a draft batch's payments against CURRENT configuration.
 *
 * A batch can be created, reviewed for a day, and funded later — by which time
 * the configured settlement asset may have changed. This catches that before a
 * wallet is opened. Read-only: it reports, and changes nothing.
 */
export async function revalidateBatch(
  db: any,
  ctx: TenantContext,
  batch: { id: string; reference: string; payments: readonly RevalidationPayment[] },
): Promise<RevalidationReport> {
  const asset = settlementAsset();
  const errors: FieldIssue[] = [];

  for (const p of batch.payments) {
    if (p.assetCode !== asset.code) {
      errors.push({
        field: 'asset',
        code: 'ASSET_NOT_SETTLEABLE',
        message:
          `Payment to ${p.recipientAddress.slice(0, 8)}… is denominated in ` +
          `${p.assetCode}, but this deployment now settles ${asset.code}. ` +
          'An escrow holds one asset, so this batch cannot settle as it stands.',
      });
    }
    // The contract enforces hours * rate == amount and refuses anything else, so
    // a drifted row would fund custody that can never be released.
    if (p.hours * p.rateBaseUnits !== p.amountBaseUnits) {
      errors.push({
        field: 'amount',
        code: 'HOURS_RATE_MISMATCH',
        message:
          `Payment to ${p.recipientAddress.slice(0, 8)}… has an amount of ` +
          `${formatAmount(p.amountBaseUnits, p.assetDecimals)} but ${p.hours} hours ` +
          `at ${formatAmount(p.rateBaseUnits, p.assetDecimals)} is ` +
          `${formatAmount(p.hours * p.rateBaseUnits, p.assetDecimals)}.`,
      });
    }
    if (p.amountBaseUnits <= 0n) {
      errors.push({
        field: 'amount',
        code: 'AMOUNT_NOT_POSITIVE',
        message: `Payment to ${p.recipientAddress.slice(0, 8)}… has a non-positive amount.`,
      });
    }
  }

  if (asset.contractId === null) {
    errors.push({
      field: 'asset',
      code: 'SETTLEMENT_ASSET_UNCONFIGURED',
      message:
        `No Stellar Asset Contract is configured for ${asset.code}, so this batch ` +
        'cannot be funded yet. CoreFlow will not infer a contract address from an ' +
        'asset symbol.',
    });
  }

  return {
    valid: errors.length === 0,
    batch: { id: batch.id, reference: batch.reference, paymentCount: batch.payments.length },
    errors,
    asset: { code: asset.code, contractId: asset.contractId, configured: asset.contractId !== null },
  };
}

// ---------------------------------------------------------------------------
// Batch approval
// ---------------------------------------------------------------------------

/** States in which a payment is still waiting for an off-chain approval decision. */
const APPROVABLE_STATES: readonly PaymentState[] = [
  PaymentState.AWAITING_MANAGER,
  PaymentState.AWAITING_FINANCE,
  PaymentState.ORACLE_VERIFIED,
  PaymentState.DRAFT,
];

export interface BatchApprovalOutcome {
  batchId: string;
  /** Which half of the gate the caller exercised, derived from membership. */
  approvalRole: OrgRole;
  recorded: number;
  alreadyRecorded: number;
  failed: number;
  results: {
    paymentId: string;
    ok: boolean;
    recorded: boolean;
    state: PaymentState;
    stateLabel: string;
    message?: string;
    code?: string;
  }[];
  /** True only when this caller's half is now present on every payment. */
  completeForRole: boolean;
}

/**
 * Record the caller's approval across a batch.
 *
 * Fans out to `approvePayment` per payment rather than reimplementing approval,
 * so separation of duties, duplicate detection and the audit trail all come from
 * the one implementation that is already tested.
 *
 * Per-payment outcomes are reported individually and a failure on one payment does
 * not abort the rest. "11 approved, 1 needs attention" is the normal result of a
 * real batch, and collapsing it into a single success or failure would either hide
 * the exception or discard eleven valid approvals.
 */
export async function approveBatch(
  db: any,
  ctx: TenantContext,
  batch: { id: string; payments: { id: string; state: PaymentState }[] },
  opts: { paymentIds?: string[]; reason?: string; idempotencyKey?: string } = {},
): Promise<BatchApprovalOutcome> {
  // Restrict to the named payments where given, intersected with the batch. A
  // payment id from another batch or tenant simply is not in this list, so it
  // cannot be reached by naming it.
  const named = opts.paymentIds ? new Set(opts.paymentIds) : null;
  const candidates = batch.payments.filter(
    (p) => (named === null || named.has(p.id)) && APPROVABLE_STATES.includes(p.state),
  );

  if (named !== null) {
    const missing = [...named].filter((id) => !batch.payments.some((p) => p.id === id));
    if (missing.length > 0) {
      throw new ApiError(
        404,
        'NOT_FOUND',
        'One or more of the named payments is not part of this batch.',
      );
    }
  }

  if (candidates.length === 0) {
    throw new ApiError(
      409,
      'STATE_CONFLICT',
      'No payment in this batch is awaiting an approval decision.',
    );
  }

  const results: BatchApprovalOutcome['results'] = [];
  let recorded = 0;
  let alreadyRecorded = 0;
  let failed = 0;
  let approvalRole: OrgRole | null = null;

  for (const payment of candidates) {
    const result = await approvePayment({
      db,
      membership: ctx,
      paymentId: payment.id,
      reason: opts.reason,
      // Scoped per payment, so one batch-level key cannot collapse twelve
      // distinct approvals into one recorded decision.
      idempotencyKey: opts.idempotencyKey ? `${opts.idempotencyKey}:${payment.id}` : undefined,
    });

    if (result.ok) {
      const changed = result.body.changed !== false || result.status === 201;
      const isNew = result.status === 201;
      if (isNew) recorded++;
      else alreadyRecorded++;
      if (typeof result.body.approvalRole === 'string') {
        approvalRole = result.body.approvalRole as OrgRole;
      }
      const state = (result.body.state as PaymentState) ?? payment.state;
      results.push({
        paymentId: payment.id,
        ok: true,
        recorded: isNew,
        state,
        stateLabel: describeState(state).label,
        ...(changed || isNew ? {} : { message: result.body.note as string }),
        ...(isNew ? {} : { message: (result.body.note as string) ?? 'Already recorded.' }),
      });
    } else {
      failed++;
      results.push({
        paymentId: payment.id,
        ok: false,
        recorded: false,
        state: payment.state,
        stateLabel: describeState(payment.state).label,
        message: result.message,
        ...(result.code ? { code: result.code } : {}),
      });
    }
  }

  return {
    batchId: batch.id,
    approvalRole: approvalRole ?? inferRole(ctx.role),
    recorded,
    alreadyRecorded,
    failed,
    results,
    completeForRole: failed === 0,
  };
}

/**
 * Which half of the gate a role exercises, for reporting only.
 *
 * The authoritative decision is `approvePayment`'s; this is the fallback used when
 * every payment was already recorded and no action returned a role.
 */
function inferRole(role: OrgRole): OrgRole {
  return role === OrgRole.FINANCE ? OrgRole.FINANCE : OrgRole.MANAGER;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/**
 * Audit events for a batch, newest last, as the activity timeline.
 *
 * Rendered from real `AuditEvent` rows and nothing else. The timeline will look
 * sparse early in a batch's life — created, funded, approved — and that is correct.
 * Padding it with plausible-sounding entries nobody recorded would make the one
 * screen whose job is to show what actually happened the least trustworthy in the
 * product.
 */
export function presentActivity(events: readonly any[]) {
  return events.map((e) => ({
    id: e.id,
    type: e.type,
    at: e.createdAt?.toISOString() ?? null,
    actor: e.actorAddress
      ? { kind: 'user' as const, address: e.actorAddress }
      : e.actorSystem
        ? { kind: 'system' as const, system: e.actorSystem }
        : null,
    previousState: e.previousState ?? null,
    newState: e.newState ?? null,
    txHash: e.txHash ?? null,
    paymentId: e.paymentId ?? null,
    // Metadata is operator-facing detail, already free of secrets by construction:
    // every writer passes explicit fields, never a whole request or config object.
    metadata: (e.metadata ?? null) as Record<string, unknown> | null,
  }));
}

/** Open reconciliation findings for a batch's payments. */
export function presentFindings(findings: readonly any[]) {
  return findings.map((f) => ({
    id: f.id,
    kind: f.kind,
    severity: f.severity,
    status: f.status,
    detail: f.detail,
    paymentId: f.paymentId ?? null,
    firstDetectedAt: f.detectedAt?.toISOString() ?? null,
    lastObservedAt: f.lastObservedAt?.toISOString() ?? null,
    observationCount: f.observationCount ?? null,
    remediation: f.remediation ?? null,
  }));
}

/** Shape a batch for the detail view, including its derived standing. */
export function presentBatch(batch: any) {
  const payments: any[] = batch.payments ?? [];
  const decimals = payments[0]?.assetDecimals ?? SAC_DECIMALS;
  // The batch's standing is DERIVED from its payments on every read. There is no
  // stored status column, because a stored rollup is a second copy of mutable
  // truth and will eventually disagree with the payments it claims to summarize.
  const rollup = rollupBatch(payments);
  const totalBaseUnits = rollup.totalAmountBaseUnits;

  return {
    id: batch.id,
    reference: batch.reference,
    projectId: batch.projectId ?? null,
    periodStart: batch.periodStart?.toISOString() ?? null,
    periodEnd: batch.periodEnd?.toISOString() ?? null,
    createdAt: batch.createdAt?.toISOString() ?? null,
    source: {
      filename: batch.sourceFilename ?? null,
      rowsSeen: batch.sourceRowCount ?? null,
      checksum: batch.sourceChecksum ?? null,
      uploadedBy: batch.uploadedBy ?? null,
    },
    total: formatAmountWithSeparators(totalBaseUnits, decimals),
    totalBaseUnits: totalBaseUnits.toString(),
    asset: payments[0]?.assetCode ?? null,
    paymentCount: payments.length,
    standing: {
      headline: rollup.headline,
      byState: rollup.byState,
      needsAttention: rollup.needsAttention,
      // Exact, as strings: JSON has no bigint, and a Number would reintroduce
      // the rounding this codebase refuses everywhere else.
      totalAmountBaseUnits: rollup.totalAmountBaseUnits.toString(),
      paidAmountBaseUnits: rollup.paidAmountBaseUnits.toString(),
      paid: formatAmountWithSeparators(rollup.paidAmountBaseUnits, decimals),
    },
    payments: payments.map((p: any) => {
      const d = describeState(p.state);
      return {
        id: p.id,
        recipient: p.recipientAddress,
        amount: formatAmountWithSeparators(p.amountBaseUnits, p.assetDecimals),
        amountBaseUnits: p.amountBaseUnits.toString(),
        // Formatted server-side for the same reason the amount is: a rate rendered
        // from base units in the browser either reads as 250000000 or requires the
        // browser to divide, and neither belongs on a payroll screen.
        rate: formatAmountWithSeparators(p.rateBaseUnits, p.assetDecimals),
        rateBaseUnits: p.rateBaseUnits.toString(),
        hours: p.hours.toString(),
        asset: p.assetCode,
        state: p.state,
        stateLabel: d.label,
        tone: d.tone,
        needsAttention: d.needsAttention,
        stateReason: p.stateReason ?? null,
        reference: p.sourceReference ?? null,
        // A transaction link is surfaced only where one can exist. Showing an
        // explorer URL for an unsubmitted payment invites the reader to believe
        // something settled.
        transactionHash: d.mayHaveTransaction ? (p.settlementTxHash ?? null) : null,
        settledAt: p.settledAt?.toISOString() ?? null,
        onChainPaymentIndex: p.onChainPaymentIndex ?? null,
        approvals: (p.approvals ?? []).map((a: any) => ({
          role: a.role,
          decision: a.decision,
          actorAddress: a.actorAddress,
          createdAt: a.createdAt?.toISOString() ?? null,
        })),
      };
    }),
  };
}
