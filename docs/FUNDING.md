# Funding — an approved draft becomes a funded escrow

> **Status: domain and API complete and unit-tested. UI and live Testnet run outstanding.**

## The architecture, as the contract actually is

**Creating the escrow *is* funding the escrow.**

`initialize_multi_sig_escrow(manager, finance_approver, oracle_pubkey, payments)`
transfers custody — one `TokenClient::transfer(manager → contract)` per distinct
asset — and *then* stores the escrow. There is no `fund()` entry point, and
`CoreFlowEscrow` has no `funded` field.

So:

- **One wallet interaction, not two.** "Created but not funded" is not a state the
  product can display, because it is not a state the contract can be in. The UI
  must not present creation and funding as separate steps.
- **An escrow exists if and only if its custody moved.** Existence is the funding
  evidence.

| Question | Answer |
|---|---|
| Custody destination | the contract's own address (`env.current_contract_address()`) |
| Asset | per-payment `token`, a SAC address — never inferred from a symbol |
| Amount | sum per distinct token, moved during creation |
| Creation proof | `escrow/created` + one `payment/add` per payee |
| Funding proof | the **SAC's own** `transfer` event |
| Read state | `get_escrow(id)` |
| Preconditions | `manager != finance_approver`, registered oracle key, `end_date > start_date`, `amount % rate_per_hour == 0`, ≤100 payments |

## The contract is not idempotent — this is the central safety problem

A second `initialize_multi_sig_escrow` creates a **second escrow** and moves the
money **again**. Nothing on-chain prevents it.

Every control against double-funding is therefore off-chain, and the enforcement is
a **database constraint**, not a disabled button:

```
BlockchainTransaction.idempotencyKey  UNIQUE   =  fund:batch:<batchId>
```

The attempt is opened **before the wallet is shown**. A second call while an
attempt is open returns *that* attempt. Double-click, refresh, two tabs and a
client retry all converge on one escrow.

A retry after a genuinely finished attempt gets a new key
(`fund:batch:<id>:retry:<n>`), so a failed attempt does not block the batch forever
while a confirmed one can never be repeated.

## The plan is frozen, and is what the chain is compared against

When the intent opens, the exact plan is persisted to
`BlockchainTransaction.plan` with a SHA-256 `planDigest`: batch, organization,
project, contract, custody destination, network, manager, finance approver, oracle
key, asset code + SAC + decimals, total, and every row's payment id, recipient,
token, amount, rate and period. Money is stored as **decimal strings** — JSON has
no bigint.

Confirmation compares the chain against **that**, never against a recomputed plan.
Configuration can move under a pending transaction — the settlement asset switched,
a different finance approver becoming the first candidate, a payment edited — and a
recomputed plan would quietly agree with whatever the chain happened to contain.
That is the agreement that must not be manufactured.

A plan whose digest does not match its content is refused outright.

## Lifecycle

```
READY ──▶ AWAITING_SIGNATURE ──▶ SUBMITTED ──▶ CONFIRMED (funded)
             │                       │
             │                       ├─▶ FAILED        chain says it failed
             │                       ├─▶ UNVERIFIABLE  chain unreadable — retry
             │                       └─▶ MISMATCH      chain ≠ plan; not adopted
             └─▶ CANCELLED   signature declined, nothing submitted
```

Every transition writes an audit event: `funding.intent.opened`,
`funding.submitted`, `funding.confirmed`, `funding.failed`, `funding.declined`,
`funding.mismatch`.

## Confirmation: what has to be true

`CONFIRMED` requires **all** of:

1. `readTransactionSucceeded(hash)` is true
2. the escrow reads back, is not cancelled, and its manager and finance approver are
   the planned ones — and are not the same key
3. its payment count matches, and every row's recipient, amount and token match the
   plan **in order**
4. the payments in the database still match the plan (nothing edited or removed
   since it was frozen)
5. a transfer of the **exact** total, from the plan's manager to the custody
   address, is observable **in that transaction**

Freighter returning is not evidence. The client builds and signs, so it could
submit something other than the plan.

### The three non-success outcomes are never collapsed

| Outcome | Meaning | Effect |
|---|---|---|
| `FAILED` | the chain says the transaction failed | payments return to DRAFT; nothing moved |
| `UNVERIFIABLE` | the chain could not be read | **nothing recorded**; retry later |
| `MISMATCH` | we read the chain and it disagrees | escrow **not adopted**; CRITICAL finding opened |

`UNVERIFIABLE ≠ FAILED`. An RPC outage proves nothing about the transaction, and
marking a funded escrow failed would be worse than waiting.

`MISMATCH` preserves the evidence as a `ReconciliationFinding` (CRITICAL) and
attaches nothing to the batch. Someone funded an escrow this batch did not
describe; adopting it would make the product assert something untrue about money.

## Uncertain transactions — the retry policy

| Situation | Behaviour |
|---|---|
| Wallet declined, nothing submitted | safe. Attempt `CANCELLED`, payments return to DRAFT, a fresh attempt may be opened |
| Submitted, then the client died | the attempt persists with its hash. **Do not submit again** — call confirm |
| Submitted, RPC unreadable | `UNVERIFIABLE`. The attempt stays `SUBMITTED` and keeps blocking a new one |
| Confirmed | a new attempt can never be opened |
| Mismatch | stop. A human resolves the finding |

Abandon is narrow by design: payments return to DRAFT **only when no hash exists**.
Once a transaction was submitted the money may have moved, so the record is not
rewound — manufacturing a "not funded" state is how a second escrow gets funded.

The UI must say so plainly while verification is pending:

> We're verifying whether your funding transaction completed. **Do not fund again.**

## The pay period is required

`period_start` and `period_end` are **required CSV columns**.

The period is a signed field of the CFWP-v2 attestation and the contract refuses
`end_date <= start_date`. A row without one can be drafted but can never be funded.
CoreFlow will not supply it — defaulting to today, last month or the upload date
means attesting to a pay period nobody stated.

This is enforced at **upload**, not at funding. Discovering it at the wallet prompt,
after a payroll has been prepared and approved, is far worse than being told at
row 8.

## Eligibility

Every blocker is reported at once — 13 codes: `ROLE_NOT_PERMITTED`,
`ALREADY_FUNDED`, `FUNDING_IN_FLIGHT`, `NO_PAYMENTS`, `TOO_MANY_PAYMENTS`,
`PAYMENT_NOT_FUNDABLE`, `PAYMENT_ALREADY_ON_CHAIN`,
`SETTLEMENT_ASSET_UNCONFIGURED`, `ASSET_MISMATCH`, `MIXED_ASSETS`,
`AMOUNT_NOT_POSITIVE`, `HOURS_RATE_MISMATCH`, `PERIOD_REQUIRED`,
`PERIOD_INVALID`, `NO_DISTINCT_FINANCE_APPROVER`, `ORACLE_KEY_UNAVAILABLE`.

Funding is permitted to `OWNER`, `ADMIN`, `MANAGER` — mirroring `escrow:create`, and
matching the contract, where the signer **is** the escrow's manager. The finance
approver is chosen **server-side** and never taken from the request: letting a
caller nominate it would let them nominate themselves, which is what the contract
refuses with `SignersNotDistinct`.

## API

| Method | Path | Permission |
|---|---|---|
| GET | `/api/payroll/batches/:id/funding` | `escrow:read` |
| POST | `/api/payroll/batches/:id/funding/intent` | `escrow:create` |
| POST | `/api/payroll/batches/:id/funding/submitted` | `escrow:create` |
| POST | `/api/payroll/batches/:id/funding/confirm` | `escrow:create` |
| POST | `/api/payroll/batches/:id/funding/abandon` | `escrow:create` |

Every attempt id is scoped to the batch in the URL, so an attempt belonging to
another batch cannot be acted on by naming it. No request body carries an amount,
recipient, asset, manager or finance approver — all of that comes from the frozen
plan.

Confirm returns **200 for every outcome**: the verification request succeeded, and
the body says what the chain showed. A 4xx would conflate "we could not check" with
"your request was wrong".

## Division of labour with the indexer

| Component | Owns |
|---|---|
| **Funding** | the intent, the frozen plan, chain verification, creating/linking the `Escrow`, and setting each payment's `onChainPaymentIndex` |
| **Indexer** | state from chain events. On `payment/add` it recognises the linked payment and advances `VALIDATING → AWAITING_ORACLE` |

Linking payments to their on-chain slot is what stops the indexer creating a second
set of rows: it looks up `(escrowId, onChainPaymentIndex)` and finds ours. It also
cross-checks recipient and amount, opening an `AMOUNT_MISMATCH` finding if they
disagree.

## Still blocked

| | Prerequisite |
|---|---|
| Funding review UI + Freighter disclosure | next |
| Batch detail page | next |
| Live Testnet funding run | the UI, plus a Freighter signature in a browser |

Test USDC **can** be obtained through the project's existing setup: the Stellar CLI
holds `coreflow-v2-usdc-issuer`, `coreflow-v2-manager` and `coreflow-v2-finance`
identities, and the previous golden path funded escrow #8 with 2,860 test USDC that
way. The browser wallet interaction cannot be automated and needs the operator.
