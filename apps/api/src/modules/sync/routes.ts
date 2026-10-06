import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { conflict, notFound } from '../../lib/errors.js';
import { assertLocationAccess, requirePermission } from '../auth/context.js';

export async function syncRoutes(app: FastifyInstance) {
  app.post('/v1/devices', { preHandler: requirePermission('devices.manage') }, async request => {
    const body = z.object({ name: z.string().min(1).max(100), deviceKey: z.string().min(8).max(120), locationId: z.string(), registerId: z.string().optional() }).parse(request.body);
    assertLocationAccess(request, body.locationId);
    if (body.registerId) {
      const register = await prisma.register.findFirst({ where: { id: body.registerId, tenantId: request.auth.tenantId, locationId: body.locationId } });
      if (!register) throw notFound('Register not found at the selected location');
    }
    return prisma.device.upsert({ where: { tenantId_deviceKey: { tenantId: request.auth.tenantId, deviceKey: body.deviceKey } }, create: { tenantId: request.auth.tenantId, ...body }, update: { name: body.name, locationId: body.locationId, registerId: body.registerId, active: true } });
  });

  app.post('/v1/sync/bootstrap', { preHandler: requirePermission('sales.create') }, async request => {
    const body = z.object({ deviceKey: z.string().min(8) }).parse(request.body);
    const [tenant, device] = await Promise.all([
      prisma.tenant.findUnique({ where: { id: request.auth.tenantId } }),
      prisma.device.findUnique({ where: { tenantId_deviceKey: { tenantId: request.auth.tenantId, deviceKey: body.deviceKey } } })
    ]);
    if (!tenant?.offlineSalesEnabled) throw conflict('Offline sales are disabled for this tenant');
    if (!device?.active) throw notFound('Registered device not found');
    assertLocationAccess(request, device.locationId);
    const latest = await prisma.catalogRevision.findFirst({ where: { tenantId: tenant.id }, orderBy: { revision: 'desc' } });
    const nextRevision = (latest?.revision ?? 0) + 1;
    const expiresAt = new Date(Date.now() + tenant.offlineMaxSnapshotHours * 3600_000);
    const variants = await prisma.productVariant.findMany({ where: { tenantId: tenant.id, active: true, product: { active: true } }, include: { product: { select: { name: true } } } });
    const revision = await prisma.$transaction(async tx => {
      const rev = await tx.catalogRevision.create({ data: { tenantId: tenant.id, revision: nextRevision, expiresAt } });
      if (variants.length) await tx.catalogSnapshotItem.createMany({ data: variants.map(v => ({ catalogRevisionId: rev.id, productVariantId: v.id, sku: v.sku, name: `${v.product.name} — ${v.name}`, sellPrice: v.sellPrice, taxRate: v.taxRate, active: true })) });
      await tx.device.update({ where: { id: device.id }, data: { lastSeenAt: new Date() } });
      return rev;
    });
    return { device: { id: device.id, locationId: device.locationId, registerId: device.registerId }, revision: revision.revision, expiresAt, products: variants.map(v => ({ productVariantId: v.id, sku: v.sku, barcode: v.barcode, name: `${v.product.name} — ${v.name}`, sellPrice: v.sellPrice, taxRate: v.taxRate, trackStock: v.trackStock })) };
  });

  app.get('/v1/inventory/exceptions', { preHandler: requirePermission('inventory.read') }, async request => ({
    exceptions: await prisma.inventoryException.findMany({ where: { tenantId: request.auth.tenantId, resolvedAt: null, ...(request.auth.allLocations ? {} : { locationId: { in: [...request.auth.locationIds] } }) }, orderBy: { createdAt: 'desc' }, take: 200 })
  }));

  app.post('/v1/inventory/exceptions/:id/resolve', { preHandler: requirePermission('inventory.adjust') }, async request => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const body = z.object({ notes: z.string().min(3).max(1000) }).parse(request.body);
    const row = await prisma.inventoryException.findFirst({ where: { id, tenantId: request.auth.tenantId } });
    if (!row) throw notFound('Inventory exception not found');
    assertLocationAccess(request, row.locationId);
    return prisma.inventoryException.update({ where: { id }, data: { resolvedAt: new Date(), resolvedBy: request.auth.userId, notes: body.notes } });
  });
}
