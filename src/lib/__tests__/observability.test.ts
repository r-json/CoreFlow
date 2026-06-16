// @vitest-environment node
import { describe, it, expect, vi, afterEach } from 'vitest';
import { logger } from '../logger';
import { normalizeError, captureError } from '../observability';

afterEach(() => vi.restoreAllMocks());

describe('logger', () => {
  it('emits a single JSON line with level, msg, time and fields', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    logger.error('boom', { escrowId: 7 });
    expect(spy).toHaveBeenCalledTimes(1);
    const parsed = JSON.parse(spy.mock.calls[0][0] as string);
    expect(parsed.level).toBe('error');
    expect(parsed.msg).toBe('boom');
    expect(parsed.escrowId).toBe(7);
    expect(typeof parsed.time).toBe('string');
  });

  it('routes warn to console.warn', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    logger.warn('careful');
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe('observability', () => {
  it('normalizes Error and non-Error values', () => {
    expect(normalizeError(new Error('x')).message).toBe('x');
    expect(normalizeError('plain').name).toBe('NonError');
    expect(normalizeError(42).message).toBe('42');
  });

  it('captureError logs structurally without throwing', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => captureError(new Error('nope'), { route: 'test' })).not.toThrow();
    const parsed = JSON.parse(spy.mock.calls[0][0] as string);
    expect(parsed.msg).toBe('captured_error');
    expect(parsed.route).toBe('test');
    expect(parsed.err.message).toBe('nope');
  });
});
