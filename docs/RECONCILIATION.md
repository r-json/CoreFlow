# CoreFlow Reconciliation

Reconciliation is an **independent correctness check** on the payment projection,
not a background tidy-up. This document states what it verifies, how independently,
what it will and will not change, and how an operator works with it.

> **Scope claim.** Reconciliation runs on a schedule, records every run, detects
> the discrepancy classes below, and surfaces them with remediation. It is not
> described here as production-grade: see §11 for what is missing.

---

## 1. Authority

| Authoritative for | Source |
|---|---|
| Token movement, settlement, custody | **Chain** |
| Contract state and authorization | **Chain** |
| Transaction outcome | **Chain** |
| Application projections, workflow metadata | PostgreSQL |
| Organization/project relationships, tenancy | PostgreSQL |
| Audit presentation, search, reconciliation findings | PostgreSQL |

The database never silently overrides chain evidence. Where they disagree, the
disagreement is **recorded**.

---

## 2. Independence: what is actually verified

A reconciler that re-read CoreFlow's own events, through the same parser, into the
same projection would verify nothing — a bug in how CoreFlow emits or decodes its
events would validate itself.

Verification therefore comes from sources CoreFlow did not author:

| Source | Why it is independent |
|---|---|
| **SAC `transfer` events** | Emitted by the TOKEN contract: `transfer / from / to / asset → amount`. This is the actual movement of value. If CoreFlow claims a payment settled and no transfer from the escrow contract to that recipient for that amount exists, the claim is false regardless of CoreFlow's own log. |
| **Contract storage (`get_escrow`)** | A read of current state, not of the event stream — a different derivation of the same truth. |
| **Transaction results** | Whether a specific hash actually succeeded. |

The indexer trusts `payment/paid`. The reconciler does not. That asymmetry is the
point.

### Transaction-scoped matching

A transfer is matched on `(from = escrow contract, to = recipient, asset, exact
amount)` **within one transaction**.

The transaction scope is load-bearing, and live validation is what proved it: the
tuple without a transaction is **not unique**, because the same escrow contract
pays the same contractor the same rate every pay period. Seven identical payroll
runs produced seven identical transfers, and treating those as seven matches for
one payment reported a duplicate payment that never happened.

- When the payment records a settlement transaction, the match is confined to it.
- Otherwise the settling transaction is inferred as the most recent one whose
  transfers cover **every** expected payment of the escrow — a `pay_batch`
  transaction contains one transfer per payee.
- `DUPLICATE_PAYMENT_EVENT` is raised only for two transfers to one payee **inside
  a single transaction**. Across transactions that is normal recurring payroll.

---

## 3. Outcomes

| Outcome | Meaning |
|---|---|
| `AGREED` | Projection, contract state and observed transfer all match |
| `CHAIN_AHEAD` | Chain settled; projection behind. **Corrected.** |
| `DATABASE_AHEAD` | Database claims PAID; chain does not support it. **Never reverted.** |
| `CHAIN_UNREADABLE` | Could not check. Not agreement, not a mismatch. |
| `MISMATCHED` | Identity or amount disagrees |
| `UNKNOWN_ON_CHAIN_OBJECT` | On-chain escrow belongs to no organization |
| `ORPHANED_DATABASE_OBJECT` | Recorded payment with no on-chain slot |

### Only two automatic corrections

`CHAIN_AHEAD → PAID` and *escrow cancelled on-chain* `→ CANCELLED`.

Both require independent confirmation. A `CHAIN_AHEAD` payment is advanced **only**
when an observed SAC transfer corroborates it: if the contract reports `FINALIZED`
but no transfer is visible, the projection is **not** advanced and a
`MISSING_PAYMENT_EVENT` finding is opened. Advancing on contract state alone would
defeat the independent check.

### `DATABASE_AHEAD` is never reverted

`PAID` is terminal in the payment state machine and stays so. The finding is the
durable record, and the state machine is not weakened to permit an exit.

A system that silently un-pays a payment to look consistent has destroyed the
evidence of its own worst bug. The operator workflow is in §8.

---

## 4. Finding taxonomy

| Kind | Severity | Meaning |
|---|---|---|
| `DB_PAID_CHAIN_NOT` | **CRITICAL** | Shown as settled; chain disagrees |
| `FAILED_TX_ACTUALLY_SUCCEEDED` | **CRITICAL** | Recorded failed, actually succeeded — retry would double-pay |
| `AMOUNT_MISMATCH` | HIGH | Settled amount ≠ recorded amount |
| `RECIPIENT_MISMATCH` | HIGH | Funds reached a different address |
| `ASSET_MISMATCH` | HIGH | Settled in a different asset |
| `DUPLICATE_PAYMENT_EVENT` | HIGH | Two transfers for one payee in one transaction |
| `MISSING_PAYMENT_EVENT` | HIGH | Contract says settled, no transfer observed |
| `CHAIN_PAID_DB_NOT` | MEDIUM | Projection lagging |
| `MISSING_ON_CHAIN` | MEDIUM | Recorded payment with no on-chain slot |
| `ORPHAN_ON_CHAIN` | MEDIUM | On-chain payment with no database row |
| `UNKNOWN_ON_CHAIN_OBJECT` | LOW | Escrow belongs to no organization |
| `CHAIN_UNREADABLE` | LOW | Could not check |
| `OTHER` | MEDIUM | Unclassified — taxonomy needs an entry |

**CRITICAL is reserved for findings where the product may be making a false
statement about money.** Everything else, however annoying, is a lag or an
operational issue. Every kind carries operator-facing `remediation`; a finding
without it is a puzzle.

---

## 5. Scheduling and concurrency

Triggered by **Vercel Cron** (`vercel.json`, hourly at :17) against
`POST /api/reconciliation/run`, protected by `CRON_SECRET`. An operator can also
run one organization via `POST /api/organizations/:id/reconciliation`.

**No job framework.** CoreFlow deploys on Vercel, where there are no long-lived
workers. Redis or a queue purely to own a cron tick would be infrastructure with no
other purpose and one more thing that can be down. The lock lives in PostgreSQL,
which the application already depends on absolutely.

### The lock

```sql
CREATE UNIQUE INDEX "ReconciliationRun_one_running_per_org"
  ON "ReconciliationRun" ("orgId") WHERE "status" = 'RUNNING';
```

A check-then-insert is a race: two workers on the same tick both pass the check and
both insert. The partial unique index makes PostgreSQL refuse the second, so the
lock does not depend on the application noticing. Verified directly against the
database — see the evidence package.

### Heartbeats

A run refreshes `heartbeatAt` every 30s. A run whose heartbeat is older than
**10 minutes** is marked `STALE` and its lock reclaimed. Stale runs are marked, not
deleted: that a run died is evidence, and silently reusing the lock would erase it.

### Bounded scope

`maxEscrows` caps one pass. The platform sweep processes at most 50 organizations
per invocation; the rest are picked up next tick rather than making one invocation
unbounded. One tenant's RPC failure does not abort the sweep.

---

## 6. Run records

Every run records scope, correlation id, status, timings, and counters
(`escrowsExamined`, `paymentsExamined`, `agreed`, `mismatched`, `unreadable`,
`chainAhead`, `databaseAhead`, `findingsOpened`, `correctionsApplied`).

A failure still **completes** the record, marked `FAILED` with the error. A run that
simply stops existing is indistinguishable from one that never started — and then
"no findings" reads as health.

`reconciliationHealth()` reports **DEGRADED** when the last run failed, went stale,
stopped responding, or never happened. The UI refuses to show "all clear" in that
state: an empty findings list after a failed run means nothing was checked.

---

## 7. Retry behaviour

| Condition | Behaviour |
|---|---|
| RPC timeout reading an escrow | `CHAIN_UNREADABLE` finding; nothing downgraded; retried next run |
| RPC timeout reading transfers | Payment **not** advanced; `CHAIN_UNREADABLE` |
| Escrow genuinely absent on-chain | `MISSING_ON_CHAIN` — distinct from unreadable |
| Transaction not found (beyond retention) | Left alone; absence of a record is not failure |
| Finding still present next run | Re-observed: `lastObservedAt` and `observationCount` updated, no duplicate row |
| Finding resolved, then recurs | A **new** finding opens |

A duplicated queue becomes noise, and a noisy queue gets ignored — the same as
having none.

---

## 8. Operator workflow

```
OPEN → ACKNOWLEDGED → INVESTIGATING → RESOLVED
```

`PATCH /api/organizations/:id/findings/:findingId`, requiring
`reconciliation:resolve` (OWNER/ADMIN). Resolution requires a substantive
explanation — a "mark resolved" button with no reason turns the queue into a
dismiss button, and the next reader during an incident learns nothing. Actor,
timestamp and reason are recorded, and an `AuditEvent` is written.

**What resolution cannot do:** change a payment's state, amount, recipient or
transaction hash. It records a human judgement *about* a discrepancy. Only
lifecycle fields are written; a test asserts exactly which.

### Resolving a `DB_PAID_CHAIN_NOT`

1. Open the transaction on the explorer (link is on the finding).
2. If the transfer exists, the database was right and the verifier's window missed
   it — resolve, noting the transaction.
3. If it does not, the payment did not settle. The payment record stays `PAID`
   (terminal), so re-issuing requires a **new** payment; note the original finding
   id in the new batch's reference.
4. Either way the resolution text must say which was established.

### Investigating an orphaned escrow

`UNKNOWN_ON_CHAIN_OBJECT` names the escrow id. CoreFlow will not guess an owner. If
it is yours, claim it via `POST /api/organizations/:id/escrows/claim` with the
wallet that created it — the claim verifies on-chain manager against live state.
Events recorded before the claim are replayed, not lost.

---

## 9. Observability

Every run has a correlation id (`rec_<uuid>`) threaded through its logs, stored on
the run and on every finding it observed. The trace is:

```
run correlationId → organization → escrow (onChainId) → payment → transaction hash → finding id
```

Never logged: private keys, wallet secrets, session secrets, authentication
payloads. Findings carry addresses and amounts, which are tenant data and are
served only through tenant-scoped endpoints.

### Metrics available from run records

Runs (total/succeeded/failed), findings opened and resolved, chain-ahead
corrections, unreadable cases, orphaned objects, run duration
(`completedAt - startedAt`), and oldest unresolved finding age.

---

## 10. Security

| Control | Implementation |
|---|---|
| Cron trigger not user-reachable | `CRON_SECRET`, constant-time compare, minimum 16 chars, rate limited, 404 on every failure |
| Findings are tenant-scoped | `withTenant` + `orgId` in every query; cross-tenant finding id → 404 |
| Resolution is authorized | `reconciliation:resolve` (OWNER/ADMIN only) |
| Cannot forge PAID | Only `applyTransition` changes state, and only on observed transfer evidence |
| Cannot inject a transaction hash | Hashes come from observed transfers, never from a request |
| Cannot mutate an amount | Reconciliation has no amount-write path at all |
| No user-supplied chain confirmation | The verifier reads RPC; request content is never evidence |
| Organization spoofing | Organization comes from membership, never from the request |

---

## 11. What is NOT done

| Gap | Status |
|---|---|
| **Alerting is in-product only** | Critical findings surface in the API and the operator panel. There is **no** email, Slack or pager integration — nobody is woken up. An unattended deployment would not notice a CRITICAL finding until someone looked. |
| **Operator panel is not routed** | `ReconciliationPanel` is built and tested but not yet mounted on a dashboard page. |
| **Transfer history is bounded by RPC retention** | The default lookback is ~16,000 ledgers (~22h). A payment older than the node's retained event history reads as `CHAIN_UNREADABLE`, not as verified. Long-horizon verification needs an archive or stored per-payment transfer evidence. |
| **No per-payment transfer cache** | Every run re-reads the token's events. Fine at current volume; at scale this needs the verified transfer recorded against the payment on first confirmation. |
| **Batch aggregate check is implicit** | Payment-level verification is exhaustive, and a batch is verified by verifying each of its payments. There is no separate stored batch total assertion — deliberately, since a stored aggregate is a second copy of mutable truth. |
| **No automated retry/backoff schedule** | Unreadable findings clear on the next scheduled run; there is no escalating retry for a persistently unreachable RPC. |
| **Not load-tested** | Behaviour with thousands of payments per organization is unmeasured. |
| **Live test suites cannot run in parallel** | The three opt-in live suites share one database and each resets the chain-event table, so they must be invoked sequentially (one `vitest run` per file). Running them together produces spurious failures. Not a product defect, but a real constraint on the validation procedure. |
