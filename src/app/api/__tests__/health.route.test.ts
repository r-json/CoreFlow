// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db/prisma', () => {
  const prisma = { $queryRaw: vi.fn() };
  return { default: prisma };
});

import { GET as liveness } from '../health/route';
import { GET as readiness } from '../health/ready/route';
import prisma from '@/lib/db/prisma';

const mockPrisma = prisma as any;

describe('health endpoints', () => {
  beforeEach(() => vi.clearAllMocks());

  it('liveness returns 200 ok', async () => {
    const res = await liveness();
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe('ok');
  });

  it('readiness returns 200 when the DB is reachable', async () => {
    mockPrisma.$queryRaw.mockResolvedValue([{ '?column?': 1 }]);
    const res = await readiness();
    expect(res.status).toBe(200);
    expect((await res.json()).checks.db).toBe('ok');
  });

  it('readiness returns 503 when the DB is down', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mockPrisma.$queryRaw.mockRejectedValue(new Error('no db'));
    const res = await readiness();
    expect(res.status).toBe(503);
    expect((await res.json()).checks.db).toBe('fail');
  });
});
