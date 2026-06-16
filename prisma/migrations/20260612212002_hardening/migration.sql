/*
  Warnings:

  - Made the column `txHash` on table `TimeLog` required. This step will fail if there are existing NULL values in that column.

*/
-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_TimeLog" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "escrowId" INTEGER NOT NULL,
    "hoursLogged" INTEGER NOT NULL,
    "paymentId" INTEGER NOT NULL,
    "txHash" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TimeLog_escrowId_fkey" FOREIGN KEY ("escrowId") REFERENCES "Escrow" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_TimeLog" ("createdAt", "escrowId", "hoursLogged", "id", "paymentId", "txHash") SELECT "createdAt", "escrowId", "hoursLogged", "id", "paymentId", "txHash" FROM "TimeLog";
DROP TABLE "TimeLog";
ALTER TABLE "new_TimeLog" RENAME TO "TimeLog";
CREATE UNIQUE INDEX "TimeLog_txHash_key" ON "TimeLog"("txHash");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "Escrow_createdAt_idx" ON "Escrow"("createdAt");
