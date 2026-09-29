import type { FastifyInstance } from 'fastify';
import { ShipmentStatus } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { config } from '../../lib/config.js';
import { verifyPlatformSignature } from '../../lib/platform-signature.js';
import { builtInRoleKeys } from '../auth/context.js';

const provisionSchema = z.object({
  organization: z.object({ id: z.string().min(8).max(100), name: z.string().min(1).max(180), slug: z.string().min(1).max(100) }),
  user: z.object({ id: z.string().uuid() }),
  role: z.literal('owner')
});

export async function platformRoutes(app: FastifyInstance) {
  app.addHook('preHandler', async (request, reply) => {
    if (!request.url.startsWith('/api/platform/')) return;
    const pathname = new URL(request.url, 'http://localhost').pathname;
    const body = request.method === 'GET' ? '' : JSON.stringify(request.body ?? {});
    if (request.headers['x-v79-service-id'] !== 'v79-hub' || !verifyPlatformSignature({
      method: request.method, pathname, timestamp: String(request.headers['x-v79-timestamp'] ?? ''),
      signature: String(request.headers['x-v79-signature'] ?? ''), body, secret: config.V79_PLATFORM_SHARED_SECRET
    })) return reply.code(401).send({ error: 'Invalid V79 platform signature.' });
  });

  app.post('/api/platform/provision', async request => {
    const { organization, user } = provisionSchema.parse(request.body);
    await prisma.$transaction(async tx => {
      const existing = await tx.tenant.findUnique({ where: { id: organization.id } });
      if (existing && existing.slug !== organization.slug) throw new Error('Hub organisation slug mismatch');
      await tx.tenant.upsert({ where: { id: organization.id }, create: { id: organization.id, name: organization.name, slug: organization.slug, currency: 'XCD', timezone: 'America/St_Lucia' }, update: { name: organization.name } });
      for (const key of builtInRoleKeys()) {
        await tx.tenantRole.upsert({ where: { tenantId_key: { tenantId: organization.id, key } }, create: { tenantId: organization.id, key, name: key[0] + key.slice(1).toLowerCase(), builtIn: true }, update: {} });
      }
      await tx.membership.upsert({ where: { tenantId_userId: { tenantId: organization.id, userId: user.id } }, create: { tenantId: organization.id, userId: user.id, roleKey: 'OWNER' }, update: { roleKey: 'OWNER', active: true } });
      const location = await tx.location.upsert({ where: { tenantId_code: { tenantId: organization.id, code: 'MAIN' } }, create: { tenantId: organization.id, name: 'Main Store', code: 'MAIN', type: 'STORE' }, update: {} });
      await tx.register.upsert({ where: { tenantId_code: { tenantId: organization.id, code: 'REG-01' } }, create: { tenantId: organization.id, locationId: location.id, name: 'Register 1', code: 'REG-01' }, update: {} });
    });
    return { organizationId: organization.id, ownerUserId: user.id, provisioned: true };
  });

  app.get<{ Params: { organizationId: string } }>('/api/platform/summary/:organizationId', async (request, reply) => {
    const tenant = await prisma.tenant.findUnique({
      where: { id: request.params.organizationId },
      select: { id: true, active: true, currency: true, timezone: true }
    });
    if (!tenant?.active) return reply.code(404).send({ error: 'POS workspace is not provisioned.' });
    const tenantId = tenant.id;
    const since30d = new Date(Date.now() - 30 * 86400_000);
    const now = new Date();
    const [products, locations, sales, openPurchaseOrders, recentSales, criticalReplenishment, delayedShipments, unresolvedExceptions] = await Promise.all([
      prisma.product.count({ where: { tenantId } }),
      prisma.location.count({ where: { tenantId, active: true } }),
      prisma.sale.count({ where: { tenantId, status: { in: ['COMPLETED','PARTIALLY_REFUNDED','REFUNDED'] } } }),
      prisma.purchaseOrder.count({ where: { tenantId, status: { in: ['DRAFT','PENDING_APPROVAL','APPROVED','SUBMITTED','CONFIRMED','PARTIALLY_RECEIVED'] } } }),
      prisma.sale.aggregate({
        where: { tenantId, completedAt: { gte: since30d }, status: { in: ['COMPLETED','PARTIALLY_REFUNDED','REFUNDED'] } },
        _count: { _all: true },
        _sum: { total: true }
      }),
      prisma.reorderRecommendation.count({ where: { tenantId, status: { in: ['ORDER_NOW','STOCKOUT_RISK','STOCKED_OUT'] } } }),
      prisma.shipment.count({
        where: { tenantId, status: { notIn: [ShipmentStatus.RECEIVED, ShipmentStatus.CANCELLED] }, eta: { lt: now } }
      }),
      prisma.inventoryException.count({ where: { tenantId, resolvedAt: null } })
    ]);
    return {
      organizationId: tenantId,
      generatedAt: new Date().toISOString(),
      metrics: {
        products,
        locations,
        sales,
        openPurchaseOrders,
        sales30d: recentSales._count._all,
        revenue30d: recentSales._sum.total?.toNumber() ?? 0,
        currency: tenant.currency,
        criticalReplenishmentItems: criticalReplenishment,
        delayedShipments,
        unresolvedInventoryExceptions: unresolvedExceptions
      }
    };
  });

  app.get('/api/platform/admin/stats', async () => {
    const [totalTenants, activeTenants, inactiveTenants, activeMemberships, activeLocations, products, sales, openPurchaseOrders] = await Promise.all([
      prisma.tenant.count(),
      prisma.tenant.count({ where: { active: true } }),
      prisma.tenant.count({ where: { active: false } }),
      prisma.membership.count({ where: { active: true } }),
      prisma.location.count({ where: { active: true } }),
      prisma.product.count(),
      prisma.sale.count({ where: { status: { in: ['COMPLETED','PARTIALLY_REFUNDED','REFUNDED'] } } }),
      prisma.purchaseOrder.count({ where: { status: { in: ['DRAFT','PENDING_APPROVAL','APPROVED','SUBMITTED','CONFIRMED','PARTIALLY_RECEIVED'] } } }),
    ]);
    return {
      totalTenants,
      activeTenants,
      inactiveTenants,
      activeMemberships,
      activeLocations,
      products,
      completedSales: sales,
      openPurchaseOrders,
      generatedAt: new Date().toISOString(),
    };
  });

  app.get('/api/platform/admin/tenants', async () => {
    const tenants = await prisma.tenant.findMany({
      select: {
        id: true,
        name: true,
        slug: true,
        currency: true,
        timezone: true,
        active: true,
        offlineSalesEnabled: true,
        offlineMaxSnapshotHours: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
    });

    return Promise.all(tenants.map(async tenant => {
      const [members, locations, products, sales, openPurchaseOrders] = await Promise.all([
        prisma.membership.count({ where: { tenantId: tenant.id, active: true } }),
        prisma.location.count({ where: { tenantId: tenant.id, active: true } }),
        prisma.product.count({ where: { tenantId: tenant.id } }),
        prisma.sale.count({ where: { tenantId: tenant.id, status: { in: ['COMPLETED','PARTIALLY_REFUNDED','REFUNDED'] } } }),
        prisma.purchaseOrder.count({ where: { tenantId: tenant.id, status: { in: ['DRAFT','PENDING_APPROVAL','APPROVED','SUBMITTED','CONFIRMED','PARTIALLY_RECEIVED'] } } }),
      ]);
      return { ...tenant, memberCount: members, locationCount: locations, productCount: products, completedSales: sales, openPurchaseOrders };
    }));
  });

  app.put<{ Params: { tenantId: string; state: string } }>('/api/platform/admin/tenants/:tenantId/active/:state', async (request, reply) => {
    const params = z.object({ tenantId: z.string().min(1).max(100), state: z.enum(['enabled','disabled']) }).parse(request.params);
    const existing = await prisma.tenant.findUnique({ where: { id: params.tenantId }, select: { id: true } });
    if (!existing) return reply.code(404).send({ error: 'POS tenant not found.' });
    const tenant = await prisma.tenant.update({ where: { id: params.tenantId }, data: { active: params.state === 'enabled' }, select: { id: true, active: true } });
    return { success: true, tenantId: tenant.id, active: tenant.active };
  });

  app.put<{ Params: { tenantId: string; state: string } }>('/api/platform/admin/tenants/:tenantId/offline-sales/:state', async (request, reply) => {
    const params = z.object({ tenantId: z.string().min(1).max(100), state: z.enum(['enabled','disabled']) }).parse(request.params);
    const existing = await prisma.tenant.findUnique({ where: { id: params.tenantId }, select: { id: true } });
    if (!existing) return reply.code(404).send({ error: 'POS tenant not found.' });
    const tenant = await prisma.tenant.update({ where: { id: params.tenantId }, data: { offlineSalesEnabled: params.state === 'enabled' }, select: { id: true, offlineSalesEnabled: true } });
    return { success: true, tenantId: tenant.id, offlineSalesEnabled: tenant.offlineSalesEnabled };
  });

}
