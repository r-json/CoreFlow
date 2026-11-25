import { describe, expect, it } from 'vitest';
import { ClaimError, fromContractErrorCode } from '../src/index.js';

describe('ClaimError', () => {
  it('is an Error carrying a code and a next step', () => {
    const e = new ClaimError('ClaimExpired', 'too late');
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe('ClaimError');
    expect(e.code).toBe('ClaimExpired');
    expect(e.message).toBe('too late');
    expect(e.nextStep).toBe('Ask the issuer for a fresh claim.');
  });
  it('defaults the message to the code', () => {
    expect(new ClaimError('InvalidInput').message).toBe('InvalidInput');
  });
});

describe('fromContractErrorCode', () => {
  const table: [number, string, string][] = [
    [1101, 'IssuerNotRegistered', 'The signing key is not registered on this contract; register it or sign with a registered key.'],
    [1102, 'InvalidWindow', 'expires_at must be later than issued_at.'],
    [1103, 'ClaimExpired', 'Ask the issuer for a fresh claim.'],
    [1104, 'InvalidReplayFields', 'Sequence claims need a zero claim_id; unique-id claims need nonce = 0.'],
    [1105, 'NonceMismatch', 'Read the expected nonce for this scope and sign with it.'],
    [1106, 'ClaimAlreadyUsed', 'This claim was already accepted; it cannot be submitted twice.'],
    [1107, 'NonceOverflow', 'The sequence for this scope is exhausted; use a new subject.'],
    [1108, 'IssuerAlreadyRegistered', 'Nothing to do - the key is already registered.'],
    [1109, 'IssuerNotFound', 'The key to revoke or rotate is not registered.'],
  ];
  it.each(table)('maps %i to %s with the section 6 next step', (num, code, nextStep) => {
    const e = fromContractErrorCode(num);
    expect(e).toBeInstanceOf(ClaimError);
    expect(e?.code).toBe(code);
    expect(e?.nextStep).toBe(nextStep);
    expect(e?.message).toContain(String(num));
  });
  it('returns undefined outside 1101-1109', () => {
    for (const n of [0, 1, 1100, 1110, -1101, 1101.5, NaN]) expect(fromContractErrorCode(n)).toBeUndefined();
    expect(fromContractErrorCode('toString' as never)).toBeUndefined();
  });
});
