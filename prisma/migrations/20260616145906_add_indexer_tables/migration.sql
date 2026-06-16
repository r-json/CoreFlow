-- CreateTable
CREATE TABLE "IndexerCursor" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "lastLedger" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IndexerCursor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChainEvent" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "ledger" INTEGER NOT NULL,
    "escrowOnChainId" INTEGER,
    "processedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChainEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ChainEvent_ledger_idx" ON "ChainEvent"("ledger");
