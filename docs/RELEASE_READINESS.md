# Release Readiness: production (v1) vs `main`

**Status: investigation only. Nothing in this document has been executed.**
No deploy, promotion, rollback, migration or Vercel setting change was made while
writing it. Production was only read through public, read-only HTTP requests
(listed in [Evidence](#6-evidence-and-how-it-was-gathered)).

Written 2026-11-25 against `main` at `886518d`.

---

## Summary

| Question | Answer |
|---|---|
| What is production running? | The Sep 5 2026 build of PR #5. Its original SHA `2273ea3` no longer exists (history was rewritten); the same merge is now **`5adbdb0`**. The deployed route set matches `5adbdb0` exactly (41/41). |
| How far behind is it? | 56 commits (48 excluding merges), 488 files. Most of the volume is test snapshots, the Testnet evidence archive and the Kit (`packages/`, `apps/workbench`, `examples/`). |
| Can `main` run against the production **v1 schema**? | **No.** `main`'s Prisma client reads columns and tables that v1 does not have ([§2.1](#21-schema-no)). |
| Can `main` run against the **Mainnet v1 contract**? | **No.** `main` signs only `CFWP-v2` proofs, which v1 rejects. Even with a migrated database, no payment could complete ([§2.2](#22-contract-no)). |
| Would deploying `main` today migrate production? | Only via `deploy.yml`, whose `migrate deploy` step should abort with **P3009** on the failed baseline row (last observed 2026-09-11). A plain Vercel deploy or promotion of `main` runs **no** migrations. It would ship v2 code onto the v1 schema and break the app ([§3](#3-migrations-that-would-run-on-production)). |
| Recommendation | Stay on v1 and ship a v1 patch release (Option A). Stand up a v2 Testnet deployment in parallel (Option B). Treat v2 on Mainnet (Option C) as a separate, scheduled project. |

---

## 1. What changed between `5adbdb0` and `main`

### 1.1 Database schema (`prisma/schema.prisma`)

v1 has 10 models and 1 enum. `main` has 21 models and 12 enums.

**New models:** `Organization`, `OrgMember`, `Project`, `Worker`, `PayrollBatch`,
`Payment`, `Approval`, `BlockchainTransaction`, `AuditEvent`,
`ReconciliationRun`, `ReconciliationFinding`.

**Changes to models that exist in v1:**

| Model | Added | Removed | Type changed |
|---|---|---|---|
| `Escrow` | `orgId`, `projectId?`, `contractId`, `network`, `managerAddress`, `financeApproverAddress`, `oraclePublicKey?`, `assetDecimals`, `totalAmountBaseUnits` (BigInt), `cancelled`, `oracleRotations` | `workerPubKey`, `amountCents`, `rateCents`, `currency`, `status`, `rejectionReason` | `id` Int → String |
| `TimeLog` | | `escrow` relation | `escrowId` Int → String? |
| `Invitation` | `orgId`, `orgRole`, `tokenHash`, `revokedAt?`, `revokedBy?`, `invitedBy?` | `token` | |
| `OracleAttestation` | `orgId`, `onChainPaymentIndex`, `contractId?`, `schema`, `hours` (BigInt), `preimageSha256?` | `hoursLogged` | `paymentId` Int → String?, `nonce` Int → BigInt |
| `IndexerCursor` | `contractId`, `network` | | `id` Int → String |
| `ChainEvent` | `contractId?`, `network`, `txHash?`, `paymentIndex?`, `payload?`, `attributed` | | |
| `User` | relations only (`memberships`, `workerProfiles`) | | |

### 1.2 Migrations

`main` adds 11 migrations after the squashed baseline `20260801000000_initial_schema`,
plus `migration_lock.toml`. Each is detailed in [§3](#3-migrations-that-would-run-on-production).

### 1.3 Environment variables

| Variable | Change in `main` | Production today |
|---|---|---|
| `NEXT_PUBLIC_STELLAR_CONTRACT_ID` | No fallback any more. Unset is a hard error (`src/lib/config.ts`, `requireContractId`). At `5adbdb0` it fell back to the v1 Mainnet ID. | The production bundle inlines `CCTF5WBO…J2XPRFFW` (v1 Mainnet). |
| `NEXT_PUBLIC_STELLAR_NETWORK` | Normalised: anything except `public`/`mainnet` means testnet. | The production bundle inlines `"public"`. |
| `NEXT_PUBLIC_STELLAR_TOKEN_ID` | Escrow creation refuses to build a transaction without it. | **Not set at build time.** The production bundle still reads `process.env.NEXT_PUBLIC_STELLAR_TOKEN_ID \|\| ""`, which Next.js leaves in place only when the variable is undefined during the build. |
| `NEXT_PUBLIC_SETTLEMENT_ASSET_CODE` | **New.** Defaults to `USDC` (`src/lib/payroll/assets.ts`). | n/a |
| `NEXT_PUBLIC_BULK_PAY_ESCROW_ID` | **New.** Defaults to `1` (`src/app/bulk-pay/page.tsx`). | n/a |
| `COREFLOW_LIVE_TESTNET` | **New.** Tests only. | n/a |
| `AUTH_SECRET` | The insecure default was removed from `src/lib/env.ts`. No change in practice: nothing imports `env.ts`, and `src/lib/auth/jwt.ts` already required the variable in both builds. | Not inspected (it's a secret). Confirm it's present in the Vercel dashboard. |
| `CRON_SECRET` / `INDEXER_SECRET` | Now also guards `/api/reconciliation/run`. | Needed once crons exist. Presence not verified. |

No dependency versions changed in `package.json`.

### 1.4 `vercel.json`

| Key | `5adbdb0` | `main` |
|---|---|---|
| `buildCommand` / `installCommand` / `outputDirectory` | unchanged | unchanged. The build runs `prisma generate && next build` and **never migrates**. |
| `git.deploymentEnabled` | absent | `main`, `feat/*`, `fix/*` → `false` |
| `crons` | none | `/api/indexer/run` at 00:00 UTC, `/api/reconciliation/run` at 00:30 UTC |

Crons are registered by the deployment that carries them. Deploying `main` turns
on a nightly reconciliation run, and that run needs v2 tables.

### 1.5 `.github/workflows/deploy.yml`

The trigger changed from `push: main` to `workflow_dispatch`. The job still runs
`npx prisma migrate deploy` and then `vercel --prod`. It calls Prisma directly,
**not** `npm run db:deploy`, so `scripts/check-env.mjs` does not run on this path.

### 1.6 Contract and network configuration

| | v1 (`5adbdb0` source, on Mainnet) | v2 (`main` source, on Testnet) |
|---|---|---|
| Contract ID | `CCTF5WBOQR7JP2KPLQT372X7JCGCINHDFRSAPF4YTYRKZXZ3J2XPRFFW` | `CDN4FIKLJ72WYNPBIKWYSDJWDZG22QNPLWI37VTUAE4EKKIBVAQRG5F4` |
| Settlement SAC | not recorded in the repo | `CBW2ZKFBHLHNNVCZ7JP4AXHQOOC3S6NLAMORXOAIWQNWMKUVJS743Q5M` (test USDC) |
| Entry points | 14 | 23. Adds `expected_admin`, `propose_admin`, `accept_admin`, `get_admin`, `register_oracle_key`, `revoke_oracle_key`, `is_oracle_key_registered`, `extend_escrow_ttl`, `proof_preimage`. |
| Shared entry-point signatures | | unchanged (`initialize_multi_sig_escrow`, `submit_hours_proof`, …) |
| `CoreFlowEscrow` / `PaymentSchedule` layout | | unchanged |
| Signed proof message | 32 bytes: `escrow_id ‖ payment_id ‖ hours ‖ nonce` | 198 bytes: `CFWP` v2, domain-separated |
| RPC endpoints | `soroban-testnet.stellar.org`, `mainnet.sorobanrpc.com` | unchanged |

Production still runs v1. No v2 contract exists on Mainnet ([DEPLOYMENTS.md](DEPLOYMENTS.md)).

---

## 2. Can `main` run on production as it stands?

### 2.1 Schema: no

Prisma selects every scalar column of a model by default. `main`'s `Escrow`
model declares `orgId`, `contractId`, `network`, `managerAddress` and others that
the v1 `Escrow` table lacks, and it types `id` as `String` where v1 has `integer`.
So every query on `Escrow`, `Invitation`, `OracleAttestation`, `IndexerCursor` or
`ChainEvent` would fail with *column does not exist* (P2022). Every query on a new
model would fail with *table does not exist* (P2021). That covers escrows, hours,
invitations, attestations, the indexer, payroll, funding and reconciliation.

`/api/health/ready` would stay green throughout, because it only runs
`SELECT 1` (`src/app/api/health/ready/route.ts:14`). Don't use it as evidence
that a release works.

### 2.2 Contract: no, even with a migrated database

- `main` only builds the 198-byte `CFWP-v2` preimage (`src/lib/oracle/index.ts:55-57`)
  and throws on any other length (`:180`). `/api/oracle/attest` records
  `schema: 'CFWP-v2'` (`src/app/api/oracle/attest/route.ts:160`).
- v1's `submit_hours_proof` verifies the signature over a 32-byte message
  (`contracts/core-flow/src/lib.rs` at `5adbdb0`, lines 427–433).
- So every hours proof `main` produces fails verification on v1. A payment
  can't reach `proof_verified`, and `pay_batch` refuses it.
- `proof_preimage`, `register_oracle_key` and `is_oracle_key_registered` (wrapped in
  `src/lib/contracts.ts:427-520`) don't exist on v1 either.

`main` therefore needs **both** the v2 schema **and** a v2 contract. Mainnet has
neither.

---

## 3. Migrations that would run on production

### 3.1 Production's migration state (last observed 2026-09-11, not re-checked)

From [PRODUCTION_DATABASE_REMEDIATION.md](PRODUCTION_DATABASE_REMEDIATION.md):
five `20260616*` migrations are applied, and `20260801000000_initial_schema` is
recorded as **failed** with 0 steps applied. Those five directories are not in
this repository. Until the failed row is resolved, any `prisma migrate deploy`
stops with **P3009** before running anything. Re-read `_prisma_migrations`
(read-only) before relying on this.

That document lists 7 v1→v2 migrations. There are now **11**, and it should be
updated before anyone follows it.

### 3.2 What would run, and whether it can be undone

Prisma has no down migrations. "Undo" means either hand-written reverse SQL or a
restore from a verified backup.

| # | Migration | What it does to existing v1 data | Undo |
|---|---|---|---|
| 0 | `20260801000000_initial_schema` | Must be **baselined** with `migrate resolve --applied`. No DDL runs. Running it would fail on `CREATE TABLE` as before. | `migrate resolve --rolled-back` (no DDL ran) |
| 1 | `20260910000000_money_base_units` | Converts `Escrow.amountCents`/`rateCents` to base units (×10⁵) and **drops the cents columns**. | Arithmetic is exact, but there's no reverse script, and #2 drops the replacement columns. **Restore only.** |
| 2 | `20260910120000_payment_state_machine` (464 lines) | Creates the legacy organisation, turns each `Escrow` into one `PayrollBatch` plus one `Payment`, retypes `Escrow.id` to text, **drops 7 `Escrow` columns and 2 `OracleAttestation` columns**, and adds NOT NULL constraints. | **Restore only.** |
| 3 | `20260911000000_multi_tenancy` | **Deletes** `OracleAttestation`, `AuditEvent` and `Invitation` rows it can't attribute to an organisation. Hashes, then **drops** `Invitation.token`. Aborts on orphan `Approval` rows (none can exist in v1). | **Restore only** (rows deleted). |
| 4 | `20260911010000_chain_event_attribution` | Adds `ChainEvent.attributed` (default true) and an index. | Hand SQL: drop the column and index |
| 5 | `20260911015000_finding_kind_values` | `ALTER TYPE … ADD VALUE` ×6 on a v2 enum. | PostgreSQL can't remove enum values. Harmless, but permanent. |
| 6 | `20260911020000_reconciliation_reliability` | Only touches v2 tables, plus an `Invitation.orgRole` default. | Hand SQL |
| 7 | `20260911030000_reconciliation_run_lock` | Partial unique index. | `DROP INDEX` |
| 8 | `20260911040000_payroll_batch_idempotency` | Adds columns and indexes on v2 tables. | Hand SQL |
| 9 | `20260911044540_composite_fk_no_action` | Rewrites foreign keys to `NO ACTION`. No data change. | Hand SQL |
| 10 | `20260911052247_funding_transaction_batch_link` | Adds a column, index and FK. | Hand SQL |
| 11 | `20260911121635_funding_plan_immutable` | Adds 2 columns. | Hand SQL |

Migrations #1–#3 decide this: **once #1 runs, the only way back is a restore.**

### 3.3 Defect to fix before any production run

Migration #2 sets each legacy escrow's `contractId` to the **v1 Mainnet** contract,
but leaves `network` at its column default, **`'testnet'`**
(`20260910120000_payment_state_machine/migration.sql:260` and `:273`). Run against
production, it would label every real Mainnet escrow as a Testnet escrow. It also
backfills `managerAddress` with `''`. Both need a follow-up migration, or a fix
before this has ever run anywhere that matters, followed by a rehearsal.

---

## 4. Release options

### Option A: keep v1 and ship a v1 patch release (recommended now)

Production stays on the v1 schema and the Mainnet v1 contract. Only app-layer fixes
that work without v2 tables or the v2 contract get ported.

- **Steps**
  1. Cut `release/v1` from `5adbdb0`.
  2. Port the selected fixes by hand. Most of them sit inside the single
     227-file commit `ab16c8d`, so cherry-picking whole commits won't work.
     Agree the list of fixes before the branch is cut. Some are security-relevant
     and are tracked outside this public document.
  3. Run the gates on the branch, plus an e2e run against a local database restored
     from a v1-shaped dump, on Testnet.
  4. Deploy **without** `deploy.yml`. Its `migrate deploy` step is not wanted here
     and should stop at P3009 anyway. The `5adbdb0` `vercel.json` has no
     `deploymentEnabled` block, so a push to `release/v1` should create a Preview
     deployment (unless an Ignored Build Step is configured in the project). Smoke-test
     it, then **Promote to Production** in Vercel.
- **Risks**
  - Low. No schema or contract change.
  - The branch diverges from `main` and has to be maintained.
  - The Preview deployment uses Preview env vars: make sure they don't point at
    the production database.
  - Set `NEXT_PUBLIC_STELLAR_TOKEN_ID` first if escrow creation needs to work.
- **Rollback:** Vercel Instant Rollback to the current Sep 5 deployment
  (`coreflow-kuvv292m7-…`). No data to restore.
- **Decision needed:** which fixes to port, and whether to keep v1 as a
  maintained line or freeze it.

### Option B: a separate v2 Testnet deployment (staging), in parallel

Run `main` as a second Vercel project or environment on Testnet v2 with its own
disposable database. This is the "Testnet validation" environment in
[ENVIRONMENTS.md](ENVIRONMENTS.md).

- **Steps**
  1. Create a new Vercel project (or a protected Preview branch) with
     `NEXT_PUBLIC_STELLAR_NETWORK=testnet`, the v2 contract and token IDs from
     [DEPLOYMENTS.md](DEPLOYMENTS.md), and a new hosted Postgres.
  2. Generate new secrets (`AUTH_SECRET`, `CRON_SECRET`, `BOOTSTRAP_SECRET`) and a
     new Testnet oracle key. Never reuse production values.
  3. `npm run db:deploy` against that database, with `COREFLOW_ALLOW_REMOTE_DB=1`
     for that one run.
  4. Deploy `main` and run the e2e suite and a real Testnet payroll through it.
- **Risks**
  - None to production funds or data.
  - Moderate cost and operating overhead.
  - Crons on this project need their own `CRON_SECRET`.
- **Rollback:** delete the project and database.
- **Decision needed:** a separate project (cleanest isolation) or a Preview
  environment on the existing project (fewer moving parts, shared env-var
  namespace).

### Option C: v2 on Mainnet (staged migration plus contract cutover), later

Make production `main`: deploy a v2 contract to Mainnet, migrate the production
database to v2, then switch the app over.

- **Prerequisites (blocking)**
  - Fix the [§3.3](#33-defect-to-fix-before-any-production-run) defect.
  - Deploy and verify a pinned v2 contract on Mainnet, with a registered oracle key
    and a verified WASM hash.
  - Finish the outstanding secret rotation ([ENVIRONMENTS.md](ENVIRONMENTS.md)).
  - Run Option B successfully.
  - Make `deploy.yml` run `check:env` (or stop it migrating) so it can't apply
    migrations as a side effect.
- **Steps**
  1. Follow [PRODUCTION_DATABASE_REMEDIATION.md](PRODUCTION_DATABASE_REMEDIATION.md)
     §4, updated for 11 migrations: freeze writes, take a verified `pg_dump` plus a
     provider snapshot, diff the baseline, `resolve --applied`, **rehearse on a
     restored copy**, then `migrate deploy`.
  2. Set the Mainnet v2 contract and token IDs in Vercel Production.
  3. Deploy `main`.
  4. Verify real reads and writes, not just `/api/health/ready`.
  5. Unfreeze.
  6. Decide what happens to open escrows on v1: they stay on the v1 contract,
     and the v2 app can't produce proofs v1 accepts (§2.2).
- **Risks**
  - High. Destructive migrations on financial records.
  - Open v1 escrows are stranded unless they settle or cancel first.
  - Mainnet contract deployment is irreversible.
- **Rollback:** restore the pre-migration dump, then Vercel Instant Rollback to
  the v1 deployment. The v2 contract stays on chain; pause it.
- **Decision needed:**
  - a date;
  - how to drain or settle open v1 escrows before cutover;
  - whether real users' data is in production (this decides how strict the
    rehearsal must be).

---

## 5. Open questions and checks before any release

1. **Why production stopped at Sep 5.** `5adbdb0`'s `vercel.json` didn't disable
   `main` deployments, and `deploymentEnabled` only arrived on 2026-10-17
   (`8dfb2e7`). Pushes between those dates would normally have deployed. Check
   the Vercel deployment list for failed builds in that window.
2. **Production `_prisma_migrations` today.** Re-read it (read-only). §3.1 is
   from 2026-09-11.
3. **`NEXT_PUBLIC_STELLAR_TOKEN_ID` is unset in the production build.** Confirm
   whether escrow creation in production currently works at all.
4. **Mainnet v1 WASM hash vs the `5adbdb0` source.** Not verified. §2.2 relies on
   `DEPLOYMENTS.md`, which describes v1 as a 32-byte, non-domain-separated proof.
5. **Stale docs.** [ENVIRONMENTS.md](ENVIRONMENTS.md) says "10 migrations" and
   PRODUCTION_DATABASE_REMEDIATION.md lists 7. There are 11 after the baseline.

---

## 6. Evidence and how it was gathered

| Claim | How |
|---|---|
| Production runs `5adbdb0` | The route table in the Sep 5 Vercel build log matches the `page`/`route` files at `5adbdb0`: 41/41, no difference. The SHA in the log (`2273ea3`) isn't in the repository. `git log --grep "#5 from"` gives `5adbdb0`, dated 2026-09-05. |
| Production network, contract and token config | `GET` of the public pages and `/_next/static/**/*.js` on `coreflow-psi.vercel.app`, searched for the inlined `STELLAR_CONFIG`. |
| Schema and env-var diffs | `git diff 5adbdb0 main`, a field-level diff of the two `schema.prisma` files, and `git grep process.env` at both revisions. |
| Contract diff | `pub fn` lists, struct definitions and `submit_hours_proof` message construction at both revisions. |
| Migration contents | Read each `prisma/migrations/*/migration.sql` on `main`. |

Nothing was run against the production database, Mainnet, or Vercel's
configuration.
