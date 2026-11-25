/** Every failure `@coreflow/sdk` can report. Codes 1101-1109 mirror the on-chain error codes. */
export type ClaimErrorCode =
  | 'InvalidInput'
  | 'IssuerMismatch'
  | 'InvalidSignature'
  | 'IssuerNotRegistered'
  | 'InvalidWindow'
  | 'ClaimExpired'
  | 'InvalidReplayFields'
  | 'NonceMismatch'
  | 'ClaimAlreadyUsed'
  | 'NonceOverflow'
  | 'IssuerAlreadyRegistered'
  | 'IssuerNotFound';

const NEXT_STEPS: Record<ClaimErrorCode, string> = {
  InvalidInput:
    'Check the argument against the documented type: byte arrays have fixed lengths, integers must fit in a u64, ids must be valid strkeys.',
  IssuerMismatch: 'Sign with the secret key that matches claim.issuer, or set claim.issuer to the signing key.',
  InvalidSignature:
    'The signature does not match this claim under this network and contract. Re-sign with the issuer key using the same claim and context.',
  IssuerNotRegistered:
    'The signing key is not registered on this contract; register it or sign with a registered key.',
  InvalidWindow: 'expires_at must be later than issued_at.',
  ClaimExpired: 'Ask the issuer for a fresh claim.',
  InvalidReplayFields:
    'Sequence claims need a zero claim_id; unique-id claims need nonce = 0.',
  NonceMismatch: 'Read the expected nonce for this scope and sign with it.',
  ClaimAlreadyUsed: 'This claim was already accepted; it cannot be submitted twice.',
  NonceOverflow: 'The sequence for this scope is exhausted; use a new subject.',
  IssuerAlreadyRegistered: 'Nothing to do - the key is already registered.',
  IssuerNotFound: 'The key to revoke or rotate is not registered.',
};

/** On-chain error code (1101-1109) to name, per claim-format.md section 6. */
const CONTRACT_CODES: Readonly<Record<number, ClaimErrorCode>> = {
  1101: 'IssuerNotRegistered',
  1102: 'InvalidWindow',
  1103: 'ClaimExpired',
  1104: 'InvalidReplayFields',
  1105: 'NonceMismatch',
  1106: 'ClaimAlreadyUsed',
  1107: 'NonceOverflow',
  1108: 'IssuerAlreadyRegistered',
  1109: 'IssuerNotFound',
};

/**
 * Error thrown by every function in this package.
 *
 * `code` is stable and safe to branch on; `nextStep` is a human-readable
 * instruction for whoever has to fix the problem.
 */
export class ClaimError extends Error {
  readonly code: ClaimErrorCode;
  readonly nextStep: string;

  constructor(code: ClaimErrorCode, message?: string) {
    super(message ?? code);
    this.name = 'ClaimError';
    this.code = code;
    this.nextStep = NEXT_STEPS[code];
  }
}

/**
 * Map a numeric error code returned by a contract (1101-1109) to a `ClaimError`.
 * Returns `undefined` for any other number.
 *
 * @example
 * const err = fromContractErrorCode(1103);
 * err?.code;     // 'ClaimExpired'
 * err?.nextStep; // 'Ask the issuer for a fresh claim.'
 */
export function fromContractErrorCode(code: number): ClaimError | undefined {
  const name = Object.hasOwn(CONTRACT_CODES, code) ? CONTRACT_CODES[code] : undefined;
  if (name === undefined) return undefined;
  return new ClaimError(name, `${name} (contract error ${code})`);
}
