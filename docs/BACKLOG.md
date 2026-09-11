# Engineering backlog

Known gaps that are deliberately **not** being fixed in the current phase, recorded
so they cannot quietly become permanent.

---

## 1. Test files are not typechecked

**Status:** open. Raised 2026-09-11 during the funding API work.

### What

[`tsconfig.json`](../tsconfig.json) excludes test files from the compiler:

```json
"exclude": ["node_modules", "test", "e2e", "playwright.config.ts",
            "**/*.test.ts", "**/*.test.tsx", "**/__tests__/**"]
```

So `npm run typecheck` checks production code only. A test file can reference a
function with the wrong arguments, the wrong types, or a parameter that no longer
exists, and nothing objects until runtime — if then.

### Why it matters, concretely

It silently weakened a security test. A required `batchId` parameter was added to
three funding service functions to scope an attempt to its batch. The existing test
call sites were not updated, and:

- **no compile error**, because tests are not typechecked
- **no test failure**, because Prisma (and the in-memory double) treat
  `where: { batchId: undefined }` as *"no filter"* rather than *"match null"*

The tests kept passing while no longer exercising the isolation they were written to
prove. That is worse than a failing test: a green suite asserting nothing.

Found by reading the code, not by any tool. There is no reason to think it is the
only instance.

### Likely cost of fixing

Unknown, and probably not small. Across ~40 test files the expected classes are:

- fixtures passing partial objects where a full type is required (the fake-db rows
  are written by hand and omit optional columns)
- `any`-typed `db` handles hiding argument mismatches
- mock factories returning narrower shapes than the real module
- `vi.mock` factories whose return type does not match the mocked module

### Intended migration

1. Add a second config, `tsconfig.test.json`, extending the base and *including*
   test files. Do not change the main `tsconfig.json`.
2. Run it and record the error count before changing any test.
3. Fix by directory, smallest first, so each step is reviewable: `lib/money`,
   `lib/payroll`, `lib/funding`, `lib/payments`, `lib/tenancy`, routes.
4. Where a fixture genuinely needs a partial row, introduce an explicit test-only
   type rather than casting to `any` — a cast reintroduces the blindness.
5. Add `typecheck:tests` to the npm scripts and to CI only once it is clean, so it
   cannot regress.

Not started. Scheduled after the funding UI gate.

---

## 2. Reconciliation panel is built but unrouted

`ReconciliationPanel` is implemented and tested and reachable from no page. See
[RECONCILIATION.md](RECONCILIATION.md). To be routed with the remaining payroll
workflow UI.

## 3. Transfer verification is bounded by RPC retention

Soroban RPC retains roughly 22 hours of events, so a payment older than that reads
as `UNREADABLE` rather than absent. Partially mitigated: funding now persists
verified settlement evidence at confirmation time. The same persistence is still
needed for `pay_batch` settlement evidence.

## 4. Alerting is in-product only

Findings surface in the UI. There is no email, Slack or pager path, so a critical
finding raised overnight is seen the next morning. Deliberately out of scope until
the workflow is complete.

## 5. Approval granularity is per-escrow

The contract's `manager_approve` / `finance_approve` act on the whole escrow, so a
reviewer cannot approve eleven of twelve payments on-chain. The off-chain approval
records are per-payment. A v3 contract decision.

## 6. Whole hours only

`hours` is an integer and the contract enforces `hours × rate == amount`. Fractional
hours need a versioned scaled-hours schema. Refused rather than rounded.

## 7. 🔴 Secret rotation outstanding — now on the critical path

The oracle half of this is blocking the live Testnet funding run: the contract trusts
the deployment-time oracle key and not the one in the local environment, so escrow
creation is refused with `OracleKeyNotRegistered`. Prepared, unexecuted runbook:
[ORACLE_KEY_TRANSITION.md](ORACLE_KEY_TRANSITION.md). It waits on the owner
confirming which public key is post-rotation — a fact that cannot be inferred from
here, and guessing it could re-authorize an exposed credential.


Everything exposed by `prodenv.txt` — the oracle signing key, `AUTH_SECRET`,
`BOOTSTRAP_SECRET`, cron/indexer secrets, the database credential. Owner-operated;
not something to be solved by reading the secrets. Until each is rotated and the old
value proven unable to authenticate or sign, this environment is not
production-grade regardless of what the test suite reports.
