// @vitest-environment node
/**
 * Bulk Pay route tests.
 *
 * These are UNIT tests. The Prisma client is replaced by the in-memory fake, which
 * enforces the unique constraints and required columns that carry the idempotency
 * and tenancy guarantees — so a test can observe those being relied upon rather
 * than trusting a canned return value.
 *
 * They do NOT constitute database-backed validation. No migration has been applied
 * and no real Postgres has seen these queries; composite foreign keys, partial
 * indexes and column types remain unverified against a real database. That work is
 * BLOCKED on a local development database.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OrgRole, MembershipStatus, PaymentState, ApprovalDecision } from '@prisma/client';
import type { FakeDb } from '@/lib/payments/__tests__/fake-db';

// The factory is HOISTED above every import, so it must not close over a module
// variable — `const db = createFakeDb()` above this line is not yet initialized
// when the factory runs. The fake is therefore built inside the factory and read
// back from the mocked module afterwards.
vi.mock('@/lib/db/prisma', async () => {
  const { createFakeDb } = await import('@/lib/payments/__tests__/fake-db');
  return { default: createFakeDb() };
});
vi.mock('@/lib/auth', () => ({ getUserFromRequest: vi.fn() }));

import { POST as createBatchRoute, GET as listBatchesRoute } from '../batches/route';
import { POST as validateCsvRoute } from '../batches/validate/route';
import { GET as getBatchRoute } from '../batches/[id]/route';
import { POST as revalidateRoute } from '../batches/[id]/validate/route';
import { POST as approveBatchRoute } from '../batches/[id]/approve/route';
import { getUserFromRequest } from '@/lib/auth';
import { __resetRateLimiter } from '@/lib/ratelimit';
import prismaDefault from '@/lib/db/prisma';

/** The same instance the routes use, so assertions read the rows they wrote. */
const db = prismaDefault as unknown as FakeDb;

const mockUser = getUserFromRequest as unknown as ReturnType<typeof vi.fn>;

const ORG_A = 'orgA';
const ORG_B = 'orgB';
const TOKEN = 'CBW2ZKFBHLHNNVCZ7JP4AXHQOOC3S6NLAMORXOAIWQNWMKUVJS743Q5M';

function addr(tag: string): string {
  return ('G' + tag.toUpperCase().replace(/[^A-Z2-7]/g, '')).padEnd(56, 'A');
}

const HEADER = 'recipient,amount,asset,hours,rate,period_start,period_end';
/** A pay period, required because the oracle attests to it. */
const PERIOD = '2026-09-01,2026-09-15';
const GOOD_CSV = [
  HEADER,
  `${addr('alice')},1000,USDC,40,25,${PERIOD}`,
  `${addr('bob')},1600,USDC,80,20,${PERIOD}`,
  `${addr('carol')},260,USDC,20,13,${PERIOD}`,
].join('\n');

/** Seed an organization and a member. */
function seedMember(orgId: string, userId: string, role: OrgRole, wallet: string) {
  if (!db.__tables.organization.rows.some((o) => o.id === orgId)) {
    db.__tables.organization.rows.push({ id: orgId, name: orgId, slug: orgId });
  }
  if (!db.__tables.user.rows.some((u) => u.id === userId)) {
    db.__tables.user.rows.push({ id: userId, walletAddress: wallet, role: 'EMPLOYEE' });
  }
  db.__tables.orgMember.rows.push({
    id: `ogm_${orgId}_${userId}`,
    orgId,
    userId,
    role,
    status: MembershipStatus.ACTIVE,
    createdAt: new Date(),
  });
}

function signedInAs(userId: string, wallet: string) {
  mockUser.mockResolvedValue({ userId, walletAddress: wallet, role: 'EMPLOYEE' });
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

/** JSON.stringify refuses bigint, and every monetary column is one. */
function snapshotRows(rows: readonly Record<string, any>[]): string {
  return JSON.stringify(rows, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
}

const URL_BATCHES = 'https://app.test/api/payroll/batches';

beforeEach(() => {
  vi.clearAllMocks();
  __resetRateLimiter();
  for (const t of Object.values(db.__tables)) t.rows.length = 0;

  process.env.NEXT_PUBLIC_STELLAR_TOKEN_ID = TOKEN;
  process.env.NEXT_PUBLIC_SETTLEMENT_ASSET_CODE = 'USDC';

  // Two organizations, so every test can check isolation rather than assuming it.
  seedMember(ORG_A, 'u_admin_a', OrgRole.ADMIN, addr('adminA'));
  seedMember(ORG_A, 'u_manager_a', OrgRole.MANAGER, addr('managerA'));
  seedMember(ORG_A, 'u_finance_a', OrgRole.FINANCE, addr('financeA'));
  seedMember(ORG_A, 'u_worker_a', OrgRole.WORKER, addr('workerA'));
  seedMember(ORG_A, 'u_viewer_a', OrgRole.VIEWER, addr('viewerA'));
  seedMember(ORG_B, 'u_admin_b', OrgRole.ADMIN, addr('adminB'));
});

// ---------------------------------------------------------------------------

describe('POST /api/payroll/batches — authentication and authorization', () => {
  it('refuses an unauthenticated request', async () => {
    mockUser.mockResolvedValue(null);
    const res = await createBatchRoute(post(URL_BATCHES, { csv: GOOD_CSV }));
    expect(res.status).toBe(401);
    expect(db.__tables.payrollBatch.rows).toHaveLength(0);
  });

  it('refuses a role without payroll:create', async () => {
    signedInAs('u_viewer_a', addr('viewerA'));
    const res = await createBatchRoute(
      post(URL_BATCHES, { csv: GOOD_CSV }, { 'x-organization-id': ORG_A }),
    );
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('PERMISSION_DENIED');
    expect(db.__tables.payrollBatch.rows).toHaveLength(0);
  });

  it('refuses a WORKER, who holds no organization permissions at all', async () => {
    signedInAs('u_worker_a', addr('workerA'));
    const res = await createBatchRoute(
      post(URL_BATCHES, { csv: GOOD_CSV }, { 'x-organization-id': ORG_A }),
    );
    expect(res.status).toBe(403);
  });

  it('does not let a member of org B create a batch in org A', async () => {
    signedInAs('u_admin_b', addr('adminB'));
    const res = await createBatchRoute(
      post(URL_BATCHES, { csv: GOOD_CSV }, { 'x-organization-id': ORG_A }),
    );
    // A non-enumerating 404: naming an organization you do not belong to is
    // indistinguishable from naming one that does not exist.
    expect(res.status).toBe(404);
    expect(db.__tables.payrollBatch.rows).toHaveLength(0);
  });
});

describe('POST /api/payroll/batches — request validation', () => {
  beforeEach(() => signedInAs('u_admin_a', addr('adminA')));

  it('rejects a non-JSON content type before reading the body', async () => {
    const res = await createBatchRoute(
      new Request(URL_BATCHES, {
        method: 'POST',
        headers: { 'content-type': 'text/csv', 'x-organization-id': ORG_A },
        body: GOOD_CSV,
      }) as any,
    );
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('UNSUPPORTED_CONTENT_TYPE');
  });

  it('rejects an oversized declared body', async () => {
    const req = new Request(URL_BATCHES, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': String(50 * 1024 * 1024),
        'x-organization-id': ORG_A,
      },
      body: JSON.stringify({ csv: GOOD_CSV }),
    });
    const res = await createBatchRoute(req as any);
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('PAYLOAD_TOO_LARGE');
  });

  it('rejects unknown fields rather than ignoring them', async () => {
    const res = await createBatchRoute(
      post(
        URL_BATCHES,
        { csv: GOOD_CSV, state: 'PAID', role: 'FINANCE' },
        { 'x-organization-id': ORG_A },
      ),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe('MALFORMED_REQUEST');
    // Silently dropping these would teach a client that they were honoured.
    expect(JSON.stringify(body.details)).toContain('UNKNOWN_FIELD');
    expect(db.__tables.payment.rows).toHaveLength(0);
  });

  it('rejects a missing csv field', async () => {
    const res = await createBatchRoute(post(URL_BATCHES, {}, { 'x-organization-id': ORG_A }));
    expect(res.status).toBe(400);
  });

  it('rejects a reference containing control characters', async () => {
    const res = await createBatchRoute(
      post(
        URL_BATCHES,
        { csv: GOOD_CSV, reference: 'A' + String.fromCharCode(7) + 'B' },
        { 'x-organization-id': ORG_A },
      ),
    );
    expect(res.status).toBe(400);
    expect(JSON.stringify((await res.json()).details)).toContain('control characters');
  });

  it('rejects a projectId belonging to another organization', async () => {
    db.__tables.project.rows.push({ id: 'prjb', orgId: ORG_B, code: 'B1', name: 'Other' });
    const res = await createBatchRoute(
      post(URL_BATCHES, { csv: GOOD_CSV, projectId: 'prjb' }, { 'x-organization-id': ORG_A }),
    );
    expect(res.status).toBe(404);
    expect(db.__tables.payrollBatch.rows).toHaveLength(0);
  });
});

describe('POST /api/payroll/batches — CSV validation', () => {
  beforeEach(() => signedInAs('u_admin_a', addr('adminA')));

  it('creates one payment per row and returns 201', async () => {
    const res = await createBatchRoute(
      post(URL_BATCHES, { csv: GOOD_CSV, filename: 'sept.csv' }, { 'x-organization-id': ORG_A }),
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.created).toBe(true);
    expect(body.batch.paymentCount).toBe(3);
    expect(body.batch.totalBaseUnits).toBe('28600000000');
    expect(body.batch.asset).toBe('USDC');

    expect(db.__tables.payment.rows).toHaveLength(3);
    expect(db.__tables.payment.rows.every((p) => p.state === PaymentState.DRAFT)).toBe(true);
    expect(db.__tables.payment.rows.every((p) => p.orgId === ORG_A)).toBe(true);
  });

  it('returns 422 with per-row errors for an invalid file, and writes nothing', async () => {
    const csv = [
      HEADER,
      `${addr('ok')},1000,USDC,40,25,${PERIOD}`,
      `NOTANADDRESS,100,USDC,10,10,${PERIOD}`,
      `${addr('sci')},1e3,USDC,10,10,${PERIOD}`,
      `${addr('frac')},100,USDC,7.5,10,${PERIOD}`,
    ].join('\n');

    const res = await createBatchRoute(post(URL_BATCHES, { csv }, { 'x-organization-id': ORG_A }));
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.code).toBe('CSV_INVALID');

    const codes = body.details.errors.map((e: any) => e.code).sort();
    expect(codes).toEqual(['AMBIGUOUS_NUMBER', 'FRACTIONAL_HOURS', 'INVALID_ADDRESS']);
    // Each error names the line the uploader sees.
    expect(body.details.errors.every((e: any) => typeof e.row === 'number')).toBe(true);
    // Nothing partial: a batch is created only from a wholly valid file.
    expect(db.__tables.payrollBatch.rows).toHaveLength(0);
    expect(db.__tables.payment.rows).toHaveLength(0);
  });

  it('rejects an asset this deployment cannot settle', async () => {
    const csv = [HEADER, `${addr('x')},100,XLM,10,10,${PERIOD}`].join('\n');
    const res = await createBatchRoute(post(URL_BATCHES, { csv }, { 'x-organization-id': ORG_A }));
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.details.errors[0].code).toBe('UNSUPPORTED_ASSET');
    expect(body.details.errors[0].message).toContain('settles: USDC');
  });

  it('rejects a row whose amount does not equal hours x rate', async () => {
    const csv = [HEADER, `${addr('x')},1000,USDC,40,20,${PERIOD}`].join('\n');
    const res = await createBatchRoute(post(URL_BATCHES, { csv }, { 'x-organization-id': ORG_A }));
    expect(res.status).toBe(422);
    expect((await res.json()).details.errors[0].code).toBe('HOURS_RATE_MISMATCH');
  });

  it('rejects a file with a header but no rows', async () => {
    const res = await createBatchRoute(
      post(URL_BATCHES, { csv: HEADER }, { 'x-organization-id': ORG_A }),
    );
    expect(res.status).toBe(422);
  });
});

describe('POST /api/payroll/batches — idempotency', () => {
  beforeEach(() => signedInAs('u_admin_a', addr('adminA')));

  const KEY = 'idem-sept-2026';

  it('replays the first outcome for a repeated request (double-click, retry)', async () => {
    const headers = { 'x-organization-id': ORG_A, 'idempotency-key': KEY };
    const first = await createBatchRoute(post(URL_BATCHES, { csv: GOOD_CSV }, headers));
    const second = await createBatchRoute(post(URL_BATCHES, { csv: GOOD_CSV }, headers));

    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    const a = await first.json();
    const b = await second.json();
    expect(b.created).toBe(false);
    expect(b.batch.id).toBe(a.batch.id);

    // The property that matters: three payments, not six.
    expect(db.__tables.payrollBatch.rows).toHaveLength(1);
    expect(db.__tables.payment.rows).toHaveLength(3);
  });

  it('is deterministic across several concurrent identical requests', async () => {
    const headers = { 'x-organization-id': ORG_A, 'idempotency-key': KEY };
    const results = await Promise.all([
      createBatchRoute(post(URL_BATCHES, { csv: GOOD_CSV }, headers)),
      createBatchRoute(post(URL_BATCHES, { csv: GOOD_CSV }, headers)),
      createBatchRoute(post(URL_BATCHES, { csv: GOOD_CSV }, headers)),
    ]);
    const bodies = await Promise.all(results.map((r) => r.json()));
    const ids = new Set(bodies.map((b) => b.batch.id));

    expect(ids.size).toBe(1);
    expect(bodies.filter((b) => b.created)).toHaveLength(1);
    expect(db.__tables.payrollBatch.rows).toHaveLength(1);
    expect(db.__tables.payment.rows).toHaveLength(3);
  });

  it('refuses the same key with a different payload instead of replaying the wrong batch', async () => {
    const headers = { 'x-organization-id': ORG_A, 'idempotency-key': KEY };
    await createBatchRoute(post(URL_BATCHES, { csv: GOOD_CSV }, headers));

    const differentCsv = [HEADER, `${addr('dave')},500,USDC,25,20,${PERIOD}`].join('\n');
    const res = await createBatchRoute(post(URL_BATCHES, { csv: differentCsv }, headers));

    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('IDEMPOTENCY_KEY_REUSED');
    // Neither payroll was altered, and no second one was created.
    expect(db.__tables.payrollBatch.rows).toHaveLength(1);
    expect(db.__tables.payment.rows).toHaveLength(3);
  });

  it('does not tie together two deliberate uploads without a key', async () => {
    const headers = { 'x-organization-id': ORG_A };
    await createBatchRoute(post(URL_BATCHES, { csv: GOOD_CSV }, headers));
    await createBatchRoute(post(URL_BATCHES, { csv: GOOD_CSV }, headers));
    expect(db.__tables.payrollBatch.rows).toHaveLength(2);
    expect(db.__tables.payment.rows).toHaveLength(6);
  });

  it('warns about a byte-identical recent upload rather than blocking it', async () => {
    const headers = { 'x-organization-id': ORG_A };
    await createBatchRoute(post(URL_BATCHES, { csv: GOOD_CSV }, headers));
    const res = await createBatchRoute(post(URL_BATCHES, { csv: GOOD_CSV }, headers));
    const body = await res.json();
    expect(res.status).toBe(201);
    expect(body.possibleDuplicateOf?.reference).toBe('CF-00001');
  });

  it('scopes an idempotency key to the organization', async () => {
    signedInAs('u_admin_a', addr('adminA'));
    await createBatchRoute(
      post(URL_BATCHES, { csv: GOOD_CSV }, { 'x-organization-id': ORG_A, 'idempotency-key': KEY }),
    );
    signedInAs('u_admin_b', addr('adminB'));
    const res = await createBatchRoute(
      post(URL_BATCHES, { csv: GOOD_CSV }, { 'x-organization-id': ORG_B, 'idempotency-key': KEY }),
    );
    expect(res.status).toBe(201);
    expect((await res.json()).created).toBe(true);
  });
});

describe('POST /api/payroll/batches/validate', () => {
  const URL_VALIDATE = `${URL_BATCHES}/validate`;
  beforeEach(() => signedInAs('u_admin_a', addr('adminA')));

  it('reports a valid file without creating anything', async () => {
    const res = await validateCsvRoute(
      post(URL_VALIDATE, { csv: GOOD_CSV }, { 'x-organization-id': ORG_A }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.valid).toBe(true);
    expect(body.summary.paymentsToCreate).toBe(3);
    expect(body.summary.totalHours).toBe('140');

    // The whole point of the endpoint: no writes at all.
    expect(db.__tables.payrollBatch.rows).toHaveLength(0);
    expect(db.__tables.payment.rows).toHaveLength(0);
    expect(db.__tables.auditEvent.rows).toHaveLength(0);
  });

  it('returns 200 with structured row errors for an invalid file', async () => {
    const csv = [HEADER, `BADADDRESS,100,USDC,10,10,${PERIOD}`].join('\n');
    const res = await validateCsvRoute(
      post(URL_VALIDATE, { csv }, { 'x-organization-id': ORG_A }),
    );
    // The CALL succeeded; the file is what is wrong. A reviewer iterating on a
    // preview is not making failing requests.
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.valid).toBe(false);
    expect(body.errors[0]).toMatchObject({ row: 2, field: 'recipient', code: 'INVALID_ADDRESS' });
  });

  it('is safe to call repeatedly', async () => {
    const req = () =>
      validateCsvRoute(post(URL_VALIDATE, { csv: GOOD_CSV }, { 'x-organization-id': ORG_A }));
    for (let i = 0; i < 5; i++) expect((await req()).status).toBe(200);
    expect(db.__tables.payrollBatch.rows).toHaveLength(0);
    expect(db.__tables.payment.rows).toHaveLength(0);
  });

  it('reports an unconfigured settlement asset without failing the call', async () => {
    delete process.env.NEXT_PUBLIC_STELLAR_TOKEN_ID;
    const res = await validateCsvRoute(
      post(URL_VALIDATE, { csv: GOOD_CSV }, { 'x-organization-id': ORG_A }),
    );
    const body = await res.json();
    expect(body.asset.configured).toBe(false);
    expect(body.asset.contractId).toBeNull();
  });

  it('refuses an unauthenticated caller', async () => {
    mockUser.mockResolvedValue(null);
    const res = await validateCsvRoute(post(URL_VALIDATE, { csv: GOOD_CSV }));
    expect(res.status).toBe(401);
  });
});

describe('GET /api/payroll/batches', () => {
  beforeEach(async () => {
    signedInAs('u_admin_a', addr('adminA'));
    await createBatchRoute(post(URL_BATCHES, { csv: GOOD_CSV }, { 'x-organization-id': ORG_A }));
    signedInAs('u_admin_b', addr('adminB'));
    await createBatchRoute(post(URL_BATCHES, { csv: GOOD_CSV }, { 'x-organization-id': ORG_B }));
  });

  it('lists only the caller organization batches', async () => {
    signedInAs('u_admin_a', addr('adminA'));
    const res = await listBatchesRoute(get(URL_BATCHES, { 'x-organization-id': ORG_A }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.batches).toHaveLength(1);
    expect(body.batches[0].paymentCount).toBe(3);
    expect(body.batches[0].totalBaseUnits).toBe('28600000000');
    // Standing is derived on read, not stored.
    expect(body.batches[0].headline).toBeDefined();
  });

  it('rejects an unknown query parameter', async () => {
    signedInAs('u_admin_a', addr('adminA'));
    const res = await listBatchesRoute(
      get(`${URL_BATCHES}?sneaky=1`, { 'x-organization-id': ORG_A }),
    );
    expect(res.status).toBe(400);
  });

  it('rejects a limit outside the allowed range', async () => {
    signedInAs('u_admin_a', addr('adminA'));
    const res = await listBatchesRoute(
      get(`${URL_BATCHES}?limit=5000`, { 'x-organization-id': ORG_A }),
    );
    expect(res.status).toBe(400);
  });
});

describe('GET /api/payroll/batches/:id', () => {
  let batchId: string;

  beforeEach(async () => {
    signedInAs('u_admin_a', addr('adminA'));
    const res = await createBatchRoute(
      post(URL_BATCHES, { csv: GOOD_CSV }, { 'x-organization-id': ORG_A }),
    );
    batchId = (await res.json()).batch.id;
  });

  it('returns the batch with its payments and derived standing', async () => {
    const res = await getBatchRoute(get(`${URL_BATCHES}/${batchId}`, { 'x-organization-id': ORG_A }), {
      params: { id: batchId },
    });
    expect(res.status).toBe(200);
    const { batch } = await res.json();
    expect(batch.paymentCount).toBe(3);
    expect(batch.payments).toHaveLength(3);
    expect(batch.standing.totalAmountBaseUnits).toBe('28600000000');
    expect(batch.standing.paidAmountBaseUnits).toBe('0');
    // No transaction link on a payment that cannot have one.
    expect(batch.payments.every((p: any) => p.transactionHash === null)).toBe(true);
  });

  it('returns a non-enumerating 404 for another organization batch', async () => {
    signedInAs('u_admin_b', addr('adminB'));
    const res = await getBatchRoute(get(`${URL_BATCHES}/${batchId}`, { 'x-organization-id': ORG_B }), {
      params: { id: batchId },
    });
    expect(res.status).toBe(404);
    // Identical to a batch that truly does not exist, so an id cannot be probed.
    const absent = await getBatchRoute(
      get(`${URL_BATCHES}/batnope`, { 'x-organization-id': ORG_B }),
      { params: { id: 'batnope' } },
    );
    expect(absent.status).toBe(404);
    expect(await res.json()).toEqual(await absent.json());
  });
});

describe('POST /api/payroll/batches/:id/validate', () => {
  let batchId: string;

  beforeEach(async () => {
    signedInAs('u_admin_a', addr('adminA'));
    const res = await createBatchRoute(
      post(URL_BATCHES, { csv: GOOD_CSV }, { 'x-organization-id': ORG_A }),
    );
    batchId = (await res.json()).batch.id;
  });

  it('confirms a sound draft without changing anything', async () => {
    const before = snapshotRows(db.__tables.payment.rows);
    const res = await revalidateRoute(
      post(`${URL_BATCHES}/${batchId}/validate`, {}, { 'x-organization-id': ORG_A }),
      { params: { id: batchId } },
    );
    expect(res.status).toBe(200);
    expect((await res.json()).valid).toBe(true);
    expect(snapshotRows(db.__tables.payment.rows)).toBe(before);
  });

  it('reports a batch denominated in an asset no longer settleable', async () => {
    // Configuration moved under the batch, as it would if the operator switched
    // the settlement asset between drafting and funding.
    process.env.NEXT_PUBLIC_SETTLEMENT_ASSET_CODE = 'EURC';
    const res = await revalidateRoute(
      post(`${URL_BATCHES}/${batchId}/validate`, {}, { 'x-organization-id': ORG_A }),
      { params: { id: batchId } },
    );
    const body = await res.json();
    expect(body.valid).toBe(false);
    expect(body.errors.some((e: any) => e.code === 'ASSET_NOT_SETTLEABLE')).toBe(true);
  });

  it('reports an unconfigured settlement contract', async () => {
    delete process.env.NEXT_PUBLIC_STELLAR_TOKEN_ID;
    const res = await revalidateRoute(
      post(`${URL_BATCHES}/${batchId}/validate`, {}, { 'x-organization-id': ORG_A }),
      { params: { id: batchId } },
    );
    const body = await res.json();
    expect(body.errors.some((e: any) => e.code === 'SETTLEMENT_ASSET_UNCONFIGURED')).toBe(true);
  });

  it('gives another organization a non-enumerating 404', async () => {
    signedInAs('u_admin_b', addr('adminB'));
    const res = await revalidateRoute(
      post(`${URL_BATCHES}/${batchId}/validate`, {}, { 'x-organization-id': ORG_B }),
      { params: { id: batchId } },
    );
    expect(res.status).toBe(404);
  });
});

describe('POST /api/payroll/batches/:id/approve', () => {
  let batchId: string;
  let paymentIds: string[];

  beforeEach(async () => {
    signedInAs('u_admin_a', addr('adminA'));
    const res = await createBatchRoute(
      post(URL_BATCHES, { csv: GOOD_CSV }, { 'x-organization-id': ORG_A }),
    );
    batchId = (await res.json()).batch.id;
    paymentIds = db.__tables.payment.rows.map((p) => p.id);
  });

  const approveUrl = () => `${URL_BATCHES}/${batchId}/approve`;

  it('derives the approval role from membership, ignoring a client-sent role', async () => {
    signedInAs('u_manager_a', addr('managerA'));
    // `role` is not in the schema, so sending it is refused outright rather than
    // quietly dropped — a manager cannot nominate themselves as finance.
    const res = await approveBatchRoute(
      post(approveUrl(), { role: 'FINANCE' }, { 'x-organization-id': ORG_A }),
      { params: { id: batchId } },
    );
    expect(res.status).toBe(400);
    expect(JSON.stringify((await res.json()).details)).toContain('UNKNOWN_FIELD');
    expect(db.__tables.approval.rows).toHaveLength(0);
  });

  it('records a MANAGER approval on every payment in the batch', async () => {
    signedInAs('u_manager_a', addr('managerA'));
    const res = await approveBatchRoute(
      post(approveUrl(), {}, { 'x-organization-id': ORG_A }),
      { params: { id: batchId } },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.approvalRole).toBe(OrgRole.MANAGER);
    expect(body.recorded).toBe(3);
    expect(body.failed).toBe(0);

    expect(db.__tables.approval.rows).toHaveLength(3);
    expect(db.__tables.approval.rows.every((a) => a.role === OrgRole.MANAGER)).toBe(true);
    expect(db.__tables.approval.rows.every((a) => a.orgId === ORG_A)).toBe(true);
    expect(
      db.__tables.approval.rows.every((a) => a.decision === ApprovalDecision.APPROVED),
    ).toBe(true);
  });

  it('records an audit event per approval', async () => {
    signedInAs('u_manager_a', addr('managerA'));
    await approveBatchRoute(post(approveUrl(), {}, { 'x-organization-id': ORG_A }), {
      params: { id: batchId },
    });
    const granted = db.__tables.auditEvent.rows.filter((e) => e.type === 'approval.granted');
    expect(granted).toHaveLength(3);
    expect(granted.every((e) => e.actorAddress === addr('managerA'))).toBe(true);
  });

  it('is idempotent: a repeated approval records nothing further', async () => {
    signedInAs('u_manager_a', addr('managerA'));
    const headers = { 'x-organization-id': ORG_A };
    await approveBatchRoute(post(approveUrl(), {}, headers), { params: { id: batchId } });
    const res = await approveBatchRoute(post(approveUrl(), {}, headers), {
      params: { id: batchId },
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.recorded).toBe(0);
    expect(body.alreadyRecorded).toBe(3);
    // One decision per role per payment. A second manager approval is a
    // duplicate, not a new fact.
    expect(db.__tables.approval.rows).toHaveLength(3);
  });

  it('keeps manager and finance as two distinct decisions', async () => {
    signedInAs('u_manager_a', addr('managerA'));
    await approveBatchRoute(post(approveUrl(), {}, { 'x-organization-id': ORG_A }), {
      params: { id: batchId },
    });
    signedInAs('u_finance_a', addr('financeA'));
    const res = await approveBatchRoute(
      post(approveUrl(), {}, { 'x-organization-id': ORG_A }),
      { params: { id: batchId } },
    );
    const body = await res.json();

    expect(body.approvalRole).toBe(OrgRole.FINANCE);
    expect(body.recorded).toBe(3);
    expect(db.__tables.approval.rows).toHaveLength(6);
    const roles = new Set(db.__tables.approval.rows.map((a) => a.role));
    expect(roles).toEqual(new Set([OrgRole.MANAGER, OrgRole.FINANCE]));
    // Two distinct wallets, never one standing in for both.
    const wallets = new Set(db.__tables.approval.rows.map((a) => a.actorAddress));
    expect(wallets.size).toBe(2);
  });

  it('refuses to let one wallet supply both halves of the gate', async () => {
    // An ADMIN holds both permissions, so separation of duties has to be enforced
    // by the approval logic rather than by the permission check.
    signedInAs('u_admin_a', addr('adminA'));
    const headers = { 'x-organization-id': ORG_A };
    const first = await approveBatchRoute(post(approveUrl(), {}, headers), {
      params: { id: batchId },
    });
    expect((await first.json()).recorded).toBe(3);

    const second = await approveBatchRoute(post(approveUrl(), {}, headers), {
      params: { id: batchId },
    });
    const body = await second.json();
    // The second attempt finds its own role already recorded and adds nothing.
    expect(body.recorded).toBe(0);
    expect(db.__tables.approval.rows).toHaveLength(3);
  });

  it('refuses a role that cannot approve at all', async () => {
    signedInAs('u_viewer_a', addr('viewerA'));
    const res = await approveBatchRoute(
      post(approveUrl(), {}, { 'x-organization-id': ORG_A }),
      { params: { id: batchId } },
    );
    expect(res.status).toBe(403);
    expect(db.__tables.approval.rows).toHaveLength(0);
  });

  it('does not approve another organization batch', async () => {
    signedInAs('u_admin_b', addr('adminB'));
    const res = await approveBatchRoute(
      post(approveUrl(), {}, { 'x-organization-id': ORG_B }),
      { params: { id: batchId } },
    );
    expect(res.status).toBe(404);
    expect(db.__tables.approval.rows).toHaveLength(0);
  });

  it('approves only the named payments', async () => {
    signedInAs('u_manager_a', addr('managerA'));
    const res = await approveBatchRoute(
      post(approveUrl(), { paymentIds: [paymentIds[0]] }, { 'x-organization-id': ORG_A }),
      { params: { id: batchId } },
    );
    expect((await res.json()).recorded).toBe(1);
    expect(db.__tables.approval.rows).toHaveLength(1);
    expect(db.__tables.approval.rows[0].paymentId).toBe(paymentIds[0]);
  });

  it('refuses a payment id that is not in this batch', async () => {
    signedInAs('u_manager_a', addr('managerA'));
    const res = await approveBatchRoute(
      post(approveUrl(), { paymentIds: ['payelsewhere'] }, { 'x-organization-id': ORG_A }),
      { params: { id: batchId } },
    );
    expect(res.status).toBe(404);
    expect(db.__tables.approval.rows).toHaveLength(0);
  });

  it('reports a conflict when no payment is awaiting a decision', async () => {
    for (const p of db.__tables.payment.rows) p.state = PaymentState.PAID;
    signedInAs('u_manager_a', addr('managerA'));
    const res = await approveBatchRoute(
      post(approveUrl(), {}, { 'x-organization-id': ORG_A }),
      { params: { id: batchId } },
    );
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('STATE_CONFLICT');
    expect(db.__tables.approval.rows).toHaveLength(0);
  });

  it('never changes payment state, settlement hash or amount', async () => {
    const snapshot = () =>
      db.__tables.payment.rows.map((p) => ({
        state: p.state,
        settlementTxHash: p.settlementTxHash ?? null,
        amount: p.amountBaseUnits,
        recipient: p.recipientAddress,
      }));
    const before = snapshot();
    signedInAs('u_manager_a', addr('managerA'));
    await approveBatchRoute(post(approveUrl(), {}, { 'x-organization-id': ORG_A }), {
      params: { id: batchId },
    });
    // Recording an approval is not settlement. Nothing financial moves here.
    expect(snapshot()).toEqual(before);
    expect(snapshot().every((p) => p.state === PaymentState.DRAFT)).toBe(true);
  });
});

describe('error sanitization', () => {
  beforeEach(() => signedInAs('u_admin_a', addr('adminA')));

  it('returns an opaque 500 and leaks no internals when a write fails', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    db.__failOn('payrollBatch', 'create', 1);

    const res = await createBatchRoute(
      post(URL_BATCHES, { csv: GOOD_CSV }, { 'x-organization-id': ORG_A }),
    );
    expect(res.status).toBe(500);
    const raw = JSON.stringify(await res.json());

    // None of this may cross the boundary.
    expect(raw).not.toContain('fake-db');
    expect(raw).not.toContain('payrollBatch');
    expect(raw).not.toContain('prisma');
    expect(raw).not.toMatch(/at \w+ \(/);
    expect(db.__tables.payment.rows).toHaveLength(0);
    spy.mockRestore();
  });
});
