import { createHash } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { z } from 'zod';

// Same request body and acknowledgement fields as Hub's signed delivery worker.
export const hubOrgNameSchema = z.object({
  eventId: z.string().min(1).max(180).regex(/^[A-Za-z0-9._:@-]+$/),
  organizationId: z.string().min(1).max(100).regex(/^[A-Za-z0-9._:@-]+$/),
  destination: z.literal('pos'),
  name: z.string().min(1).max(120).refine(n => n.trim() === n && !/[\x00-\x1f\x7f]/.test(n)),
  nameRevision: z.number().int().positive().safe(),
}).strict();

export type HubOrgNamePayload = z.infer<typeof hubOrgNameSchema>;

export class HubOrgNameConflict extends Error {
  constructor(message: string) { super(message); this.name = 'HubOrgNameConflict'; }
}

export function hubOrgNameHash(value: HubOrgNamePayload) {
  return createHash('sha256').update(JSON.stringify({
    eventId: value.eventId,
    organizationId: value.organizationId,
    destination: value.destination,
    name: value.name,
    nameRevision: value.nameRevision,
  })).digest('hex');
}

// Every mutation is serialised by a FOR UPDATE lock on this tenant.
// Receipt insert, revision advance and name update commit in ONE transaction.
export async function applyHubOrgNameSync(tx: Prisma.TransactionClient, body: HubOrgNamePayload) {
  const locked = await tx.$queryRaw<Array<{ id: string; active: boolean }>>`
    SELECT "id", "active" FROM "Tenant" WHERE "id" = ${body.organizationId} FOR UPDATE
  `;
  if (locked.length !== 1 || !locked[0].active) {
    throw new HubOrgNameConflict('POS organisation does not exist or is inactive.');
  }

  const hash = hubOrgNameHash(body);
  const receipts = await tx.$queryRaw<Array<{ payload_hash: string }>>`
    SELECT "payload_hash" FROM "hub_org_name_receipts" WHERE "event_id" = ${body.eventId}
  `;
  if (receipts.length > 0) {
    if (receipts[0].payload_hash !== hash) {
      throw new HubOrgNameConflict('POS organisation rename event ID reused with different data.');
    }
    return { duplicate: true };
  }

  const states = await tx.$queryRaw<Array<{ name_revision: bigint }>>`
    SELECT "name_revision" FROM "hub_org_name_state" WHERE "organization_id" = ${body.organizationId}
  `;
  if (states.length && BigInt(body.nameRevision) <= states[0].name_revision) {
    // The same revision with a different event ID is always a conflict.
    if (BigInt(body.nameRevision) === states[0].name_revision) {
      throw new HubOrgNameConflict('POS organisation rename revision is conflicting.');
    }
    // Out-of-order older events are obsolete but legitimate Hub deliveries.
    // Record a durable receipt and acknowledge without changing the latest name.
    await tx.$executeRaw`
      INSERT INTO "hub_org_name_receipts"
        ("event_id", "organization_id", "name_revision", "name", "payload_hash")
      VALUES (${body.eventId}, ${body.organizationId}, ${BigInt(body.nameRevision)}, ${body.name}, ${hash})
    `;
    return { duplicate: false, obsolete: true };
  }

  await tx.tenant.update({ where: { id: body.organizationId }, data: { name: body.name } });
  await tx.$executeRaw`
    INSERT INTO "hub_org_name_state" ("organization_id", "name_revision", "name")
    VALUES (${body.organizationId}, ${BigInt(body.nameRevision)}, ${body.name})
    ON CONFLICT ("organization_id") DO UPDATE SET
      "name_revision" = EXCLUDED."name_revision", "name" = EXCLUDED."name"
  `;
  await tx.$executeRaw`
    INSERT INTO "hub_org_name_receipts"
      ("event_id", "organization_id", "name_revision", "name", "payload_hash")
    VALUES (${body.eventId}, ${body.organizationId}, ${BigInt(body.nameRevision)}, ${body.name}, ${hash})
  `;
  return { duplicate: false };
}
