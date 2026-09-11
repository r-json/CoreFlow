# CoreFlow — Reviewer Evidence

Everything below is reproducible from this repository. Where a claim is about
on-chain state, the verification command is given so it can be checked
independently rather than taken on trust.

> **Scope note.** CoreFlow **v2** — the hardened contract described here — is
> deployed on **Stellar Testnet only**. CoreFlow **v1** remains on Mainnet and
> carries none of v2's hardening. See [`../DEPLOYMENTS.md`](../DEPLOYMENTS.md).

---

## 1. Test suites

| Suite | Command | Result |
|---|---|---|
| Soroban contract (Rust) | `cd contracts/core-flow && cargo test` | **70 passed**, 2 ignored |
| Application unit (TypeScript) | `npm run test:ci` | **761 passed**, 9 skipped (opt-in live) |
| Application integration (real PostgreSQL) | `npm run test:integration` | **71 passed** |
| Type check | `npm run typecheck` | clean |
| Production build | `npm run build` | succeeds |
| Deployable WASM | `cargo build --release --target wasm32v1-none` | 42,425 bytes |

The single ignored Rust test is documented in place: `ed25519_verify` traps
non-catchably in native `cargo test`, so a bad-signature rejection cannot be
asserted with `#[should_panic]`. It is covered by the live Testnet run below.

---

## 2. v2 Testnet deployment

Machine-readable: [`testnet-v2-deployment.json`](testnet-v2-deployment.json)

| Field | Value |
|---|---|
| Contract | `CDN4FIKLJ72WYNPBIKWYSDJWDZG22QNPLWI37VTUAE4EKKIBVAQRG5F4` |
| Network | Stellar **Testnet** |
| WASM SHA-256 | `d9f2d849d69b56aebcbdf585e8b2e0e8d81d9e5bf13f51534f27bf479d0e56da` |
| Admin pinned in WASM | yes |
| Oracle key registered | yes |
| Explorer | https://stellar.expert/explorer/testnet/contract/CDN4FIKLJ72WYNPBIKWYSDJWDZG22QNPLWI37VTUAE4EKKIBVAQRG5F4 |

Verify the deployed state yourself:

```bash
stellar contract invoke --id CDN4FIKLJ72WYNPBIKWYSDJWDZG22QNPLWI37VTUAE4EKKIBVAQRG5F4 --network testnet -- expected_admin
stellar contract invoke --id CDN4FIKLJ72WYNPBIKWYSDJWDZG22QNPLWI37VTUAE4EKKIBVAQRG5F4 --network testnet -- get_admin
stellar contract invoke --id CDN4FIKLJ72WYNPBIKWYSDJWDZG22QNPLWI37VTUAE4EKKIBVAQRG5F4 --network testnet -- is_paused
stellar contract invoke --id CDN4FIKLJ72WYNPBIKWYSDJWDZG22QNPLWI37VTUAE4EKKIBVAQRG5F4 --network testnet -- \
  is_oracle_key_registered --pubkey f42a48839e48d58e6628f5d096ee859e635b056be580bdcc68d620e2a2badae0
```

---

## 3. Live golden-path validation

Machine-readable: [`testnet-v2-golden-path.json`](testnet-v2-golden-path.json)
Reproduce: `ORACLE_SECRET_KEY=<seed> node scripts/validate-testnet-v2.mjs`

Escrow **#2**, three contractors, **2,860 test USDC** settled by real SAC
transfers. Each assertion below was checked against on-chain state, not inferred
from a non-erroring CLI call:

| # | Step | Verified |
|---|---|---|
| 1 | Balances recorded before settlement | manager 100,000 USDC; all workers 0 |
| 2 | Escrow created, custody funded | contract holds exactly 2,860; manager debited exactly 2,860 |
| 3 | Oracle attestation (`CFWP-v2`) | locally built preimage is **byte-identical** to the contract's `proof_preimage` for all 3 payments |
| 3 | Proofs submitted on-chain | 40 h, 32 h, 45 h accepted at nonces 0, 1, 2 |
| 4 | **Replay rejected** | resubmitting a consumed attestation fails (`InvalidNonce`) |
| 5 | **Dual approval enforced** | `pay_batch` refused with 0 approvals, and again with only the manager's |
| 5 | Distinct finance signer | finance approval signed by a **different key** than the manager |
| 6 | `pay_batch` executed | real SAC transfers |
| 7 | Settlement measured | worker payouts of exactly 1,000 / 960 / 900 USDC; custody drained to **0** |
| 8 | **Double settlement rejected** | second `pay_batch` fails (`PaymentAlreadyFinalized`) |
| 9 | Final state | both approvals true; every payment `proof_verified`; every payment `Finalized` |

### Reconciliation reliability (P2 #4)

**Verification is independent of the indexer.** The indexer trusts CoreFlow's own
`payment/paid` events; the reconciler reads the **token contract's own `transfer`
events** — `transfer / from / to / asset → amount` — plus contract storage. A bug in
how CoreFlow emits or parses its events therefore cannot validate itself. Live
sample from the SAC's event stream:

```
transfer  GCQR4PEWRAKH… → CDN4FIKLJ72W…  28600000000   (custody funded)
transfer  CDN4FIKLJ72W… → GDHMEB2U2XQH…  10000000000   (worker 1)
transfer  CDN4FIKLJ72W… → GA7Q23T4I2CA…   9600000000   (worker 2)
transfer  CDN4FIKLJ72W… → GCFTJIXCBQR6…   9000000000   (worker 3)
```

| Claim | Evidence |
|---|---|
| Verification refuses contract state alone | `reconciler.test.ts` → "refuses to confirm settlement the contract claims but no transfer supports" |
| CHAIN_AHEAD corrected only on observed transfer | "advances the projection when a transfer independently confirms settlement" |
| DATABASE_AHEAD is **never** reverted | "records a CRITICAL finding and leaves PAID in place" |
| No fabricated transaction hash | "does not fabricate a transaction hash" |
| CHAIN_UNREADABLE ≠ agreement, ≠ failure | 4 tests under "CHAIN_UNREADABLE is not agreement" |
| Batch totals cannot hide payment errors | "catches individual mismatches even when the batch total matches" (1000/960/900 recorded vs 1000/860/1000 settled — totals equal, two mismatches found) |
| A mismatched payment is not also counted agreed | same test: `agreed` is 1, not 3 |
| Recurring payroll is not a double payment | "does not flag a repeat of an identical pay period as a double payment" |
| Duplicate only within one transaction | "flags duplicate transfers as possible double payment" |
| Recorded hash with no transfer is caught | "flags a payment whose recorded hash has no corresponding transfer" |
| Findings deduplicate, acknowledgement survives | 3 tests under "finding deduplication" |
| CRITICAL reserved for false money statements | "reserves CRITICAL for false statements about money" |
| Every finding kind has remediation | "gives every finding kind actionable remediation" |
| Falsely-failed tx says DO NOT RETRY | "detects a false failure and warns against retrying" |
| Unattributed escrow reported, never attached | "reports unattributed escrows without attaching them to a tenant" |
| Cron trigger unreachable without the secret | `routes.test.ts` — 5 tests incl. short-secret refusal |
| Resolution requires an explanation | "refuses to resolve without a substantive explanation" |
| Resolution cannot alter financial state | "cannot alter payment state, amount or transaction hash" — asserts exactly which fields are written |
| Findings are tenant-scoped | "404s a finding belonging to another organization" |
| "No findings" never reads as healthy after a failed run | `ReconciliationPanel.test.tsx` — 4 summary tests |

#### The run lock, verified against PostgreSQL

```
first RUNNING run                 INSERT 0 1                                    ALLOWED
second concurrent RUNNING run     ReconciliationRun_one_running_per_org         BLOCKED
after the first completes         INSERT 0 1                                    ALLOWED
historical runs retained          2 runs                                        PRESERVED
```

A check-then-insert is a race; the partial unique index means the lock does not
depend on the application noticing.

#### Live Testnet validation

`COREFLOW_LIVE_TESTNET=1 npx vitest run src/lib/reconciliation/__tests__/live-reconciliation.test.ts`

```
1. settled batch reconciles AGREED
   RECONCILE: paymentsExamined=3 agreed=3 mismatched=0 databaseAhead=0
2. repeated run is idempotent
   correctionsApplied=0, findings unchanged, both runs COMPLETED
3. interrupted indexer recovered
   RECOVERY: chainAhead=1 correctionsApplied=1
   → payment returned to PAID from an observed SAC transfer, audit actorSystem=reconciler,
     metadata.verifiedBy=sac-transfer-event
4. unattributed escrow reported, not attached
   UNKNOWN_ON_CHAIN_OBJECT (LOW), 0 escrow rows created for it
5. synthetic DATABASE_AHEAD mismatch detected, NOT reverted
   MISSING_ON_CHAIN — "Payment references escrow 7 slot 97, which does not exist on-chain."
   → payment stayed PAID; real payments unaffected
```

Case 5 used a synthetic payment inside a throwaway test organization, written
directly rather than through any settlement path and deleted afterwards. No fake
PAID state was created in a production path.

#### A bug found by live validation

The first live run reported three duplicate payments on a batch that agreed. Cause:
transfers were matched on `(escrow contract, recipient, asset, amount)`, which is
**not unique** — the same contract pays the same contractor the same rate every
period, so seven identical payroll runs produced seven matches for one payment.
Matching is now scoped to a single transaction, and the regression is pinned by
"does not flag a repeat of an identical pay period as a double payment". The
hermetic tests had passed because their fixture gave each transfer its own
transaction hash, which `pay_batch` never does.

### Multi-tenancy (P2 #2)

**The boundary is enforced by PostgreSQL, not only by application code.** Every
parent relation on a tenant-owned record is a composite foreign key on
`(orgId, id)`. Verified directly against the database:

```
org A payment → org A batch      INSERT 0 1                        ALLOWED
org A payment → org B batch      Payment_orgId_batchId_fkey        BLOCKED
org A payment → org B project    Payment_orgId_projectId_fkey      BLOCKED
org A payment → org B worker     Payment_orgId_workerId_fkey       BLOCKED
org B approval → org A payment   Approval_orgId_paymentId_fkey     BLOCKED
org B audit → org A payment      AuditEvent_orgId_paymentId_fkey   BLOCKED
org B escrow → org A project     Escrow_orgId_projectId_fkey       BLOCKED
```

| Claim | Evidence |
|---|---|
| 6 roles × 35 permissions, enumerated including empty cells | `tenancy/__tests__/rbac.test.ts` (81 tests); [`../RBAC.md`](../RBAC.md) |
| WORKER holds **no** permissions; all 35 refused | "grants WORKER nothing" |
| VIEWER refused every non-read permission | "VIEWER is read-only" |
| MANAGER cannot exercise the finance approval | "does not let a MANAGER exercise the finance rejection" |
| FINANCE cannot create the payroll it approves | "does not let FINANCE create the payroll it approves" |
| ADMIN cannot mint an OWNER | "does NOT let an ADMIN mint an OWNER" |
| MANAGER cannot mint a FINANCE approver | "does NOT let a MANAGER mint a FINANCE approver" |
| Cross-tenant reads return **404, not 403** | `tenancy/__tests__/isolation.test.ts` — 9 resource types |
| Foreign and nonexistent ids are byte-identical | "returns an identical response for foreign and nonexistent ids" |
| Id enumeration over 25 foreign payments leaks nothing | "leaks nothing when enumerating a range of ids" |
| Same on-chain id in two tenants does not cross over | "does not return another tenant's escrow for the same onChainId" |
| Suspended/invited/removed members are indistinguishable from non-members | "refuses a %s membership, indistinguishably from non-membership" |
| Invitation tokens stored hashed only | `membership.test.ts` — "are stored hashed, never in plaintext" |
| Invitation single-use under concurrency | "cannot mint two memberships when two requests race" |
| Every invitation rejection reads identically | "reports every rejection with an identical caller-visible message" |
| Invitation cannot change an existing member's role | "does not change the role of someone who already belongs" |
| Last administrator cannot be removed, suspended or demoted | "last administrator protection" (5 tests) |
| Self-promotion refused | "refuses changing your own membership" |
| Cross-tenant invitation revocation refused | `organizations/__tests__/invitations.route.test.ts` |

### Indexer tenant mapping — verified on live Testnet

Run: `COREFLOW_LIVE_TESTNET=1 npx vitest run src/lib/indexer/__tests__/live-tenancy.test.ts`

```
PASS 1 (no mapping):  {"processed":13, "paymentsCreated":0, "unattributed":13}
  → 0 payments projected, 0 organizations invented, 13 events recorded
[indexer] replayed 13 previously unattributed event(s) (+3 payments, +3 settled)
PASS 2 (after org A claims the escrow):
  org A  idx=0 GDHMEB2U2X…  amount=10000000000  state=PAID
  org A  idx=1 GA7Q23T4I2…  amount=9600000000   state=PAID
  org A  idx=2 GCFTJIXCBQ…  amount=9000000000   state=PAID
PASS 3: org B sees 0 payments; every org A payment id → 404; on-chain id → 404
```

The indexer **never invents a tenant**. It previously auto-created one organization
per deployment and attached every discovered escrow to it — a guess that would place
one party's payroll inside another's workspace. Unattributable events are recorded
with `attributed = false` and replayed once an operator claims the escrow, so a
claim does not lose the history that predates it.

### Payment state machine (P2 #1)

| Claim | Evidence |
|---|---|
| 16 states, 38 transitions, each with a declared actor | `src/lib/payments/state-machine.ts`; [`../PAYMENT_STATE_MACHINE.md`](../PAYMENT_STATE_MACHINE.md) |
| Every **undeclared** (from, to) pair is rejected, for every actor kind | `state-machine.test.ts` → "every undeclared pair is rejected" (>500 pairs asserted) |
| **Only a chain observer can reach `PAID`** — no user or system path | `state-machine.test.ts` → "PAID is reachable only by the indexer" |
| A MANAGER cannot exercise the FINANCE decision | "does not let a MANAGER exercise the finance rejection" |
| One wallet cannot supply both halves of the dual-approval gate | `actions.test.ts` → "refuses one wallet supplying both halves of the gate" |
| `SETTLEMENT_FAILED` cannot be retried by a user | "refuses retry after a settlement that DID reach the chain" (409 `RECONCILIATION_FIRST`) |
| Retried settlement does not double-pay | "replays the original attempt for a repeated key" |
| Cross-tenant access returns 404, not 403 | `actions.test.ts` → "tenant isolation" (6 actions × cross-tenant) |
| Racing transitions: exactly one wins | "lets only one of two racing transitions win" |
| Reconciliation records disagreements instead of overwriting | `reconcile.test.ts` (21 tests) |
| A false "failed" transaction is detected and flagged do-not-retry | "detects a false failure and warns against retrying" |
| No generic "Processing" anywhere in the UI | `PaymentStateBadge.test.tsx` → all 16 states |
| Transaction links only where a transaction can exist | `PaymentTransactionRef` tests |

### Multi-payment indexing — the defect this phase fixed

**Before:** the `Escrow` model held one `workerPubKey` and one `amountBaseUnits`, so
a three-payee settlement collapsed into a single row carrying the FIRST payee's
figures. Two of the three payments did not exist in the product.

**Root cause found during this work:** the contract's `payment/final` event emits
only `(escrow_id, total_amount, count)` — **no per-payment data**. The event stream
was insufficient to reconstruct per-payment state, so any projection would have had
to read `get_escrow` at index time, returning CURRENT state rather than state at
that ledger. That makes re-indexing non-deterministic. Per-payment events
(`payment/add`, `payment/paid`, `payment/cancel`) were added to the contract. No
change to authority or validation — the security model is identical.

**Verified against live Testnet data** (escrow #3, `COREFLOW_LIVE_TESTNET=1`):

```
escrow 3: 3 payment(s)
   idx=0 GDHMEB2U2X… amount=10000000000 hours=40 state=PAID
   idx=1 GA7Q23T4I2… amount=9600000000  hours=32 state=PAID
   idx=2 GCFTJIXCBQ… amount=9000000000  hours=45 state=PAID
```

Per-payment audit history, all attributed to the indexer (not a person):

| Event | previous → new | count |
|---|---|---|
| `payment.indexed` | → `AWAITING_ORACLE` | 3 |
| `payment.oracle.verified` | `AWAITING_ORACLE` → `ORACLE_VERIFIED` | 3 |
| `approval.manager.observed` | `AWAITING_MANAGER` → `AWAITING_FINANCE` | 3 |
| `approval.finance.observed` | `AWAITING_FINANCE` → `READY_TO_SETTLE` | 3 |
| `payment.state.changed` | `READY_TO_SETTLE` → `PAID` | 3 |

One batch, three payments, 17 chain events, **0 reconciliation findings**.

### Restartability, demonstrated accidentally

During this work an indexer run crashed partway through (a genuine bug: Prisma's
interactive transaction client has no `$transaction`, so nested transaction code
threw). The crashed run left a **committed prefix** — escrow and three payment rows
— with ChainEvent markers proving exactly which events had applied. The next run
skipped those, processed the remaining four, and completed. That is the
partial-ingestion property working on real data rather than in a test.

### Pause-gated contract upgrade

The per-payment events were deployed by **upgrading the existing v2 contract in
place**, which preserved its address and all existing escrows:

```
upgrade without pausing first  → Error(Contract, #22)  NotPaused   (refused)
set_paused(true) → upgrade → set_paused(false)         (succeeded)
get_admin, expected_admin, oracle registry             (all survived)
escrow 2: 3 payments, manager_approved=true            (state intact)
extend_escrow_ttl                                      (new entry point live)
```

### Indexing (chain → database)

Verified against a live Postgres with the real indexer
(`src/lib/indexer/__tests__/live-testnet.test.ts`, opt-in via
`COREFLOW_LIVE_TESTNET=1`):

- 14 contract events read from Testnet RPC and projected
- escrow rows written with `status = paid`
- amounts stored as **base units** with `assetDecimals = 7` (not cents)
- re-running the indexer adds no duplicate `ChainEvent` rows (idempotent by RPC
  paging token)

**Caveat, stated plainly:** the current off-chain `Escrow` model carries a single
worker and amount, so a 3-payee batch is projected as one row holding the first
payment's figures. The on-chain settlement is complete and correct; the database
view of it is lossy. See Known limitations.

### Live front-running test (F-9)

A second contract was deployed from the same pinned WASM and an attacker
identity attempted to claim admin:

```
victim contract : CCXRQYROEXDTTS77HNEZNLQLNSU35W6BKUPMN27HCV4JLB3VLHXDQQHT
attacker        : GCQR4PEWRAKH4IB4NUDU77WOU326UUQORNVBIHOZ5XD3ZK2FN5SJKSSY
result          : Error(Contract, #20)   AdminMismatch
get_admin after : null
```

The attacker won the race and gained nothing.

---

### Bulk Pay API layer (P2 #5, in progress)

See [`../BULK_PAY.md`](../BULK_PAY.md). **Database-backed validation is BLOCKED** — the
local development database is unavailable, so migration 8 is unapplied and no query
below has run against real PostgreSQL.

| Property | Evidence |
|---|---|
| One Payment per CSV row, never an aggregate | `payroll/__tests__/batches.test.ts`; `payroll/__tests__/csv.test.ts` (102 tests) |
| Exact decimals; scientific notation, excess precision and fractional hours refused | `csv.test.ts` — 74 tests incl. `0.0000001` preserved as `1n` |
| Spreadsheet formula injection neutralized at the storage boundary | `csv.test.ts` "hostile input"; asserted on the stored `sourceReference` |
| Unknown request fields rejected, not ignored | `batches.route.test.ts` — `{state:'PAID', role:'FINANCE'}` → 400 `UNKNOWN_FIELD` |
| Approver role derived from membership, never the body | `batches.route.test.ts` — `{"role":"FINANCE"}` refused at the schema |
| Separation of duties holds for roles with BOTH permissions | `batches.route.test.ts` — ADMIN approving twice records 3, then 0 |
| Cross-tenant batch returns a byte-identical 404 to a non-existent one | `batches.route.test.ts` — responses compared with `toEqual` |
| Idempotent creation under double-click, retry and N concurrent requests | `batches.route.test.ts` — 1 batch, 3 payments, not 9 |
| Same key + different payload refused rather than replayed | `batches.route.test.ts` → 409 `IDEMPOTENCY_KEY_REUSED` |
| Lost-race path relies on the unique index, not the pre-check | `batches.test.ts` — pre-check blinded so only the index can stop the write |
| Batch creation is atomic | `batches.test.ts` — injected failure leaves no batch, payment or audit event |
| Approval changes no state, hash, amount or recipient | `batches.route.test.ts` — before/after snapshot equality |
| 500 leaks no model name, `prisma`, or stack frames | `batches.route.test.ts` "error sanitization" |

#### Two real bugs found while building this

**`approval.create` omitted `orgId`.** `Approval`'s parent relation is a composite
foreign key on `(orgId, paymentId)`, so `orgId` is a required scalar — the generated
`ApprovalUncheckedCreateInput` lists it without `?`. The call passed only `paymentId`,
and would have failed against real PostgreSQL with *Argument `orgId` is missing* on the
**dual-approval path**. It survived because `db` is typed `any` and the in-memory
double did not enforce required columns.

Fixed in `payments/actions.ts`, and the double now enforces required columns for all
twelve tenant-scoped tables. Switching that on immediately caught a **second** instance
in `rejectPayment`'s `approval.upsert`, which a `.create`-only static audit had missed.

**`any * any` is typed `number` by TypeScript.** The draft re-validation read payments
as `any`, so `p.hours * p.rateBaseUnits` — the exactness check itself — would have been
evaluated as floating-point arithmetic. Caught by `tsc` only once the operands were
given explicit `bigint` types, which is why `RevalidationPayment` is declared rather
than inferred.

#### A fake-db defect that would have weakened a test

The in-memory double's `$transaction` snapshotted **every** table and restored the whole
snapshot on failure. Under concurrency that is wrong in the worst direction: when two
transactions interleave at an `await` and the second fails, restoring its snapshot also
discards the **first** one's committed writes.

The concurrent-idempotency test therefore saw one batch with **one** payment instead of
one batch with **three** — a result that invites weakening the assertion. Real Postgres
isolates transactions per connection, so the double now records a per-transaction undo
log and replays only its own writes.

### Database validation gate (real PostgreSQL)

`npm run test:integration` — 71 tests against PostgreSQL 18.6 on a private local
cluster. A separate vitest config from the unit suite, so the two totals can never be
conflated. Setup: [`../ENVIRONMENTS.md`](../ENVIRONMENTS.md#setting-up-the-development-database).

| Property | Evidence |
|---|---|
| 10 migrations apply from zero | `prisma migrate deploy` on an empty database |
| Schema matches the Prisma model | `prisma migrate diff --exit-code` → 0 (no drift) |
| 14 composite tenant FKs exist | enumerated from `information_schema` |
| Cross-tenant payment → batch rejected | `constraints.integration.test.ts` → P2003 |
| Cross-tenant approval, project, worker, audit event rejected | 4 further P2003 tests |
| Same wallet may be a worker in two orgs | uniqueness is per tenant, not global |
| `(orgId, idempotencyKey)` unique; NULLs distinct | 3 tests |
| One payment per on-chain slot | `(escrowId, onChainPaymentIndex)` → P2002 |
| One RUNNING reconciliation run per org | partial unique index, incl. release-and-restart |
| Money exact through the column | `250.50`, `1000`, `1n`, int8 max: client value, re-read, and `::text` from SQL all agree |
| int8 overflow refused, not wrapped | max + 1 rejected |
| Organization delete cascades; other tenant untouched | cascade test |
| Rollback leaves zero partial records | real transaction, failure injected on row 3 |
| One failing transaction cannot undo another | the defect the in-memory double had |
| 3 concurrent identical creates → 1 batch, 3 payments | 1 response `created:true`, 2 `created:false` |
| Same key + different payload → 409 | `IDEMPOTENCY_KEY_REUSED` |
| 3 concurrent unkeyed creates → 3 distinct references | reference-collision retry under contention |
| No user actor of any role can persist PAID | OWNER, ADMIN, MANAGER, FINANCE each refused |
| PAID never moves backwards | 6 destinations × 3 actor kinds, all refused |
| Audit trail is continuous | each row's `previousState` equals the prior row's `newState` |
| Tenant isolation through the API | cross-tenant read/approve/re-validate → byte-identical 404 |

#### Two more real defects, found only by real PostgreSQL

**A migration that could never have applied.** `20260911020000_reconciliation_reliability`
added six values to the existing `FindingKind` enum and then used them in `UPDATE`
statements in the same file. PostgreSQL refuses that:

```
ERROR: unsafe use of new value "ASSET_MISMATCH" of enum type "FindingKind"
HINT:  New enum values must be committed before they can be used.   (55P04)
```

`prisma migrate deploy` wraps each migration in one transaction, so add-and-use in a
single file can never work — regardless of PostgreSQL version, and despite the
generated comment in that file claiming it is only a PG-11-and-earlier concern. The
earlier claim that "7 migrations apply from zero" was **wrong**: this migration had
been applied by hand and then marked applied with `migrate resolve`, so the from-zero
path had never actually been exercised. The ADD VALUE statements are now their own
migration, `20260911015000_finding_kind_values`, and the full history applies from
zero.

**`onDelete: SetNull` on a composite FK whose `orgId` is NOT NULL.** Twelve relations
declared it. SET NULL nulls **every** column of the foreign key, so deleting an
Escrow, Project or Worker that any row referenced failed with:

```
Null constraint violation on the fields: (`orgId`)
```

Deleting an escrow was therefore impossible. `prisma validate` had been emitting a
warning about exactly this, which had been noted as pre-existing and not
investigated — the integration test is what forced it. Changed to `NoAction` in
`20260911044540_composite_fk_no_action`: NO ACTION is checked at the end of the
statement, so a cascading delete from Organization still succeeds, while a direct
delete is refused while dependent rows exist. That refusal is the correct behaviour
for financial data — detaching a payment from its escrow destroys the record of what
the money was for.

#### Three tests that were wrong, and were corrected rather than deleted

Recorded because each looked like a product bug and was not:

- A test asserted the planner would choose an index over a sequential scan on 200
  rows. Postgres is right to prefer a seq scan at that size. Rewritten to prove a
  usable index **exists** (`SET LOCAL enable_seqscan = off`) — which also exposed
  that `SET LOCAL` outside a transaction is silently discarded.
- A concurrency test raced `READY_TO_SETTLE → SUBMITTING` against
  `READY_TO_SETTLE → PAID` and expected one winner. Both succeeded, correctly: the
  table allows `SUBMITTING → PAID`, because a confirmation can arrive before our own
  update lands. Re-aimed at a genuinely incompatible pair.
- A concurrency assertion listed only two of the three legitimate refusal codes and
  failed about **half the time**. The missing one was `TERMINAL`: when the CANCELLED
  side won, the other transition was refused because nothing leaves a terminal state.
  Found by running the suite ten times rather than accepting eight green runs. The
  flake was the test's, not the product's — and a flaky financial test is exactly the
  kind that gets silenced instead of understood.
- A test expected `Argument \`orgId\` is missing`. Prisma reports the missing
  **relation**: `Argument \`org\` is missing`. Worth recording, since grepping logs
  for the column name would never surface that failure.

### Live Testnet funding validation — ATTEMPTED, BLOCKED

**No transaction was submitted. No funds moved.** Recorded in
[`testnet-v2-live-funding.json`](testnet-v2-live-funding.json).

This is a live-infrastructure attempt, separate from the unit and integration suites
and separate from the historical v1 Mainnet activity. It is **not** evidence of
adoption or of anything settling.

The run stopped at transaction **simulation** with `Error(Contract, #16)` —
`OracleKeyNotRegistered`. The v2 contract refused to create the escrow because the
oracle public key supplied is not in its admin-managed registry. Because simulation
failed, nothing reached the network.

| Read-only check | Result |
|---|---|
| `is_oracle_key_registered(3b9d395a…)` — the key in the local environment | **false** |
| `is_oracle_key_registered(f42a4883…)` — the key recorded at deployment | **true** |

The contract trusts the key from deployment time and does not trust the one now in
the local environment — consistent with the oracle secret having been rotated
locally without the new public key being registered on-chain.

**No key was registered or revoked.** Which key is the post-rotation one is a fact
only the operator holds, and registering the wrong one would re-authorize a
credential that may be compromised — exactly what the admin registry exists to
prevent. This is therefore an operator action, and the 🔴 outstanding secret rotation
is now on the critical path rather than deferred.

What the run did establish before stopping:

| Stage | Result |
|---|---|
| Environment preflight | local PostgreSQL + CoreFlow v2 Testnet |
| Payroll from a real CSV through the real parser and batch service | 1 batch, 3 payments |
| Exact base units persisted | 10000000 + 15000000 + 5000000 = 30000000 (3.00 test USDC) |
| Dual approval as real `Approval` rows, two distinct wallets | 6 rows |
| Funding intent opened, plan frozen, digest verified against its content | ✅ |
| Manager Testnet balance | 77,120 test USDC — funds were not the blocker |

The contract refusing an unregistered oracle is the security control working. A
manager cannot install their own oracle, which is the defect this phase's
attestation registry was built to close — and it held against a real transaction.

## 4. Instawards SOW deliverables

| # | Deliverable | Implementation | Test | Live evidence |
|---|---|---|---|---|
| 1 | Token transfer integration | `pay_batch` / `initialize_multi_sig_escrow` (`contracts/core-flow/src/lib.rs`) | `test_pay_batch_settles_two_assets_in_one_call`, `test_custody_sum_invariant_fuzz` | Golden path §3 step 6–7 |
| 2 | Ed25519 oracle verification | `build_proof_message`, `verify_oracle_work`, `proof_preimage`; `src/lib/oracle/index.ts`; `scripts/oracle-cli.mjs` | `test_proof_preimage_matches_cross_language_vector`, `test_contract_preimage_matches_independent_implementation`, 16 TS oracle tests | Golden path §3 step 3–4 |
| 3 | Bulk Pay + Freighter dual approval | `src/app/bulk-pay/page.tsx`, `manager_approve` / `finance_approve` | `test_finalize_without_finance_approval_fails`, `test_escrow_rejects_identical_manager_and_finance` | Golden path §3 step 5 |
| 4 | Testing, docs, validation evidence | 62 Rust + 135 TS | this document | `testnet-v2-golden-path.json` |

---

## 5. Cross-language proof vector

[`proof-vector-v2.json`](proof-vector-v2.json) pins the 198-byte `CFWP-v2`
preimage across three independent implementations:

1. **Rust (contract)** — `test_proof_preimage_matches_cross_language_vector`
2. **TypeScript (server signer)** — `builds the exact preimage pinned by the cross-language vector`
3. **Contract vs. independent Rust** — `test_contract_preimage_matches_independent_implementation`

The Rust test's builder is deliberately a *second* implementation rather than a
call into the contract's. Sharing the builder would prove only that one function
agrees with itself, and a field silently dropped from the preimage would pass.

---

## 6. Known limitations

Stated plainly rather than omitted.

| Limitation | Detail |
|---|---|
| **Whole hours only** | The contract enforces `hours × rate == amount` with integer hours. `,001` at `5/h` is 40.04 h and is **rejected at creation**. Fractional-hour payroll requires a versioned scaled-hours schema (v3). Hours and amounts are never silently rounded. |
| **v2 is Testnet only** | Mainnet runs v1, which has none of v2's hardening. |
| **Storage archival** | Persistent entries that run out of rent are archived to the Expired State Stack and require a `RestoreFootprint` operation before the escrow can be used again. This is recoverable, not fund loss. `extend_escrow_ttl` is permissionless so anyone can keep an escrow alive. |
| **Rate limiter is per-instance** | In-memory; on a multi-instance deployment effective limits scale with instance count. Needs a shared store for production. |
| **`upgrade` remains a centralization risk** | Requiring a pause first makes it observable and deliberate; it does not constrain a malicious admin. |
| **Test USDC** | The Testnet settlement asset is a locally issued `USDC`, not Circle USDC. |
| ~~Indexer projects one payee per escrow~~ | **FIXED in P2 #1.** One `Payment` row per on-chain payment slot, verified against live Testnet data above. |
| **Batch-level approval granularity** | Manager and finance approval are per-ESCROW on-chain, so approving advances every payment in that escrow. Per-payment approval would need a contract change and is not claimed. |
| **`PAID` is terminal** | When reconciliation finds a payment recorded as `PAID` that the chain disputes, it opens a finding but cannot move the payment, because no transition leaves `PAID`. The finding is the durable record; the state machine was not weakened to allow an exit. |
