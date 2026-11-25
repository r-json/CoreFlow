import { assertBytes, assertU64, isZero } from './bytes.js';
import { ClaimError } from './errors.js';
import { contractDigest, networkId } from './hash.js';
import type { Claim, ClaimContext } from './types.js';

/** Exact size of the signed preimage in bytes. */
export const PREIMAGE_LENGTH = 256;

const MAGIC = [0x43, 0x46, 0x43, 0x4c]; // "CFCL"
const WIRE_VERSION = 1;

/**
 * @internal Validate the shape of a claim and return its wire values. Throws `InvalidInput`.
 * The inactive replay field is returned as zero.
 */
export function claimWireValues(claim: Claim): { encoding: number; mode: number; nonce: bigint; claimId: Uint8Array } {
  if (typeof claim !== 'object' || claim === null) throw new ClaimError('InvalidInput', 'claim: expected an object');
  assertBytes(claim.issuer, 32, 'claim.issuer');
  assertBytes(claim.claimType, 32, 'claim.claimType');
  assertBytes(claim.subject, 32, 'claim.subject');
  assertBytes(claim.payloadHash, 32, 'claim.payloadHash');
  assertU64(claim.issuedAt, 'claim.issuedAt');
  assertU64(claim.expiresAt, 'claim.expiresAt');

  let encoding: number;
  if (claim.payloadEncoding === 'raw') encoding = 0;
  else if (claim.payloadEncoding === 'xdr') encoding = 1;
  else throw new ClaimError('InvalidInput', "claim.payloadEncoding: expected 'raw' or 'xdr'");

  const replay = claim.replay as Claim['replay'] | undefined;
  if (replay?.mode === 'sequence') {
    assertU64(replay.nonce, 'claim.replay.nonce');
    return { encoding, mode: 0, nonce: replay.nonce, claimId: new Uint8Array(32) };
  }
  if (replay?.mode === 'unique-id') {
    assertBytes(replay.claimId, 32, 'claim.replay.claimId');
    return { encoding, mode: 1, nonce: 0n, claimId: replay.claimId };
  }
  throw new ClaimError('InvalidInput', "claim.replay.mode: expected 'sequence' or 'unique-id'");
}

/**
 * Throw `InvalidReplayFields` when the inactive replay field is set:
 * sequence claims must carry no non-zero `claimId`, unique-id claims no non-zero `nonce`.
 * The typed `Claim` cannot express this, so it guards untyped (JavaScript or JSON) callers.
 */
export function assertReplayFields(claim: Claim): void {
  const replay = claim.replay as { mode?: string; nonce?: unknown; claimId?: unknown } | undefined;
  if (replay?.mode === 'sequence' && replay.claimId !== undefined) {
    if (!(replay.claimId instanceof Uint8Array) || !isZero(replay.claimId)) {
      throw new ClaimError('InvalidReplayFields', 'sequence claims must not carry a claim_id');
    }
  }
  // JSON and plain JavaScript callers pass 0 as a number; `0 !== 0n` is true.
  if (replay?.mode === 'unique-id' && replay.nonce !== undefined && replay.nonce !== 0n && replay.nonce !== 0) {
    throw new ClaimError('InvalidReplayFields', 'unique-id claims must carry nonce 0');
  }
}

/**
 * Build the 256-byte preimage the issuer signs (claim-format.md section 2).
 *
 * The inactive replay field is written as zero: `sequence` claims get an
 * all-zero `claim_id`, `unique-id` claims get `nonce = 0`.
 *
 * @example
 * const preimage = encodeClaim(claim, { networkPassphrase: Networks.TESTNET, contractId: 'C...' });
 * preimage.length; // 256
 *
 * @throws {ClaimError} `InvalidInput` for a wrong byte length, an out-of-range u64 or a bad strkey.
 */
export function encodeClaim(claim: Claim, ctx: ClaimContext): Uint8Array {
  const { encoding, mode, nonce, claimId } = claimWireValues(claim);
  if (typeof ctx !== 'object' || ctx === null) throw new ClaimError('InvalidInput', 'ctx: expected an object');
  // Both digests validate their input and throw InvalidInput.
  const network = networkId(ctx.networkPassphrase);
  const contract = contractDigest(ctx.contractId);

  const out = new Uint8Array(PREIMAGE_LENGTH);
  const view = new DataView(out.buffer);
  out.set(MAGIC, 0);
  view.setUint16(4, WIRE_VERSION);
  // check:network-binding begin
  out.set(network, 6);
  // check:network-binding end
  // check:contract-binding begin
  out.set(contract, 38);
  // check:contract-binding end
  out.set(claim.issuer, 70);
  out.set(claim.claimType, 102);
  out.set(claim.subject, 134);
  out.set(claim.payloadHash, 166);
  out[198] = encoding;
  out[199] = mode;
  view.setBigUint64(200, nonce);
  out.set(claimId, 208);
  view.setBigUint64(240, claim.issuedAt);
  view.setBigUint64(248, claim.expiresAt);
  return out;
}
