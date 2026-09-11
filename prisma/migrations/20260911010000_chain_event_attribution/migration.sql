-- Records whether a chain event could be attributed to an organization.
--
-- The chain knows nothing about CoreFlow organizations. An escrow created outside
-- the app — by the CLI, a validation script, or another client — has no tenant
-- mapping, and guessing one would silently place another party's payroll inside a
-- customer's workspace. Unattributable events are now recorded rather than either
-- dropped or mis-assigned, and surfaced for an operator to claim.
--
-- Existing rows default to true: they were ingested under the previous model,
-- which only ever projected escrows it had already attributed.

ALTER TABLE "ChainEvent" ADD COLUMN "attributed" BOOLEAN NOT NULL DEFAULT true;

CREATE INDEX "ChainEvent_attributed_idx" ON "ChainEvent"("attributed");
