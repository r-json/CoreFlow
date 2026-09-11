-- Reconciliation reliability (P2 #4).
--
-- Turns reconciliation from a function into an operated system: runs with
-- heartbeats and locking, a granular finding taxonomy, severity, and an auditable
-- finding lifecycle.
--
-- ── Why the taxonomy is granular ────────────────────────────────────────────
-- A single "MISMATCH" value is useless. An unreadable RPC, a settled-but-
-- unrecorded payment, and a database claiming a payment that never settled demand
-- completely different responses — retry, catch up, and stop trusting the record.
-- Collapsing them forces an operator to re-derive the distinction from free text.
--
-- ── Why runs are recorded ───────────────────────────────────────────────────
-- So an operator can answer "when did CoreFlow last reconcile this organization,
-- and did that run finish?". A reconciler whose last run silently died is worse
-- than none, because the absence of findings reads as health.

-- CreateEnum
CREATE TYPE "FindingStatus" AS ENUM ('OPEN', 'ACKNOWLEDGED', 'INVESTIGATING', 'RESOLVED');

-- CreateEnum
CREATE TYPE "FindingSeverity" AS ENUM ('CRITICAL', 'HIGH', 'MEDIUM', 'LOW');

-- CreateEnum
CREATE TYPE "ReconcileOutcome" AS ENUM ('AGREED', 'CHAIN_AHEAD', 'DATABASE_AHEAD', 'CHAIN_UNREADABLE', 'MISMATCHED', 'UNKNOWN_ON_CHAIN_OBJECT', 'ORPHANED_DATABASE_OBJECT');

-- CreateEnum
CREATE TYPE "RunStatus" AS ENUM ('RUNNING', 'COMPLETED', 'FAILED', 'STALE');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "FindingKind" ADD VALUE 'ASSET_MISMATCH';
ALTER TYPE "FindingKind" ADD VALUE 'UNKNOWN_ON_CHAIN_OBJECT';
ALTER TYPE "FindingKind" ADD VALUE 'MISSING_PAYMENT_EVENT';
ALTER TYPE "FindingKind" ADD VALUE 'DUPLICATE_PAYMENT_EVENT';
ALTER TYPE "FindingKind" ADD VALUE 'CHAIN_UNREADABLE';
ALTER TYPE "FindingKind" ADD VALUE 'OTHER';

-- DropIndex
DROP INDEX "ReconciliationFinding_orgId_resolvedAt_idx";

-- AlterTable
ALTER TABLE "Invitation" ALTER COLUMN "orgRole" SET DEFAULT 'VIEWER';

-- AlterTable
ALTER TABLE "ReconciliationFinding" ADD COLUMN     "acknowledgedAt" TIMESTAMP(3),
ADD COLUMN     "acknowledgedBy" TEXT,
ADD COLUMN     "escrowOnChainId" INTEGER,
ADD COLUMN     "lastObservedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "observationCount" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "paymentIndex" INTEGER,
ADD COLUMN     "remediation" TEXT,
ADD COLUMN     "runId" TEXT,
ADD COLUMN     "severity" "FindingSeverity" NOT NULL DEFAULT 'MEDIUM',
ADD COLUMN     "status" "FindingStatus" NOT NULL DEFAULT 'OPEN',
ADD COLUMN     "txHash" TEXT;

-- CreateTable
CREATE TABLE "ReconciliationRun" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "correlationId" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "contractId" TEXT,
    "network" TEXT,
    "status" "RunStatus" NOT NULL DEFAULT 'RUNNING',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "heartbeatAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "escrowsExamined" INTEGER NOT NULL DEFAULT 0,
    "paymentsExamined" INTEGER NOT NULL DEFAULT 0,
    "agreed" INTEGER NOT NULL DEFAULT 0,
    "mismatched" INTEGER NOT NULL DEFAULT 0,
    "unreadable" INTEGER NOT NULL DEFAULT 0,
    "chainAhead" INTEGER NOT NULL DEFAULT 0,
    "databaseAhead" INTEGER NOT NULL DEFAULT 0,
    "findingsOpened" INTEGER NOT NULL DEFAULT 0,
    "correctionsApplied" INTEGER NOT NULL DEFAULT 0,
    "errorMessage" TEXT,

    CONSTRAINT "ReconciliationRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ReconciliationRun_correlationId_key" ON "ReconciliationRun"("correlationId");

-- CreateIndex
CREATE INDEX "ReconciliationRun_orgId_startedAt_idx" ON "ReconciliationRun"("orgId", "startedAt");

-- CreateIndex
CREATE INDEX "ReconciliationRun_status_idx" ON "ReconciliationRun"("status");

-- CreateIndex
CREATE INDEX "ReconciliationFinding_orgId_status_idx" ON "ReconciliationFinding"("orgId", "status");

-- CreateIndex
CREATE INDEX "ReconciliationFinding_orgId_severity_status_idx" ON "ReconciliationFinding"("orgId", "severity", "status");

-- CreateIndex
CREATE INDEX "ReconciliationFinding_runId_idx" ON "ReconciliationFinding"("runId");

-- AddForeignKey
ALTER TABLE "ReconciliationRun" ADD CONSTRAINT "ReconciliationRun_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReconciliationFinding" ADD CONSTRAINT "ReconciliationFinding_runId_fkey" FOREIGN KEY ("runId") REFERENCES "ReconciliationRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- ── Backfill: a finding that was already resolved is RESOLVED, not OPEN ─────
-- The new `status` column defaults to OPEN. Applied blindly that would reopen
-- every historical finding, burying genuine problems in noise on the first run.
UPDATE "ReconciliationFinding"
SET "status" = 'RESOLVED'
WHERE "resolvedAt" IS NOT NULL;

-- Existing findings were observed once, when they were detected.
UPDATE "ReconciliationFinding"
SET "lastObservedAt" = "detectedAt"
WHERE "lastObservedAt" IS NULL OR "lastObservedAt" < "detectedAt";

-- Severity for pre-existing findings, by kind. DB_PAID_CHAIN_NOT is CRITICAL
-- because it means the product may be making a false statement about money.
UPDATE "ReconciliationFinding" SET "severity" = 'CRITICAL'
WHERE "kind" IN ('DB_PAID_CHAIN_NOT', 'FAILED_TX_ACTUALLY_SUCCEEDED');
UPDATE "ReconciliationFinding" SET "severity" = 'HIGH'
WHERE "kind" IN ('AMOUNT_MISMATCH', 'RECIPIENT_MISMATCH', 'ASSET_MISMATCH', 'DUPLICATE_PAYMENT_EVENT');
