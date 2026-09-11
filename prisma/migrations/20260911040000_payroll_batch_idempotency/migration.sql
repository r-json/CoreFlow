-- Batch-creation idempotency, enforced by the database.
--
-- Both columns are nullable and added to a table that may already hold rows, so
-- this is additive only: no backfill, no NOT NULL, nothing to order carefully.
--
-- The unique index relies on Postgres treating NULLs as DISTINCT, so any number
-- of batches created WITHOUT an idempotency key coexist, while two requests
-- carrying the same key can only ever produce one row.

ALTER TABLE "PayrollBatch" ADD COLUMN "idempotencyKey" TEXT;
ALTER TABLE "PayrollBatch" ADD COLUMN "sourceChecksum" TEXT;

CREATE UNIQUE INDEX "PayrollBatch_orgId_idempotencyKey_key"
  ON "PayrollBatch"("orgId", "idempotencyKey");

-- Supports "have I uploaded this exact file already?" without scanning a tenant's
-- whole payroll history.
CREATE INDEX "PayrollBatch_orgId_sourceChecksum_idx"
  ON "PayrollBatch"("orgId", "sourceChecksum");

-- Per-row free text from the uploaded CSV. Nullable and additive.
--
-- Stored already neutralized against spreadsheet formula injection, so every
-- read path inherits the protection instead of each having to reapply it.
ALTER TABLE "Payment" ADD COLUMN "sourceReference" TEXT;
