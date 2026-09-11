# Bulk Pay — API Layer

> **Status: API layer implemented and unit-tested. Database-backed validation BLOCKED.**
>
> Every route below compiles, is covered by unit tests against an in-memory Prisma
> double, and is registered in the production build. **No query in this document has
> been executed against a real PostgreSQL database.** Migration 8 is written and not
> applied. See [Blocked](#what-is-blocked) for exactly what that leaves unverified.

Verified work → approved payment → programmable escrow → on-chain settlement. This
document covers the first two links: turning a payroll file into individual,
reviewable, approvable payment records.

---

## Endpoints

| Method | Path | Permission | Writes? |
|---|---|---|---|
| POST | `/api/payroll/batches` | `payroll:create` | Yes — one batch, N payments, 1 audit event |
| GET | `/api/payroll/batches` | `payroll:read` | No |
| POST | `/api/payroll/batches/validate` | `payroll:create` | **No — nothing at all** |
| GET | `/api/payroll/batches/:id` | `payroll:read` | No |
| POST | `/api/payroll/batches/:id/validate` | `payroll:read` | **No — nothing at all** |
| POST | `/api/payroll/batches/:id/approve` | `payment:approve:manager` **or** `payment:approve:finance` | Yes — approvals + audit events |

Per-payment business actions already exist and are unchanged:
`POST /api/payments/:id/{approve,reject,cancel,submit,retry,reconcile}`.

There is deliberately **no** `PATCH /api/payments/:id`. No endpoint anywhere accepts
a destination `PaymentState`. The state machine owns state; the one state a caller
would most like to name is `PAID`.

### Two different `/validate` endpoints

- **`POST /batches/validate`** — stateless. Checks an uploaded file before any record
  exists. Returns **200** with `valid: false` for a bad file: the *call* succeeded,
  the *file* is wrong, and a reviewer iterating on a preview is not making failing
  requests.
- **`POST /batches/:id/validate`** — re-checks an **existing draft** against *current*
  configuration. A payroll drafted on Monday and funded on Wednesday may be
  denominated in an asset the deployment no longer settles.

Creation, by contrast, returns **422** for an invalid file — there, bad content does
mean the request cannot be honoured.

---

## Request schemas

Declared in [`src/lib/payroll/schemas.ts`](../src/lib/payroll/schemas.ts) with Zod,
every object `.strict()`.

### What a client may send

| Field | Constraint |
|---|---|
| `csv` | string, 1 byte – 1 MB |
| `filename` | ≤ 255 chars, no control characters |
| `reference` | ≤ 64 chars, no control characters, trimmed |
| `projectId` | ≤ 64 chars, `[A-Za-z0-9_-]`, resolved **within the tenant** |
| `idempotencyKey` | 8–128 chars, `[A-Za-z0-9._:-]` (header `Idempotency-Key` wins) |
| `rejectDuplicateRecipients` | boolean, default `true` |
| `paymentIds` | 1–100 ids, approval only |
| `reason` | ≤ 500 chars, no control characters |
| `orgId` | names which organization to act in — **never** a claim of membership |

Unknown fields are **rejected**, not ignored. Silently dropping `{"state":"PAID"}`
teaches a client it was honoured, and the next reader of that code assumes it is.

### What a client can never send

`role` · `state` / `status` · `settlementTxHash` · `settledAt` · `approvalRole` ·
`actorAddress` · `amountBaseUnits` · `orgId` as an authorization claim.

All derived from the authenticated session, from membership, and from server-side
state. **A field that cannot be sent cannot be forged.**

Monetary values enter the system through exactly one path: the CSV parser, as decimal
**strings** converted to `bigint` base units. No endpoint accepts an amount as a
number.

---

## Authorization

Every route passes through `withTenant()`
([`src/lib/tenancy/http.ts`](../src/lib/tenancy/http.ts)) — authenticate → resolve
membership from the database → check permission. No route implements its own tenant
check.

Approval is the one route without a single `permission`, because either half of the
dual-approval gate is a legitimate approver and gating on one would reject the other.
It uses `requireAnyPermission(ctx, ['payment:approve:manager', 'payment:approve:finance'])`
— still the central helper, in the central module.

### Dual approval

The approver's role is derived from membership by `approvePayment`, never from the
request. A manager sending `{"role":"FINANCE"}` is rejected at the schema — the field
does not exist.

Separation of duties is enforced even for roles holding **both** permissions: an
`ADMIN` who approves twice finds their own role already recorded on the second
attempt and adds nothing. `Approval` is `@@unique([paymentId, role])`, so a second
manager approval is a duplicate, not a new fact.

Recording an approval **does not settle anything**. It is the workflow record of who
decided what; the authoritative approval is the on-chain signature the indexer
observes.

### Tenant isolation

`orgId` is part of every **query**, not a check afterwards. A batch belonging to
another organization returns the identical 404 as one that never existed — verified by
a test that asserts the two responses are byte-equal, so an id cannot be probed for
existence.

---

## Idempotency

| Scenario | Result |
|---|---|
| Same request twice (double-click) | 200, `created: false`, the original batch |
| Retry after timeout | 200, `created: false`, the original batch |
| Two tabs, same key | One batch; one response says `created: true` |
| N concurrent identical requests | One batch, N payments — not N×rows |
| Same key, **different** payload | **409 `IDEMPOTENCY_KEY_REUSED`** |
| No key, two deliberate uploads | Two batches (NULLs are distinct) |
| Same key, different organization | Two batches (the key is tenant-scoped) |
| Byte-identical file within an hour | Created, plus `possibleDuplicateOf` |

The guarantee is a **unique index** on `(orgId, idempotencyKey)`, not a read-then-write:
check-then-insert loses exactly the race it is meant to cover. The pre-check is an
optimization; the index is the correctness argument, and the collision path is tested
by blinding the pre-check so only the index can stop the second write.

A reused key with a different payload is **refused rather than replayed**. Returning
the original batch would hand back a payroll that is not the one the caller just
described. The comparison uses `idempotencyFingerprint` — a hash of the CSV checksum,
reference, project, asset and duplicate-handling option. The **filename is excluded**:
re-uploading identical rows as `september-final.csv` is the same payroll.

`possibleDuplicateOf` only **warns**. Running the same figures next period is
legitimate payroll, so it is surfaced for a human rather than blocked.

---

## Error model

[`src/lib/api/errors.ts`](../src/lib/api/errors.ts). Envelope:
`{ error, code, details? }`.

| Status | Meaning |
|---|---|
| 400 | Malformed request — bad JSON, wrong content type, unknown field, oversized body |
| 401 | Not authenticated |
| 403 | Authenticated, organization known, role insufficient |
| 404 | Absent **or** not visible to this tenant — deliberately identical |
| 409 | Conflicts with current state, or an idempotency key reused |
| 422 | Well-formed request whose **content** fails domain validation |
| 429 | Rate limited (`Retry-After` set) |
| 500 | Unexpected. Opaque, always |
| 503 | A dependency is unavailable |

`details` carries only **the caller's own input echoed back** — field paths, row
numbers, and messages derived from the schema. Never server state.

A 500 never carries detail, and there is deliberately **no** "include the stack in
development" switch: a conditional that reveals internals is one misconfigured
environment variable away from revealing them in production. A test asserts the 500
body contains no model name, no `prisma`, and no stack frames.

### Row-level CSV errors

```json
{
  "error": "The payroll file has 3 problems that must be fixed before a batch can be created.",
  "code": "CSV_INVALID",
  "details": {
    "errors": [
      { "row": 3, "field": "recipient", "code": "INVALID_ADDRESS",
        "message": "\"NOTANADDRESS\" is not a valid Stellar address. Expected 56 characters beginning with G." },
      { "row": 4, "field": "amount", "code": "AMBIGUOUS_NUMBER",
        "message": "amount \"1e3\" uses scientific notation, which is ambiguous. Write the number out in full." },
      { "row": 5, "field": "hours", "code": "FRACTIONAL_HOURS",
        "message": "hours \"7.5\" is fractional. CoreFlow v2 records whole hours and will not round a payroll figure." }
    ]
  }
}
```

Every problem in the file is reported at once. A finance user fixing a 40-row file one
error per upload cannot work.

---

## Financial safety

- One `Payment` per CSV row. A multi-payee payroll is never one aggregate record —
  "11 paid, 1 needs attention" has to be representable, because it is the normal
  outcome of a real batch.
- `bigint` base units throughout. No JS `number` touches money.
- Excess precision is **refused**, not truncated. Scientific notation is refused as
  ambiguous. Accounting negatives `(500)` are refused.
- Whole hours only, and `hours × rate == amount` is checked before anything is funded
  — the contract enforces it on-chain (error #17), so a drifted row would fund custody
  that can never be released. **Nothing is rounded to make a demo work.**
- One settlement asset per escrow. A row naming an asset this deployment cannot settle
  is refused at validation, never allowed into a state that can never settle. SAC
  addresses are read from configuration, never inferred from a symbol.
- Batch creation is atomic: if any payment fails to write, the batch, every payment
  and the audit event are rolled back. A partially created payroll would look complete
  and quietly underpay someone.
- No endpoint can set `PAID`, write a settlement hash, alter an amount or recipient,
  bypass the oracle requirement, or bypass manager/finance separation.

---

## What is blocked

> These are **not** done, and no mock stands in for them.

| Blocked | Prerequisite |
|---|---|
| Applying migration `20260911040000_payroll_batch_idempotency` | Local development database |
| Verifying the schema matches the Prisma model | Local development database |
| Composite foreign keys actually rejecting cross-tenant rows | Local development database |
| The `(orgId, idempotencyKey)` unique index under real concurrency | Local development database |
| Route integration tests against PostgreSQL | Local development database |
| Full Bulk Pay end-to-end | Local DB + funded Testnet escrow |
| A fresh Testnet golden-path run | Local DB + funded Testnet escrow |
| Production `migrate diff` | Local shadow database |

Setup instructions: [ENVIRONMENTS.md](ENVIRONMENTS.md#setting-up-the-development-database).

### What the unit tests do and do not prove

They **do** prove: authorization decisions, tenant isolation in query construction,
schema rejection of unknown and malformed fields, the idempotency contract including
the lost-race path, atomic rollback, error sanitization, and exact monetary arithmetic.

They **do not** prove anything about PostgreSQL. The in-memory double
([`fake-db.ts`](../src/lib/payments/__tests__/fake-db.ts)) enforces unique constraints,
required columns and per-transaction rollback — deliberately, so these properties can
be observed being relied upon — but it is not a database. Column types, composite
foreign keys, partial indexes, cascade behaviour, transaction isolation and
constraint-trigger timing are all unverified.

---

## Not yet built

The API layer is complete; the product workflow is not. Still to come:

- Upload / preview / draft UI, and the batch detail page
- Freighter pre-signing disclosure (network, asset, total, recipient count, org, role,
  batch id, with TESTNET shown plainly)
- Escrow funding from an approved draft
- Batch and per-payment receipts
- Audit-trail timeline rendering

The `ReconciliationPanel` component remains built, tested, and **not routed to a page**.
