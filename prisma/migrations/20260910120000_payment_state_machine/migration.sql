-- CoreFlow payment state machine (P2 #1).
--
-- Introduces the payment domain model: Organization / Project / Worker /
-- PayrollBatch / Payment / Approval / BlockchainTransaction / AuditEvent /
-- ReconciliationFinding, and makes Payment the atomic financial record.
--
-- ── Why this migration is hand-ordered ──────────────────────────────────────
-- The generated diff adds NOT NULL columns to `Escrow` with no default and
-- retypes `OracleAttestation.paymentId` from the payment INDEX to a Payment FK.
-- Applied verbatim, both destroy existing rows: the first fails outright on a
-- non-empty table, the second silently loses the index it used to hold.
--
-- So the order here is: create the new world, BACKFILL from the old one, and
-- only then tighten constraints and drop columns. The prior schema's single
-- worker/amount per Escrow is expanded into one Payment row, which is the
-- defect this phase exists to fix.

-- ══ 1. Enums ════════════════════════════════════════════════════════════════
CREATE TYPE "OrgRole" AS ENUM ('OWNER', 'ADMIN', 'MANAGER', 'FINANCE', 'WORKER', 'VIEWER');
CREATE TYPE "PaymentState" AS ENUM ('DRAFT', 'VALIDATING', 'AWAITING_ORACLE', 'ORACLE_VERIFIED', 'AWAITING_MANAGER', 'AWAITING_FINANCE', 'READY_TO_SETTLE', 'SUBMITTING', 'CONFIRMING', 'PAID', 'REJECTED', 'CANCELLED', 'EXPIRED', 'SUBMISSION_FAILED', 'SETTLEMENT_FAILED', 'RECONCILIATION_REQUIRED');
CREATE TYPE "ApprovalDecision" AS ENUM ('APPROVED', 'REJECTED');
CREATE TYPE "TxKind" AS ENUM ('INITIALIZE_ESCROW', 'SUBMIT_HOURS_PROOF', 'MANAGER_APPROVE', 'FINANCE_APPROVE', 'PAY_BATCH', 'CANCEL_ESCROW', 'ROTATE_ORACLE_KEY', 'EXTEND_ESCROW_TTL');
CREATE TYPE "TxStatus" AS ENUM ('PREPARING', 'SIMULATING', 'AWAITING_SIGNATURE', 'SUBMITTED', 'CONFIRMED', 'FAILED', 'EXPIRED', 'CANCELLED');
CREATE TYPE "FindingKind" AS ENUM ('DB_PAID_CHAIN_NOT', 'CHAIN_PAID_DB_NOT', 'AMOUNT_MISMATCH', 'RECIPIENT_MISMATCH', 'MISSING_ON_CHAIN', 'ORPHAN_ON_CHAIN', 'FAILED_TX_ACTUALLY_SUCCEEDED');

-- ══ 2. New tables ═══════════════════════════════════════════════════════════
CREATE TABLE "Organization" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Organization_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "OrgMember" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" "OrgRole" NOT NULL DEFAULT 'VIEWER',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrgMember_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Project" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Project_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Worker" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "userId" TEXT,
    "walletAddress" TEXT NOT NULL,
    "displayName" TEXT,
    "email" TEXT,
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Worker_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PayrollBatch" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "projectId" TEXT,
    "reference" TEXT NOT NULL,
    "periodStart" TIMESTAMP(3),
    "periodEnd" TIMESTAMP(3),
    "sourceFilename" TEXT,
    "sourceRowCount" INTEGER,
    "uploadedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PayrollBatch_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Payment" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "escrowId" TEXT,
    "projectId" TEXT,
    "workerId" TEXT,
    "recipientAddress" TEXT NOT NULL,
    "onChainPaymentIndex" INTEGER,
    "assetContractId" TEXT,
    "assetCode" TEXT NOT NULL DEFAULT 'USDC',
    "assetDecimals" INTEGER NOT NULL DEFAULT 7,
    "amountBaseUnits" BIGINT NOT NULL,
    "rateBaseUnits" BIGINT NOT NULL,
    "hours" BIGINT NOT NULL,
    "periodStart" TIMESTAMP(3),
    "periodEnd" TIMESTAMP(3),
    "state" "PaymentState" NOT NULL DEFAULT 'DRAFT',
    "stateUpdatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "stateReason" TEXT,
    "settledAt" TIMESTAMP(3),
    "settlementTxHash" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Payment_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Approval" (
    "id" TEXT NOT NULL,
    "paymentId" TEXT NOT NULL,
    "role" "OrgRole" NOT NULL,
    "decision" "ApprovalDecision" NOT NULL,
    "actorAddress" TEXT NOT NULL,
    "reason" TEXT,
    "txHash" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Approval_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "BlockchainTransaction" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "paymentId" TEXT,
    "escrowId" TEXT,
    "kind" "TxKind" NOT NULL,
    "status" "TxStatus" NOT NULL DEFAULT 'PREPARING',
    "idempotencyKey" TEXT NOT NULL,
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "hash" TEXT,
    "ledger" INTEGER,
    "resultCode" TEXT,
    "errorMessage" TEXT,
    "contractId" TEXT,
    "network" TEXT NOT NULL DEFAULT 'testnet',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "submittedAt" TIMESTAMP(3),
    "confirmedAt" TIMESTAMP(3),

    CONSTRAINT "BlockchainTransaction_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AuditEvent" (
    "id" TEXT NOT NULL,
    "orgId" TEXT,
    "type" TEXT NOT NULL,
    "actorAddress" TEXT,
    "actorUserId" TEXT,
    "actorSystem" TEXT,
    "paymentId" TEXT,
    "batchId" TEXT,
    "escrowId" TEXT,
    "previousState" TEXT,
    "newState" TEXT,
    "txHash" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditEvent_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ReconciliationFinding" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "paymentId" TEXT,
    "kind" "FindingKind" NOT NULL,
    "dbState" TEXT,
    "chainState" TEXT,
    "detail" TEXT,
    "metadata" JSONB,
    "detectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),
    "resolvedBy" TEXT,
    "resolution" TEXT,

    CONSTRAINT "ReconciliationFinding_pkey" PRIMARY KEY ("id")
);

-- ══ 2b. Indexes and unique constraints on the new tables ═══════════════════
-- Created BEFORE the backfill below, because the inserts rely on ON CONFLICT
-- targets that do not exist until their unique indexes do.
CREATE UNIQUE INDEX "Organization_slug_key" ON "Organization"("slug");
CREATE INDEX "OrgMember_userId_idx" ON "OrgMember"("userId");
CREATE INDEX "OrgMember_orgId_role_idx" ON "OrgMember"("orgId", "role");
CREATE UNIQUE INDEX "OrgMember_orgId_userId_key" ON "OrgMember"("orgId", "userId");
CREATE INDEX "Project_orgId_idx" ON "Project"("orgId");
CREATE UNIQUE INDEX "Project_orgId_code_key" ON "Project"("orgId", "code");
CREATE INDEX "Worker_orgId_idx" ON "Worker"("orgId");
CREATE UNIQUE INDEX "Worker_orgId_walletAddress_key" ON "Worker"("orgId", "walletAddress");
CREATE INDEX "PayrollBatch_orgId_idx" ON "PayrollBatch"("orgId");
CREATE INDEX "PayrollBatch_createdAt_idx" ON "PayrollBatch"("createdAt");
CREATE UNIQUE INDEX "PayrollBatch_orgId_reference_key" ON "PayrollBatch"("orgId", "reference");
CREATE INDEX "Payment_orgId_state_idx" ON "Payment"("orgId", "state");
CREATE INDEX "Payment_batchId_idx" ON "Payment"("batchId");
CREATE INDEX "Payment_escrowId_idx" ON "Payment"("escrowId");
CREATE INDEX "Payment_recipientAddress_idx" ON "Payment"("recipientAddress");
CREATE INDEX "Payment_createdAt_idx" ON "Payment"("createdAt");
CREATE UNIQUE INDEX "Payment_escrowId_onChainPaymentIndex_key" ON "Payment"("escrowId", "onChainPaymentIndex");
CREATE INDEX "Approval_paymentId_idx" ON "Approval"("paymentId");
CREATE UNIQUE INDEX "Approval_paymentId_role_key" ON "Approval"("paymentId", "role");
CREATE UNIQUE INDEX "BlockchainTransaction_idempotencyKey_key" ON "BlockchainTransaction"("idempotencyKey");
CREATE UNIQUE INDEX "BlockchainTransaction_hash_key" ON "BlockchainTransaction"("hash");
CREATE INDEX "BlockchainTransaction_orgId_status_idx" ON "BlockchainTransaction"("orgId", "status");
CREATE INDEX "BlockchainTransaction_paymentId_idx" ON "BlockchainTransaction"("paymentId");
CREATE INDEX "BlockchainTransaction_escrowId_idx" ON "BlockchainTransaction"("escrowId");
CREATE INDEX "BlockchainTransaction_hash_idx" ON "BlockchainTransaction"("hash");
CREATE INDEX "AuditEvent_orgId_createdAt_idx" ON "AuditEvent"("orgId", "createdAt");
CREATE INDEX "AuditEvent_paymentId_idx" ON "AuditEvent"("paymentId");
CREATE INDEX "AuditEvent_batchId_idx" ON "AuditEvent"("batchId");
CREATE INDEX "AuditEvent_escrowId_idx" ON "AuditEvent"("escrowId");
CREATE INDEX "AuditEvent_type_idx" ON "AuditEvent"("type");
CREATE INDEX "ReconciliationFinding_orgId_resolvedAt_idx" ON "ReconciliationFinding"("orgId", "resolvedAt");
CREATE INDEX "ReconciliationFinding_paymentId_idx" ON "ReconciliationFinding"("paymentId");

-- ══ 3. Additive column changes (safe on non-empty tables) ══════════════════
ALTER TABLE "ChainEvent" ADD COLUMN     "contractId" TEXT,
ADD COLUMN     "network" TEXT NOT NULL DEFAULT 'testnet',
ADD COLUMN     "payload" JSONB,
ADD COLUMN     "paymentIndex" INTEGER,
ADD COLUMN     "txHash" TEXT;

ALTER TABLE "Invitation" ADD COLUMN     "orgId" TEXT,
ADD COLUMN     "orgRole" "OrgRole";

-- ══ 4. A home for pre-existing records ══════════════════════════════════════
-- Rows written before organizations existed have to belong to one. A single
-- explicitly-named tenant is created to hold them, rather than inventing a
-- plausible-looking company name that would read as real customer data.
INSERT INTO "Organization" ("id", "name", "slug", "createdAt", "updatedAt")
VALUES ('org_legacy_default', 'Legacy (pre-organization records)', 'legacy', NOW(), NOW())
ON CONFLICT ("slug") DO NOTHING;

-- Every existing user becomes an ADMIN of that tenant, preserving the access
-- they already had. Narrowing it would lock people out of their own records.
INSERT INTO "OrgMember" ("id", "orgId", "userId", "role", "createdAt", "updatedAt")
SELECT 'ogm_' || "User"."id", 'org_legacy_default', "User"."id",
       CASE WHEN "User"."role" = 'ADMIN' THEN 'OWNER'::"OrgRole" ELSE 'ADMIN'::"OrgRole" END,
       NOW(), NOW()
FROM "User"
ON CONFLICT ("orgId", "userId") DO NOTHING;

-- ══ 5. Escrow: widen before tightening ══════════════════════════════════════
-- Added nullable, backfilled, then constrained. `id` casts Int -> TEXT in place,
-- so escrow rows and their onChainId survive.
ALTER TABLE "Escrow"
  ADD COLUMN "orgId" TEXT,
  ADD COLUMN "projectId" TEXT,
  ADD COLUMN "contractId" TEXT,
  ADD COLUMN "network" TEXT NOT NULL DEFAULT 'testnet',
  ADD COLUMN "managerAddress" TEXT,
  ADD COLUMN "financeApproverAddress" TEXT,
  ADD COLUMN "oraclePublicKey" TEXT,
  ADD COLUMN "oracleRotations" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "cancelled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "totalAmountBaseUnits" BIGINT NOT NULL DEFAULT 0;

UPDATE "Escrow" SET
  "orgId" = 'org_legacy_default',
  -- Legacy rows predate per-escrow contract tracking. They belong to the v1
  -- Mainnet deployment, which is the only contract that existed when they were
  -- written; recording that is more honest than leaving it blank.
  "contractId" = COALESCE("contractId", 'CCTF5WBOQR7JP2KPLQT372X7JCGCINHDFRSAPF4YTYRKZXZ3J2XPRFFW'),
  "managerAddress" = COALESCE("managerAddress", ''),
  "financeApproverAddress" = COALESCE("financeApproverAddress", COALESCE("financeApprover", '')),
  "cancelled" = ("status" = 'cancelled'),
  "totalAmountBaseUnits" = COALESCE("amountBaseUnits", 0);

ALTER TABLE "Escrow"
  ALTER COLUMN "orgId" SET NOT NULL,
  ALTER COLUMN "contractId" SET NOT NULL,
  ALTER COLUMN "managerAddress" SET NOT NULL,
  ALTER COLUMN "financeApproverAddress" SET NOT NULL;

-- ══ 6. Expand each legacy Escrow into a batch + ONE Payment ════════════════
-- This is the lossy-projection fix applied backwards over history: the old
-- schema could only express one payee per escrow, so each legacy escrow yields
-- exactly one Payment carrying the figures it actually held.
INSERT INTO "PayrollBatch"
  ("id", "orgId", "reference", "sourceFilename", "sourceRowCount", "createdAt", "updatedAt")
SELECT 'bat_legacy_' || "Escrow"."id",
       'org_legacy_default',
       'LEGACY-' || LPAD("Escrow"."id"::text, 5, '0'),
       NULL, 1, "Escrow"."createdAt", NOW()
FROM "Escrow"
ON CONFLICT ("orgId", "reference") DO NOTHING;

INSERT INTO "Payment" (
  "id", "orgId", "batchId", "escrowId", "recipientAddress", "onChainPaymentIndex",
  "assetContractId", "assetCode", "assetDecimals",
  "amountBaseUnits", "rateBaseUnits", "hours",
  "state", "stateUpdatedAt", "settledAt", "createdAt", "updatedAt"
)
SELECT
  'pay_legacy_' || "Escrow"."id",
  'org_legacy_default',
  'bat_legacy_' || "Escrow"."id",
  "Escrow"."id"::text,
  COALESCE("Escrow"."workerPubKey", ''),
  0,
  "Escrow"."tokenAddress",
  COALESCE("Escrow"."currency", 'USDC'),
  COALESCE("Escrow"."assetDecimals", 7),
  COALESCE("Escrow"."amountBaseUnits", 0),
  COALESCE("Escrow"."rateBaseUnits", 1),
  -- Whole hours implied by amount / rate. Zero when the rate is unusable,
  -- rather than a rounded guess at work nobody attested to.
  CASE WHEN COALESCE("Escrow"."rateBaseUnits", 0) > 0
       THEN COALESCE("Escrow"."amountBaseUnits", 0) / "Escrow"."rateBaseUnits"
       ELSE 0 END,
  -- Legacy status strings map onto the new lifecycle. Anything unrecognised
  -- becomes RECONCILIATION_REQUIRED so it surfaces for a human instead of
  -- being quietly assumed healthy.
  CASE "Escrow"."status"
    WHEN 'paid'            THEN 'PAID'::"PaymentState"
    WHEN 'cancelled'       THEN 'CANCELLED'::"PaymentState"
    WHEN 'rejected'        THEN 'REJECTED'::"PaymentState"
    WHEN 'ready'           THEN 'READY_TO_SETTLE'::"PaymentState"
    WHEN 'pending_finance' THEN 'AWAITING_FINANCE'::"PaymentState"
    WHEN 'pending_manager' THEN 'AWAITING_MANAGER'::"PaymentState"
    WHEN 'pending_hours'   THEN 'AWAITING_ORACLE'::"PaymentState"
    ELSE 'RECONCILIATION_REQUIRED'::"PaymentState"
  END,
  NOW(),
  CASE WHEN "Escrow"."status" = 'paid' THEN "Escrow"."updatedAt" ELSE NULL END,
  "Escrow"."createdAt",
  NOW()
FROM "Escrow"
ON CONFLICT ("escrowId", "onChainPaymentIndex") DO NOTHING;

-- Record the migration itself in the audit history, so the provenance of these
-- rows is visible rather than something a reader has to deduce.
INSERT INTO "AuditEvent"
  ("id", "orgId", "type", "actorSystem", "paymentId", "escrowId", "newState", "metadata", "createdAt")
SELECT 'aud_mig_' || "Payment"."id", "Payment"."orgId", 'payment.migrated', 'migration',
       "Payment"."id", "Payment"."escrowId", "Payment"."state"::text,
       jsonb_build_object('migration', '20260910120000_payment_state_machine',
                          'note', 'Expanded from the single-payee Escrow schema'),
       NOW()
FROM "Payment"
WHERE "Payment"."id" LIKE 'pay_legacy_%';

-- ══ 6b. Detach TimeLog before the Escrow key is retyped ════════════════════
-- Escrow's primary key cannot be dropped while a foreign key depends on it, and
-- TimeLog.escrowId must change type alongside it.
ALTER TABLE "TimeLog" DROP CONSTRAINT "TimeLog_escrowId_fkey";
ALTER TABLE "TimeLog" ALTER COLUMN "escrowId" DROP NOT NULL,
ALTER COLUMN "escrowId" SET DATA TYPE TEXT;

-- ══ 7. Escrow: retype the key and drop superseded columns ═══════════════════
ALTER TABLE "Escrow" DROP CONSTRAINT "Escrow_pkey",
DROP COLUMN "amountBaseUnits",
DROP COLUMN "currency",
DROP COLUMN "financeApprover",
DROP COLUMN "rateBaseUnits",
DROP COLUMN "rejectionReason",
DROP COLUMN "status",
DROP COLUMN "workerPubKey",
ALTER COLUMN "id" DROP DEFAULT,
ALTER COLUMN "id" SET DATA TYPE TEXT,
ADD CONSTRAINT "Escrow_pkey" PRIMARY KEY ("id");
DROP SEQUENCE "Escrow_id_seq";

-- ══ 8. OracleAttestation: preserve the payment index before retyping ═══════
DROP INDEX "OracleAttestation_escrowOnChainId_paymentId_nonce_key";

ALTER TABLE "OracleAttestation"
  ADD COLUMN "onChainPaymentIndex" INTEGER,
  ADD COLUMN "hours" BIGINT,
  ADD COLUMN "contractId" TEXT,
  ADD COLUMN "preimageSha256" TEXT,
  ADD COLUMN "schema" TEXT NOT NULL DEFAULT 'CFWP-v2';

-- The old `paymentId` column held the on-chain payment INDEX, not a Payment FK.
-- Copy it across BEFORE the type change, or the index is lost silently.
UPDATE "OracleAttestation" SET
  "onChainPaymentIndex" = "paymentId",
  "hours" = COALESCE("hoursLogged", 0),
  -- Pre-existing attestations were produced under the v1 32-byte message, which
  -- bound no network, contract, payee, asset, amount or period. Labelling them
  -- CFWP-v2 would overstate their guarantees.
  "schema" = 'v1-legacy';

ALTER TABLE "OracleAttestation"
  ALTER COLUMN "onChainPaymentIndex" SET NOT NULL,
  ALTER COLUMN "hours" SET NOT NULL;

ALTER TABLE "OracleAttestation" DROP COLUMN "hoursLogged";
ALTER TABLE "OracleAttestation" DROP COLUMN "paymentId";
ALTER TABLE "OracleAttestation" ADD COLUMN "paymentId" TEXT;
ALTER TABLE "OracleAttestation" ALTER COLUMN "nonce" SET DATA TYPE BIGINT;

-- Re-link attestations to the Payment rows created above.
UPDATE "OracleAttestation" oa SET "paymentId" = p."id"
FROM "Payment" p
JOIN "Escrow" e ON e."id" = p."escrowId"
WHERE e."onChainId" = oa."escrowOnChainId"
  AND p."onChainPaymentIndex" = oa."onChainPaymentIndex";

-- ══ 9. IndexerCursor: per (contract, network) ══════════════════════════════
-- A single global cursor conflates deployments, and v1/v2 escrow ids overlap.
ALTER TABLE "IndexerCursor"
  ADD COLUMN "contractId" TEXT,
  ADD COLUMN "network" TEXT;

UPDATE "IndexerCursor" SET
  "contractId" = COALESCE("contractId", 'CCTF5WBOQR7JP2KPLQT372X7JCGCINHDFRSAPF4YTYRKZXZ3J2XPRFFW'),
  "network" = COALESCE("network", 'public');

ALTER TABLE "IndexerCursor"
  ALTER COLUMN "contractId" SET NOT NULL,
  ALTER COLUMN "network" SET NOT NULL;

ALTER TABLE "IndexerCursor" DROP CONSTRAINT "IndexerCursor_pkey",
ALTER COLUMN "id" DROP DEFAULT,
ALTER COLUMN "id" SET DATA TYPE TEXT,
ADD CONSTRAINT "IndexerCursor_pkey" PRIMARY KEY ("id");

-- ══ 11. Indexes on altered tables ════════════════════════════════════════
CREATE INDEX "ChainEvent_escrowOnChainId_idx" ON "ChainEvent"("escrowOnChainId");
CREATE INDEX "ChainEvent_contractId_network_idx" ON "ChainEvent"("contractId", "network");
CREATE INDEX "Escrow_orgId_idx" ON "Escrow"("orgId");
CREATE INDEX "Escrow_contractId_network_idx" ON "Escrow"("contractId", "network");
CREATE UNIQUE INDEX "IndexerCursor_contractId_network_key" ON "IndexerCursor"("contractId", "network");
CREATE INDEX "OracleAttestation_paymentId_idx" ON "OracleAttestation"("paymentId");
CREATE UNIQUE INDEX "OracleAttestation_escrowOnChainId_onChainPaymentIndex_nonce_key" ON "OracleAttestation"("escrowOnChainId", "onChainPaymentIndex", "nonce");
CREATE INDEX "TimeLog_escrowId_idx" ON "TimeLog"("escrowId");

-- ══ 12. Foreign keys ═══════════════════════════════════════════════════════
ALTER TABLE "OrgMember" ADD CONSTRAINT "OrgMember_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OrgMember" ADD CONSTRAINT "OrgMember_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Project" ADD CONSTRAINT "Project_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Worker" ADD CONSTRAINT "Worker_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Worker" ADD CONSTRAINT "Worker_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Escrow" ADD CONSTRAINT "Escrow_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Escrow" ADD CONSTRAINT "Escrow_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "PayrollBatch" ADD CONSTRAINT "PayrollBatch_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PayrollBatch" ADD CONSTRAINT "PayrollBatch_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "PayrollBatch"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_escrowId_fkey" FOREIGN KEY ("escrowId") REFERENCES "Escrow"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_workerId_fkey" FOREIGN KEY ("workerId") REFERENCES "Worker"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Approval" ADD CONSTRAINT "Approval_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "Payment"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OracleAttestation" ADD CONSTRAINT "OracleAttestation_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "Payment"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "BlockchainTransaction" ADD CONSTRAINT "BlockchainTransaction_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "BlockchainTransaction" ADD CONSTRAINT "BlockchainTransaction_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "Payment"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "BlockchainTransaction" ADD CONSTRAINT "BlockchainTransaction_escrowId_fkey" FOREIGN KEY ("escrowId") REFERENCES "Escrow"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "AuditEvent" ADD CONSTRAINT "AuditEvent_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "AuditEvent" ADD CONSTRAINT "AuditEvent_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "Payment"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "AuditEvent" ADD CONSTRAINT "AuditEvent_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "PayrollBatch"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "AuditEvent" ADD CONSTRAINT "AuditEvent_escrowId_fkey" FOREIGN KEY ("escrowId") REFERENCES "Escrow"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ReconciliationFinding" ADD CONSTRAINT "ReconciliationFinding_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ReconciliationFinding" ADD CONSTRAINT "ReconciliationFinding_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "Payment"("id") ON DELETE SET NULL ON UPDATE CASCADE;
