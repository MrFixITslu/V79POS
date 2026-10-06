import type { FastifyInstance } from 'fastify';
import { ShipmentStatus } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { assertLocationAccess, requirePermission } from '../auth/context.js';

const rangeSchema = z.object({
  from: z.coerce.date().optional(), to: z.coerce.date().optional(), locationId: z.string().optional()
});

export async function reportRoutes(app: FastifyInstance) {
  app.get('/v1/reports/dashboard', { preHandler: requirePermission('reports.read') }, async request => {
    const q = rangeSchema.parse(request.query);
    if (q.locationId) assertLocationAccess(request, q.locationId);
    const from = q.from ?? new Date(Date.now() - 30 * 86400_000);
    const to = q.to ?? new Date();
    const allowedLocationIds = q.locationId ? [q.locationId] : request.auth.allLocations ? null : [...request.auth.locationIds];
    const locationFilter = allowedLocationIds ? { locationId: { in: allowedLocationIds } } : {};
    const purchaseLocationFilter = allowedLocationIds ? { shipToLocationId: { in: allowedLocationIds } } : {};
    const sales = await prisma.sale.findMany({
      where: { tenantId: request.auth.tenantId, completedAt: { gte: from, lte: to }, status: { in: ['COMPLETED','PARTIALLY_REFUNDED','REFUNDED'] }, ...locationFilter },
      include: { lines: true, returns: true }
    });
    const revenue = sales.reduce((sum, s) => sum + s.total.toNumber(), 0);
    const discount = sales.reduce((sum, s) => sum + s.discount.toNumber(), 0);
    const tax = sales.reduce((sum, s) => sum + s.tax.toNumber(), 0);
    const cogs = sales.reduce((sum, s) => sum + s.lines.reduce((a,l) => a + l.unitCostSnapshot.toNumber() * l.quantity.toNumber(),0),0);
    const refunds = sales.reduce((sum, s) => sum + s.returns.reduce((a,r) => a + r.total.toNumber(),0),0);
    const inventoryValueAgg = await prisma.inventoryCostLayer.aggregate({ where: { tenantId: request.auth.tenantId, quantityRemaining: { gt: 0 }, ...locationFilter }, _sum: { quantityRemaining: true } });
    const costLayers = await prisma.inventoryCostLayer.findMany({ where: { tenantId: request.auth.tenantId, quantityRemaining: { gt: 0 }, ...locationFilter }, select: { quantityRemaining: true, unitCost: true } });
    const inventoryValue = costLayers.reduce((sum,l)=>sum+l.quantityRemaining.toNumber()*l.unitCost.toNumber(),0);
    const [riskCount, openPoCount, openPoLines, delayedShipments, unresolvedExceptions] = await Promise.all([
      prisma.reorderRecommendation.count({ where: { tenantId: request.auth.tenantId, status: { in: ['ORDER_NOW','STOCKOUT_RISK','STOCKED_OUT'] }, ...locationFilter } }),
      prisma.purchaseOrder.count({ where: { tenantId: request.auth.tenantId, status: { in: ['APPROVED','SUBMITTED','CONFIRMED','PARTIALLY_RECEIVED'] }, ...purchaseLocationFilter } }),
      prisma.purchaseOrderLine.findMany({ where: { purchaseOrder: { tenantId: request.auth.tenantId, status: { in: ['APPROVED','SUBMITTED','CONFIRMED','PARTIALLY_RECEIVED'] }, ...purchaseLocationFilter } }, select: { orderedQty: true, receivedQty: true, unitCost: true } }),
      prisma.shipment.count({ where: { tenantId: request.auth.tenantId, status: { notIn: [ShipmentStatus.RECEIVED, ShipmentStatus.CANCELLED] }, eta: { lt: new Date() }, ...(allowedLocationIds ? { purchaseOrder: { shipToLocationId: { in: allowedLocationIds } } } : {}) } }),
      prisma.inventoryException.count({ where: { tenantId: request.auth.tenantId, resolvedAt: null, ...locationFilter } })
    ]);
    const openPoValue = openPoLines.reduce((sum,l)=>sum+Math.max(0,l.orderedQty.minus(l.receivedQty).toNumber())*l.unitCost.toNumber(),0);
    return {
      period: { from, to }, sales: { revenue, refunds, netRevenue: revenue-refunds, cogs, grossProfit: revenue-refunds-cogs, grossMargin: revenue-refunds > 0 ? (revenue-refunds-cogs)/(revenue-refunds) : 0, tax, discount, orders: sales.length, averageSale: sales.length ? revenue/sales.length : 0 },
      inventory: { value: inventoryValue, quantityAcrossCostLayers: inventoryValueAgg._sum.quantityRemaining ?? 0, criticalReplenishmentItems: riskCount, unresolvedExceptions },
      purchasing: { openPurchaseOrders: openPoCount, openPoValue }, logistics: { delayedShipments }
    };
  });

  app.get('/v1/reports/inventory/slow-moving', { preHandler: requirePermission('reports.read') }, async request => {
    const q = z.object({ days: z.coerce.number().int().min(30).max(730).default(90), locationId: z.string().optional() }).parse(request.query);
    if (q.locationId) assertLocationAccess(request, q.locationId);
    const cutoff = new Date(Date.now() - q.days * 86400_000);
    const allowedLocationIds = q.locationId ? [q.locationId] : request.auth.allLocations ? null : [...request.auth.locationIds];
    const locationFilter = allowedLocationIds ? { locationId: { in: allowedLocationIds } } : {};
    const balances = await prisma.inventoryBalance.findMany({ where: { tenantId: request.auth.tenantId, onHand: { gt: 0 }, ...locationFilter }, include: { productVariant: { include: { product: true } }, location: true } });
    const recent = await prisma.saleLine.findMany({ where: { productVariantId: { in: balances.map(b=>b.productVariantId) }, sale: { tenantId: request.auth.tenantId, completedAt: { gte: cutoff }, ...locationFilter } }, select: { productVariantId: true } });
    const moved = new Set(recent.map(r=>r.productVariantId));
    return { days: q.days, items: balances.filter(b=>!moved.has(b.productVariantId)).map(b=>({ locationId:b.locationId, location:b.location.name, productVariantId:b.productVariantId, sku:b.productVariant.sku, name:`${b.productVariant.product.name} — ${b.productVariant.name}`, onHand:b.onHand, baseCost:b.productVariant.baseCost, estimatedValue:b.onHand.toNumber()*b.productVariant.baseCost.toNumber() })) };
  });

  app.get('/v1/reports/suppliers', { preHandler: requirePermission('reports.read') }, async request => {
    const suppliers = await prisma.supplier.findMany({ where: { tenantId: request.auth.tenantId }, include: { purchaseOrders: { where: request.auth.allLocations ? {} : { shipToLocationId: { in: [...request.auth.locationIds] } }, include: { lines: true, receipts: true } } } });
    return { suppliers: suppliers.map(s => {
      const pos = s.purchaseOrders.filter(p=>p.orderDate);
      const completed = pos.filter(p=>p.receipts.length>0);
      const leadDays = completed.flatMap(p=>p.receipts.map(r=>(r.receivedAt.getTime()-(p.orderDate?.getTime()??r.receivedAt.getTime()))/86400_000));
      const onTime = completed.filter(p=>p.expectedAt && p.receipts.some(r=>r.receivedAt<=p.expectedAt!)).length;
      const ordered = pos.reduce((a,p)=>a+p.lines.reduce((x,l)=>x+l.orderedQty.toNumber(),0),0);
      const received = pos.reduce((a,p)=>a+p.lines.reduce((x,l)=>x+l.receivedQty.toNumber(),0),0);
      return { supplierId:s.id, name:s.name, purchaseOrders:pos.length, averageLeadDays:leadDays.length?leadDays.reduce((a,b)=>a+b,0)/leadDays.length:null, onTimeRate:completed.length?onTime/completed.length:null, fillRate:ordered>0?received/ordered:null, quotedLeadDays:s.quotedLeadDays };
    }) };
  });

  app.get('/v1/intelligence/briefing', { preHandler: requirePermission('reports.read') }, async request => {
    const allowedLocationIds = request.auth.allLocations ? null : [...request.auth.locationIds];
    const locationFilter = allowedLocationIds ? { locationId: { in: allowedLocationIds } } : {};
    const [critical, delayed, exceptions, slow] = await Promise.all([
      prisma.reorderRecommendation.findMany({ where: { tenantId: request.auth.tenantId, status: { in: ['ORDER_NOW','STOCKOUT_RISK','STOCKED_OUT'] }, ...locationFilter }, orderBy: [{ orderByAt:'asc' },{ calculatedAt:'desc' }], take: 15 }),
      prisma.shipment.findMany({ where: { tenantId: request.auth.tenantId, status: { notIn: ['RECEIVED','CANCELLED'] }, eta: { lt: new Date() }, ...(allowedLocationIds ? { purchaseOrder: { shipToLocationId: { in: allowedLocationIds } } } : {}) }, orderBy: { eta:'asc' }, take: 10 }),
      prisma.inventoryException.findMany({ where: { tenantId: request.auth.tenantId, resolvedAt:null, ...locationFilter }, orderBy:{createdAt:'desc'}, take:10 }),
      prisma.inventoryBalance.count({ where: { tenantId: request.auth.tenantId, onHand:{gt:0}, ...locationFilter, productVariant:{ movements:{ none:{ createdAt:{gte:new Date(Date.now()-90*86400_000)}, movementType:'SALE'} } } } })
    ]);
    const priorities = [
      ...critical.map(r=>({ severity:r.status==='STOCKED_OUT'||r.status==='STOCKOUT_RISK'?'CRITICAL':'WARNING', type:'REPLENISHMENT', title:`${r.status.replaceAll('_',' ')}: reorder required`, detail:`Recommended quantity ${r.recommendedQty.toString()}, planning lead time ${r.planningLeadDays} days.`, referenceId:r.id })),
      ...delayed.map(s=>({ severity:'WARNING', type:'LOGISTICS', title:'Shipment past ETA', detail:`Shipment ${s.trackingNumber ?? s.id} was due ${s.eta?.toISOString()}.`, referenceId:s.id })),
      ...exceptions.map(e=>({ severity:'CRITICAL', type:'INVENTORY_EXCEPTION', title:'Offline inventory exception', detail:`Short by ${e.quantityShort.toString()} units after offline synchronization.`, referenceId:e.id }))
    ];
    return { generatedAt:new Date(), summary:{ criticalReplenishment:critical.length, delayedShipments:delayed.length, unresolvedInventoryExceptions:exceptions.length, slowMovingStockItems:slow }, priorities };
  });
}
