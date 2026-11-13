-- Independent durable organisation-name revision and event receipts.
-- Technician inventory schema and tenant records are unchanged by this migration.
CREATE TABLE "hub_org_name_state" (
    "organization_id" TEXT NOT NULL PRIMARY KEY,
    "name_revision" BIGINT NOT NULL CHECK ("name_revision" > 0),
    "name" TEXT NOT NULL,
    CONSTRAINT "hub_org_name_state_organization_id_fkey"
      FOREIGN KEY ("organization_id") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE TABLE "hub_org_name_receipts" (
    "event_id" TEXT NOT NULL PRIMARY KEY,
    "organization_id" TEXT NOT NULL,
    "name_revision" BIGINT NOT NULL CHECK ("name_revision" > 0),
    "name" TEXT NOT NULL,
    "payload_hash" CHAR(64) NOT NULL,
    CONSTRAINT "hub_org_name_receipts_organization_id_fkey"
      FOREIGN KEY ("organization_id") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "hub_org_name_receipts_organization_id_idx" ON "hub_org_name_receipts"("organization_id");
