-- CreateTable
CREATE TABLE "Escrow" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "onChainId" INTEGER,
    "workerPubKey" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "rateCents" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USDC',
    "status" TEXT NOT NULL DEFAULT 'pending_manager',
    "managerApproved" BOOLEAN NOT NULL DEFAULT false,
    "financeApproved" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "TimeLog" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "escrowId" INTEGER NOT NULL,
    "hoursLogged" INTEGER NOT NULL,
    "paymentId" INTEGER NOT NULL,
    "txHash" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TimeLog_escrowId_fkey" FOREIGN KEY ("escrowId") REFERENCES "Escrow" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "Escrow_onChainId_key" ON "Escrow"("onChainId");
