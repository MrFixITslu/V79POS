import type { FastifyInstance } from 'fastify';
import { InventoryMovementType } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { serializable } from '../../lib/transactions.js';
import { writeAudit } from '../../lib/audit.js';
import { emitEvent } from '../../lib/outbox.js';
import { assertLocationAccess, requirePermission } from '../auth/context.js';
import { availableFromBalance, postInventoryMovement } from './service.js';

const adjustmentSchema = z.object({
  locationId: z.string().min(1),
  productVariantId: z.string().min(1),
  type: z.enum(['ADJUSTMENT_GAIN', 'ADJUSTMENT_LOSS', 'DAMAGE', 'EXPIRY', 'QUARANTINE_IN', 'QUARANTINE_RELEASE']),
  quantity: z.coerce.number().positive(),
  reason: z.string().min(3).max(500)
});

export async function inventoryRoutes(app: FastifyInstance) {
  app.get('/v1/locations', { preHandler: requirePermission('inventory.read') }, async request => ({
    locations: await prisma.location.findMany({
      where: { tenantId: request.auth.tenantId, active: true, ...(request.auth.allLocations ? {} : { id: { in: [...request.auth.locationIds] } }) },
      select: { id: true, name: true, code: true, type: true },
      orderBy: { name: 'asc' }
    })
  }));
  app.get('/v1/inventory', { preHandler: requirePermission('inventory.read') }, async request => {
    const query = z.object({ locationId: z.string().optional() }).parse(request.query);
    if (query.locationId) assertLocationAccess(request, query.locationId);
    const locationFilter = request.auth.allLocations
      ? query.locationId ? { locationId: query.locationId } : {}
      : { locationId: { in: query.locationId ? [query.locationId] : [...request.auth.locationIds] } };
    const balances = await prisma.inventoryBalance.findMany({
      where: { tenantId: request.auth.tenantId, ...locationFilter },
      include: { location: { select: { id: true, name: true, code: true } }, productVariant: { include: { product: { select: { name: true } } } } },
      orderBy: { updatedAt: 'desc' }
    });
    return { inventory: balances.map(balance => ({ ...balance, available: availableFromBalance(balance).toString() })) };
  });

  app.get('/v1/inventory/lots', { preHandler: requirePermission('inventory.read') }, async request => {
    const q=z.object({locationId:z.string().optional(),expiringWithinDays:z.coerce.number().int().min(0).max(3650).optional()}).parse(request.query);
    if(q.locationId) assertLocationAccess(request,q.locationId);
    const expiry=q.expiringWithinDays!=null?new Date(Date.now()+q.expiringWithinDays*86400_000):undefined;
    const locationFilter=q.locationId?{locationId:q.locationId}:request.auth.allLocations?{}:{locationId:{in:[...request.auth.locationIds]}};
    return {lots:await prisma.inventoryLot.findMany({where:{tenantId:request.auth.tenantId,quantityOnHand:{gt:0},...locationFilter,...(expiry?{expiryDate:{lte:expiry}}:{})},include:{productVariant:{include:{product:true}},location:true},orderBy:{expiryDate:'asc'},take:500})};
  });

  app.get('/v1/inventory/serials', { preHandler: requirePermission('inventory.read') }, async request => {
    const q=z.object({locationId:z.string().optional(),productVariantId:z.string().optional(),status:z.enum(['AVAILABLE','RESERVED','SOLD','IN_TRANSIT','DAMAGED','RETIRED']).optional(),q:z.string().max(200).optional()}).parse(request.query);
    if(q.locationId) assertLocationAccess(request,q.locationId);
    const locationFilter=q.locationId?{locationId:q.locationId}:request.auth.allLocations?{}:{locationId:{in:[...request.auth.locationIds]}};
    return {serials:await prisma.inventorySerial.findMany({where:{tenantId:request.auth.tenantId,...locationFilter,productVariantId:q.productVariantId,status:q.status,serialNumber:q.q?{contains:q.q,mode:'insensitive'}:undefined},include:{productVariant:{include:{product:true}},location:true},orderBy:{updatedAt:'desc'},take:200})};
  });

  app.post('/v1/inventory/adjustments', { preHandler: requirePermission('inventory.adjust') }, async request => {
    const body = adjustmentSchema.parse(request.body);
    assertLocationAccess(request, body.locationId);
    return serializable(async tx => {
      const movement = await postInventoryMovement(tx, {
        tenantId: request.auth.tenantId, locationId: body.locationId, productVariantId: body.productVariantId,
        movementType: InventoryMovementType[body.type], quantity: body.quantity, referenceType: 'MANUAL_ADJUSTMENT',
        referenceId: crypto.randomUUID(), reason: body.reason, performedBy: request.auth.userId
      });
      await writeAudit(tx, { tenantId: request.auth.tenantId, actorUserId: request.auth.userId, action: 'inventory.adjusted', resourceType: 'InventoryLedger', resourceId: movement.id, after: { type: body.type, quantity: body.quantity, reason: body.reason } });
      await emitEvent(tx, { tenantId: request.auth.tenantId, eventType: 'inventory.adjusted', aggregateType: 'InventoryLedger', aggregateId: movement.id, payload: { locationId: body.locationId, productVariantId: body.productVariantId, type: body.type, quantity: body.quantity } });
      return movement;
    });
  });
}
