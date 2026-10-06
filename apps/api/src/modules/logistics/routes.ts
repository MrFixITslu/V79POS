import type { FastifyInstance } from 'fastify';
import { ShipmentStatus } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { serializable } from '../../lib/transactions.js';
import { conflict, notFound } from '../../lib/errors.js';
import { emitEvent } from '../../lib/outbox.js';
import { writeAudit } from '../../lib/audit.js';
import { assertLocationAccess, requirePermission } from '../auth/context.js';

const createShipmentSchema = z.object({
  purchaseOrderId: z.string().min(1),
  trackingNumber: z.string().max(200).optional(),
  carrier: z.string().max(160).optional(),
  origin: z.string().max(300).optional(),
  destination: z.string().max(300).optional(),
  etd: z.coerce.date().optional(),
  eta: z.coerce.date().optional(),
  lines: z.array(z.object({ purchaseOrderLineId: z.string().min(1), quantity: z.coerce.number().positive() })).min(1)
});

const statusSchema = z.object({
  status: z.enum(['PLANNED', 'CONFIRMED', 'PREPARING', 'DISPATCHED', 'IN_TRANSIT', 'ARRIVED_CUSTOMS', 'CUSTOMS_RELEASED', 'OUT_FOR_DELIVERY', 'RECEIVED', 'EXCEPTION', 'CANCELLED']),
  occurredAt: z.coerce.date().default(() => new Date()),
  eta: z.coerce.date().optional(),
  notes: z.string().max(2000).optional(),
  source: z.string().max(100).default('manual')
});

export async function logisticsRoutes(app: FastifyInstance) {
  app.get('/v1/shipments', { preHandler: requirePermission('logistics.read') }, async request => {
    const shipments = await prisma.shipment.findMany({
      where: { tenantId: request.auth.tenantId },
      include: { purchaseOrder: { select: { number: true, shipToLocationId: true } }, lines: true, events: { orderBy: { occurredAt: 'desc' }, take: 10 } },
      orderBy: { updatedAt: 'desc' }, take: 100
    });
    return { shipments: shipments.filter(s => request.auth.allLocations || Boolean(s.purchaseOrder && request.auth.locationIds.has(s.purchaseOrder.shipToLocationId))) };
  });

  app.post('/v1/shipments', { preHandler: requirePermission('logistics.write') }, async request => {
    const body = createShipmentSchema.parse(request.body);
    return serializable(async tx => {
      const po = await tx.purchaseOrder.findFirst({ where: { id: body.purchaseOrderId, tenantId: request.auth.tenantId }, include: { lines: true } });
      if (!po) throw notFound('Purchase order not found');
      assertLocationAccess(request, po.shipToLocationId);
      const lineMap = new Map(po.lines.map(line => [line.id, line]));
      for (const input of body.lines) {
        const line = lineMap.get(input.purchaseOrderLineId);
        if (!line) throw conflict('Shipment line does not belong to purchase order');
        if (input.quantity > line.orderedQty.minus(line.receivedQty).toNumber()) throw conflict('Shipment quantity exceeds outstanding PO quantity');
      }
      return tx.shipment.create({
        data: {
          tenantId: request.auth.tenantId,
          purchaseOrderId: po.id,
          trackingNumber: body.trackingNumber,
          carrier: body.carrier,
          origin: body.origin,
          destination: body.destination,
          etd: body.etd,
          eta: body.eta,
          status: ShipmentStatus.PLANNED,
          lines: { create: body.lines.map(input => ({ purchaseOrderLineId: input.purchaseOrderLineId, productVariantId: lineMap.get(input.purchaseOrderLineId)!.productVariantId, quantity: input.quantity })) },
          events: { create: { status: ShipmentStatus.PLANNED, occurredAt: new Date(), source: 'manual' } }
        }, include: { lines: true, events: true }
      });
    });
  });

  app.patch('/v1/shipments/:id/status', { preHandler: requirePermission('logistics.write') }, async request => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const body = statusSchema.parse(request.body);
    return serializable(async tx => {
      const shipment = await tx.shipment.findFirst({ where: { id, tenantId: request.auth.tenantId }, include: { purchaseOrder: true } });
      if (!shipment) throw notFound('Shipment not found');
      if (shipment.purchaseOrder) assertLocationAccess(request, shipment.purchaseOrder.shipToLocationId);
      const oldEta = shipment.eta;
      const updated = await tx.shipment.update({
        where: { id },
        data: {
          status: ShipmentStatus[body.status],
          eta: body.eta ?? undefined,
          actualDeparture: body.status === 'DISPATCHED' && !shipment.actualDeparture ? body.occurredAt : undefined,
          actualArrival: body.status === 'RECEIVED' && !shipment.actualArrival ? body.occurredAt : undefined,
          events: { create: { status: ShipmentStatus[body.status], occurredAt: body.occurredAt, notes: body.notes, source: body.source } }
        }, include: { lines: true, events: { orderBy: { occurredAt: 'desc' }, take: 10 } }
      });
      let eventType = body.status === 'DISPATCHED' ? 'shipment.dispatched' : body.status === 'RECEIVED' ? 'shipment.received' : 'shipment.updated';
      if (body.eta && oldEta && body.eta.getTime() > oldEta.getTime()) eventType = 'shipment.delayed';
      await emitEvent(tx, { tenantId: request.auth.tenantId, eventType, aggregateType: 'Shipment', aggregateId: shipment.id, payload: { status: body.status, eta: updated.eta?.toISOString() ?? null, oldEta: oldEta?.toISOString() ?? null, trackingNumber: updated.trackingNumber } });
      await writeAudit(tx, { tenantId: request.auth.tenantId, actorUserId: request.auth.userId, action: eventType, resourceType: 'Shipment', resourceId: shipment.id, before: { status: shipment.status, eta: oldEta?.toISOString() ?? null }, after: { status: updated.status, eta: updated.eta?.toISOString() ?? null } });
      return updated;
    });
  });
}
