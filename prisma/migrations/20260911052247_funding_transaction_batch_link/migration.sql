-- Link a blockchain transaction to the batch it acts for.
--
-- Needed for funding idempotency. initialize_multi_sig_escrow creates the escrow
-- AND pulls custody in ONE atomic invocation, so submitting it twice produces two
-- funded escrows and charges the manager twice. The contract has no idempotency of
-- its own, so the question "has this batch already been funded, or is an attempt in
-- flight?" must be answered off-chain -- and escrowId cannot answer it, because it
-- is null until the escrow the attempt is creating exists.
--
-- Nullable and additive: a payment-level transaction has no batch of its own.

-- AlterTable
ALTER TABLE "BlockchainTransaction" ADD COLUMN     "batchId" TEXT;

-- CreateIndex
CREATE INDEX "BlockchainTransaction_batchId_idx" ON "BlockchainTransaction"("batchId");

-- AddForeignKey
ALTER TABLE "BlockchainTransaction" ADD CONSTRAINT "BlockchainTransaction_orgId_batchId_fkey" FOREIGN KEY ("orgId", "batchId") REFERENCES "PayrollBatch"("orgId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;
