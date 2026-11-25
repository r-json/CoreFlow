-- Money is stored in the settlement asset's BASE UNITS, not cents.
--
-- WHY: the dashboard collected dollars, multiplied by 100, and passed the
-- result to the contract as the on-chain amount. Stellar assets carry SEVEN
-- decimals, so every escrow funded 100,000x less than the UI displayed. The
-- column was also INTEGER, which overflows at $21,474,836.47.
--
-- CONVERSION: existing rows hold cents. One cent is 10^5 base units on a
-- 7-decimal asset (10^7 / 10^2), so the historical values are scaled up rather
-- than dropped. Those rows predate any real settlement at this scale; the
-- multiply keeps the DISPLAYED figure stable, which is what they recorded.

ALTER TABLE "Escrow" ADD COLUMN "financeApprover" TEXT;
ALTER TABLE "Escrow" ADD COLUMN "assetDecimals" INTEGER NOT NULL DEFAULT 7;

ALTER TABLE "Escrow" ADD COLUMN "amountBaseUnits" BIGINT;
ALTER TABLE "Escrow" ADD COLUMN "rateBaseUnits" BIGINT;

UPDATE "Escrow" SET
  "amountBaseUnits" = "amountCents"::BIGINT * 100000,
  "rateBaseUnits"   = "rateCents"::BIGINT   * 100000;

ALTER TABLE "Escrow" ALTER COLUMN "amountBaseUnits" SET NOT NULL;
ALTER TABLE "Escrow" ALTER COLUMN "rateBaseUnits" SET NOT NULL;

ALTER TABLE "Escrow" DROP COLUMN "amountCents";
ALTER TABLE "Escrow" DROP COLUMN "rateCents";
