-- CreateTable
CREATE TABLE "OracleAttestation" (
    "id" TEXT NOT NULL,
    "escrowOnChainId" INTEGER NOT NULL,
    "paymentId" INTEGER NOT NULL,
    "hoursLogged" INTEGER NOT NULL,
    "nonce" INTEGER NOT NULL,
    "signature" TEXT NOT NULL,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OracleAttestation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OracleAttestation_escrowOnChainId_idx" ON "OracleAttestation"("escrowOnChainId");

-- CreateIndex
CREATE UNIQUE INDEX "OracleAttestation_escrowOnChainId_paymentId_nonce_key" ON "OracleAttestation"("escrowOnChainId", "paymentId", "nonce");
