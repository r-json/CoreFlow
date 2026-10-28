import { ClaimError, fromContractErrorCode, type ClaimErrorCode } from '@coreflow/sdk';

export type ErrorScope = 'kit' | 'sdk' | 'host' | 'example';

export interface ErrorEntry {
  scope: ErrorScope;
  /** Contract error number, when the failure has one. */
  code?: number;
  name: string;
  meaning: string;
  nextStep: string;
  /** Verification step (claim-format.md section 5) that raises it. */
  step?: number;
}

const nextStep = (code: ClaimErrorCode) => new ClaimError(code).nextStep;

const KIT_MEANINGS: Record<number, [string, number | undefined]> = {
  1101: ["The signing key is not in this contract's issuer registry.", 1],
  1102: ['expires_at is not later than issued_at.', 2],
  1103: ['The ledger time is past expires_at.', 3],
  1104: [
    'A sequence claim carries a claim_id, a unique-id claim carries a nonce, or payload_encoding is not 0 or 1.',
    4,
  ],
  1105: ['The nonce is not the next expected value for (issuer, claim_type, subject).', 5],
  1106: ['This (issuer, claim_id) was already accepted.', 5],
  1107: ['The sequence for this scope reached the u64 maximum.', 7],
  1108: ['register was called for a key that is already registered.', undefined],
  1109: ['revoke or rotate was called for a key that is not registered.', undefined],
};

/** coreflow-attest errors, numbered 1101-1109 (claim-format.md section 6). */
export const KIT_ERRORS: ErrorEntry[] = Object.entries(KIT_MEANINGS).map(([code, [meaning, step]]) => {
  const error = fromContractErrorCode(Number(code))!;
  return { scope: 'kit', code: Number(code), name: error.code, meaning, nextStep: error.nextStep, step };
});

/** Failures @coreflow/sdk reports off-chain that have no contract error number. */
export const SDK_ERRORS: ErrorEntry[] = [
  {
    scope: 'sdk',
    name: 'InvalidSignature',
    meaning:
      'The signature does not match the claim under this network and contract. On-chain there is no error number: the host aborts the whole transaction (see Error(Crypto, InvalidInput) below).',
    nextStep: nextStep('InvalidSignature'),
    step: 6,
  },
  {
    scope: 'sdk',
    name: 'IssuerMismatch',
    meaning: 'signClaim was given a secret key whose public key is not claim.issuer.',
    nextStep: nextStep('IssuerMismatch'),
  },
  {
    scope: 'sdk',
    name: 'InvalidInput',
    meaning:
      'An argument has the wrong type or length, an integer does not fit in a u64, or an id is not a valid strkey.',
    nextStep: nextStep('InvalidInput'),
  },
];

/** What a bad signature looks like in a failed simulation or transaction. */
export const HOST_ERRORS: ErrorEntry[] = [
  {
    scope: 'host',
    name: 'Error(Crypto, InvalidInput)',
    meaning:
      "The host's ed25519_verify rejected a signature and aborted the invocation, so no contract error number is returned. Seen in recorded Testnet runs of the payroll reference contract.",
    nextStep:
      'Run verifyClaim (or the Verify page) with the same claim, network and contract to find which check fails before you submit.',
    step: 6,
  },
];

/** marketplace-hold's own errors. Numbers below 1101 belong to each host contract. */
export const EXAMPLE_ERRORS: ErrorEntry[] = [
  ['HoldNotFound', 'No hold has this id.', 'Check the hold id returned by open_hold.'],
  ['HoldNotOpen', 'The hold was already released or refunded.', 'Nothing to release; read the hold with get_hold.'],
  [
    'WrongClaimType',
    'The claim is not a marketplace.delivery.v1 claim.',
    'Sign the claim with claim type "marketplace.delivery.v1".',
  ],
  [
    'WrongSubject',
    "The claim's subject is not this hold's order.",
    'Sign with subject = SHA-256 of the order the buyer locked.',
  ],
  [
    'TooEarly',
    'The refund deadline has not passed yet.',
    'Wait until after refund_after, or release with a valid claim.',
  ],
  ['InvalidAmount', 'The amount is zero or negative.', 'Open the hold with a positive amount.'],
  ['SameParty', 'The buyer and the seller are the same address.', 'Use different buyer and seller addresses.'],
].map(([name, meaning, next], i) => ({
  scope: 'example' as const,
  code: i + 1,
  name: name!,
  meaning: meaning!,
  nextStep: next!,
}));

export const ALL_ERRORS: ErrorEntry[] = [...KIT_ERRORS, ...SDK_ERRORS, ...HOST_ERRORS, ...EXAMPLE_ERRORS];

/** The contract error number for an SDK error code, when there is one. */
export function onChainCodeFor(code: ClaimErrorCode): number | undefined {
  return KIT_ERRORS.find((e) => e.name === code)?.code;
}

export interface ErrorLookup {
  /** What was recognised in the input, e.g. "Error(Contract, #1106)". */
  matched: string;
  entries: ErrorEntry[];
  /** Shown when the number is outside the kit's range. */
  caveat?: string;
}

/**
 * Recognise an error in text pasted from stellar-cli, an RPC response or a
 * test failure: `Error(Contract, #1106)`, `#1106`, `1106`, `ClaimAlreadyUsed`
 * or `Error(Crypto, InvalidInput)`.
 */
export function lookupError(input: string): ErrorLookup | undefined {
  const text = input.trim();
  if (!text) return undefined;

  const crypto = /Error\(\s*Crypto\s*,\s*InvalidInput\s*\)/i.exec(text);
  if (crypto) return { matched: crypto[0], entries: HOST_ERRORS };

  const contract = /Error\(\s*Contract\s*,\s*#?(\d+)\s*\)/i.exec(text) ?? /#(\d+)\b/.exec(text) ?? /^(\d+)$/.exec(text);
  if (contract) {
    const code = Number(contract[1]);
    const kit = KIT_ERRORS.filter((e) => e.code === code);
    if (kit.length) return { matched: contract[0], entries: kit };
    const example = EXAMPLE_ERRORS.filter((e) => e.code === code);
    return {
      matched: contract[0],
      entries: example,
      caveat:
        code < 1101
          ? `Contract error ${code} is defined by the contract you called, not by coreflow-attest.${example.length ? ' In the marketplace-hold example it means:' : ''}`
          : `Contract error ${code} is not a coreflow-attest code (those are 1101-1109).`,
    };
  }

  const byName = ALL_ERRORS.filter((e) => e.name.toLowerCase() === text.toLowerCase());
  if (byName.length) return { matched: text, entries: byName };
  return undefined;
}
