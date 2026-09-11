/**
 * Request schemas for the Bulk Pay API.
 *
 * Every field a client can send is declared here, with a length or range, and
 * `.strict()` rejects anything undeclared. An unknown field is reported rather
 * than ignored: silently dropping `{ state: "PAID" }` teaches a client that it
 * worked, and the next reader of that code assumes the field is honoured.
 *
 * What is deliberately ABSENT matters as much as what is present. No schema here
 * accepts a role, a payment state, a settlement status, an approval identity, or
 * a monetary amount in any form other than the uploaded file. Those are derived
 * from the authenticated session, from membership, and from server-side state. A
 * field that cannot be sent cannot be forged.
 *
 * `orgId` is the one exception, and it is not a grant: it merely NAMES which of
 * the caller's organizations to act in. `withTenant` reads the membership from
 * the database on every request, so naming an organization the caller does not
 * belong to produces the same non-enumerating miss as naming one that does not
 * exist.
 */

import { z } from 'zod';
import { MAX_CSV_BYTES, MAX_ROWS, containsControlChars } from './csv';

/** cuid()s are what Prisma generates; bound both length and alphabet. */
const id = (label: string) =>
  z
    .string({
      required_error: `${label} is required.`,
      invalid_type_error: `${label} must be a string.`,
    })
    .min(1, `${label} is required.`)
    .max(64, `${label} is not a valid identifier.`)
    .regex(/^[A-Za-z0-9_-]+$/, `${label} is not a valid identifier.`);

/**
 * Free text a human typed, which will be stored and re-displayed.
 *
 * Control characters are REFUSED, not stripped. This is not a payroll figure, but
 * it is still the caller's words: quietly altering them while reporting success
 * means the stored value is not what was sent.
 */
const shortText = (label: string, max: number) =>
  z
    .string()
    .max(max, `${label} must be ${max} characters or fewer.`)
    .refine((v) => !containsControlChars(v), {
      message: `${label} contains control characters.`,
    });

/** Naming the organization to act in. Never a claim of membership or role. */
const orgId = id('orgId').optional();

/**
 * The uploaded file, as text.
 *
 * Capped here as well as in the parser. The parser's cap protects the parser;
 * this one refuses the request before a megabyte of attacker-chosen text is held
 * in memory and walked character by character.
 */
const csvText = z
  .string({
    required_error: 'A CSV file is required.',
    invalid_type_error: 'csv must be a string.',
  })
  .min(1, 'The CSV file is empty.')
  .max(MAX_CSV_BYTES, `The CSV file exceeds the ${Math.round(MAX_CSV_BYTES / 1024)} KB limit.`);

const filename = shortText('filename', 255).optional();

/**
 * Client-supplied retry key.
 *
 * Opaque to the server — compared, never interpreted. Bounded so it cannot become
 * a channel for storing arbitrary data on the batch row.
 */
const idempotencyKey = z
  .string()
  .min(8, 'An idempotency key must be at least 8 characters.')
  .max(128, 'An idempotency key must be 128 characters or fewer.')
  .regex(/^[A-Za-z0-9._:-]+$/, 'An idempotency key may use letters, digits and . _ : - only.')
  .optional();

/** Stateless CSV validation. Writes nothing, so it takes no reference or project. */
export const validateCsvRequest = z
  .object({
    csv: csvText,
    filename,
    orgId,
    /**
     * Whether a repeated payee is an error. Default true. Exposed because a
     * legitimate payroll can pay one wallet for two projects, and the uploader is
     * the only one who knows which case this is.
     */
    rejectDuplicateRecipients: z.boolean().optional(),
  })
  .strict();

export type ValidateCsvRequest = z.infer<typeof validateCsvRequest>;

/** Create a draft batch and one payment per valid row. */
export const createBatchRequest = z
  .object({
    csv: csvText,
    filename,
    orgId,
    /** Human-facing label. Generated sequentially when omitted. */
    reference: shortText('reference', 64).optional(),
    projectId: id('projectId').optional(),
    /** Also accepted as the `Idempotency-Key` header, which takes precedence. */
    idempotencyKey,
    rejectDuplicateRecipients: z.boolean().optional(),
  })
  .strict();

export type CreateBatchRequest = z.infer<typeof createBatchRequest>;

/** Re-validate an existing draft batch. Writes nothing. */
export const revalidateBatchRequest = z.object({ orgId }).strict();

/**
 * Record the caller's approval across a batch.
 *
 * There is no `role` field. Which half of the dual-approval gate this exercises
 * is derived from the caller's membership — taking it from the body would let one
 * manager send `{"role":"FINANCE"}` and satisfy both halves alone, which is
 * exactly what the contract refuses with SignersNotDistinct.
 *
 * There is no payment-state field either. The state machine owns state.
 */
export const approveBatchRequest = z
  .object({
    orgId,
    reason: shortText('reason', 500).optional(),
    /**
     * Payments to act on. Omitted means every payment in the batch awaiting this
     * caller's approval. Naming them lets a reviewer approve part of a batch after
     * querying a row, and caps the blast radius of a mis-click.
     */
    paymentIds: z.array(id('paymentId')).min(1).max(MAX_ROWS).optional(),
    idempotencyKey,
  })
  .strict();

export type ApproveBatchRequest = z.infer<typeof approveBatchRequest>;

/** Listing filters. Query-string sourced, so every value arrives as a string. */
export const listBatchesQuery = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).optional(),
    cursor: id('cursor').optional(),
    projectId: id('projectId').optional(),
  })
  .strict();

export interface FieldIssue {
  /** 1-based CSV line, where the issue came from a file row. */
  row?: number;
  /** Request field path, e.g. `reference`, or a CSV column name. */
  field?: string;
  code: string;
  message: string;
}

/**
 * Render a Zod failure as field issues.
 *
 * Every path and message derives from the caller's own input and from the schema,
 * never from server state, so all of it is safe to return.
 */
export function zodIssues(error: z.ZodError): FieldIssue[] {
  return error.issues.map((i) => ({
    field: i.path.length > 0 ? i.path.join('.') : undefined,
    code: i.code === 'unrecognized_keys' ? 'UNKNOWN_FIELD' : 'INVALID_FIELD',
    message: i.message,
  }));
}
