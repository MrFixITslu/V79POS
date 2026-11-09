import type { FastifyInstance, FastifyRequest } from 'fastify';
import { InventoryMovementType, Prisma, StockTransferPurpose } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { serializable } from '../../lib/transactions.js';
import { businessNumber } from '../../lib/numbering.js';
import { conflict, forbidden, notFound } from '../../lib/errors.js';
import { requirePermission } from '../auth/context.js';
import { postInventoryMovement } from '../inventory/service.js';
import { consumeFifoCost } from '../inventory/costing.js';
import { writeAudit } from '../../lib/audit.js';
import { emitEvent } from '../../lib/outbox.js';

const allocation = z.object({ lotId: z.string().min(1), quantity: z.number().positive().finite() });
const item = z.object({
  productVariantId: z.string().min(1),
  quantity: z.number().positive().finite(),
  serialNumberIds: z.array(z.string().min(1)).max(100).default([]),
  lotAllocations: z.array(allocation).max(100).default([])
});
const requestSchema = item.extend({
  purpose: z.enum(['TECHNICIAN_ISSUE', 'TECHNICIAN_RETURN_GOOD', 'TECHNICIAN_RETURN_FAULTY']),
  warehouseId: z.string().min(1),
  requestKey: z.string().uuid(),
  jobReference: z.string().trim().max(120).optional(),
  reason: z.string().trim().min(3).max(500)
});
const useSchema = item.extend({
  requestKey: z.string().uuid(),
  jobReference: z.string().trim().min(2).max(120)
});

async function custody(tx: Prisma.TransactionClient, request: FastifyRequest) {
  const mobile = await tx.location.findFirst({
    where: { tenantId: request.auth.tenantId, custodianUserId: request.auth.userId, active: true, type: 'MOBILE' }
  });
  if (!mobile || !request.auth.locationIds.has(mobile.id)) throw forbidden('No assigned technician stock location');
  return mobile;
}

async function checkAllocations(tx: Prisma.TransactionClient, input: z.infer<typeof item>,
  tenantId: string, fromLocationId: string) {
  const variant = await tx.productVariant.findFirst({
    where: { id: input.productVariantId, tenantId, active: true, trackStock: true, product: { active: true } },
    include: { product: true }
  });
  if (!variant) throw notFound('Stock-tracked item not found');
  if (variant.product.productType === 'SERIALIZED') {
    if (!Number.isInteger(input.quantity) || input.serialNumberIds.length !== input.quantity ||
      new Set(input.serialNumberIds).size !== input.serialNumberIds.length) {
      throw conflict('Specify one distinct serial number per unit');
    }
    const serials = await tx.inventorySerial.findMany({
      where: { id: { in: input.serialNumberIds }, tenantId, locationId: fromLocationId,
        productVariantId: variant.id, status: 'AVAILABLE' }
    });
    if (serials.length !== input.serialNumberIds.length) throw conflict('One or more serials are unavailable');
  } else if (input.serialNumberIds.length) throw conflict('Serials are not used for this item');

  if (variant.product.productType === 'LOT_TRACKED' || variant.requiresExpiry) {
    if (new Set(input.lotAllocations.map(a => a.lotId)).size !== input.lotAllocations.length ||
      Math.abs(input.lotAllocations.reduce((sum, a) => sum + a.quantity, 0) - input.quantity) > 0.0001) {
      throw conflict('Specify unique lots totalling the requested quantity');
    }
    for (const line of input.lotAllocations) {
      const lot = await tx.inventoryLot.findFirst({
        where: { id: line.lotId, tenantId, locationId: fromLocationId, productVariantId: variant.id }
      });
      if (!lot || lot.quantityOnHand.lt(line.quantity)) throw conflict('Lot is unavailable or insufficient');
    }
  } else if (input.lotAllocations.length) throw conflict('Lots are not used for this item');
  return variant;
}

export async function technicianRoutes(app: FastifyInstance) {
  // Provision a dedicated custody location once; it never grants unrestricted warehouse access.
  app.post('/v1/technician/assign', { preHandler: requirePermission('team.write') }, async request => {
    if (!['OWNER', 'ADMIN'].includes(request.auth.roleKey)) throw forbidden('Only business owners or administrators can assign technician stock');
    const body = z.object({ userId: z.string().min(1).max(200), displayName: z.string().trim().min(2).max(100) }).parse(request.body);
    return serializable(async tx => {
      const member = await tx.membership.findUnique({
        where: { tenantId_userId: { tenantId: request.auth.tenantId, userId: body.userId } }
      });
      if (!member?.active || member.roleKey !== 'TECHNICIAN') throw conflict('User must have an active TECHNICIAN membership');
      let mobile = await tx.location.findFirst({
        where: { tenantId: request.auth.tenantId, custodianUserId: body.userId }
      });
      if (mobile && mobile.type !== 'MOBILE') throw conflict('Custody location has invalid type');
      if (!mobile) mobile = await tx.location.create({
        data: { tenantId: request.auth.tenantId, name: body.displayName + ' · Technician Stock',
          code: 'TECH-' + crypto.randomUUID().slice(0, 12).toUpperCase(), type: 'MOBILE', custodianUserId: body.userId }
      });
      else if (!mobile.active) mobile = await tx.location.update({ where: { id: mobile.id }, data: { active: true } });
      await tx.userLocationAccess.upsert({
        where: { membershipId_locationId: { membershipId: member.id, locationId: mobile.id } },
        create: { membershipId: member.id, locationId: mobile.id }, update: {}
      });
      await writeAudit(tx, { tenantId: request.auth.tenantId, actorUserId: request.auth.userId,
        action: 'technician.location_assigned', resourceType: 'Location', resourceId: mobile.id,
        after: { userId: body.userId } });
      return { location: { id: mobile.id, name: mobile.name, code: mobile.code } };
    });
  });

  app.get('/v1/technician/workspace', { preHandler: requirePermission('inventory.technician') }, async request => {
    const mobile = await custody(prisma, request);
    const tenantId = request.auth.tenantId;
    const [inventory, warehouses, products, transfers, usage, serials, lots] = await Promise.all([
      prisma.inventoryBalance.findMany({
        where: { tenantId, locationId: mobile.id },
        include: { productVariant: { include: { product: true } } }, orderBy: { updatedAt: 'desc' }
      }),
      prisma.location.findMany({ where: { tenantId, active: true, type: { in: ['WAREHOUSE', 'STORE'] } },
        select: { id: true, name: true, code: true }, orderBy: { name: 'asc' } }),
      prisma.productVariant.findMany({ where: { tenantId, active: true, trackStock: true, product: { active: true } },
        include: { product: true }, orderBy: { sku: 'asc' }, take: 500 }),
      prisma.stockTransfer.findMany({ where: { tenantId, technicianUserId: request.auth.userId },
        include: { lines: { include: { productVariant: true } }, fromLocation: { select: { name: true } }, toLocation: { select: { name: true } } },
        orderBy: { createdAt: 'desc' }, take: 100 }),
      prisma.technicianUsage.findMany({ where: { tenantId, technicianUserId: request.auth.userId },
        orderBy: { createdAt: 'desc' }, take: 100 }),
      prisma.inventorySerial.findMany({ where: { tenantId, locationId: mobile.id, status: 'AVAILABLE' },
        select: { id: true, productVariantId: true, serialNumber: true }, take: 500 }),
      prisma.inventoryLot.findMany({ where: { tenantId, locationId: mobile.id, quantityOnHand: { gt: 0 } },
        select: { id: true, productVariantId: true, lotNumber: true, quantityOnHand: true, expiryDate: true }, take: 500 })
    ]);
    return { location: { id: mobile.id, name: mobile.name }, warehouses, products,
      inventory: inventory.map(b => ({ ...b, available: b.onHand.minus(b.reserved).minus(b.committed)
        .minus(b.quarantined).minus(b.damaged).minus(b.expired).toString() })),
      transfers, usage, serials, lots };
  });

  app.post('/v1/technician/requests', { preHandler: requirePermission('inventory.technician') }, async request => {
    const body = requestSchema.parse(request.body);
    const tenantId = request.auth.tenantId;
    return serializable(async tx => {
      const mobile = await custody(tx, request);
      const existing = await tx.stockTransfer.findFirst({ where: { tenantId, requestKey: body.requestKey } });
      if (existing) {
        if (existing.technicianUserId !== request.auth.userId) throw conflict('Request key is already used');
        return existing;
      }
      const warehouse = await tx.location.findFirst({
        where: { id: body.warehouseId, tenantId, active: true, type: { in: ['WAREHOUSE', 'STORE'] } }
      });
      if (!warehouse) throw notFound('Warehouse was not found');
      const isIssue = body.purpose === 'TECHNICIAN_ISSUE';
      const source = isIssue ? warehouse.id : mobile.id;
      const target = isIssue ? mobile.id : warehouse.id;
      const variant = await tx.productVariant.findFirst({
        where: { id: body.productVariantId, tenantId, active: true, trackStock: true, product: { active: true } },
        include: { product: true }
      });
      if (!variant) throw notFound('Item was not found');
      // Warehouse operators must allocate controlled items at issue time.
      if (isIssue && (variant.product.productType === 'SERIALIZED' ||
          variant.product.productType === 'LOT_TRACKED' || variant.requiresExpiry)) {
        throw conflict('Warehouse must issue serialized or lot-tracked hardware using Stock Control');
      }
      if (!isIssue) await checkAllocations(tx, body, tenantId, mobile.id);
      else if (body.serialNumberIds.length || body.lotAllocations.length) throw conflict('Do not allocate stock from an unassigned warehouse');
      const transfer = await tx.stockTransfer.create({
        data: { tenantId, number: businessNumber('TECH'), fromLocationId: source, toLocationId: target,
          purpose: body.purpose as StockTransferPurpose, technicianUserId: request.auth.userId,
          jobReference: body.jobReference, requestKey: body.requestKey, notes: body.reason,
          createdBy: request.auth.userId, lines: { create: [{ productVariantId: body.productVariantId, quantity: body.quantity }] } },
        include: { lines: true }
      });
      const lineId = transfer.lines[0].id;
      if (body.serialNumberIds.length) await tx.stockTransferSerialAllocation.createMany({
        data: body.serialNumberIds.map(serialId => ({ stockTransferLineId: lineId, serialId }))
      });
      if (body.lotAllocations.length) await tx.stockTransferLotAllocation.createMany({
        data: body.lotAllocations.map(a => ({ stockTransferLineId: lineId, lotId: a.lotId, quantity: a.quantity }))
      });
      await writeAudit(tx, { tenantId, actorUserId: request.auth.userId,
        action: 'technician.stock_requested', resourceType: 'StockTransfer', resourceId: transfer.id,
        after: { purpose: body.purpose, jobReference: body.jobReference, quantity: body.quantity } });
      return transfer;
    });
  });

  app.post('/v1/technician/use', { preHandler: requirePermission('inventory.technician') }, async request => {
    const body = useSchema.parse(request.body);
    const tenantId = request.auth.tenantId;
    return serializable(async tx => {
      const mobile = await custody(tx, request);
      const existing = await tx.technicianUsage.findUnique({
        where: { tenantId_requestKey: { tenantId, requestKey: body.requestKey } }
      });
      if (existing) {
        if (existing.technicianUserId !== request.auth.userId) throw conflict('Request key already belongs to another user');
        return existing;
      }
      const variant = await checkAllocations(tx, body, tenantId, mobile.id);
      // Guard serial/lot state even when the same technician submits two parallel requests.
      for (const line of body.lotAllocations) {
        const changed = await tx.inventoryLot.updateMany({
          where: { id: line.lotId, tenantId, locationId: mobile.id, productVariantId: variant.id,
            quantityOnHand: { gte: line.quantity } },
          data: { quantityOnHand: { decrement: line.quantity } }
        });
        if (changed.count !== 1) throw conflict('Lot quantity changed. Refresh stock and retry');
      }
      for (const serialId of body.serialNumberIds) {
        const changed = await tx.inventorySerial.updateMany({
          where: { id: serialId, tenantId, locationId: mobile.id, productVariantId: variant.id, status: 'AVAILABLE' },
          data: { status: 'INSTALLED' }
        });
        if (changed.count !== 1) throw conflict('Serial is no longer available');
      }
      const usageId = crypto.randomUUID();
      await postInventoryMovement(tx, { tenantId, locationId: mobile.id, productVariantId: variant.id,
        movementType: InventoryMovementType.TECHNICIAN_USE, quantity: body.quantity,
        referenceType: 'TECHNICIAN_USAGE', referenceId: usageId, performedBy: request.auth.userId,
        reason: 'Used on job ' + body.jobReference });
      const unitCost = await consumeFifoCost(tx, { tenantId, locationId: mobile.id,
        productVariantId: variant.id, quantity: body.quantity, fallbackUnitCost: variant.baseCost });
      const usage = await tx.technicianUsage.create({ data: {
        id: usageId, tenantId, technicianUserId: request.auth.userId, locationId: mobile.id,
        productVariantId: variant.id, quantity: body.quantity, jobReference: body.jobReference,
        requestKey: body.requestKey, unitCost,
        serialNumberIds: body.serialNumberIds, lotAllocations: body.lotAllocations
      } });
      await writeAudit(tx, { tenantId, actorUserId: request.auth.userId, action: 'technician.stock_used',
        resourceType: 'TechnicianUsage', resourceId: usageId,
        after: { jobReference: body.jobReference, productVariantId: variant.id, quantity: body.quantity } });
      await emitEvent(tx, { tenantId, eventType: 'technician.stock_used',
        aggregateType: 'TechnicianUsage', aggregateId: usageId,
        payload: { jobReference: body.jobReference, productVariantId: variant.id, quantity: body.quantity } });
      return usage;
    });
  });
}
