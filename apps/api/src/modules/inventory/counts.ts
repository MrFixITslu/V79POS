import type { FastifyInstance } from 'fastify';
import { InventoryMovementType, Prisma, StockCountStatus, StockCountType } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { serializable } from '../../lib/transactions.js';
import { conflict, notFound } from '../../lib/errors.js';
import { assertLocationAccess, requirePermission } from '../auth/context.js';
import { postInventoryMovement } from './service.js';
import { businessNumber } from '../../lib/numbering.js';
import { writeAudit } from '../../lib/audit.js';

const D = (v: Prisma.Decimal.Value) => new Prisma.Decimal(v);

export async function stockCountRoutes(app: FastifyInstance) {
  app.post('/v1/stock-counts', { preHandler: requirePermission('inventory.count') }, async request => {
    const body = z.object({
      locationId: z.string(), type: z.enum(['FULL','CYCLE','BLIND']).default('CYCLE'),
      blind: z.boolean().optional(), productVariantIds: z.array(z.string()).optional(), notes: z.string().max(1000).optional()
    }).parse(request.body);
    assertLocationAccess(request, body.locationId);
    return serializable(async tx => {
      const location = await tx.location.findFirst({ where: { id: body.locationId, tenantId: request.auth.tenantId, active: true } });
      if (!location) throw notFound('Location not found');
      const filter = body.productVariantIds?.length ? { id: { in: [...new Set(body.productVariantIds)] } } : {};
      const variants = await tx.productVariant.findMany({ where: { tenantId: request.auth.tenantId, active: true, trackStock: true, ...filter }, select: { id: true } });
      if (body.productVariantIds?.length && variants.length !== new Set(body.productVariantIds).size) throw notFound('One or more products were not found');
      const ids = variants.map(v => v.id);
      const balances = await tx.inventoryBalance.findMany({ where: { tenantId: request.auth.tenantId, locationId: body.locationId, productVariantId: { in: ids } } });
      const balanceMap = new Map(balances.map(b => [b.productVariantId, b.onHand]));
      const count = await tx.stockCount.create({ data: {
        tenantId: request.auth.tenantId, locationId: body.locationId, number: businessNumber('COUNT'),
        type: StockCountType[body.type], blind: body.blind ?? body.type === 'BLIND', status: StockCountStatus.IN_PROGRESS,
        notes: body.notes, createdBy: request.auth.userId, startedAt: new Date()
      }});
      if (ids.length) await tx.stockCountLine.createMany({ data: ids.map(productVariantId => ({ stockCountId: count.id, productVariantId, expectedQty: balanceMap.get(productVariantId) ?? D(0) })) });
      return tx.stockCount.findUnique({ where: { id: count.id }, include: { lines: { include: { productVariant: { include: { product: true } } } } } });
    });
  });

  app.get('/v1/stock-counts', { preHandler: requirePermission('inventory.read') }, async request => ({
    counts: await prisma.stockCount.findMany({ where: { tenantId: request.auth.tenantId, ...(request.auth.allLocations ? {} : { locationId: { in: [...request.auth.locationIds] } }) }, orderBy: { createdAt: 'desc' }, take: 100 })
  }));

  app.get('/v1/stock-counts/:id', { preHandler: requirePermission('inventory.read') }, async request => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const count = await prisma.stockCount.findFirst({ where: { id, tenantId: request.auth.tenantId }, include: { lines: { include: { productVariant: { include: { product: true } } } } } });
    if (!count) throw notFound('Stock count not found');
    assertLocationAccess(request, count.locationId);
    if (count.blind && count.status !== StockCountStatus.COMPLETED) {
      return { ...count, lines: count.lines.map(({ expectedQty: _expected, varianceQty: _variance, ...line }) => line) };
    }
    return count;
  });

  app.patch('/v1/stock-counts/:id/lines/:lineId', { preHandler: requirePermission('inventory.count') }, async request => {
    const params = z.object({ id: z.string(), lineId: z.string() }).parse(request.params);
    const body = z.object({ countedQty: z.coerce.number().min(0), notes: z.string().max(500).optional() }).parse(request.body);
    const count = await prisma.stockCount.findFirst({ where: { id: params.id, tenantId: request.auth.tenantId, status: { in: [StockCountStatus.IN_PROGRESS, StockCountStatus.SUBMITTED] } } });
    if (!count) throw notFound('Active stock count not found');
    assertLocationAccess(request, count.locationId);
    const line = await prisma.stockCountLine.findFirst({ where: { id: params.lineId, stockCountId: count.id } });
    if (!line) throw notFound('Stock count line not found');
    const counted = D(body.countedQty);
    return prisma.stockCountLine.update({ where: { id: line.id }, data: { countedQty: counted, varianceQty: counted.minus(line.expectedQty), countedBy: request.auth.userId, countedAt: new Date(), notes: body.notes } });
  });

  app.post('/v1/stock-counts/:id/submit', { preHandler: requirePermission('inventory.count') }, async request => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const count = await prisma.stockCount.findFirst({ where: { id, tenantId: request.auth.tenantId, status: StockCountStatus.IN_PROGRESS }, include: { lines: true } });
    if (!count) throw notFound('Stock count not found');
    assertLocationAccess(request, count.locationId);
    if (count.lines.some(l => l.countedQty == null)) throw conflict('All stock count lines must be counted before submission');
    return prisma.stockCount.update({ where: { id }, data: { status: StockCountStatus.SUBMITTED, submittedBy: request.auth.userId, submittedAt: new Date() } });
  });

  app.post('/v1/stock-counts/:id/complete', { preHandler: requirePermission('inventory.count.approve') }, async request => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    return serializable(async tx => {
      const count = await tx.stockCount.findFirst({ where: { id, tenantId: request.auth.tenantId, status: StockCountStatus.SUBMITTED }, include: { lines: true } });
      if (!count) throw notFound('Submitted stock count not found');
      assertLocationAccess(request, count.locationId);
      for (const line of count.lines) {
        if (line.countedQty == null) throw conflict('Count contains uncounted lines');
        const variance = line.countedQty.minus(line.expectedQty);
        if (variance.gt(0)) await postInventoryMovement(tx, { tenantId: request.auth.tenantId, locationId: count.locationId, productVariantId: line.productVariantId, movementType: InventoryMovementType.ADJUSTMENT_GAIN, quantity: variance, referenceType: 'STOCK_COUNT', referenceId: count.id, reason: 'Stock count variance', performedBy: request.auth.userId });
        if (variance.lt(0)) await postInventoryMovement(tx, { tenantId: request.auth.tenantId, locationId: count.locationId, productVariantId: line.productVariantId, movementType: InventoryMovementType.ADJUSTMENT_LOSS, quantity: variance.abs(), referenceType: 'STOCK_COUNT', referenceId: count.id, reason: 'Stock count variance', performedBy: request.auth.userId });
      }
      const completed = await tx.stockCount.update({ where: { id }, data: { status: StockCountStatus.COMPLETED, completedBy: request.auth.userId, completedAt: new Date() } });
      await writeAudit(tx, { tenantId: request.auth.tenantId, actorUserId: request.auth.userId, action: 'stock_count.completed', resourceType: 'StockCount', resourceId: id, after: { lineCount: count.lines.length } });
      return completed;
    });
  });
}
