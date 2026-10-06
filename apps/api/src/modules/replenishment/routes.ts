import type { FastifyInstance } from 'fastify';
import { PurchaseOrderStatus } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { businessNumber } from '../../lib/numbering.js';
import { serializable } from '../../lib/transactions.js';
import { conflict, notFound } from '../../lib/errors.js';
import { emitEvent } from '../../lib/outbox.js';
import { assertLocationAccess, requirePermission } from '../auth/context.js';
import { recalculateTenant } from './service.js';

const policySchema = z.object({
  locationId: z.string().min(1),
  productVariantId: z.string().min(1),
  preferredSupplierId: z.string().optional(),
  safetyStockQty: z.coerce.number().min(0).default(0),
  safetyDays: z.coerce.number().int().min(0).max(365).optional(),
  serviceLevel: z.coerce.number().min(0.5).max(0.9999).optional(),
  reviewPeriodDays: z.coerce.number().int().min(1).max(365).default(14),
  manualLeadDays: z.coerce.number().int().min(0).max(365).optional(),
  manualDailyDemand: z.coerce.number().min(0).optional(),
  enabled: z.boolean().default(true)
});

export async function replenishmentRoutes(app: FastifyInstance) {
  app.get('/v1/replenishment', { preHandler: requirePermission('replenishment.read') }, async request => {
    const rows = await prisma.reorderRecommendation.findMany({ where: { tenantId: request.auth.tenantId }, orderBy: { calculatedAt: 'desc' }, take: 1000 });
    const latest = new Map<string, (typeof rows)[number]>();
    for (const row of rows) {
      const key = `${row.locationId}:${row.productVariantId}`;
      if (!latest.has(key) && (request.auth.allLocations || request.auth.locationIds.has(row.locationId))) latest.set(key, row);
    }
    const recommendations = [...latest.values()];
    const [locations, variants, suppliers] = await Promise.all([
      prisma.location.findMany({ where: { id: { in: recommendations.map(r => r.locationId) }, tenantId: request.auth.tenantId }, select: { id: true, name: true, code: true } }),
      prisma.productVariant.findMany({ where: { id: { in: recommendations.map(r => r.productVariantId) }, tenantId: request.auth.tenantId }, include: { product: { select: { name: true } } } }),
      prisma.supplier.findMany({ where: { id: { in: recommendations.flatMap(r => r.supplierId ? [r.supplierId] : []) }, tenantId: request.auth.tenantId }, select: { id: true, name: true } })
    ]);
    const lm = new Map(locations.map(x => [x.id, x]));
    const vm = new Map(variants.map(x => [x.id, x]));
    const sm = new Map(suppliers.map(x => [x.id, x]));
    return { recommendations: recommendations.map(row => ({ ...row, location: lm.get(row.locationId), productVariant: vm.get(row.productVariantId), supplier: row.supplierId ? sm.get(row.supplierId) : undefined })) };
  });

  app.put('/v1/replenishment/policies', { preHandler: requirePermission('replenishment.manage') }, async request => {
    const body = policySchema.parse(request.body);
    assertLocationAccess(request, body.locationId);
    const [variant, supplierMap] = await Promise.all([
      prisma.productVariant.findFirst({ where: { id: body.productVariantId, tenantId: request.auth.tenantId, active: true } }),
      body.preferredSupplierId ? prisma.supplierProduct.findFirst({ where: { tenantId: request.auth.tenantId, supplierId: body.preferredSupplierId, productVariantId: body.productVariantId, active: true } }) : Promise.resolve(null)
    ]);
    if (!variant) throw notFound('Product variant not found');
    if (body.preferredSupplierId && !supplierMap) throw conflict('Preferred supplier is not linked to this product');
    return prisma.replenishmentPolicy.upsert({
      where: { tenantId_locationId_productVariantId: { tenantId: request.auth.tenantId, locationId: body.locationId, productVariantId: body.productVariantId } },
      create: { tenantId: request.auth.tenantId, ...body },
      update: body
    });
  });

  app.post('/v1/replenishment/recalculate', { preHandler: requirePermission('replenishment.run') }, async request => {
    const recommendations = await recalculateTenant(request.auth.tenantId);
    return { recommendations: recommendations.filter(row => request.auth.allLocations || request.auth.locationIds.has(row.locationId)) };
  });

  app.post('/v1/replenishment/create-draft-pos', { preHandler: [requirePermission('replenishment.read'), requirePermission('procurement.write')] }, async request => {
    const body = z.object({ recommendationIds: z.array(z.string()).min(1).max(200) }).parse(request.body);
    return serializable(async tx => {
      const recs = await tx.reorderRecommendation.findMany({ where: { id: { in: body.recommendationIds }, tenantId: request.auth.tenantId } });
      if (recs.length !== new Set(body.recommendationIds).size) throw notFound('One or more recommendations were not found');
      for (const rec of recs) {
        assertLocationAccess(request, rec.locationId);
        if (!rec.supplierId) throw conflict('Every selected recommendation needs a supplier');
        if (rec.recommendedQty.lte(0)) throw conflict('A selected recommendation has no order quantity');
      }
      const groups = new Map<string, typeof recs>();
      for (const rec of recs) {
        const key = `${rec.supplierId}:${rec.locationId}`;
        const list = groups.get(key) ?? [];
        list.push(rec);
        groups.set(key, list);
      }
      const created = [];
      for (const group of groups.values()) {
        const first = group[0];
        const supplier = await tx.supplier.findFirst({ where: { id: first.supplierId!, tenantId: request.auth.tenantId, active: true } });
        if (!supplier) throw notFound('Supplier not found');
        const mappings = await tx.supplierProduct.findMany({ where: { supplierId: supplier.id, productVariantId: { in: group.map(r => r.productVariantId) }, active: true } });
        const mm = new Map(mappings.map(m => [m.productVariantId, m]));
        if (mappings.length !== group.length) throw conflict('Supplier pricing is missing for a recommended product');
        const longestLead = Math.max(...group.map(r => r.planningLeadDays));
        const po = await tx.purchaseOrder.create({
          data: {
            tenantId: request.auth.tenantId,
            supplierId: supplier.id,
            shipToLocationId: first.locationId,
            number: businessNumber('PO'),
            status: PurchaseOrderStatus.DRAFT,
            expectedAt: new Date(Date.now() + longestLead * 86_400_000),
            currency: supplier.currency,
            notes: `Drafted automatically from ${group.length} V79 Commerce replenishment recommendation(s).`,
            createdBy: request.auth.userId,
            lines: { create: group.map(rec => ({ productVariantId: rec.productVariantId, orderedQty: rec.recommendedQty, unitCost: mm.get(rec.productVariantId)!.unitCost })) }
          }, include: { lines: true, supplier: true }
        });
        await emitEvent(tx, { tenantId: request.auth.tenantId, eventType: 'purchase_order.created', aggregateType: 'PurchaseOrder', aggregateId: po.id, payload: { number: po.number, source: 'replenishment', recommendationIds: group.map(r => r.id) } });
        created.push(po);
      }
      return { purchaseOrders: created };
    });
  });

  app.get('/v1/notifications', async request => {
    const query = z.object({ unreadOnly: z.coerce.boolean().default(true) }).parse(request.query);
    return { notifications: await prisma.notification.findMany({ where: { tenantId: request.auth.tenantId, ...(query.unreadOnly ? { readAt: null } : {}) }, orderBy: { createdAt: 'desc' }, take: 100 }) };
  });
}
