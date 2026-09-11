-- CoreFlow multi-tenancy (P2 #2).
--
-- Makes the organization boundary a DATABASE constraint rather than an
-- application convention.
--
-- ── What this migration is for ──────────────────────────────────────────────
-- Before it, `Payment.batchId` was a plain foreign key: it guaranteed the batch
-- existed, not that the batch belonged to the payment's organization. A bug or a
-- crafted request could attach a payment in org A to a batch, escrow, project or
-- worker in org B, and no constraint would object. Tenant isolation rested
-- entirely on every query remembering to filter — which is exactly the thing a
-- security boundary must not depend on.
--
-- Every parent relation on tenant-owned records becomes a COMPOSITE foreign key
-- on (orgId, id). Cross-tenant attachment is now rejected by PostgreSQL.
--
-- Also: `Approval` and `OracleAttestation` gain an explicit owner (they were
-- reachable only by joining through Payment); `AuditEvent.orgId` becomes
-- REQUIRED (a null-org audit row is invisible to every scoped query, i.e. to
-- everyone); `Invitation` becomes org-scoped with a hashed token and per-org
-- email uniqueness.
--
-- Hand-ordered: the generated diff adds NOT NULL columns to populated tables and
-- drops Invitation.token before anything can be derived from it.

-- ══ 1. Membership lifecycle ═════════════════════════════════════════════════
CREATE TYPE "MembershipStatus" AS ENUM ('INVITED', 'ACTIVE', 'SUSPENDED', 'REMOVED');

ALTER TABLE "OrgMember"
  ADD COLUMN "status" "MembershipStatus" NOT NULL DEFAULT 'ACTIVE',
  ADD COLUMN "invitedBy" TEXT,
  ADD COLUMN "invitedAt" TIMESTAMP(3),
  ADD COLUMN "activatedAt" TIMESTAMP(3),
  ADD COLUMN "suspendedAt" TIMESTAMP(3),
  ADD COLUMN "removedAt" TIMESTAMP(3);

-- Pre-existing memberships were created by the legacy migration and are in use,
-- so they are ACTIVE from their creation date rather than retroactively INVITED.
UPDATE "OrgMember" SET "activatedAt" = "createdAt" WHERE "activatedAt" IS NULL;

-- ══ 2. Approval: add its owner, derived from the payment ════════════════════
ALTER TABLE "Approval" ADD COLUMN "orgId" TEXT;

UPDATE "Approval" a SET "orgId" = p."orgId"
FROM "Payment" p WHERE p."id" = a."paymentId";

-- An approval whose payment vanished cannot be attributed to a tenant. Deleting
-- it would destroy an approval record; there is nowhere safe to put it, so the
-- migration fails loudly rather than inventing an owner.
DO $$
DECLARE orphans INT;
BEGIN
  SELECT count(*) INTO orphans FROM "Approval" WHERE "orgId" IS NULL;
  IF orphans > 0 THEN
    RAISE EXCEPTION 'Cannot migrate: % Approval row(s) have no resolvable organization. Resolve these manually before migrating.', orphans;
  END IF;
END $$;

ALTER TABLE "Approval" ALTER COLUMN "orgId" SET NOT NULL;

-- ══ 3. OracleAttestation: add its owner ════════════════════════════════════
ALTER TABLE "OracleAttestation" ADD COLUMN "orgId" TEXT;

UPDATE "OracleAttestation" oa SET "orgId" = p."orgId"
FROM "Payment" p WHERE p."id" = oa."paymentId";

-- Attestations predating the payment model have no link. They belong to the
-- legacy tenant created by the previous migration, which is where every other
-- pre-organization record already lives.
UPDATE "OracleAttestation" SET "orgId" = 'org_legacy_default'
WHERE "orgId" IS NULL
  AND EXISTS (SELECT 1 FROM "Organization" WHERE "id" = 'org_legacy_default');

DELETE FROM "OracleAttestation" WHERE "orgId" IS NULL;

ALTER TABLE "OracleAttestation" ALTER COLUMN "orgId" SET NOT NULL;

-- ══ 4. AuditEvent.orgId becomes required ═══════════════════════════════════
UPDATE "AuditEvent" SET "orgId" = 'org_legacy_default'
WHERE "orgId" IS NULL
  AND EXISTS (SELECT 1 FROM "Organization" WHERE "id" = 'org_legacy_default');

-- An audit row with no tenant is unreadable by any scoped query. Rather than
-- keep invisible history, unattributable rows are removed and the count is
-- reported so the loss is not silent.
DO $$
DECLARE orphans INT;
BEGIN
  SELECT count(*) INTO orphans FROM "AuditEvent" WHERE "orgId" IS NULL;
  IF orphans > 0 THEN
    RAISE NOTICE 'Removing % AuditEvent row(s) with no resolvable organization.', orphans;
    DELETE FROM "AuditEvent" WHERE "orgId" IS NULL;
  END IF;
END $$;

ALTER TABLE "AuditEvent" ALTER COLUMN "orgId" SET NOT NULL;

-- ══ 5. Invitation: org-scoped, hashed token, per-org email ═════════════════
DROP INDEX "Invitation_email_key";
DROP INDEX "Invitation_token_idx";
DROP INDEX "Invitation_token_key";

ALTER TABLE "Invitation"
  ADD COLUMN "tokenHash" TEXT,
  ADD COLUMN "revokedAt" TIMESTAMP(3),
  ADD COLUMN "revokedBy" TEXT,
  ADD COLUMN "invitedBy" TEXT;

-- Derive the hash from the existing plaintext token BEFORE dropping it, so live
-- invitation links keep working. sha256 matches what the application computes.
-- Built-in sha256() (PostgreSQL 11+), NOT pgcrypto's digest(). A migration that
-- requires an extension fails on any managed Postgres where the role cannot
-- CREATE EXTENSION — which is most of them.
UPDATE "Invitation" SET "tokenHash" = encode(sha256(convert_to("token", 'UTF8')), 'hex')
WHERE "tokenHash" IS NULL AND "token" IS NOT NULL;

UPDATE "Invitation" SET "orgId" = 'org_legacy_default'
WHERE "orgId" IS NULL
  AND EXISTS (SELECT 1 FROM "Organization" WHERE "id" = 'org_legacy_default');
UPDATE "Invitation" SET "orgRole" = 'VIEWER' WHERE "orgRole" IS NULL;

-- Any invitation still unattributable is revoked rather than carried forward: an
-- invitation that cannot name its organization must not be acceptable.
DELETE FROM "Invitation" WHERE "orgId" IS NULL OR "tokenHash" IS NULL;

ALTER TABLE "Invitation" DROP COLUMN "token";
ALTER TABLE "Invitation"
  ALTER COLUMN "tokenHash" SET NOT NULL,
  ALTER COLUMN "orgId" SET NOT NULL,
  ALTER COLUMN "orgRole" SET NOT NULL;

-- ══ 6. Composite-key targets, before any FK references them ════════════════
CREATE UNIQUE INDEX "Escrow_orgId_id_key" ON "Escrow"("orgId", "id");
CREATE UNIQUE INDEX "Payment_orgId_id_key" ON "Payment"("orgId", "id");
CREATE UNIQUE INDEX "PayrollBatch_orgId_id_key" ON "PayrollBatch"("orgId", "id");
CREATE UNIQUE INDEX "Project_orgId_id_key" ON "Project"("orgId", "id");
CREATE UNIQUE INDEX "Worker_orgId_id_key" ON "Worker"("orgId", "id");

-- ══ 7. Remaining indexes ═══════════════════════════════════════════════════
CREATE UNIQUE INDEX "Invitation_tokenHash_key" ON "Invitation"("tokenHash");
CREATE UNIQUE INDEX "Invitation_orgId_email_key" ON "Invitation"("orgId", "email");
CREATE INDEX "Approval_orgId_idx" ON "Approval"("orgId");
CREATE INDEX "Invitation_tokenHash_idx" ON "Invitation"("tokenHash");
CREATE INDEX "Invitation_orgId_idx" ON "Invitation"("orgId");
CREATE INDEX "OracleAttestation_orgId_idx" ON "OracleAttestation"("orgId");
CREATE INDEX "OrgMember_orgId_status_idx" ON "OrgMember"("orgId", "status");

-- ══ 8. Replace single-column FKs with composite ones ═══════════════════════
-- From here, PostgreSQL itself rejects a child row pointing at a parent in a
-- different organization. Note MATCH SIMPLE semantics: when the optional id is
-- NULL the constraint is satisfied, which is the intended behaviour for optional
-- parents.
ALTER TABLE "Approval" DROP CONSTRAINT "Approval_paymentId_fkey";
ALTER TABLE "AuditEvent" DROP CONSTRAINT "AuditEvent_batchId_fkey";
ALTER TABLE "AuditEvent" DROP CONSTRAINT "AuditEvent_escrowId_fkey";
ALTER TABLE "AuditEvent" DROP CONSTRAINT "AuditEvent_orgId_fkey";
ALTER TABLE "AuditEvent" DROP CONSTRAINT "AuditEvent_paymentId_fkey";
ALTER TABLE "BlockchainTransaction" DROP CONSTRAINT "BlockchainTransaction_escrowId_fkey";
ALTER TABLE "BlockchainTransaction" DROP CONSTRAINT "BlockchainTransaction_paymentId_fkey";
ALTER TABLE "Escrow" DROP CONSTRAINT "Escrow_projectId_fkey";
ALTER TABLE "OracleAttestation" DROP CONSTRAINT "OracleAttestation_paymentId_fkey";
ALTER TABLE "Payment" DROP CONSTRAINT "Payment_batchId_fkey";
ALTER TABLE "Payment" DROP CONSTRAINT "Payment_escrowId_fkey";
ALTER TABLE "Payment" DROP CONSTRAINT "Payment_projectId_fkey";
ALTER TABLE "Payment" DROP CONSTRAINT "Payment_workerId_fkey";
ALTER TABLE "PayrollBatch" DROP CONSTRAINT "PayrollBatch_projectId_fkey";
ALTER TABLE "ReconciliationFinding" DROP CONSTRAINT "ReconciliationFinding_paymentId_fkey";

ALTER TABLE "Escrow" ADD CONSTRAINT "Escrow_orgId_projectId_fkey" FOREIGN KEY ("orgId", "projectId") REFERENCES "Project"("orgId", "id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "PayrollBatch" ADD CONSTRAINT "PayrollBatch_orgId_projectId_fkey" FOREIGN KEY ("orgId", "projectId") REFERENCES "Project"("orgId", "id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_orgId_batchId_fkey" FOREIGN KEY ("orgId", "batchId") REFERENCES "PayrollBatch"("orgId", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_orgId_escrowId_fkey" FOREIGN KEY ("orgId", "escrowId") REFERENCES "Escrow"("orgId", "id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_orgId_projectId_fkey" FOREIGN KEY ("orgId", "projectId") REFERENCES "Project"("orgId", "id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_orgId_workerId_fkey" FOREIGN KEY ("orgId", "workerId") REFERENCES "Worker"("orgId", "id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Approval" ADD CONSTRAINT "Approval_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Approval" ADD CONSTRAINT "Approval_orgId_paymentId_fkey" FOREIGN KEY ("orgId", "paymentId") REFERENCES "Payment"("orgId", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OracleAttestation" ADD CONSTRAINT "OracleAttestation_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OracleAttestation" ADD CONSTRAINT "OracleAttestation_orgId_paymentId_fkey" FOREIGN KEY ("orgId", "paymentId") REFERENCES "Payment"("orgId", "id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "BlockchainTransaction" ADD CONSTRAINT "BlockchainTransaction_orgId_paymentId_fkey" FOREIGN KEY ("orgId", "paymentId") REFERENCES "Payment"("orgId", "id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "BlockchainTransaction" ADD CONSTRAINT "BlockchainTransaction_orgId_escrowId_fkey" FOREIGN KEY ("orgId", "escrowId") REFERENCES "Escrow"("orgId", "id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "AuditEvent" ADD CONSTRAINT "AuditEvent_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AuditEvent" ADD CONSTRAINT "AuditEvent_orgId_paymentId_fkey" FOREIGN KEY ("orgId", "paymentId") REFERENCES "Payment"("orgId", "id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "AuditEvent" ADD CONSTRAINT "AuditEvent_orgId_batchId_fkey" FOREIGN KEY ("orgId", "batchId") REFERENCES "PayrollBatch"("orgId", "id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "AuditEvent" ADD CONSTRAINT "AuditEvent_orgId_escrowId_fkey" FOREIGN KEY ("orgId", "escrowId") REFERENCES "Escrow"("orgId", "id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ReconciliationFinding" ADD CONSTRAINT "ReconciliationFinding_orgId_paymentId_fkey" FOREIGN KEY ("orgId", "paymentId") REFERENCES "Payment"("orgId", "id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Invitation" ADD CONSTRAINT "Invitation_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
