-- Composite tenant foreign keys: ON DELETE SET NULL -> NO ACTION.
--
-- SET NULL was unusable on these relations and had never been exercised. It nulls
-- EVERY column of the foreign key, and the first column is `orgId`, which is
-- NOT NULL. So deleting an Escrow, Project or Worker that any row referenced
-- failed with:
--
--   Null constraint violation on the fields: (`orgId`)
--
-- Found by an integration test against real PostgreSQL (`prisma validate` had been
-- warning about it; the unit suite, using an in-memory double, could not see it).
--
-- NO ACTION rather than RESTRICT: NO ACTION is checked at the END of the
-- statement, so a cascading delete from Organization — which removes parent and
-- child in the same statement — still succeeds. RESTRICT is checked immediately
-- and would reject it depending on evaluation order.
--
-- The resulting behaviour for a DIRECT delete is to refuse it while dependent rows
-- exist. That is correct for financial data: detaching a payment from its escrow,
-- project or worker destroys the record of what was paid for, and the payment must
-- outlive an attempt to tidy up around it.
--
-- Every statement below only re-declares a referential action. No data is touched,
-- no column is added or dropped, and the constraint columns are unchanged.

-- DropForeignKey
ALTER TABLE "AuditEvent" DROP CONSTRAINT "AuditEvent_orgId_batchId_fkey";

-- DropForeignKey
ALTER TABLE "AuditEvent" DROP CONSTRAINT "AuditEvent_orgId_escrowId_fkey";

-- DropForeignKey
ALTER TABLE "AuditEvent" DROP CONSTRAINT "AuditEvent_orgId_paymentId_fkey";

-- DropForeignKey
ALTER TABLE "BlockchainTransaction" DROP CONSTRAINT "BlockchainTransaction_orgId_escrowId_fkey";

-- DropForeignKey
ALTER TABLE "BlockchainTransaction" DROP CONSTRAINT "BlockchainTransaction_orgId_paymentId_fkey";

-- DropForeignKey
ALTER TABLE "Escrow" DROP CONSTRAINT "Escrow_orgId_projectId_fkey";

-- DropForeignKey
ALTER TABLE "OracleAttestation" DROP CONSTRAINT "OracleAttestation_orgId_paymentId_fkey";

-- DropForeignKey
ALTER TABLE "Payment" DROP CONSTRAINT "Payment_orgId_escrowId_fkey";

-- DropForeignKey
ALTER TABLE "Payment" DROP CONSTRAINT "Payment_orgId_projectId_fkey";

-- DropForeignKey
ALTER TABLE "Payment" DROP CONSTRAINT "Payment_orgId_workerId_fkey";

-- DropForeignKey
ALTER TABLE "PayrollBatch" DROP CONSTRAINT "PayrollBatch_orgId_projectId_fkey";

-- DropForeignKey
ALTER TABLE "ReconciliationFinding" DROP CONSTRAINT "ReconciliationFinding_orgId_paymentId_fkey";

-- AddForeignKey
ALTER TABLE "Escrow" ADD CONSTRAINT "Escrow_orgId_projectId_fkey" FOREIGN KEY ("orgId", "projectId") REFERENCES "Project"("orgId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollBatch" ADD CONSTRAINT "PayrollBatch_orgId_projectId_fkey" FOREIGN KEY ("orgId", "projectId") REFERENCES "Project"("orgId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_orgId_escrowId_fkey" FOREIGN KEY ("orgId", "escrowId") REFERENCES "Escrow"("orgId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_orgId_projectId_fkey" FOREIGN KEY ("orgId", "projectId") REFERENCES "Project"("orgId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_orgId_workerId_fkey" FOREIGN KEY ("orgId", "workerId") REFERENCES "Worker"("orgId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OracleAttestation" ADD CONSTRAINT "OracleAttestation_orgId_paymentId_fkey" FOREIGN KEY ("orgId", "paymentId") REFERENCES "Payment"("orgId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BlockchainTransaction" ADD CONSTRAINT "BlockchainTransaction_orgId_paymentId_fkey" FOREIGN KEY ("orgId", "paymentId") REFERENCES "Payment"("orgId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BlockchainTransaction" ADD CONSTRAINT "BlockchainTransaction_orgId_escrowId_fkey" FOREIGN KEY ("orgId", "escrowId") REFERENCES "Escrow"("orgId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditEvent" ADD CONSTRAINT "AuditEvent_orgId_paymentId_fkey" FOREIGN KEY ("orgId", "paymentId") REFERENCES "Payment"("orgId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditEvent" ADD CONSTRAINT "AuditEvent_orgId_batchId_fkey" FOREIGN KEY ("orgId", "batchId") REFERENCES "PayrollBatch"("orgId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditEvent" ADD CONSTRAINT "AuditEvent_orgId_escrowId_fkey" FOREIGN KEY ("orgId", "escrowId") REFERENCES "Escrow"("orgId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReconciliationFinding" ADD CONSTRAINT "ReconciliationFinding_orgId_paymentId_fkey" FOREIGN KEY ("orgId", "paymentId") REFERENCES "Payment"("orgId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;
