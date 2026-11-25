/**
 * Request validation schemas (zod) + a small helper for route handlers.
 * Centralizes input validation so every mutating endpoint rejects malformed
 * input with a consistent 400 envelope instead of trusting the body shape.
 */

import { z, type ZodSchema } from 'zod';

export const stellarAddress = z
  .string()
  .regex(/^[GC][A-Z2-7]{55}$/, 'must be a valid Stellar address (G… or C…, 56 chars)');

export const challengeSchema = z.object({
  walletAddress: stellarAddress,
});

export const verifySchema = z.object({
  walletAddress: stellarAddress,
  signature: z.string().min(1, 'signature is required'),
});

/**
 * Base-unit amounts arrive as decimal STRINGS, not numbers.
 *
 * JSON has no bigint, and a large payroll batch in 7-decimal base units
 * exceeds Number.MAX_SAFE_INTEGER (2^53-1) at roughly 900 million units of the
 * asset — where a JSON number would start silently rounding. A string parsed
 * with BigInt is exact at any size.
 */
export const baseUnitString = z
  .string()
  .regex(/^\d+$/, 'must be a whole number of base units, as a string')
  .refine((v) => BigInt(v) > 0n, 'must be greater than zero');

export const createEscrowSchema = z.object({
  onChainId: z.number().int().positive().nullish(),
  workerPubKey: z.string().min(1),
  financeApprover: stellarAddress.nullish(),
  amountBaseUnits: baseUnitString,
  rateBaseUnits: baseUnitString,
  assetDecimals: z.number().int().min(0).max(18).default(7),
  tokenAddress: z.string().min(1).nullish(),
});

export const statusPatchSchema = z
  .object({
    status: z.string().min(1).optional(),
    managerApproved: z.boolean().optional(),
    financeApproved: z.boolean().optional(),
    rejectionReason: z.string().optional(),
  })
  .refine(
    (v) =>
      v.status !== undefined ||
      v.managerApproved !== undefined ||
      v.financeApproved !== undefined ||
      v.rejectionReason !== undefined,
    {
      message: 'at least one of status, managerApproved, financeApproved, rejectionReason is required',
    }
  );

export const hoursSchema = z.object({
  onChainId: z.number().int().min(0),
  paymentId: z.number().int().min(0),
  hoursLogged: z.number().int().positive(),
  // Required + unique in the DB — prevents double-counting the same on-chain proof.
  txHash: z.string().min(1),
});

export const attestSchema = z.object({
  onChainId: z.number().int().min(0),
  paymentId: z.number().int().min(0),
  hoursLogged: z.number().int().positive(),
  nonce: z.number().int().min(0),
});

export const roleGrantSchema = z.object({
  walletAddress: stellarAddress,
  role: z.enum(['ADMIN', 'EMPLOYEE']),
});

export type ParseResult<T> = { ok: true; data: T } | { ok: false; error: string };

/** Validate `body` against `schema`, returning a flat error message on failure. */
export function parseBody<T>(schema: ZodSchema<T>, body: unknown): ParseResult<T> {
  const result = schema.safeParse(body);
  if (result.success) return { ok: true, data: result.data };
  const error = result.error.issues
    .map((i) => `${i.path.join('.') || 'body'}: ${i.message}`)
    .join('; ');
  return { ok: false, error };
}
