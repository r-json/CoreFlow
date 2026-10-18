import { Keypair, StrKey } from '@stellar/stellar-base';
import { assertBytes, assertU64 } from './bytes.js';
import { assertReplayFields, encodeClaim } from './encode.js';
import { ClaimError } from './errors.js';
import type { Claim, ClaimContext } from './types.js';

function toUnixSeconds(now: bigint | number | undefined): bigint {
  if (now === undefined) return BigInt(Math.floor(Date.now() / 1000));
  if (typeof now === 'number') {
    if (!Number.isSafeInteger(now) || now < 0) {
      throw new ClaimError('InvalidInput', 'opts.now: expected a non-negative integer number of seconds');
    }
    return BigInt(now);
  }
  assertU64(now, 'opts.now');
  return now;
}

/**
 * Pre-verify a claim off-chain, in the same order as the contract: window,
 * expiry, replay fields, signature. Returns normally when the claim is valid
 * and throws a `ClaimError` otherwise.
 *
 * This cannot check what lives on-chain: whether the issuer is registered,
 * and whether the nonce or claim id was already consumed. The contract still
 * enforces both (`IssuerNotRegistered`, `NonceMismatch`, `ClaimAlreadyUsed`).
 *
 * A claim is valid while `now <= expiresAt`; `now > expiresAt` is `ClaimExpired`.
 *
 * @example
 * try {
 *   verifyClaim(claim, ctx, signature);
 * } catch (e) {
 *   if (e instanceof ClaimError) console.log(e.code, e.nextStep);
 * }
 *
 * @param opts.now Unix seconds to treat as the current time; defaults to the system clock.
 * @throws {ClaimError} `InvalidWindow`, `ClaimExpired`, `InvalidReplayFields`,
 *   `InvalidSignature`, or `InvalidInput` for malformed arguments.
 */
export function verifyClaim(
  claim: Claim,
  ctx: ClaimContext,
  signature: Uint8Array,
  opts?: { now?: bigint | number },
): void {
  assertBytes(signature, 64, 'signature');
  const now = toUnixSeconds(opts?.now);
  // Validates the claim and context shape (InvalidInput) before any check below.
  const preimage = encodeClaim(claim, ctx);

  // check:window begin
  if (claim.expiresAt <= claim.issuedAt) {
    throw new ClaimError('InvalidWindow', 'expiresAt must be later than issuedAt');
  }
  // check:window end

  // check:expiry begin
  if (now > claim.expiresAt) {
    throw new ClaimError('ClaimExpired', `claim expired at ${claim.expiresAt}, now is ${now}`);
  }
  // check:expiry end

  // check:replay-fields begin
  assertReplayFields(claim);
  // check:replay-fields end

  // check:signature begin
  const publicKey = Keypair.fromPublicKey(StrKey.encodeEd25519PublicKey(claim.issuer as never));
  if (!publicKey.verify(preimage as never, signature as never)) {
    throw new ClaimError('InvalidSignature', 'signature does not match this claim, network and contract');
  }
  // check:signature end
}
