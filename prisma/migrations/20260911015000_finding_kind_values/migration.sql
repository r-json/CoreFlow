-- New FindingKind values, committed BEFORE anything uses them.
--
-- These were originally in 20260911020000_reconciliation_reliability, alongside
-- the UPDATE statements that assign severities by kind. Real PostgreSQL refuses
-- that: a value added to an existing enum cannot be USED until the transaction
-- that added it commits.
--
--   ERROR: unsafe use of new value "ASSET_MISMATCH" of enum type "FindingKind"
--   HINT:  New enum values must be committed before they can be used.  (55P04)
--
-- `prisma migrate deploy` wraps each migration in one transaction, so add-and-use
-- in a single file can never work — regardless of PostgreSQL version, and despite
-- the generated comment in that file suggesting it is only a PG-11-and-earlier
-- concern. Splitting the ADD VALUE statements into their own migration makes the
-- commit boundary explicit.
--
-- IF NOT EXISTS so this is safe to apply to a database that already has some of
-- these values, which is the situation any database migrated by hand is in.

-- AlterEnum
ALTER TYPE "FindingKind" ADD VALUE IF NOT EXISTS 'ASSET_MISMATCH';
ALTER TYPE "FindingKind" ADD VALUE IF NOT EXISTS 'UNKNOWN_ON_CHAIN_OBJECT';
ALTER TYPE "FindingKind" ADD VALUE IF NOT EXISTS 'MISSING_PAYMENT_EVENT';
ALTER TYPE "FindingKind" ADD VALUE IF NOT EXISTS 'DUPLICATE_PAYMENT_EVENT';
ALTER TYPE "FindingKind" ADD VALUE IF NOT EXISTS 'CHAIN_UNREADABLE';
ALTER TYPE "FindingKind" ADD VALUE IF NOT EXISTS 'OTHER';
