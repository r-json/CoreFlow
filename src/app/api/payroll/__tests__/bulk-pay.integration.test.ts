/**
 * Bulk Pay against real PostgreSQL.
 *
 * The same route handlers the unit suite exercises, but with the real Prisma client
 * and a real database: composite foreign keys, unique indexes, bigint columns and
 * genuine transaction isolation.
 *
 * Only authentication is substituted. Wallet challenge/signature verification has
 * its own tests and cannot be performed headlessly; everything downstream of the
 * authenticated identity — membership, role, permission, tenant scope — is resolved
 * from this database on every request, exactly as in production.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { OrgRole, PaymentState, ApprovalDecision } from '@prisma/client';

vi.mock('@/lib/auth', () => ({ getUserFromRequest: vi.fn() }));

import prisma from '@/lib/db/prisma';
import { getUserFromRequest } from '@/lib/auth';
import { __resetRateLimiter } from '@/lib/ratelimit';
import { POST as createBatchRoute, GET as listBatchesRoute } from '../batches/route';
import { POST as validateCsvRoute } from '../batches/validate/route';
import { GET as getBatchRoute } from '../batches/[id]/route';
import { POST as revalidateRoute } from '../batches/[id]/validate/route';
import { POST as approveBatchRoute } from '../batches/[id]/approve/route';
import {
  assertLocalDatabase,
  resetDatabase,
  seedOrganization,
  seedWorker,
  payeeWallet,
  payrollCsv,
  type SeededOrg,
} from '@/lib/db/__tests__/helpers';

assertLocalDatabase();

const mockUser = getUserFromRequest as unknown as ReturnType<typeof vi.fn>;
const URL_BATCHES = 'https://app.test/api/payroll/batches';

let orgA: SeededOrg;
let orgB: SeededOrg;

/** Three contractors whose rows satisfy hours x rate == amount exactly. */
const THREE_CONTRACTORS = payrollCsv([
  { tag: 'alice', amount: '1000', hours: 40, rate: '25' },
  { tag: 'bob', amount: '1600', hours: 80, rate: '20' },
  { tag: 'carol', amount: '260', hours: 20, rate: '13' },
]);
const THREE_TOTAL = 28_600_000_000n; // 2,860.00 USDC in base units

function signedInAs(org: SeededOrg, role: OrgRole) {
  const m = org.members[role];
  mockUser.mockResolvedValue({ userId: m.userId, walletAddress: m.wallet, role: 'EMPLOYEE' });
  return m;
}

function post(url: string, body: unknown, headers: Record<string, string> = {}): any {
  return new Request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

function get(url: string, headers: Record<string, string> = {}): any {
  return new Request(url, { method: 'GET', headers });
}

beforeAll(async () => {
  process.env.NEXT_PUBLIC_STELLAR_TOKEN_ID =
    'CBW2ZKFBHLHNNVCZ7JP4AXHQOOC3S6NLAMORXOAIWQNWMKUVJS743Q5M';
  process.env.NEXT_PUBLIC_SETTLEMENT_ASSET_CODE = 'USDC';
  await prisma.$connect();
});

afterAll(async () => {
  await prisma.$disconnect();
});

beforeEach(async () => {
  vi.clearAllMocks();
  __resetRateLimiter();
  await resetDatabase(prisma);
  orgA = await seedOrganization(prisma, 'orga');
  orgB = await seedOrganization(prisma, 'orgb');
});

async function createThreePaymentBatch(org: SeededOrg, headers: Record<string, string> = {}) {
  signedInAs(org, OrgRole.ADMIN);
  const res = await createBatchRoute(
    post(URL_BATCHES, { csv: THREE_CONTRACTORS, filename: 'september.csv' }, {
      'x-organization-id': org.orgId,
      ...headers,
    }),
  );
  const body = await res.json();
  return { res, body };
}

// ---------------------------------------------------------------------------
// The realistic path: CSV -> parser -> validation -> batch -> payments -> audit
// ---------------------------------------------------------------------------

describe('CSV to persisted payroll', () => {
  it('creates one PayrollBatch and exactly three Payment rows', async () => {
    const { res, body } = await createThreePaymentBatch(orgA);
    expect(res.status).toBe(201);
    expect(body.created).toBe(true);

    // Read back from the database, not from the response.
    const batches = await prisma.payrollBatch.findMany({ where: { orgId: orgA.orgId } });
    expect(batches).toHaveLength(1);
    expect(batches[0].reference).toBe('CF-00001');
    expect(batches[0].sourceFilename).toBe('september.csv');
    expect(batches[0].sourceRowCount).toBe(3);
    expect(batches[0].sourceChecksum).toMatch(/^[0-9a-f]{64}$/);

    const payments = await prisma.payment.findMany({
      where: { orgId: orgA.orgId },
      orderBy: { amountBaseUnits: 'asc' },
    });
    // Three payees, three rows. No aggregate shortcut.
    expect(payments).toHaveLength(3);
    expect(payments.every((p) => p.batchId === batches[0].id)).toBe(true);
    expect(payments.every((p) => p.state === PaymentState.DRAFT)).toBe(true);
    expect(payments.every((p) => p.orgId === orgA.orgId)).toBe(true);
  });

  it('persists exact bigint amounts, rates and hours', async () => {
    await createThreePaymentBatch(orgA);
    const payments = await prisma.payment.findMany({
      where: { orgId: orgA.orgId },
      orderBy: { amountBaseUnits: 'asc' },
    });

    expect(payments.map((p) => p.amountBaseUnits)).toEqual([
      2_600_000_000n,
      10_000_000_000n,
      16_000_000_000n,
    ]);
    expect(payments.map((p) => p.rateBaseUnits)).toEqual([
      130_000_000n,
      250_000_000n,
      200_000_000n,
    ]);
    expect(payments.map((p) => p.hours)).toEqual([20n, 40n, 80n]);

    // The contract's invariant, as actually stored.
    for (const p of payments) {
      expect(p.hours * p.rateBaseUnits).toBe(p.amountBaseUnits);
    }

    const sum = payments.reduce((a, p) => a + p.amountBaseUnits, 0n);
    expect(sum).toBe(THREE_TOTAL);
  });

  it('links a payee with an existing worker record and leaves the rest unlinked', async () => {
    const worker = await seedWorker(prisma, orgA.orgId, 'alice');
    const { body } = await createThreePaymentBatch(orgA);
    expect(body.batch.unlinkedRecipients).toBe(2);

    const linked = await prisma.payment.findFirstOrThrow({
      where: { orgId: orgA.orgId, recipientAddress: worker.walletAddress },
      select: { workerId: true },
    });
    expect(linked.workerId).toBe(worker.id);

    const unlinked = await prisma.payment.count({
      where: { orgId: orgA.orgId, workerId: null },
    });
    expect(unlinked).toBe(2);
  });

  it('writes one batch-level audit event carrying money as a string', async () => {
    await createThreePaymentBatch(orgA);
    const events = await prisma.auditEvent.findMany({ where: { orgId: orgA.orgId } });
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('payroll.batch.created');
    const meta = events[0].metadata as any;
    expect(meta.paymentCount).toBe(3);
    expect(meta.totalBaseUnits).toBe(THREE_TOTAL.toString());
    expect(typeof meta.totalBaseUnits).toBe('string');
  });

  it('stores a neutralized reference so a formula cannot reach a spreadsheet', async () => {
    signedInAs(orgA, OrgRole.ADMIN);
    const csv = [
      'recipient,amount,asset,hours,rate,period_start,period_end,reference',
      `${payeeWallet('inj')},100,USDC,10,10,2026-09-01,2026-09-15,"=HYPERLINK(""http://evil"",""click"")"`,
    ].join('\n');
    await createBatchRoute(post(URL_BATCHES, { csv }, { 'x-organization-id': orgA.orgId }));

    const payment = await prisma.payment.findFirstOrThrow({
      where: { orgId: orgA.orgId },
      select: { sourceReference: true },
    });
    expect(payment.sourceReference?.startsWith("'=")).toBe(true);
  });

  it('writes nothing at all for an invalid file', async () => {
    signedInAs(orgA, OrgRole.ADMIN);
    const csv = payrollCsv([{ tag: 'bad', amount: '1000', hours: 40, rate: '20' }]);
    const res = await createBatchRoute(
      post(URL_BATCHES, { csv }, { 'x-organization-id': orgA.orgId }),
    );
    expect(res.status).toBe(422);
    expect((await res.json()).details.errors[0].code).toBe('HOURS_RATE_MISMATCH');

    expect(await prisma.payrollBatch.count()).toBe(0);
    expect(await prisma.payment.count()).toBe(0);
    expect(await prisma.auditEvent.count()).toBe(0);
  });

  it('validates without writing, repeatedly', async () => {
    signedInAs(orgA, OrgRole.ADMIN);
    for (let i = 0; i < 3; i++) {
      const res = await validateCsvRoute(
        post(`${URL_BATCHES}/validate`, { csv: THREE_CONTRACTORS }, {
          'x-organization-id': orgA.orgId,
        }),
      );
      expect(res.status).toBe(200);
      expect((await res.json()).valid).toBe(true);
    }
    expect(await prisma.payrollBatch.count()).toBe(0);
    expect(await prisma.payment.count()).toBe(0);
    expect(await prisma.auditEvent.count()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Transactional integrity (item 9)
// ---------------------------------------------------------------------------

describe('Transactional integrity', () => {
  it('leaves zero partial records when a payment write fails mid-batch', async () => {
    signedInAs(orgA, OrgRole.ADMIN);
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

    // The fault is injected INSIDE the real transaction, so PostgreSQL performs the
    // rollback. Spying on `prisma.payment.create` would not work: the service writes
    // through the transaction client, which is a different object — and a test that
    // quietly intercepted nothing would have reported success.
    const realTransaction = prisma.$transaction.bind(prisma);
    const txSpy = vi.spyOn(prisma, '$transaction').mockImplementation(((fn: any, opts: any) =>
      realTransaction(async (tx: any) => {
        let writes = 0;
        const proxied = new Proxy(tx, {
          get(target: any, prop: string | symbol) {
            if (prop !== 'payment') return target[prop];
            return {
              create: (args: any) => {
                writes += 1;
                // Fail the THIRD row, so the batch and two payments are already
                // written inside the transaction when it breaks.
                if (writes === 3) return Promise.reject(new Error('simulated failure on row 3'));
                return target.payment.create(args);
              },
            };
          },
        });
        return fn(proxied);
      }, opts)) as any);

    const res = await createBatchRoute(
      post(URL_BATCHES, { csv: THREE_CONTRACTORS }, { 'x-organization-id': orgA.orgId }),
    );
    txSpy.mockRestore();

    expect(res.status).toBe(500);
    // The client learns nothing about why.
    const body = JSON.stringify(await res.json());
    expect(body).not.toContain('simulated');
    expect(body).not.toContain('payment');

    // Real PostgreSQL rollback. A batch that looked complete while missing its third
    // payment would quietly underpay a contractor.
    expect(await prisma.payrollBatch.count()).toBe(0);
    expect(await prisma.payment.count()).toBe(0);
    expect(await prisma.auditEvent.count()).toBe(0);

    spy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// Concurrency and idempotency (items 5C, 5D, 10)
// ---------------------------------------------------------------------------

describe('Idempotency against the real unique index', () => {
  const KEY = 'integration-key-september';

  it('C. three concurrent identical requests produce exactly one batch', async () => {
    signedInAs(orgA, OrgRole.ADMIN);
    const headers = { 'x-organization-id': orgA.orgId, 'idempotency-key': KEY };

    const responses = await Promise.all([
      createBatchRoute(post(URL_BATCHES, { csv: THREE_CONTRACTORS }, headers)),
      createBatchRoute(post(URL_BATCHES, { csv: THREE_CONTRACTORS }, headers)),
      createBatchRoute(post(URL_BATCHES, { csv: THREE_CONTRACTORS }, headers)),
    ]);
    const bodies = await Promise.all(responses.map((r) => r.json()));

    // Exactly one request created it; the rest replayed the original.
    expect(bodies.filter((b) => b.created === true)).toHaveLength(1);
    expect(bodies.filter((b) => b.created === false)).toHaveLength(2);
    expect(new Set(bodies.map((b) => b.batch.id)).size).toBe(1);

    // The database is the authority here, not the pre-check.
    expect(await prisma.payrollBatch.count()).toBe(1);
    expect(await prisma.payment.count()).toBe(3);

    // Every replay reports the same money as the original.
    for (const b of bodies) expect(b.batch.totalBaseUnits).toBe(THREE_TOTAL.toString());
  });

  it('replays a sequential retry rather than creating a second payroll', async () => {
    signedInAs(orgA, OrgRole.ADMIN);
    const headers = { 'x-organization-id': orgA.orgId, 'idempotency-key': KEY };
    const first = await createBatchRoute(post(URL_BATCHES, { csv: THREE_CONTRACTORS }, headers));
    const second = await createBatchRoute(post(URL_BATCHES, { csv: THREE_CONTRACTORS }, headers));

    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect((await second.json()).batch.id).toBe((await first.json()).batch.id);
    expect(await prisma.payment.count()).toBe(3);
  });

  it('D. refuses the same key with a different payload', async () => {
    signedInAs(orgA, OrgRole.ADMIN);
    const headers = { 'x-organization-id': orgA.orgId, 'idempotency-key': KEY };
    await createBatchRoute(post(URL_BATCHES, { csv: THREE_CONTRACTORS }, headers));

    const different = payrollCsv([{ tag: 'dave', amount: '500', hours: 25, rate: '20' }]);
    const res = await createBatchRoute(post(URL_BATCHES, { csv: different }, headers));

    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('IDEMPOTENCY_KEY_REUSED');
    // The original payroll is untouched and no second one exists.
    expect(await prisma.payrollBatch.count()).toBe(1);
    expect(await prisma.payment.count()).toBe(3);
  });

  it('keeps keys distinct per organization', async () => {
    const headers = (org: SeededOrg) => ({
      'x-organization-id': org.orgId,
      'idempotency-key': KEY,
    });
    signedInAs(orgA, OrgRole.ADMIN);
    await createBatchRoute(post(URL_BATCHES, { csv: THREE_CONTRACTORS }, headers(orgA)));
    signedInAs(orgB, OrgRole.ADMIN);
    const res = await createBatchRoute(
      post(URL_BATCHES, { csv: THREE_CONTRACTORS }, headers(orgB)),
    );
    expect(res.status).toBe(201);
    expect(await prisma.payrollBatch.count()).toBe(2);
  });

  it('allocates distinct sequential references under concurrency', async () => {
    signedInAs(orgA, OrgRole.ADMIN);
    const headers = { 'x-organization-id': orgA.orgId };
    // No idempotency key: three deliberate payrolls racing for a reference. The
    // unique index on (orgId, reference) forces the retry path to resolve them.
    const responses = await Promise.all([
      createBatchRoute(post(URL_BATCHES, { csv: THREE_CONTRACTORS }, headers)),
      createBatchRoute(post(URL_BATCHES, { csv: THREE_CONTRACTORS }, headers)),
      createBatchRoute(post(URL_BATCHES, { csv: THREE_CONTRACTORS }, headers)),
    ]);
    const ok = responses.filter((r) => r.status === 201);
    expect(ok).toHaveLength(3);

    const refs = (await prisma.payrollBatch.findMany({ select: { reference: true } })).map(
      (b) => b.reference,
    );
    expect(new Set(refs).size).toBe(3);
    expect(await prisma.payment.count()).toBe(9);
  });
});

// ---------------------------------------------------------------------------
// Approval (item 13, partial — off-chain decision only)
// ---------------------------------------------------------------------------

describe('Approval against the real database', () => {
  let batchId: string;

  beforeEach(async () => {
    const { body } = await createThreePaymentBatch(orgA);
    batchId = body.batch.id;
  });

  const approveUrl = () => `${URL_BATCHES}/${batchId}/approve`;

  it('records a manager decision per payment, with its tenant', async () => {
    const manager = signedInAs(orgA, OrgRole.MANAGER);
    const res = await approveBatchRoute(
      post(approveUrl(), {}, { 'x-organization-id': orgA.orgId }),
      { params: { id: batchId } },
    );
    expect(res.status).toBe(200);
    expect((await res.json()).recorded).toBe(3);

    const approvals = await prisma.approval.findMany({ where: { orgId: orgA.orgId } });
    expect(approvals).toHaveLength(3);
    // The composite FK requires orgId; this is the write that previously failed.
    expect(approvals.every((a) => a.orgId === orgA.orgId)).toBe(true);
    expect(approvals.every((a) => a.role === OrgRole.MANAGER)).toBe(true);
    expect(approvals.every((a) => a.decision === ApprovalDecision.APPROVED)).toBe(true);
    expect(approvals.every((a) => a.actorAddress === manager.wallet)).toBe(true);

    const audit = await prisma.auditEvent.findMany({
      where: { orgId: orgA.orgId, type: 'approval.granted' },
    });
    expect(audit).toHaveLength(3);
  });

  it('records manager and finance as two distinct decisions by two wallets', async () => {
    const manager = signedInAs(orgA, OrgRole.MANAGER);
    await approveBatchRoute(post(approveUrl(), {}, { 'x-organization-id': orgA.orgId }), {
      params: { id: batchId },
    });
    const finance = signedInAs(orgA, OrgRole.FINANCE);
    await approveBatchRoute(post(approveUrl(), {}, { 'x-organization-id': orgA.orgId }), {
      params: { id: batchId },
    });

    const approvals = await prisma.approval.findMany({ where: { orgId: orgA.orgId } });
    expect(approvals).toHaveLength(6);
    expect(new Set(approvals.map((a) => a.role))).toEqual(
      new Set([OrgRole.MANAGER, OrgRole.FINANCE]),
    );
    expect(new Set(approvals.map((a) => a.actorAddress))).toEqual(
      new Set([manager.wallet, finance.wallet]),
    );
  });

  it('is idempotent, enforced by the unique index on (paymentId, role)', async () => {
    signedInAs(orgA, OrgRole.MANAGER);
    const headers = { 'x-organization-id': orgA.orgId };
    await approveBatchRoute(post(approveUrl(), {}, headers), { params: { id: batchId } });
    const again = await approveBatchRoute(post(approveUrl(), {}, headers), {
      params: { id: batchId },
    });
    const body = await again.json();
    expect(body.recorded).toBe(0);
    expect(body.alreadyRecorded).toBe(3);
    expect(await prisma.approval.count()).toBe(3);
  });

  it('does not let one wallet satisfy both halves of the gate', async () => {
    // ADMIN holds both approval permissions, so only the approval logic stands
    // between one wallet and a fully approved payroll.
    signedInAs(orgA, OrgRole.ADMIN);
    const headers = { 'x-organization-id': orgA.orgId };
    await approveBatchRoute(post(approveUrl(), {}, headers), { params: { id: batchId } });
    await approveBatchRoute(post(approveUrl(), {}, headers), { params: { id: batchId } });

    const approvals = await prisma.approval.findMany();
    expect(approvals).toHaveLength(3);
    expect(new Set(approvals.map((a) => a.role))).toEqual(new Set([OrgRole.MANAGER]));
  });

  it('changes no payment state, amount, recipient or settlement hash', async () => {
    const before = await prisma.payment.findMany({
      where: { orgId: orgA.orgId },
      orderBy: { id: 'asc' },
      select: {
        id: true,
        state: true,
        amountBaseUnits: true,
        recipientAddress: true,
        settlementTxHash: true,
        settledAt: true,
      },
    });

    signedInAs(orgA, OrgRole.MANAGER);
    await approveBatchRoute(post(approveUrl(), {}, { 'x-organization-id': orgA.orgId }), {
      params: { id: batchId },
    });

    const after = await prisma.payment.findMany({
      where: { orgId: orgA.orgId },
      orderBy: { id: 'asc' },
      select: {
        id: true,
        state: true,
        amountBaseUnits: true,
        recipientAddress: true,
        settlementTxHash: true,
        settledAt: true,
      },
    });

    // Recording an approval is not settlement. Nothing financial moves.
    expect(after).toEqual(before);
    expect(after.every((p) => p.state === PaymentState.DRAFT)).toBe(true);
    expect(after.every((p) => p.settlementTxHash === null)).toBe(true);
  });

  it('refuses a role that cannot approve', async () => {
    signedInAs(orgA, OrgRole.VIEWER);
    const res = await approveBatchRoute(
      post(approveUrl(), {}, { 'x-organization-id': orgA.orgId }),
      { params: { id: batchId } },
    );
    expect(res.status).toBe(403);
    expect(await prisma.approval.count()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Tenant isolation (item 11)
// ---------------------------------------------------------------------------

describe('Tenant isolation through the API and the database', () => {
  let batchA: string;
  let batchB: string;

  beforeEach(async () => {
    batchA = (await createThreePaymentBatch(orgA)).body.batch.id;
    batchB = (await createThreePaymentBatch(orgB)).body.batch.id;
  });

  it('lists only the caller own batches', async () => {
    signedInAs(orgA, OrgRole.ADMIN);
    const a = await listBatchesRoute(get(URL_BATCHES, { 'x-organization-id': orgA.orgId }));
    const bodyA = await a.json();
    expect(bodyA.batches).toHaveLength(1);
    expect(bodyA.batches[0].id).toBe(batchA);

    signedInAs(orgB, OrgRole.ADMIN);
    const b = await listBatchesRoute(get(URL_BATCHES, { 'x-organization-id': orgB.orgId }));
    const bodyB = await b.json();
    expect(bodyB.batches).toHaveLength(1);
    expect(bodyB.batches[0].id).toBe(batchB);

    // Six payments exist; each organization sees three.
    expect(await prisma.payment.count()).toBe(6);
  });

  it('gives a cross-tenant batch read the same 404 as a non-existent one', async () => {
    signedInAs(orgB, OrgRole.ADMIN);
    const foreign = await getBatchRoute(
      get(`${URL_BATCHES}/${batchA}`, { 'x-organization-id': orgB.orgId }),
      { params: { id: batchA } },
    );
    const absent = await getBatchRoute(
      get(`${URL_BATCHES}/cmdoesnotexist000000000`, { 'x-organization-id': orgB.orgId }),
      { params: { id: 'cmdoesnotexist000000000' } },
    );
    expect(foreign.status).toBe(404);
    expect(absent.status).toBe(404);
    // Byte-identical, so an id cannot be probed for existence.
    expect(await foreign.json()).toEqual(await absent.json());
  });

  it('refuses to approve, re-validate or name another tenant batch', async () => {
    signedInAs(orgB, OrgRole.MANAGER);
    const approve = await approveBatchRoute(
      post(`${URL_BATCHES}/${batchA}/approve`, {}, { 'x-organization-id': orgB.orgId }),
      { params: { id: batchA } },
    );
    const revalidate = await revalidateRoute(
      post(`${URL_BATCHES}/${batchA}/validate`, {}, { 'x-organization-id': orgB.orgId }),
      { params: { id: batchA } },
    );
    expect(approve.status).toBe(404);
    expect(revalidate.status).toBe(404);
    expect(await prisma.approval.count()).toBe(0);
  });

  it('refuses to act in an organization the caller does not belong to', async () => {
    // Authenticated as an org B member, naming org A.
    signedInAs(orgB, OrgRole.ADMIN);
    const res = await createBatchRoute(
      post(URL_BATCHES, { csv: THREE_CONTRACTORS }, { 'x-organization-id': orgA.orgId }),
    );
    expect(res.status).toBe(404);
    expect(await prisma.payrollBatch.count({ where: { orgId: orgA.orgId } })).toBe(1);
  });

  it('isolates workers, projects, audit events and findings by tenant', async () => {
    await seedWorker(prisma, orgA.orgId, 'wa');
    await seedWorker(prisma, orgB.orgId, 'wb');
    await prisma.project.create({ data: { orgId: orgA.orgId, code: 'PA', name: 'A' } });
    await prisma.project.create({ data: { orgId: orgB.orgId, code: 'PB', name: 'B' } });
    const paymentA = await prisma.payment.findFirstOrThrow({
      where: { orgId: orgA.orgId },
      select: { id: true },
    });
    await prisma.reconciliationFinding.create({
      data: {
        orgId: orgA.orgId,
        paymentId: paymentA.id,
        kind: 'ASSET_MISMATCH',
        detail: 'fixture',
        severity: 'HIGH',
      },
    });

    for (const [org, other] of [
      [orgA, orgB],
      [orgB, orgA],
    ] as const) {
      const scoped = { orgId: org.orgId };
      expect(await prisma.worker.count({ where: scoped })).toBe(1);
      expect(await prisma.project.count({ where: scoped })).toBe(1);
      expect(await prisma.payment.count({ where: scoped })).toBe(3);
      // And nothing of the other tenant's leaks into the same filter.
      const workers = await prisma.worker.findMany({ where: scoped });
      expect(workers.every((w) => w.orgId !== other.orgId)).toBe(true);
    }

    expect(await prisma.reconciliationFinding.count({ where: { orgId: orgB.orgId } })).toBe(0);
    expect(await prisma.reconciliationFinding.count({ where: { orgId: orgA.orgId } })).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Reads and re-validation
// ---------------------------------------------------------------------------

describe('Batch reads', () => {
  it('derives standing from the payments on every read', async () => {
    const { body } = await createThreePaymentBatch(orgA);
    signedInAs(orgA, OrgRole.ADMIN);

    const res = await getBatchRoute(
      get(`${URL_BATCHES}/${body.batch.id}`, { 'x-organization-id': orgA.orgId }),
      { params: { id: body.batch.id } },
    );
    const { batch } = await res.json();

    expect(batch.paymentCount).toBe(3);
    expect(batch.standing.totalAmountBaseUnits).toBe(THREE_TOTAL.toString());
    expect(batch.standing.paidAmountBaseUnits).toBe('0');
    expect(batch.payments.every((p: any) => p.transactionHash === null)).toBe(true);

    // There is no stored status column for the standing to drift from.
    const columns = await prisma.$queryRawUnsafe<{ column_name: string }[]>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'PayrollBatch' AND column_name IN ('status','state')`,
    );
    expect(columns).toHaveLength(0);
  });

  it('reports a draft whose asset is no longer settleable', async () => {
    const { body } = await createThreePaymentBatch(orgA);
    signedInAs(orgA, OrgRole.ADMIN);
    process.env.NEXT_PUBLIC_SETTLEMENT_ASSET_CODE = 'EURC';
    try {
      const res = await revalidateRoute(
        post(`${URL_BATCHES}/${body.batch.id}/validate`, {}, {
          'x-organization-id': orgA.orgId,
        }),
        { params: { id: body.batch.id } },
      );
      const report = await res.json();
      expect(report.valid).toBe(false);
      expect(report.errors.some((e: any) => e.code === 'ASSET_NOT_SETTLEABLE')).toBe(true);
    } finally {
      process.env.NEXT_PUBLIC_SETTLEMENT_ASSET_CODE = 'USDC';
    }

    // A read-only check: the payments are untouched.
    const payments = await prisma.payment.findMany({ where: { orgId: orgA.orgId } });
    expect(payments.every((p) => p.assetCode === 'USDC')).toBe(true);
    expect(payments.every((p) => p.state === PaymentState.DRAFT)).toBe(true);
  });
});
