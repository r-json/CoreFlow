import {
  ClaimError,
  encodeClaim,
  toHex,
  verifyClaim,
  type Claim,
  type ClaimContext,
  type ClaimErrorCode,
} from '@coreflow/sdk';
import { onChainCodeFor } from './errorCatalog';

export type StepStatus = 'pass' | 'fail' | 'not-reached' | 'contract-only';

export interface VerificationStep {
  /** Position in claim-format.md section 5. */
  n: number;
  id: 'registry' | 'window' | 'expiry' | 'replay-fields' | 'replay-state' | 'signature' | 'consume';
  title: string;
  /** What the check requires. */
  rule: string;
  status: StepStatus;
  /** Why a contract-only step cannot be checked off-chain. */
  note?: string;
}

export interface VerificationFailure {
  code: ClaimErrorCode;
  message: string;
  nextStep: string;
  /** The contract's error number for the same failure, when there is one. */
  onChainCode?: number;
}

export interface VerificationReport {
  /** True when every check that can run off-chain passed. */
  ok: boolean;
  steps: VerificationStep[];
  failure?: VerificationFailure;
  /** Malformed input: no check ran. */
  inputError?: VerificationFailure;
  /** The 256 bytes the signature was checked against, when the input was well-formed. */
  preimageHex?: string;
  now: bigint;
}

const STEPS: Omit<VerificationStep, 'status'>[] = [
  {
    n: 1,
    id: 'registry',
    title: 'Issuer registered',
    rule: "The issuer key is in the contract's issuer registry (1101).",
    note: 'Registry state lives on-chain. Only the contract can check it.',
  },
  { n: 2, id: 'window', title: 'Validity window', rule: 'expires_at is later than issued_at (1102).' },
  { n: 3, id: 'expiry', title: 'Not expired', rule: 'The current time is at or before expires_at (1103).' },
  {
    n: 4,
    id: 'replay-fields',
    title: 'Replay fields',
    rule: 'Sequence claims carry a zero claim_id; unique-id claims carry nonce 0 (1104).',
  },
  {
    n: 5,
    id: 'replay-state',
    title: 'Not replayed',
    rule: 'Sequence: nonce equals the next expected value (1105). Unique-id: never accepted before (1106).',
    note: 'Replay state lives on-chain. Only the contract can check it.',
  },
  {
    n: 6,
    id: 'signature',
    title: 'Signature',
    rule: 'Ed25519 over the 256-byte preimage, rebuilt for this network and contract.',
  },
  {
    n: 7,
    id: 'consume',
    title: 'Consume',
    rule: 'The contract stores nonce + 1 (overflow is 1107) or records the claim_id.',
    note: 'A write the contract makes when it accepts the claim.',
  },
];

/** Off-chain checks in the order @coreflow/sdk runs them, keyed by the error each one raises. */
const OFF_CHAIN: [VerificationStep['id'], ClaimErrorCode][] = [
  ['window', 'InvalidWindow'],
  ['expiry', 'ClaimExpired'],
  ['replay-fields', 'InvalidReplayFields'],
  ['signature', 'InvalidSignature'],
];

function failureOf(error: ClaimError): VerificationFailure {
  return {
    code: error.code,
    message: error.message,
    nextStep: error.nextStep,
    onChainCode: onChainCodeFor(error.code),
  };
}

/**
 * Run `verifyClaim` and lay the outcome over the verification order of
 * claim-format.md section 5. `verifyClaim` stops at the first failing check,
 * so checks after it are reported as not reached, not as passed.
 */
export function runVerification(
  claim: Claim,
  ctx: ClaimContext,
  signature: Uint8Array,
  now: bigint,
): VerificationReport {
  let preimageHex: string | undefined;
  try {
    preimageHex = toHex(encodeClaim(claim, ctx));
  } catch (e) {
    if (!(e instanceof ClaimError)) throw e;
    return {
      ok: false,
      steps: STEPS.map((s) => ({ ...s, status: s.note ? 'contract-only' : 'not-reached' })),
      inputError: failureOf(e),
      now,
    };
  }

  let failure: VerificationFailure | undefined;
  let inputError: VerificationFailure | undefined;
  try {
    verifyClaim(claim, ctx, signature, { now });
  } catch (e) {
    if (!(e instanceof ClaimError)) throw e;
    if (e.code === 'InvalidInput') inputError = failureOf(e);
    else failure = failureOf(e);
  }

  const failedAt = failure ? OFF_CHAIN.findIndex(([, code]) => code === failure!.code) : -1;
  const steps = STEPS.map((s): VerificationStep => {
    if (s.note) return { ...s, status: 'contract-only' };
    if (inputError) return { ...s, status: 'not-reached' };
    const index = OFF_CHAIN.findIndex(([id]) => id === s.id);
    // A failure no step owns: claim nothing about the steps.
    if (failure && failedAt === -1) return { ...s, status: 'not-reached' };
    if (failedAt === -1) return { ...s, status: 'pass' };
    if (index < failedAt) return { ...s, status: 'pass' };
    if (index === failedAt) return { ...s, status: 'fail' };
    return { ...s, status: 'not-reached' };
  });

  return { ok: !failure && !inputError, steps, failure, inputError, preimageHex, now };
}
