// @vitest-environment node
/**
 * Handler-level authorization for every protected API route, driven by the
 * policy in src/lib/auth/api-access.ts. These call the handlers directly, so
 * they hold even if the edge middleware is bypassed or its matcher drifts.
 *
 *   no session            -> 401
 *   signed in, wrong role -> 403
 *   the right role        -> gets past authorization (not 401/403)
 *
 * The two routes that hand out oracle signatures are also tested end to end:
 * the right caller gets a signature, anyone else gets nothing signed.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import path from 'node:path';
import { NextRequest } from 'next/server';
import { API_ACCESS, type Access } from '@/lib/auth/api-access';

const ADMIN = { userId: 'u-admin', walletAddress: 'GADMIN', role: 'ADMIN' };
const WORKER = 'GWORKERAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const MANAGER = 'GMANAGERAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const OTHER = 'GOTHERAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const employee = (walletAddress: string) => ({ userId: 'u-' + walletAddress, walletAddress, role: 'EMPLOYEE' });

vi.mock('@/lib/auth', async (orig) => {
  const actual = await orig<typeof import('@/lib/auth')>();
  return { ...actual, getUserFromRequest: vi.fn() };
});

// Every Prisma call resolves to an empty result, so handlers run past their
// authorization checks without a database.
vi.mock('@/lib/db/prisma', () => {
  const op = (name: string) =>
    vi.fn(async () => (name === 'findMany' ? [] : name === 'count' ? 0 : name.startsWith('find') ? null : {}));
  const model = () => new Proxy({}, { get: (_t, name: string) => op(name) });
  const prisma: any = new Proxy(
    {},
    {
      get: (_t, name: string) => {
        if (name === '$transaction')
          return vi.fn(async (arg: any) => (Array.isArray(arg) ? Promise.all(arg) : arg(prisma)));
        if (name.startsWith('$')) return vi.fn(async () => []);
        return model();
      },
    }
  );
  return { default: prisma };
});

const { getEscrow, getNonce } = vi.hoisted(() => ({ getEscrow: vi.fn(), getNonce: vi.fn() }));
vi.mock('@/lib/contracts', () => ({
  CoreFlowClient: class {
    getEscrow = getEscrow;
    getNonce = getNonce;
  },
}));

const signHoursProof = vi.fn(() => 'signature-hex');
vi.mock('@/lib/oracle', () => ({
  signHoursProof: (...args: unknown[]) => signHoursProof(...(args as [])),
  getOraclePublicKeyHex: () => 'ab'.repeat(32),
}));

import { getUserFromRequest } from '@/lib/auth';
const mockUser = getUserFromRequest as unknown as ReturnType<typeof vi.fn>;

const API_DIR = path.resolve(__dirname, '..');
const load = (route: string) =>
  import(path.join(API_DIR, route.replace(/^\/api\//, ''), 'route.ts'));

function request(route: string, method: string, body?: unknown) {
  const url = `http://localhost${route.replace(/\[[^\]]+\]/g, 'sample')}`;
  return new NextRequest(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: method === 'GET' || method === 'DELETE' ? undefined : JSON.stringify(body ?? {}),
  });
}

async function call(route: string, method: string, body?: unknown) {
  const mod = await load(route);
  return (mod[method] as Function)(request(route, method, body), {
    params: { id: 'sample', token: 'sample' },
  }) as Promise<Response>;
}

const ESCROW = {
  manager: MANAGER,
  finance_approver: OTHER,
  oracle_pubkey: 'ab'.repeat(32),
  payments: [{ id: 0, worker: WORKER }],
  manager_approved: false,
  finance_approved: false,
  cancelled: false,
  oracle_rotations: 0,
};
const ATTEST_BODY = { onChainId: 1, paymentId: 0, hoursLogged: 8, nonce: 0 };
const BATCH_BODY = { escrow_id: 1, payees: [{ address: WORKER, amount: 10, token: 'CTOKEN' }] };

/** A caller with the least privilege the access level allows. */
const allowedCaller: Record<Access, object | null> = {
  public: null,
  session: employee(OTHER),
  admin: ADMIN,
  'escrow-worker': employee(WORKER),
  'escrow-manager': employee(MANAGER),
  'bootstrap-secret': null,
  'cron-secret': null,
};
const bodyFor = (route: string) =>
  route === '/api/oracle/attest' ? ATTEST_BODY : route === '/api/submit-batch' ? BATCH_BODY : {};

const cases = Object.entries(API_ACCESS).flatMap(([route, policy]) =>
  Object.entries(policy.methods).map(([method, access]) => ({ route, method, access: access as Access }))
);
const sessionCases = cases.filter((c) => allowedCaller[c.access] !== null);

beforeEach(() => {
  vi.clearAllMocks();
  getEscrow.mockResolvedValue(ESCROW);
  getNonce.mockResolvedValue(0);
});

describe('protected handlers', () => {
  it.each(sessionCases)('$method $route: 401 without a session', async ({ route, method }) => {
    mockUser.mockResolvedValue(null);
    expect((await call(route, method, bodyFor(route))).status).toBe(401);
  });

  it.each(sessionCases.filter((c) => c.access !== 'session'))(
    '$method $route: 403 for an EMPLOYEE with no claim to it',
    async ({ route, method }) => {
      mockUser.mockResolvedValue(employee(OTHER));
      expect((await call(route, method, bodyFor(route))).status).toBe(403);
    }
  );

  it.each(sessionCases)('$method $route: allowed for $access', async ({ route, method, access }) => {
    mockUser.mockResolvedValue(allowedCaller[access]);
    const res = await call(route, method, bodyFor(route));
    expect([401, 403]).not.toContain(res.status);
  });

  it.each(cases.filter((c) => c.access === 'bootstrap-secret' || c.access === 'cron-secret'))(
    '$method $route: refused without its secret',
    async ({ route, method }) => {
      mockUser.mockResolvedValue(ADMIN); // a session is not a substitute for the secret
      const res = await call(route, method, {});
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.status).toBeLessThan(500);
    }
  );
});

describe('POST /api/submit-batch', () => {
  it('signs for the escrow manager', async () => {
    mockUser.mockResolvedValue(employee(MANAGER));
    const res = await call('/api/submit-batch', 'POST', BATCH_BODY);
    expect(res.status).toBe(200);
    expect((await res.json()).signatures).toHaveLength(1);
  });

  it('signs for an ADMIN without reading the escrow', async () => {
    mockUser.mockResolvedValue(ADMIN);
    const res = await call('/api/submit-batch', 'POST', BATCH_BODY);
    expect(res.status).toBe(200);
    expect(getEscrow).not.toHaveBeenCalled();
  });

  it('signs nothing without a session', async () => {
    mockUser.mockResolvedValue(null);
    expect((await call('/api/submit-batch', 'POST', BATCH_BODY)).status).toBe(401);
    expect(signHoursProof).not.toHaveBeenCalled();
  });

  it('signs nothing for a signed-in wallet that is not the manager', async () => {
    mockUser.mockResolvedValue(employee(WORKER));
    expect((await call('/api/submit-batch', 'POST', BATCH_BODY)).status).toBe(403);
    expect(signHoursProof).not.toHaveBeenCalled();
  });

  it('signs nothing when the escrow cannot be read', async () => {
    mockUser.mockResolvedValue(employee(MANAGER));
    getEscrow.mockRejectedValue(new Error('rpc down'));
    expect((await call('/api/submit-batch', 'POST', BATCH_BODY)).status).toBe(502);
    expect(signHoursProof).not.toHaveBeenCalled();
  });
});

describe('POST /api/oracle/attest', () => {
  it("signs for the payment's worker", async () => {
    mockUser.mockResolvedValue(employee(WORKER));
    const res = await call('/api/oracle/attest', 'POST', ATTEST_BODY);
    expect(res.status).toBe(201);
    expect((await res.json()).signature).toBe('signature-hex');
  });

  it('signs for an ADMIN', async () => {
    mockUser.mockResolvedValue(ADMIN);
    expect((await call('/api/oracle/attest', 'POST', ATTEST_BODY)).status).toBe(201);
  });

  it('signs nothing for a signed-in wallet that is not the worker', async () => {
    mockUser.mockResolvedValue(employee(OTHER));
    expect((await call('/api/oracle/attest', 'POST', ATTEST_BODY)).status).toBe(403);
    expect(signHoursProof).not.toHaveBeenCalled();
  });

  it('signs nothing for a payment that does not exist', async () => {
    mockUser.mockResolvedValue(employee(WORKER));
    const res = await call('/api/oracle/attest', 'POST', { ...ATTEST_BODY, paymentId: 5 });
    expect(res.status).toBe(403);
    expect(signHoursProof).not.toHaveBeenCalled();
  });

  it('signs nothing when the escrow cannot be read', async () => {
    mockUser.mockResolvedValue(employee(WORKER));
    getEscrow.mockRejectedValue(new Error('rpc down'));
    expect((await call('/api/oracle/attest', 'POST', ATTEST_BODY)).status).toBe(502);
    expect(signHoursProof).not.toHaveBeenCalled();
  });
});
