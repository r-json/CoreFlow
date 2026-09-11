-- Persist the funding plan a transaction was prepared for, immutably.
--
-- Confirmation must compare chain evidence against the plan as it stood WHEN THE
-- WALLET WAS OPENED, not against a freshly recomputed one. Configuration can move
-- under a pending transaction -- a changed settlement asset, a different finance
-- approver, an edited payment -- and a recomputed plan would quietly agree with
-- whatever the chain happened to contain.
--
-- planDigest is SHA-256 over the canonical form, so tampering with the JSON is
-- detectable rather than merely unlikely.
--
-- Nullable and additive. Money inside the JSON is stored as decimal STRINGS.

-- AlterTable
ALTER TABLE "BlockchainTransaction" ADD COLUMN     "plan" JSONB,
ADD COLUMN     "planDigest" TEXT;
