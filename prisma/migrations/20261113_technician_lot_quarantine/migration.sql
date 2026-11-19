-- Keep all production stock untouched. Historical technician faulty returns: 0 (read-only check).
-- New faulty returns increment quantityQuarantined; sales and transfers exclude it.
ALTER TABLE "InventoryLot"
  ADD COLUMN IF NOT EXISTS "quantityQuarantined" DECIMAL(18,4) NOT NULL DEFAULT 0;
ALTER TABLE "InventoryLot"
  ADD CONSTRAINT "InventoryLot_quantityQuarantined_bounds"
  CHECK ("quantityQuarantined" >= 0 AND "quantityQuarantined" <= "quantityOnHand");
