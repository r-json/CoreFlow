import { U64_MAX, fromHex, isZero, toHex } from './bytes.js';
import { assertReplayFields, claimWireValues } from './encode.js';
import { ClaimError } from './errors.js';
import type { Claim } from './types.js';

/**
 * Portable JSON form of a claim. The keys are the field names of the
 * on-chain `Claim` struct, so the same object can be handed to a relayer,
 * stored next to a business record, or passed to `stellar contract invoke`.
 *
 * Byte fields are 64 lower-case hex characters. u64 fields are decimal
 * strings, because JSON numbers lose precision above 2^53.
 */
export interface ClaimJSON {
  issuer: string;
  claim_type: string;
  subject: string;
  payload_hash: string;
  /** 0 = raw, 1 = XDR. */
  payload_encoding: number;
  /** 0 = sequence, 1 = unique-id. */
  replay_mode: number;
  nonce: string;
  claim_id: string;
  issued_at: string;
  expires_at: string;
}

const KEYS = [
  'issuer',
  'claim_type',
  'subject',
  'payload_hash',
  'payload_encoding',
  'replay_mode',
  'nonce',
  'claim_id',
  'issued_at',
  'expires_at',
] as const;

/**
 * Serialize a claim to its portable JSON form.
 *
 * The inactive replay field is written as zero, exactly as in the preimage.
 *
 * @example
 * JSON.stringify(claimToJSON(claim));
 *
 * @throws {ClaimError} `InvalidInput` for a malformed claim; `InvalidReplayFields`
 *   when an untyped claim carries a non-zero inactive replay field, which the
 *   JSON could not represent faithfully.
 */
export function claimToJSON(claim: Claim): ClaimJSON {
  const { encoding, mode, nonce, claimId } = claimWireValues(claim);
  assertReplayFields(claim);
  return {
    issuer: toHex(claim.issuer),
    claim_type: toHex(claim.claimType),
    subject: toHex(claim.subject),
    payload_hash: toHex(claim.payloadHash),
    payload_encoding: encoding,
    replay_mode: mode,
    nonce: nonce.toString(),
    claim_id: toHex(claimId),
    issued_at: claim.issuedAt.toString(),
    expires_at: claim.expiresAt.toString(),
  };
}

function hex32(value: unknown, key: string): Uint8Array {
  if (typeof value !== 'string' || !/^[0-9a-fA-F]{64}$/.test(value)) {
    throw new ClaimError('InvalidInput', `${key}: expected 64 hex characters (32 bytes)`);
  }
  return fromHex(value);
}

function u64(value: unknown, key: string): bigint {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new ClaimError('InvalidInput', `${key}: numbers must be non-negative safe integers; use a decimal string`);
    }
    return BigInt(value);
  }
  if (typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value)) {
    const n = BigInt(value);
    if (n <= U64_MAX) return n;
  }
  throw new ClaimError('InvalidInput', `${key}: expected a decimal u64 (string or safe integer)`);
}

function flag(value: unknown, key: string, meaning: string): 0 | 1 {
  if (value === 0 || value === 1) return value;
  throw new ClaimError('InvalidInput', `${key}: expected 0 or 1 (${meaning})`);
}

/**
 * Parse the portable JSON form of a claim (an object, or a JSON string).
 *
 * u64 fields accept decimal strings or safe-integer numbers, so the records
 * written by `stellar contract invoke` scripts parse as well. Unknown keys are
 * rejected, which catches camelCase typos such as `claimType`.
 *
 * An inactive replay field that is not zero is kept on the returned object
 * rather than dropped, so `verifyClaim` reports `InvalidReplayFields` exactly
 * as the contract would (error 1104).
 *
 * @throws {ClaimError} `InvalidInput` for a missing, unknown or malformed field.
 */
export function claimFromJSON(json: unknown): Claim {
  let obj: unknown = json;
  if (typeof json === 'string') {
    try {
      obj = JSON.parse(json);
    } catch {
      throw new ClaimError('InvalidInput', 'claim JSON: not valid JSON');
    }
  }
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) {
    throw new ClaimError('InvalidInput', 'claim JSON: expected an object');
  }
  const record = obj as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!(KEYS as readonly string[]).includes(key)) {
      throw new ClaimError('InvalidInput', `claim JSON: unknown key "${key}" (expected ${KEYS.join(', ')})`);
    }
  }
  for (const key of KEYS) {
    if (!(key in record)) throw new ClaimError('InvalidInput', `claim JSON: missing key "${key}"`);
  }

  // Parsed in key order so the first malformed field is the one reported.
  const issuer = hex32(record.issuer, 'issuer');
  const claimType = hex32(record.claim_type, 'claim_type');
  const subject = hex32(record.subject, 'subject');
  const payloadHash = hex32(record.payload_hash, 'payload_hash');
  const encoding = flag(record.payload_encoding, 'payload_encoding', '0 = raw, 1 = XDR');
  const mode = flag(record.replay_mode, 'replay_mode', '0 = sequence, 1 = unique-id');
  const nonce = u64(record.nonce, 'nonce');
  const claimId = hex32(record.claim_id, 'claim_id');
  const issuedAt = u64(record.issued_at, 'issued_at');
  const expiresAt = u64(record.expires_at, 'expires_at');

  let replay: Claim['replay'];
  if (mode === 0) {
    replay = { mode: 'sequence', nonce };
    if (!isZero(claimId)) (replay as { claimId?: Uint8Array }).claimId = claimId;
  } else {
    replay = { mode: 'unique-id', claimId };
    if (nonce !== 0n) (replay as { nonce?: bigint }).nonce = nonce;
  }

  return {
    issuer,
    claimType,
    subject,
    payloadHash,
    payloadEncoding: encoding === 0 ? 'raw' : 'xdr',
    replay,
    issuedAt,
    expiresAt,
  };
}
