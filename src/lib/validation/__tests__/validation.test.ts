// @vitest-environment node
import { describe, it, expect, beforeEach } from 'vitest';
import {
  parseBody,
  createEscrowSchema,
  roleGrantSchema,
  attestSchema,
} from '../schemas';
import { rateLimit, __resetRateLimiter } from '../../ratelimit';

describe('parseBody / schemas', () => {
  it('accepts a valid escrow body and rejects bad amounts', () => {
    const ok = parseBody(createEscrowSchema, {
      workerPubKey: 'GWORKER',
      amountCents: 4200,
      rateCents: 250,
    });
    expect(ok.ok).toBe(true);

    const bad = parseBody(createEscrowSchema, {
      workerPubKey: 'GWORKER',
      amountCents: -1,
      rateCents: 250,
    });
    expect(bad.ok).toBe(false);
  });

  it('rejects a zero/negative onChainId (no 0-collision can occur)', () => {
    const r = parseBody(createEscrowSchema, {
      onChainId: 0,
      workerPubKey: 'GWORKER',
      amountCents: 10,
      rateCents: 1,
    });
    expect(r.ok).toBe(false);
  });

  it('validates role enum', () => {
    const good = parseBody(roleGrantSchema, {
      walletAddress: 'G' + 'A'.repeat(55),
      role: 'manager',
    });
    expect(good.ok).toBe(true);

    const bad = parseBody(roleGrantSchema, {
      walletAddress: 'G' + 'A'.repeat(55),
      role: 'superuser',
    });
    expect(bad.ok).toBe(false);
  });

  it('requires positive hours in attestation', () => {
    expect(parseBody(attestSchema, { onChainId: 1, paymentId: 0, hoursLogged: 0, nonce: 0 }).ok).toBe(false);
    expect(parseBody(attestSchema, { onChainId: 1, paymentId: 0, hoursLogged: 40, nonce: 0 }).ok).toBe(true);
  });
});

describe('rateLimit', () => {
  beforeEach(() => __resetRateLimiter());

  it('allows up to the limit then blocks', () => {
    const key = 'test';
    expect(rateLimit(key, 3, 60_000).ok).toBe(true);
    expect(rateLimit(key, 3, 60_000).ok).toBe(true);
    expect(rateLimit(key, 3, 60_000).ok).toBe(true);
    const blocked = rateLimit(key, 3, 60_000);
    expect(blocked.ok).toBe(false);
    expect(blocked.retryAfter).toBeGreaterThan(0);
  });

  it('tracks keys independently', () => {
    expect(rateLimit('a', 1, 60_000).ok).toBe(true);
    expect(rateLimit('a', 1, 60_000).ok).toBe(false);
    expect(rateLimit('b', 1, 60_000).ok).toBe(true);
  });
});
