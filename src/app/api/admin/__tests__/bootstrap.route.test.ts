// @vitest-environment node
/**
 * Abuse-resistance tests for POST /api/admin/bootstrap.
 *
 * This endpoint is exempt from session auth by necessity — there is no admin to
 * authenticate as yet — so BOOTSTRAP_SECRET is the only control between an
 * anonymous caller and full platform control. It previously had no rate limit
 * and used a short-circuiting `!==` comparison.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@/lib/db/prisma', () => ({
  default: { user: { upsert: vi.fn() }, auditLog: { create: vi.fn() } },
}));
vi.mock('@/lib/audit', () => ({ audit: vi.fn() }));

import { POST } from '../bootstrap/route';
import prisma from '@/lib/db/prisma';
import { __resetRateLimiter } from '@/lib/ratelimit';

const mockPrisma = prisma as any;

const GOOD_SECRET = 'x'.repeat(48);
const WALLET = 'G' + 'A'.repeat(55);

function req(secret: string | undefined, ip = '203.0.113.10') {
  return new Request('http://localhost/api/admin/bootstrap', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-forwarded-for': ip,
      ...(secret === undefined ? {} : { 'x-bootstrap-secret': secret }),
    },
    body: JSON.stringify({ walletAddress: WALLET }),
  }) as any;
}

describe('POST /api/admin/bootstrap', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetRateLimiter();
    process.env.BOOTSTRAP_SECRET = GOOD_SECRET;
    mockPrisma.user.upsert.mockResolvedValue({
      id: 'u1', walletAddress: WALLET, role: 'ADMIN',
    });
  });
  afterEach(() => {
    delete process.env.BOOTSTRAP_SECRET;
  });

  it('promotes the target wallet when the secret is correct', async () => {
    const res = await POST(req(GOOD_SECRET));
    expect(res.status).toBe(200);
    expect(mockPrisma.user.upsert).toHaveBeenCalled();
  });

  it('404s a wrong secret without revealing that the endpoint exists', async () => {
    const res = await POST(req('y'.repeat(48)));
    expect(res.status).toBe(404);
    expect(mockPrisma.user.upsert).not.toHaveBeenCalled();
  });

  it('404s when the secret is not configured', async () => {
    delete process.env.BOOTSTRAP_SECRET;
    expect((await POST(req(GOOD_SECRET))).status).toBe(404);
  });

  it('refuses to operate with a secret too short to resist guessing', async () => {
    // A short secret reads as protection while providing none, so the endpoint
    // disables itself rather than accepting it.
    process.env.BOOTSTRAP_SECRET = 'short';
    const res = await POST(req('short'));
    expect(res.status).toBe(404);
    expect(mockPrisma.user.upsert).not.toHaveBeenCalled();
  });

  it('throttles brute-force guessing from one IP', async () => {
    // Without a brake the secret is guessable at network speed.
    for (let i = 0; i < 5; i++) {
      expect((await POST(req(`wrong-${i}`.padEnd(48, 'z')))).status).toBe(404);
    }

    // Budget exhausted: even the CORRECT secret is now refused from this IP.
    // That is the point — the limiter must not be bypassable by guessing right.
    const res = await POST(req(GOOD_SECRET));
    expect(res.status).toBe(404);
    expect(mockPrisma.user.upsert).not.toHaveBeenCalled();
  });

  it('counts the budget per IP, not globally', async () => {
    for (let i = 0; i < 5; i++) await POST(req('wrong'.padEnd(48, 'z'), '198.51.100.1'));

    // A different client is unaffected by the first one's exhausted budget.
    const res = await POST(req(GOOD_SECRET, '198.51.100.2'));
    expect(res.status).toBe(200);
  });

  it('rejects a non-string secret without throwing', async () => {
    const r = new Request('http://localhost/api/admin/bootstrap', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-forwarded-for': '203.0.113.99' },
      body: JSON.stringify({ walletAddress: WALLET, bootstrapSecret: { evil: true } }),
    }) as any;
    expect((await POST(r)).status).toBe(404);
  });
});
