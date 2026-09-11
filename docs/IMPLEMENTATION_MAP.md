# Implementation Map — the contract the UI must implement

Every step of Bulk Pay, from the screen to the chain and back. Written before the UI
so the UI is built against a workflow that exists, rather than the workflow being
bent to fit screens.

Legend: ✅ built and verified · 🟡 built, not verified end-to-end · ❌ not built

---

## The nine stages

### 1. Upload — choose a file

| | |
|---|---|
| **UI** | Drop zone; filename, size, row count. Client-side size check only as courtesy |
| **API** | none yet — the file is not sent until stage 2 |
| **State** | none |
| **Status** | ❌ UI |

The file is never trusted client-side. The browser's row count is a convenience; the
server re-derives everything.

### 2. Validate — see every problem at once

| | |
|---|---|
| **UI** | Row-level error table: line number, column, message. Re-validate on edit |
| **API** | `POST /api/payroll/batches/validate` → `{ valid, errors[], warnings[], summary, asset }` |
| **Domain** | `validateCsv` → `parsePayrollCsv` + `settleableAssetCodes` |
| **Database** | **none — writes nothing** |
| **State** | none |
| **Status** | ✅ API · ❌ UI |

Returns **200** with `valid: false` for a bad file. Safe to call on every keystroke.
Errors carry `row` (1-based, as the uploader sees it), `field`, `code`, `message`.

Refused here, never silently fixed: invalid addresses · scientific notation ·
excess precision · zero/negative amounts · accounting negatives · fractional hours ·
`hours × rate ≠ amount` · assets this deployment cannot settle · duplicate
recipients (unless opted out) · >100 rows · >1 MB · control characters.

### 3. Draft — create the batch

| | |
|---|---|
| **UI** | Preview table, total, recipient count, period; "Create draft" |
| **API** | `POST /api/payroll/batches` + `Idempotency-Key` → 201 `{created:true}` / 200 `{created:false}` / 409 / 422 |
| **Domain** | `createBatch` → `createDraftBatch` |
| **Database** | 1 `PayrollBatch` + **N `Payment`** + 1 `AuditEvent`, one transaction |
| **State** | every payment `DRAFT` |
| **Status** | ✅ API, DB-verified · ❌ UI |

**One payment per row.** Never an aggregate. Rollback is all-or-nothing — verified
against PostgreSQL by injecting a failure on row 3.

The UI **must** send `Idempotency-Key` and keep it stable across retries of the same
file. Reusing it with a different payload returns 409 `IDEMPOTENCY_KEY_REUSED`.

### 4. Fund — put custody on-chain

| | |
|---|---|
| **UI** | Pre-signing disclosure, then Freighter |
| **API** | ❌ not built |
| **Domain** | needs `requireSettlementContractId()`; escrow creation exists at `POST /api/escrows` for the single-escrow path |
| **Chain** | `create_escrow` + token transfer into custody |
| **Indexer** | `escrow/created` → `Escrow` row, `resolveEscrowTenant` |
| **State** | `DRAFT → VALIDATING → AWAITING_ORACLE` |
| **Status** | ❌ — **the gap between a draft and the chain** |

The disclosure must show, before the wallet opens: **network (TESTNET, plainly)** ·
contract id · settlement asset + SAC address · exact total · recipient count ·
organization · the caller's role · batch reference. A signature request that does not
say what is being signed is the problem CFWP-v2 exists to solve at the protocol
level; the UI must not reintroduce it at the human level.

### 5. Verify work — the oracle attestation

| | |
|---|---|
| **UI** | "Work verified" with hours and period. **Not** "CFWP-v2 signature validated" |
| **API** | `POST /api/oracle/attest` (session + on-chain-manager gated) |
| **Domain** | `buildProofMessage` — 198-byte domain-separated preimage |
| **Chain** | `submit_hours_proof`; contract enforces `hours × rate == amount` (#17) and a monotonic nonce |
| **Indexer** | `oracle/verified` → `ORACLE_VERIFIED` |
| **State** | `AWAITING_ORACLE → ORACLE_VERIFIED` |
| **Status** | ✅ API + contract · ❌ UI |

### 6. Approve — two distinct people

| | |
|---|---|
| **UI** | Two separate affordances, each labelled with the role it satisfies and who filled it |
| **API** | `POST /api/payroll/batches/:id/approve` (batch) · `POST /api/payments/:id/approve` (one) |
| **Domain** | `approveBatch` → `approvePayment`; role from **membership**, never the body |
| **Database** | `Approval` `@@unique([paymentId, role])`; `AuditEvent` per decision |
| **Chain** | `approve_manager` / `approve_finance`, two distinct keys |
| **Indexer** | `approve/*` → `AWAITING_FINANCE` → `READY_TO_SETTLE` |
| **State** | `ORACLE_VERIFIED → AWAITING_MANAGER → AWAITING_FINANCE → READY_TO_SETTLE` |
| **Status** | ✅ off-chain API, DB-verified · 🟡 on-chain signing · ❌ UI |

The UI must **never** imply one wallet satisfied both halves. An `ADMIN` holds both
permissions, and the second attempt records nothing — the screen must say *"waiting
for a second approver"*, not *"approved"*.

Off-chain approval is a **workflow record**. The authoritative approval is the
on-chain signature the indexer observes. The UI must distinguish "decision recorded"
from "approval observed on-chain".

### 7. Settle — submit, and wait for the chain

| | |
|---|---|
| **UI** | "Submitting…" → "Confirming…" → per-payment outcome. **Never "Paid" on submission** |
| **API** | `POST /api/payments/:id/submit` (+ `Idempotency-Key`) |
| **Domain** | `submitPaymentForSettlement`; `BlockchainTransaction.idempotencyKey` unique |
| **Chain** | `pay_batch` — one transaction, one SAC transfer per payee |
| **State** | `READY_TO_SETTLE → SUBMITTING → CONFIRMING` |
| **Status** | 🟡 API exists · ❌ UI |

`SUBMITTING` is not `PAID`. Verified against PostgreSQL: **no user actor of any
role — OWNER, ADMIN, MANAGER, FINANCE — can persist `PAID`.**

### 8. Confirm — PAID, from chain evidence only

| | |
|---|---|
| **UI** | "11 paid / 1 requires attention", per-payment, with explorer links |
| **API** | `GET /api/payroll/batches/:id` (standing derived on read) |
| **Indexer** | `payment/paid` → `PAID` + `settlementTxHash` + `settledAt` |
| **State** | `CONFIRMING → PAID`, actor `indexer` **only** |
| **Status** | ✅ indexer + state machine, DB-verified · ❌ UI |

A transaction link is rendered **only** where `mayHaveTransaction` is true. Showing an
explorer URL for an unsubmitted payment invites a reader to believe it settled.

Partial failure is the normal case. The UI must make one failed payment among eleven
prominent without implying the eleven failed.

### 9. Reconcile — independent verification

| | |
|---|---|
| **UI** | `ReconciliationPanel` — **built, tested, not routed to any page** |
| **API** | `POST /api/organizations/:id/reconciliation` |
| **Domain** | reads **SAC transfer events**, not CoreFlow's own projection |
| **State** | may open `RECONCILIATION_REQUIRED`; **never moves `PAID` backwards** |
| **Status** | ✅ engine · 🟡 panel built, unrouted |

Transaction-scoped matching: the same contract paying the same contractor the same
rate every period is **not** unique on `(contract, recipient, asset, amount)` — the
live-caught bug that produced seven false `DUPLICATE_PAYMENT_EVENT` findings.

---

## What the UI may never do

| Never | Because |
|---|---|
| Send `organizationId`, `role`, `state`, `status`, `settlementTxHash` or an approval identity as trusted input | All server-derived. The schemas **reject** these fields, they are not ignored |
| Show "Paid" before `state === 'PAID'` | `PAID` comes only from observed chain evidence |
| Show a transaction link where `mayHaveTransaction` is false | It implies settlement that has not happened |
| Imply one wallet satisfied both approvals | The contract refuses it (`SignersNotDistinct`); the UI must not suggest otherwise |
| Parse a formatted amount back into money | Use `*BaseUnits` strings; never `parseFloat` |
| Round or reformat hours | v2 records whole hours; fractional input is refused upstream |
| Retry an already-settled payment | Terminal financial state |
| Invent a field when evidence is absent | Render "not yet available", not a placeholder value |
| Call an endpoint that sets state directly | None exists, deliberately |

---

## Response shapes the UI binds to

Money always arrives twice: a display string **and** an exact base-unit string.

```ts
// POST /api/payroll/batches → 201
{ created: true,
  batch: { id, reference, paymentCount, periodStart, periodEnd,
           total: "2,860.00", totalBaseUnits: "28600000000",
           asset: "USDC", unlinkedRecipients: 2 },
  warnings: [{ row?, field?, code, message }],
  possibleDuplicateOf?: { id, reference, createdAt } }

// GET /api/payroll/batches/:id
{ batch: { id, reference, source: {...},
           total, totalBaseUnits, paymentCount,
           standing: { headline, byState, needsAttention,
                       totalAmountBaseUnits, paidAmountBaseUnits, paid },
           payments: [{ id, recipient, amount, amountBaseUnits,
                        rateBaseUnits, hours, state, stateLabel, tone,
                        needsAttention, stateReason, reference,
                        transactionHash,      // null unless the state allows one
                        settledAt, onChainPaymentIndex,
                        approvals: [{ role, decision, actorAddress, createdAt }] }] } }

// POST /api/payroll/batches/:id/approve → 200
{ batchId, approvalRole: "MANAGER",
  recorded: 3, alreadyRecorded: 0, failed: 0,
  results: [{ paymentId, ok, recorded, state, stateLabel, message?, code? }],
  completeForRole: true }
```

Errors are always `{ error, code, details? }`; `details` only ever echoes the
caller's own input.

---

## Pages to build

| Page | Stages | Needs |
|---|---|---|
| Bulk Pay upload | 1–3 | validate + create |
| Batch detail: Overview / Payments / Approvals / Activity / Settlement / Audit | 3–9 | detail + approve + per-payment actions |
| Batch list | — | list |
| Reconciliation | 9 | **route the existing panel** |

Every page carries the persistent **Testnet** badge. Every page derives state from
the API; none computes a state of its own.

---

## The acceptance scenario

One realistic run, against real PostgreSQL **and** real v2 Testnet:

> Organization A → 3 contractors → CSV upload → exactly 3 `Payment` rows → exact
> amounts → manager approval → finance approval (distinct wallet) → Testnet
> settlement → 3 indexed payments → independent reconciliation → 3 receipts →
> complete audit trail. **And Organization B cannot see any of it.**

Stages 1–3, 6 (off-chain) and the isolation requirement are verified against
PostgreSQL today. Stages 4, 7, 8 and the receipts are not yet end-to-end.
