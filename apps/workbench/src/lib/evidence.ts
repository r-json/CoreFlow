import {
  ClaimError,
  claimFromJSON,
  claimToJSON,
  encodeClaim,
  fromHex,
  toHex,
  verifyClaim,
  type ClaimJSON,
} from '@coreflow/sdk';
import type { EvidenceRun, EvidenceStep } from './data';

export interface Reverification {
  /** The recorded claim verifies for the recorded network and contract at its issued_at. */
  signatureOk: boolean;
  /** The preimage rebuilt here is byte-identical to the one the run recorded. */
  preimageMatches: boolean;
  error?: string;
  claimJSON?: ClaimJSON;
  signatureHex?: string;
  contractId?: string;
  issuedAt?: bigint;
}

export const stepNamed = (run: EvidenceRun, name: string): EvidenceStep | undefined =>
  run.steps.find((s) => s.name === name);

/** The contract the run deployed and released against. */
export function contractOf(run: EvidenceRun): string | undefined {
  return run.contractId ?? (stepNamed(run, 'deploy')?.contractId as string | undefined);
}

/**
 * Re-check a recorded claim offline: rebuild its preimage for the network and
 * contract the run used, compare it with the recorded bytes, and verify the
 * signature at the claim's own issued_at. Nothing is sent to the network.
 */
export function reverifyRun(run: EvidenceRun): Reverification {
  const step = stepNamed(run, 'sign-claim');
  const contractId = contractOf(run);
  if (!step?.claim || !step.signatureHex || !contractId) {
    return {
      signatureOk: false,
      preimageMatches: false,
      error: 'The run did not record a claim, a signature and a contract.',
    };
  }
  try {
    const claim = claimFromJSON(step.claim);
    const ctx = { networkPassphrase: run.networkPassphrase, contractId };
    const preimageHex = toHex(encodeClaim(claim, ctx));
    let error: string | undefined;
    try {
      verifyClaim(claim, ctx, fromHex(step.signatureHex), { now: claim.issuedAt });
    } catch (e) {
      error = e instanceof ClaimError ? `${e.code}: ${e.message}` : String(e);
    }
    return {
      signatureOk: !error,
      preimageMatches: preimageHex === step.preimageHex,
      error,
      claimJSON: claimToJSON(claim),
      signatureHex: step.signatureHex,
      contractId,
      issuedAt: claim.issuedAt,
    };
  } catch (e) {
    return { signatureOk: false, preimageMatches: false, error: e instanceof ClaimError ? e.message : String(e) };
  }
}
