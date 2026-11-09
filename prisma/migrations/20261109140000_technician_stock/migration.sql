-- Technician stock custody and traceable use; additive migration, no data deletion.
ALTER TYPE "InventoryMovementType" ADD VALUE 'TECHNICIAN_USE';
ALTER TYPE "SerialStatus" ADD VALUE 'INSTALLED';
CREATE TYPE "StockTransferPurpose" AS ENUM ('GENERAL', 'TECHNICIAN_ISSUE', 'TECHNICIAN_RETURN_GOOD', 'TECHNICIAN_RETURN_FAULTY');
ALTER TABLE "Location" ADD COLUMN "custodianUserId" TEXT;
CREATE UNIQUE INDEX "Location_tenantId_custodianUserId_key" ON "Location"("tenantId", "custodianUserId");
ALTER TABLE "StockTransfer" ADD COLUMN "purpose" "StockTransferPurpose" NOT NULL DEFAULT 'GENERAL',
  ADD COLUMN "technicianUserId" TEXT,
  ADD COLUMN "jobReference" TEXT;
CREATE TABLE "TechnicianUsage" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "technicianUserId" TEXT NOT NULL,
  "locationId" TEXT NOT NULL,
  "productVariantId" TEXT NOT NULL,
  "quantity" DECIMAL(18,4) NOT NULL,
  "jobReference" TEXT NOT NULL,
  "requestKey" TEXT NOT NULL,
  "unitCost" DECIMAL(18,4) NOT NULL,
  "serialNumberIds" JSONB,
  "lotAllocations" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "TechnicianUsage_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "TechnicianUsage_tenantId_requestKey_key" ON "TechnicianUsage"("tenantId", "requestKey");
CREATE INDEX "TechnicianUsage_tenantId_technicianUserId_createdAt_idx" ON "TechnicianUsage"("tenantId", "technicianUserId", "createdAt");
CREATE INDEX "TechnicianUsage_tenantId_locationId_productVariantId_idx" ON "TechnicianUsage"("tenantId", "locationId", "productVariantId");
