-- One RUNNING reconciliation run per organization, enforced by the database.
--
-- ── Why a partial unique index ──────────────────────────────────────────────
-- The application checks for an active run before starting one, but a check
-- followed by an insert is a race: two workers triggered by the same cron tick can
-- both pass the check and both insert. The consequence is not a double payment —
-- corrections are compare-and-swap — but duplicated findings, doubled RPC cost, and
-- two runs reporting contradictory summaries for the same moment.
--
-- A partial unique index makes PostgreSQL refuse the second insert outright, so the
-- lock does not depend on the application noticing. Prisma's schema language cannot
-- express a WHERE clause on a unique index, hence raw SQL.
--
-- COMPLETED, FAILED and STALE rows are deliberately excluded: historical runs must
-- accumulate, and only the live one is exclusive.

CREATE UNIQUE INDEX "ReconciliationRun_one_running_per_org"
  ON "ReconciliationRun" ("orgId")
  WHERE "status" = 'RUNNING';
