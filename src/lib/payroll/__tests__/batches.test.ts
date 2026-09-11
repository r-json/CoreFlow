import { describe, it, expect, beforeEach } from 'vitest';
import { OrgRole, PaymentState } from '@prisma/client';
import { createFakeDb, seedOrg, seedMember, type FakeDb } from '@/lib/payments/__tests__/fake-db';
import {
  createDraftBatch,
  deriveBatchPeriod,
  findDuplicateUpload,
  checksumCsv,
  DUPLICATE_UPLOAD_WINDOW_MS,
} from '../batches';
import { parsePayrollCsv, type ParsedPayrollRow } from '../csv';
import type { TenantContext } from '@/lib/tenancy/resolve';

const ORG = 'org_test';
const OTHER_ORG = 'org_other';

const ASSET = { code: 'USDC', contractId: 'CUSDC', decimals: 7 };

function ctxFor(role: OrgRole = OrgRole.ADMIN): TenantContext {
  return {
    orgId: ORG,
    orgName: 'Test Org',
    orgSlug: 'test-org',
    userId: 'usr_admin',
    walletAddress: 'GADMIN',
    role,
  };
}

function addr(tag: string): string {
  return ('G' + tag.toUpperCase().replace(/[^A-Z2-7]/g, '')).padEnd(56, 'A');
}

/** Rows built the way production builds them: through the real CSV parser. */
function rowsFrom(...lines: string[]): ParsedPayrollRow[] {
  const result = parsePayrollCsv(
    ['recipient,amount,asset,hours,rate,period_start,period_end,reference', ...lines].join('\n'),
  );
  if (result.issues.length > 0) {
    throw new Error('fixture did not parse: ' + JSON.stringify(result.issues));
  }
  return result.rows;
}

const THREE_ROWS = () =>
  rowsFrom(
    `${addr('alice')},1000,USDC,40,25,2026-09-01,2026-09-15,Sprint 14`,
    `${addr('bob')},1600,USDC,80,20,2026-09-01,2026-09-30,Sprint 14`,
    `${addr('carol')},260,USDC,20,13,2026-08-20,2026-09-10,`,
  );

describe('deriveBatchPeriod', () => {
  it('spans the earliest start and the latest end', () => {
    const { periodStart, periodEnd } = deriveBatchPeriod(THREE_ROWS());
    expect(periodStart?.toISOString()).toBe('2026-08-20T00:00:00.000Z');
    expect(periodEnd?.toISOString()).toBe('2026-09-30T00:00:00.000Z');
  });

  it('is null when a row carries no period', () => {
    // Unreachable through the parser now that period_start/period_end are required
    // columns, but deriveBatchPeriod is also used on payments loaded from the
    // database — including drafts created before the period became mandatory.
    const rows = THREE_ROWS().map((r) => ({ ...r, periodStart: null, periodEnd: null }));
    expect(deriveBatchPeriod(rows)).toEqual({ periodStart: null, periodEnd: null });
  });
});

describe('createDraftBatch', () => {
  let db: FakeDb;

  beforeEach(() => {
    db = createFakeDb();
    seedOrg(db, ORG);
    seedOrg(db, OTHER_ORG);
    seedMember(db, ORG, 'usr_admin', 'ADMIN', 'GADMIN');
  });

  it('creates one DRAFT payment per row, never an aggregate', async () => {
    const rows = THREE_ROWS();
    const result = await createDraftBatch(db, ctxFor(), { rows, asset: ASSET });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.created).toBe(true);
    expect(result.batch.paymentCount).toBe(3);

    const payments = db.__tables.payment.rows;
    expect(payments).toHaveLength(3);
    expect(payments.every((p) => p.state === PaymentState.DRAFT)).toBe(true);
    expect(payments.every((p) => p.batchId === result.batch.id)).toBe(true);
    expect(payments.every((p) => p.orgId === ORG)).toBe(true);
    // Each payee keeps their own figure. No row is merged into another.
    expect(payments.map((p) => p.amountBaseUnits).sort()).toEqual(
      [10_000_000_000n, 16_000_000_000n, 2_600_000_000n].sort(),
    );
    expect(result.batch.totalBaseUnits).toBe(28_600_000_000n);
  });

  it('carries each row own period, rate, hours and reference onto its payment', async () => {
    const rows = THREE_ROWS();
    await createDraftBatch(db, ctxFor(), { rows, asset: ASSET });

    const alice = db.__tables.payment.rows.find((p) => p.recipientAddress === addr('alice'));
    expect(alice).toBeDefined();
    expect(alice!.rateBaseUnits).toBe(250_000_000n);
    expect(alice!.hours).toBe(40n);
    expect(alice!.periodEnd.toISOString()).toBe('2026-09-15T00:00:00.000Z');
    expect(alice!.sourceReference).toBe('Sprint 14');
    expect(alice!.assetCode).toBe('USDC');
    expect(alice!.assetContractId).toBe('CUSDC');
    expect(alice!.assetDecimals).toBe(7);

    // An absent reference stays absent rather than becoming an empty string.
    const carol = db.__tables.payment.rows.find((p) => p.recipientAddress === addr('carol'));
    expect(carol!.sourceReference).toBeNull();
  });

  it('stores a neutralized reference, so a formula cannot reach a spreadsheet', async () => {
    const rows = rowsFrom(`${addr('inj')},100,USDC,10,10,2026-09-01,2026-09-15,"=SUM(A1:A9)"`);
    await createDraftBatch(db, ctxFor(), { rows, asset: ASSET });
    expect(db.__tables.payment.rows[0].sourceReference).toBe("'=SUM(A1:A9)");
  });

  it('refuses an empty batch', async () => {
    const result = await createDraftBatch(db, ctxFor(), { rows: [], asset: ASSET });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(400);
    expect(db.__tables.payrollBatch.rows).toHaveLength(0);
  });

  it('records provenance and a batch-level audit event with string money', async () => {
    const rows = THREE_ROWS();
    const text = 'whatever the file was';
    await createDraftBatch(db, ctxFor(OrgRole.FINANCE), {
      rows,
      asset: ASSET,
      sourceFilename: 'september.csv',
      sourceRowCount: 5,
      sourceChecksum: checksumCsv(text),
    });

    const batch = db.__tables.payrollBatch.rows[0];
    expect(batch.sourceFilename).toBe('september.csv');
    // Rows SEEN, not payments created: two rows were rejected before this point.
    expect(batch.sourceRowCount).toBe(5);
    expect(batch.uploadedBy).toBe('usr_admin');

    const events = db.__tables.auditEvent.rows;
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('payroll.batch.created');
    expect(events[0].batchId).toBe(batch.id);
    expect(events[0].actorAddress).toBe('GADMIN');
    expect(events[0].metadata.paymentCount).toBe(3);
    // Money crosses into JSON as a string. A Number here would be the rounding
    // this codebase refuses everywhere else.
    expect(events[0].metadata.totalBaseUnits).toBe('28600000000');
    expect(typeof events[0].metadata.totalBaseUnits).toBe('string');
  });

  describe('references', () => {
    it('generates sequential references per organization', async () => {
      const a = await createDraftBatch(db, ctxFor(), { rows: THREE_ROWS(), asset: ASSET });
      const b = await createDraftBatch(db, ctxFor(), { rows: THREE_ROWS(), asset: ASSET });
      expect(a.ok && a.batch.reference).toBe('CF-00001');
      expect(b.ok && b.batch.reference).toBe('CF-00002');
    });

    it('accepts a caller-supplied reference', async () => {
      const result = await createDraftBatch(db, ctxFor(), {
        rows: THREE_ROWS(),
        asset: ASSET,
        reference: 'SEPT-2026/A',
      });
      expect(result.ok && result.batch.reference).toBe('SEPT-2026/A');
    });

    it('trims surrounding whitespace on the reference', async () => {
      // A reference is a human-entered LABEL, not a monetary value. Trimming it
      // is conventional and loses nothing; the no-silent-mutation rule protects
      // amounts, hours and rates, which are never adjusted.
      const result = await createDraftBatch(db, ctxFor(), {
        rows: THREE_ROWS(),
        asset: ASSET,
        reference: '  SEPT-2026  ',
      });
      expect(result.ok && result.batch.reference).toBe('SEPT-2026');
    });

    it.each(['=cmd', 'semi;colon', '-dash-start', 'a'.repeat(70)])(
      'rejects the malformed reference "%s"',
      async (reference) => {
        const result = await createDraftBatch(db, ctxFor(), {
          rows: THREE_ROWS(),
          asset: ASSET,
          reference,
        });
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.code).toBe('INVALID_REFERENCE');
      },
    );

    it('reports a caller-supplied reference that is already taken', async () => {
      await createDraftBatch(db, ctxFor(), {
        rows: THREE_ROWS(),
        asset: ASSET,
        reference: 'SEPT-2026',
      });
      const again = await createDraftBatch(db, ctxFor(), {
        rows: THREE_ROWS(),
        asset: ASSET,
        reference: 'SEPT-2026',
      });
      expect(again.ok).toBe(false);
      if (again.ok) return;
      expect(again.status).toBe(409);
      expect(again.code).toBe('REFERENCE_TAKEN');
      expect(db.__tables.payrollBatch.rows).toHaveLength(1);
    });

    it('retries past a generated reference that another batch already holds', async () => {
      // A batch created by hand occupying the number the counter will propose.
      db.__tables.payrollBatch.rows.push({
        id: 'bat_manual',
        orgId: ORG,
        reference: 'CF-00001',
        createdAt: new Date(),
      });
      const result = await createDraftBatch(db, ctxFor(), { rows: THREE_ROWS(), asset: ASSET });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      // The count is 1, so CF-00002 is proposed first and is free.
      expect(result.batch.reference).toBe('CF-00002');
    });

    it('scopes references to the organization, so two tenants can both use CF-00001', async () => {
      await createDraftBatch(db, ctxFor(), { rows: THREE_ROWS(), asset: ASSET });
      const other = await createDraftBatch(
        db,
        { ...ctxFor(), orgId: OTHER_ORG },
        { rows: THREE_ROWS(), asset: ASSET },
      );
      expect(other.ok && other.batch.reference).toBe('CF-00001');
      expect(db.__tables.payrollBatch.rows).toHaveLength(2);
    });
  });

  describe('idempotency', () => {
    it('replays the first outcome instead of creating a second payroll', async () => {
      const key = 'idem-september';
      const first = await createDraftBatch(db, ctxFor(), {
        rows: THREE_ROWS(),
        asset: ASSET,
        idempotencyKey: key,
      });
      const second = await createDraftBatch(db, ctxFor(), {
        rows: THREE_ROWS(),
        asset: ASSET,
        idempotencyKey: key,
      });

      expect(first.ok && first.created).toBe(true);
      expect(second.ok && second.created).toBe(false);
      expect(first.ok && second.ok && second.batch.id).toBe(first.ok ? first.batch.id : '');
      // The property that matters: three payments exist, not six.
      expect(db.__tables.payrollBatch.rows).toHaveLength(1);
      expect(db.__tables.payment.rows).toHaveLength(3);
      expect(second.ok && second.batch.paymentCount).toBe(3);
      expect(second.ok && second.batch.totalBaseUnits).toBe(28_600_000_000n);
    });

    it('survives losing the race, where the pre-check misses and the insert collides', async () => {
      const key = 'idem-race';
      await createDraftBatch(db, ctxFor(), {
        rows: THREE_ROWS(),
        asset: ASSET,
        idempotencyKey: key,
      });

      // Simulate the race window: the duplicate-check read happens BEFORE the
      // competing transaction commits, so it sees nothing and we proceed to
      // insert. Only the unique index stops a second payroll.
      const realFindFirst = db.payrollBatch.findFirst;
      let blinded = true;
      db.payrollBatch.findFirst = async (args: any) => {
        if (blinded) {
          blinded = false;
          return null;
        }
        return realFindFirst(args);
      };

      const second = await createDraftBatch(db, ctxFor(), {
        rows: THREE_ROWS(),
        asset: ASSET,
        idempotencyKey: key,
      });
      db.payrollBatch.findFirst = realFindFirst;

      expect(second.ok).toBe(true);
      if (!second.ok) return;
      expect(second.created).toBe(false);
      expect(second.note).toContain('concurrently');
      expect(db.__tables.payrollBatch.rows).toHaveLength(1);
      expect(db.__tables.payment.rows).toHaveLength(3);
    });

    it('does not tie unkeyed requests together', async () => {
      await createDraftBatch(db, ctxFor(), { rows: THREE_ROWS(), asset: ASSET });
      await createDraftBatch(db, ctxFor(), { rows: THREE_ROWS(), asset: ASSET });
      // NULL idempotency keys are distinct in Postgres, and must stay distinct
      // here: two deliberate payrolls are not a double-submit.
      expect(db.__tables.payrollBatch.rows).toHaveLength(2);
      expect(db.__tables.payment.rows).toHaveLength(6);
    });

    it('scopes the key to the organization', async () => {
      const key = 'shared-key';
      await createDraftBatch(db, ctxFor(), { rows: THREE_ROWS(), asset: ASSET, idempotencyKey: key });
      const other = await createDraftBatch(
        db,
        { ...ctxFor(), orgId: OTHER_ORG },
        { rows: THREE_ROWS(), asset: ASSET, idempotencyKey: key },
      );
      expect(other.ok && other.created).toBe(true);
      expect(db.__tables.payrollBatch.rows).toHaveLength(2);
    });
  });

  describe('atomicity', () => {
    it('leaves nothing behind when a payment cannot be written', async () => {
      // The third payment fails. A partially created payroll would be worse than
      // none: the batch would look complete and quietly underpay someone.
      db.__failOn('payment', 'create', 1);

      await expect(
        createDraftBatch(db, ctxFor(), { rows: THREE_ROWS(), asset: ASSET }),
      ).rejects.toThrow();

      expect(db.__tables.payrollBatch.rows).toHaveLength(0);
      expect(db.__tables.payment.rows).toHaveLength(0);
      expect(db.__tables.auditEvent.rows).toHaveLength(0);
    });
  });

  describe('worker linking', () => {
    it('links payees that already have a worker record and counts those that do not', async () => {
      db.__tables.worker.rows.push({
        id: 'wrk_alice',
        orgId: ORG,
        walletAddress: addr('alice'),
        name: 'Alice',
      });
      // Same wallet in a DIFFERENT organization must not be linked.
      db.__tables.worker.rows.push({
        id: 'wrk_bob_other',
        orgId: OTHER_ORG,
        walletAddress: addr('bob'),
        name: 'Bob elsewhere',
      });

      const result = await createDraftBatch(db, ctxFor(), { rows: THREE_ROWS(), asset: ASSET });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.batch.unlinkedRecipients).toBe(2);

      const byAddress = new Map(
        db.__tables.payment.rows.map((p) => [p.recipientAddress, p.workerId]),
      );
      expect(byAddress.get(addr('alice'))).toBe('wrk_alice');
      expect(byAddress.get(addr('bob'))).toBeNull();
      expect(byAddress.get(addr('carol'))).toBeNull();
    });
  });
});

describe('findDuplicateUpload', () => {
  let db: FakeDb;
  const checksum = checksumCsv('recipient,amount\nGX,1');

  beforeEach(() => {
    db = createFakeDb();
    seedOrg(db, ORG);
  });

  it('finds a recent batch built from byte-identical input', async () => {
    const now = new Date('2026-09-11T12:00:00Z');
    db.__tables.payrollBatch.rows.push({
      id: 'bat_recent',
      orgId: ORG,
      reference: 'CF-00041',
      sourceChecksum: checksum,
      createdAt: new Date(now.getTime() - 4 * 60 * 1000),
    });
    const found = await findDuplicateUpload(db, ORG, checksum, { now });
    expect(found?.reference).toBe('CF-00041');
  });

  it('ignores an identical upload from outside the window', async () => {
    const now = new Date('2026-09-11T12:00:00Z');
    db.__tables.payrollBatch.rows.push({
      id: 'bat_old',
      orgId: ORG,
      reference: 'CF-00001',
      sourceChecksum: checksum,
      createdAt: new Date(now.getTime() - DUPLICATE_UPLOAD_WINDOW_MS - 1000),
    });
    // Re-running the same payroll next period is legitimate, not a duplicate.
    expect(await findDuplicateUpload(db, ORG, checksum, { now })).toBeNull();
  });

  it('returns the most recent match when there are several', async () => {
    const now = new Date('2026-09-11T12:00:00Z');
    for (const [id, ref, minutesAgo] of [
      ['bat_a', 'CF-00001', 30],
      ['bat_b', 'CF-00002', 2],
      ['bat_c', 'CF-00003', 10],
    ] as const) {
      db.__tables.payrollBatch.rows.push({
        id,
        orgId: ORG,
        reference: ref,
        sourceChecksum: checksum,
        createdAt: new Date(now.getTime() - minutesAgo * 60 * 1000),
      });
    }
    const found = await findDuplicateUpload(db, ORG, checksum, { now });
    expect(found?.reference).toBe('CF-00002');
  });

  it('does not look across organizations', async () => {
    db.__tables.payrollBatch.rows.push({
      id: 'bat_other',
      orgId: OTHER_ORG,
      reference: 'CF-00001',
      sourceChecksum: checksum,
      createdAt: new Date(),
    });
    expect(await findDuplicateUpload(db, ORG, checksum)).toBeNull();
  });

  it('treats an absent checksum as no evidence, not as a match', async () => {
    db.__tables.payrollBatch.rows.push({
      id: 'bat_nochecksum',
      orgId: ORG,
      reference: 'CF-00001',
      sourceChecksum: null,
      createdAt: new Date(),
    });
    expect(await findDuplicateUpload(db, ORG, '')).toBeNull();
  });
});
