# Production Database Remediation — Proposal Only

**Status: PROPOSED. NOT EXECUTED.**
**Nothing in this document has been run against the production database.**

Discovered 2026-09-11 during a local environment audit. The only commands run
against production were read-only `SELECT`s against `information_schema` and
`_prisma_migrations`, described in [Evidence](#evidence-how-this-was-observed).

This document exists to be reviewed *before* anyone acts. Do not treat the
production database as repaired until an authorized production deployment has
actually done so and its output has been recorded here.

---

## 1. Database state discovered

| | |
|---|---|
| Host | `db.prisma.io` (managed Prisma Postgres) |
| Database | `postgres` |
| Reached via | `DATABASE_URL` as it appeared in the local `.env` / `.env.local` after a `vercel env pull` |
| Schema | `public` |
| Tables | 11 |

Tables present:

```
AuditLog, AuthChallenge, ChainEvent, Escrow, IndexerCursor,
Invitation, OracleAttestation, Session, TimeLog, User,
_prisma_migrations
```

This is the **CoreFlow v1** schema. None of the v2 tables exist —
no `Organization`, `OrgMember`, `PayrollBatch`, `Payment`, `Approval`,
`BlockchainTransaction`, `AuditEvent`, `ReconciliationFinding`,
`ReconciliationRun`, `Project`, `Worker`.

### Consequence, stated plainly

**No part of the v2 hardening is deployed.** Multi-tenancy, the payment state
machine, reconciliation, per-payment indexing and dual approval all depend on
tables that do not exist in production. The live site runs v1 against v1 tables.

---

## 2. Migration history in production

| # | Migration | State |
|---|---|---|
| 1 | `20260616142115_init` | applied |
| 2 | `20260616143739_add_escrow_token` | applied |
| 3 | `20260616144425_add_oracle_attestation` | applied |
| 4 | `20260616145906_add_indexer_tables` | applied |
| 5 | `20260616150704_add_audit_log` | applied |
| 6 | `20260801000000_initial_schema` | **FAILED** |

### The failed migration

| Field | Value |
|---|---|
| `migration_name` | `20260801000000_initial_schema` |
| `started_at` | `2026-07-31T19:06:34.072Z` |
| `finished_at` | `null` |
| `rolled_back_at` | `null` |
| `applied_steps_count` | `0` |

`finished_at` null with `rolled_back_at` null is Prisma's representation of a
**failed migration**. Any subsequent `prisma migrate deploy` against this
database aborts with **P3009** without attempting anything further, so the
deployment pipeline's migrate step is currently broken.

`applied_steps_count: 0` is load-bearing: **not one statement was applied.** The
production schema was not partially modified. There is no half-built table and
nothing to clean up.

---

## 3. Why it failed, and why the obvious fix is the wrong one

The repository's migration history does **not** continue production's history.
It is a **squashed baseline** that recreates the same v1 schema from zero:

```
$ grep -oE 'CREATE TABLE "[A-Za-z]+"' \
    prisma/migrations/20260801000000_initial_schema/migration.sql | sort -u

CREATE TABLE "AuditLog"        CREATE TABLE "IndexerCursor"
CREATE TABLE "AuthChallenge"   CREATE TABLE "Invitation"
CREATE TABLE "ChainEvent"      CREATE TABLE "OracleAttestation"
CREATE TABLE "Escrow"          CREATE TABLE "Session"
CREATE TABLE "IndexerCursor"   CREATE TABLE "TimeLog"
                               CREATE TABLE "User"
```

Those are **exactly the ten tables production already has**, built there by
migrations 1–5. So the migration failed on its first statement with
`relation "..." already exists`, which is precisely what `applied_steps_count: 0`
records.

### `migrate resolve --rolled-back` would not fix this

It is the natural reading of a failed migration, and it is safe here — with zero
applied steps there is genuinely nothing to roll back, so the marker would be
accurate. But it resolves nothing:

1. `migrate resolve --rolled-back 20260801000000_initial_schema` clears the
   failure flag.
2. The next `migrate deploy` sees the migration as pending, **runs it again**,
   and it fails **identically** on the same first `CREATE TABLE`.

The failure is not a transient error that rollback-and-retry clears. It is a
**history mismatch**: two different migration histories describing the same
schema. Retrying cannot resolve that.

### The appropriate action is baselining

`20260801000000_initial_schema` describes a schema state production **is already
in**. That is the textbook definition of a baseline migration, and Prisma's
mechanism for it is `migrate resolve --applied`:

1. `migrate resolve --applied 20260801000000_initial_schema` records it as
   present **without executing it** — true, because migrations 1–5 already built
   that schema.
2. `migrate deploy` then proceeds to migrations 2–8, which are the real v1 → v2
   changes and whose statements have never run in production.

This is only correct if production's schema genuinely matches what the baseline
would have created. **That equivalence must be verified, not assumed** — see
step 4.3. A baseline asserted over a schema that has drifted will make later
migrations fail in harder-to-diagnose ways.

---

## 4. Proposed remediation

Every step is to be performed by an authorized operator against production,
deliberately. Nothing here is wired into any script, and no `npm` task reaches
production.

### 4.1 Freeze

Stop writes for the duration: pause Vercel Cron (the indexer hits
`GET /api/indexer/run`) and avoid deploys. Migrations 2–8 retype columns and add
constraints; concurrent writes during that window produce partial states that
are significantly harder to reason about than a short maintenance pause.

### 4.2 Snapshot — mandatory, verified before proceeding

Take a full backup and **confirm it is restorable**. An unverified backup is not
a backup.

```bash
# Structure + data, custom format.
pg_dump --format=custom --no-owner --no-privileges \
  --file=coreflow-prod-$(date -u +%Y%m%dT%H%M%SZ).dump \
  "$PRODUCTION_DATABASE_URL"

# Prove it is readable and contains the expected objects.
pg_restore --list coreflow-prod-*.dump | grep -c 'TABLE DATA'
```

Also capture the managed provider's own point-in-time snapshot if available, and
**record the row counts** migrations 2–8 will touch, so the verification in 4.5
has something to compare against:

```sql
SELECT 'User' AS t, count(*) FROM "User"
UNION ALL SELECT 'Escrow', count(*) FROM "Escrow"
UNION ALL SELECT 'TimeLog', count(*) FROM "TimeLog"
UNION ALL SELECT 'OracleAttestation', count(*) FROM "OracleAttestation"
UNION ALL SELECT 'ChainEvent', count(*) FROM "ChainEvent"
UNION ALL SELECT 'AuditLog', count(*) FROM "AuditLog";
```

### 4.3 Verify the baseline claim — BLOCKING

Do not run step 4.4 until this produces an empty diff. This needs a shadow
database, so it is **currently blocked on local Postgres** (see
[ENVIRONMENTS.md](ENVIRONMENTS.md)).

```bash
# Does production's live schema match the state the baseline migration describes?
npx prisma migrate diff \
  --from-url "$PRODUCTION_DATABASE_URL" \
  --to-migrations ./prisma/migrations/20260801000000_initial_schema \
  --shadow-database-url "$LOCAL_SHADOW_DATABASE_URL" \
  --script
```

- **Empty output** → production is in the baseline state. Baselining is sound;
  continue.
- **Any output** → production has drifted from the squashed baseline. **Stop.**
  The drift must be understood and reconciled first; asserting the baseline
  anyway would make migrations 2–8 run against a schema they were not written
  for. Attach the diff to this document and re-review.

Note: `--from-url` is read-only with respect to production. The shadow database
is written to and reset, which is why it **must never be a production URL** —
Prisma resets shadow databases.

### 4.4 Record the baseline

```bash
npx prisma migrate resolve --applied 20260801000000_initial_schema
```

Expected: one row in `_prisma_migrations` with `finished_at` set and
`applied_steps_count` 0. No DDL is executed by this command.

### 4.5 Apply the real v1 → v2 migrations

```bash
npx prisma migrate deploy
```

This applies migrations 2–8:

| Migration | What it does |
|---|---|
| `20260910000000_money_base_units` | money → integer base units |
| `20260910120000_payment_state_machine` | `PaymentState`, transitions, audit |
| `20260911000000_multi_tenancy` | organizations, members, composite FKs |
| `20260911010000_chain_event_attribution` | tenant attribution for chain events |
| `20260911020000_reconciliation_reliability` | findings, runs |
| `20260911030000_reconciliation_run_lock` | partial unique index on `RUNNING` |
| `20260911040000_payroll_batch_idempotency` | batch idempotency key, `sourceReference` |

These are **not** additive-only. The money and multi-tenancy migrations retype
columns and introduce NOT NULL constraints with backfills, and were hand-ordered
(widen → backfill → constrain → drop). They have only ever been applied to
databases built from this same history. **Rehearse them against a restored copy
of the production dump before production**, not only against a from-zero local
database:

```bash
# On a scratch database restored from the 4.2 dump:
pg_restore --dbname "$REHEARSAL_DATABASE_URL" --no-owner coreflow-prod-*.dump
DATABASE_URL="$REHEARSAL_DATABASE_URL" npx prisma migrate deploy
```

A from-zero run proves the SQL is valid. Only a restored-copy run proves it is
valid **against production's actual data**.

### 4.6 Verification

```bash
npx prisma migrate status          # all 8 applied, none failed
```

```sql
-- 28+ tables, v2 tables present
SELECT count(*) FROM information_schema.tables WHERE table_schema='public';
SELECT table_name FROM information_schema.tables
 WHERE table_schema='public'
   AND table_name IN ('Organization','OrgMember','PayrollBatch','Payment',
                      'Approval','ReconciliationRun');

-- No failed or unfinished rows remain
SELECT migration_name FROM _prisma_migrations
 WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL;

-- Row counts from 4.2 are unchanged (no migration should delete v1 data)
```

Then, against production, confirm the application actually works rather than
assuming a green migration means a working product:

- `GET /api/health/ready`
- sign in with a wallet
- load a page that reads `Escrow`
- confirm the indexer cursor advances after Cron resumes

### 4.7 Unfreeze

Resume Vercel Cron. Record in this document: who ran it, when, the
`migrate status` output, and the verification results.

---

## 5. Rollback plan

| Failure point | Action |
|---|---|
| 4.3 diff is non-empty | Stop. Nothing was changed. Re-review. |
| 4.4 resolve is wrong | `migrate resolve --rolled-back 20260801000000_initial_schema` returns the row to its prior state. No DDL ran. |
| 4.5 fails partway | **Restore from the 4.2 dump.** Do not hand-patch. These migrations retype columns and backfill; a partially applied money or multi-tenancy migration leaves data in an ambiguous state, and "fixing forward" on financial records without knowing which rows converted is how silent corruption happens. |
| Application broken after 4.5 | Restore from the 4.2 dump, redeploy the previous application build, then diagnose off production. |

Restore:

```bash
pg_restore --clean --if-exists --no-owner \
  --dbname "$PRODUCTION_DATABASE_URL" coreflow-prod-<timestamp>.dump
```

---

## 6. Evidence — how this was observed

Read-only. Two queries, both against catalog tables:

```sql
SELECT table_name FROM information_schema.tables
 WHERE table_schema='public' ORDER BY table_name;

SELECT migration_name, started_at, finished_at,
       rolled_back_at, applied_steps_count
  FROM _prisma_migrations
 WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL;
```

No write, DDL, seed, reset or `migrate` command has been run against this
database from the development workflow. The local environment has since been
repointed away from it, and `scripts/check-env.mjs` now refuses to run
development tasks against a non-local database.

## 7. Open questions for the operator

1. Is `db.prisma.io/postgres` the database serving `coreflow-psi.vercel.app`, or
   a preview/branch database? The remediation path is the same; the blast radius
   is not.
2. Who attempted `20260801000000_initial_schema` on 2026-07-31, and was the
   squashed baseline intended to replace the `20260616*` history in production?
   If the squash was meant to be local-only, the cleaner fix may be to restore
   the original five migration directories instead of baselining.
3. Does production hold real user data, or only test records? This determines
   whether 4.5's rehearsal-on-a-restored-copy is mandatory or merely advisable.
   It is recommended either way.
