import type { FastifyInstance } from 'fastify';
import { InventoryMovementType, PaymentMethod, PaymentStatus, Prisma, SaleStatus } from '@prisma/client';
import { calculateSale } from '@v79/commerce-domain';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { serializable } from '../../lib/transactions.js';
import { businessNumber } from '../../lib/numbering.js';
import { conflict, notFound } from '../../lib/errors.js';
import { emitEvent } from '../../lib/outbox.js';
import { writeAudit } from '../../lib/audit.js';
import { assertLocationAccess, hasPermission, requirePermission } from '../auth/context.js';
import { postInventoryMovement, availableFromBalance } from '../inventory/service.js';
import { consumeFifoCost } from '../inventory/costing.js';
import { resolvePromotions, resolveUnitPrices, promotionDiscount } from '../pricing/service.js';
import { creditInternalTender, debitInternalTender, earnLoyalty } from '../value/service.js';
import { recordCommission, reverseCommissionForRefund } from '../team/commission.js';
import { verifyCashierProof } from '../../lib/cashier-proof.js';

const saleSchema = z.object({
  locationId: z.string().min(1),
  registerId: z.string().optional(),
  registerSessionId: z.string().optional(),
  deviceId: z.string().optional(),
  clientReference: z.string().min(8).max(200).optional(),
  offline: z.boolean().default(false),
  catalogRevision: z.coerce.number().int().positive().optional(),
  occurredAt: z.coerce.date().optional(),
  customerId: z.string().optional(),
  salespersonUserId: z.string().optional(),
  salespersonProof: z.string().max(1000).optional(),
  promotionCode: z.string().min(2).max(50).optional(),
  lines: z.array(z.object({
    productVariantId: z.string().min(1),
    quantity: z.coerce.number().positive(),
    discount: z.coerce.number().min(0).default(0),
    lotAllocations: z.array(z.object({ lotId: z.string(), quantity: z.coerce.number().positive() })).default([]),
    serialNumberIds: z.array(z.string()).default([])
  })).min(1),
  payments: z.array(z.object({
    method: z.enum(['CASH', 'CARD', 'EXTERNAL_TERMINAL', 'BANK_TRANSFER', 'MOBILE_WALLET', 'STORE_CREDIT', 'GIFT_CARD', 'LOYALTY_POINTS', 'OTHER']),
    amount: z.coerce.number().positive(),
    provider: z.string().max(100).optional(),
    providerRef: z.string().max(200).optional(),
    accountCode: z.string().max(100).optional()
  })).min(1)
});

export async function salesRoutes(app: FastifyInstance) {
  app.get('/v1/sales', { preHandler: requirePermission('sales.read') }, async request => {
    const query = z.object({ locationId: z.string().optional(), limit: z.coerce.number().int().min(1).max(200).default(50) }).parse(request.query);
    if (query.locationId) assertLocationAccess(request, query.locationId);
    const allowedLocations = request.auth.allLocations ? undefined : [...request.auth.locationIds];
    const sales = await prisma.sale.findMany({
      where: {
        tenantId: request.auth.tenantId,
        ...(query.locationId ? { locationId: query.locationId } : allowedLocations ? { locationId: { in: allowedLocations } } : {})
      },
      include: { lines: true, payments: true, customer: true },
      orderBy: { createdAt: 'desc' },
      take: query.limit
    });
    return { sales };
  });

  app.post('/v1/sales', { preHandler: requirePermission('sales.create') }, async request => {
    const body = saleSchema.parse(request.body);
    assertLocationAccess(request, body.locationId);
    if (body.lines.some(line => line.discount > 0) && !hasPermission(request.auth, 'sales.discount')) {
      throw conflict('This role cannot apply line discounts');
    }

    return serializable(async tx => {
      const tenant = await tx.tenant.findUnique({ where: { id: request.auth.tenantId } });
      if (!tenant?.active) throw notFound('Tenant not found');
      if (body.clientReference) {
        const existingSale = await tx.sale.findUnique({ where: { tenantId_clientReference: { tenantId: tenant.id, clientReference: body.clientReference } }, include: { lines: true, payments: true } });
        if (existingSale) return existingSale;
      }
      const effectiveAt = body.offline ? body.occurredAt : new Date();
      if (body.offline && (!body.deviceId || !body.clientReference || !body.catalogRevision || !body.occurredAt)) throw conflict('Offline sales require deviceId, clientReference, catalogRevision and occurredAt');
      if (body.occurredAt && body.occurredAt.getTime() > Date.now() + 5 * 60_000) throw conflict('Sale time cannot be in the future');
      let offlineRevision: { id: string; revision: number; createdAt: Date; expiresAt: Date } | null = null;
      if (body.offline) {
        if (!tenant.offlineSalesEnabled) throw conflict('Offline sales are disabled for this tenant');
        const device = await tx.device.findFirst({ where: { id: body.deviceId, tenantId: tenant.id, locationId: body.locationId, active: true } });
        if (!device) throw notFound('Registered offline device not found');
        if (body.registerId && device.registerId && body.registerId !== device.registerId) throw conflict('Offline sale register does not match registered device');
        offlineRevision = await tx.catalogRevision.findUnique({ where: { tenantId_revision: { tenantId: tenant.id, revision: body.catalogRevision! } } });
        if (!offlineRevision) throw conflict('Offline catalogue revision was not found');
        if (effectiveAt! < offlineRevision.createdAt || effectiveAt! > offlineRevision.expiresAt) throw conflict('Offline sale occurred outside the catalogue snapshot validity window');
        await tx.device.update({ where: { id: device.id }, data: { lastSeenAt: new Date() } });
      }
      let registerSession: { id: string } | null = null;
      if (body.registerId) {
        const register = await tx.register.findFirst({ where: { id: body.registerId, tenantId: tenant.id, locationId: body.locationId, active: true } });
        if (!register) throw notFound('Register not found at this location');
        if (body.offline && body.registerSessionId) {
          registerSession = await tx.registerSession.findFirst({
            where: { id: body.registerSessionId, registerId: body.registerId, tenantId: tenant.id, openedAt: { lte: effectiveAt! }, OR: [{ closedAt: null }, { closedAt: { gte: effectiveAt! } }] },
            select: { id: true }
          });
        } else {
          registerSession = await tx.registerSession.findFirst({ where: { registerId: body.registerId, tenantId: tenant.id, status: 'OPEN' }, select: { id: true } });
        }
        if (!registerSession) throw conflict('Register must have a valid session for the sale time');
      }
      if (body.customerId) {
        const customer = await tx.customer.findFirst({ where: { id: body.customerId, tenantId: tenant.id } });
        if (!customer) throw notFound('Customer not found');
      }
      const salespersonUserId = body.salespersonUserId ?? request.auth.userId;
      const salesperson = await tx.membership.findUnique({
        where: { tenantId_userId: { tenantId: tenant.id, userId: salespersonUserId } },
        include: { locationAccess: true }
      });
      if (!salesperson?.active) throw conflict('Salesperson is not an active member of this workspace');
      const salespersonHasLocation = ['OWNER','ADMIN'].includes(salesperson.roleKey) || salesperson.locationAccess.some(row => row.locationId === body.locationId);
      if (!salespersonHasLocation) throw conflict('Salesperson is not assigned to this location');
      if (salespersonUserId !== request.auth.userId) {
        if (!body.salespersonProof || !verifyCashierProof(body.salespersonProof, { tenantId: tenant.id, locationId: body.locationId, userId: salespersonUserId })) {
          throw conflict('A recent cashier PIN verification is required to attribute this sale to another salesperson');
        }
      }

      const variantIds = [...new Set(body.lines.map(line => line.productVariantId))];
      const variants = await tx.productVariant.findMany({
        where: { id: { in: variantIds }, tenantId: tenant.id, active: true, product: { active: true } },
        include: { product: { select: { name: true, productType: true } } }
      });
      const byId = new Map(variants.map(v => [v.id, v]));
      if (variants.length !== variantIds.length) throw notFound('One or more products were not found');
      const offlineItems = body.offline && offlineRevision ? await tx.catalogSnapshotItem.findMany({ where: { catalogRevisionId: offlineRevision.id, productVariantId: { in: variantIds }, active: true } }) : [];
      const offlinePriceMap = new Map(offlineItems.map(i => [i.productVariantId, i]));
      if (body.offline && offlineItems.length !== variantIds.length) throw conflict('One or more products were not available in the offline catalogue snapshot');

      const allSerialIds = [...new Set(body.lines.flatMap(l => l.serialNumberIds))];
      const allLotIds = [...new Set(body.lines.flatMap(l => l.lotAllocations.map(a => a.lotId)))];
      const [serialRows, lotRows] = await Promise.all([
        allSerialIds.length ? tx.inventorySerial.findMany({ where: { id: { in: allSerialIds }, tenantId: tenant.id, locationId: body.locationId, status: 'AVAILABLE' } }) : Promise.resolve([]),
        allLotIds.length ? tx.inventoryLot.findMany({ where: { id: { in: allLotIds }, tenantId: tenant.id, locationId: body.locationId } }) : Promise.resolve([])
      ]);
      const serialMap = new Map(serialRows.map(r => [r.id, r]));
      const lotMap = new Map(lotRows.map(r => [r.id, r]));
      for (const input of body.lines) {
        const variant = byId.get(input.productVariantId)!;
        if (variant.product.productType === 'SERIALIZED') {
          if (!Number.isInteger(input.quantity) || input.serialNumberIds.length !== input.quantity) throw conflict('Serialized sales require one serial number per unit');
          for (const serialId of input.serialNumberIds) { const serial=serialMap.get(serialId); if (!serial || serial.productVariantId !== variant.id) throw conflict('Serial number is not available for this product/location'); }
        } else if (input.serialNumberIds.length) throw conflict('Serial numbers supplied for a non-serialized product');
        if (variant.product.productType === 'LOT_TRACKED' || variant.requiresExpiry) {
          const allocated=input.lotAllocations.reduce((a,l)=>a+l.quantity,0); if(Math.abs(allocated-input.quantity)>0.0001) throw conflict('Lot allocation must equal sale quantity');
          for (const a of input.lotAllocations) { const lot=lotMap.get(a.lotId); if(!lot||lot.productVariantId!==variant.id||lot.quantityOnHand.lt(a.quantity)) throw conflict('Lot is unavailable or has insufficient quantity'); if(lot.expiryDate && lot.expiryDate < effectiveAt!) throw conflict('Expired lot cannot be sold'); }
        } else if (input.lotAllocations.length) throw conflict('Lot allocations supplied for a non-lot product');
      }

      const [customerPrices, promotions] = await Promise.all([
        body.offline ? Promise.resolve(new Map<string, number>()) : resolveUnitPrices(tx, { tenantId: tenant.id, customerId: body.customerId, variantIds, effectiveAt: effectiveAt ?? undefined }),
        resolvePromotions(tx, { tenantId: tenant.id, variantIds, promotionCode: body.promotionCode, effectiveAt: effectiveAt ?? undefined })
      ]);
      if (body.promotionCode && promotions.length === 0) throw conflict('Promotion code is invalid or inactive');
      const promotionTotals = new Map<string, number>();
      const baseSubtotal = body.lines.reduce((sum, line) => {
        const variant = byId.get(line.productVariantId)!;
        const unitPrice = body.offline ? offlinePriceMap.get(variant.id)!.sellPrice.toNumber() : (customerPrices.get(variant.id) ?? variant.sellPrice.toNumber());
        return sum + unitPrice * line.quantity;
      }, 0);
      const eligiblePromotions = promotions.filter(p => !p.minimumSubtotal || baseSubtotal >= p.minimumSubtotal.toNumber());
      const pricedLines = body.lines.map(line => {
        const variant = byId.get(line.productVariantId)!;
        const unitPrice = body.offline ? offlinePriceMap.get(variant.id)!.sellPrice.toNumber() : (customerPrices.get(variant.id) ?? variant.sellPrice.toNumber());
        let automaticDiscount = 0;
        let selectedPromotion: (typeof eligiblePromotions)[number] | undefined;
        for (const promotion of eligiblePromotions) {
          const candidate = promotionDiscount({ promotion: promotion as any, variantId: variant.id, quantity: line.quantity, unitPrice });
          if (candidate > automaticDiscount) { automaticDiscount = candidate; selectedPromotion = promotion; }
        }
        const gross = line.quantity * unitPrice;
        const totalDiscount = Math.min(gross, line.discount + automaticDiscount);
        if (selectedPromotion && automaticDiscount > 0) {
          promotionTotals.set(selectedPromotion.id, (promotionTotals.get(selectedPromotion.id) ?? 0) + automaticDiscount);
        }
        return { variant, quantity: line.quantity, discount: totalDiscount, lotAllocations: line.lotAllocations, serialNumberIds: line.serialNumberIds, pricing: { quantity: line.quantity, unitPrice, discount: totalDiscount, taxRate: body.offline ? offlinePriceMap.get(variant.id)!.taxRate.toNumber() : variant.taxRate.toNumber() }, taxRate: body.offline ? offlinePriceMap.get(variant.id)!.taxRate.toNumber() : variant.taxRate.toNumber() };
      });
      const totals = calculateSale(pricedLines.map(line => line.pricing));
      const amountPaid = body.payments.reduce((sum, payment) => sum + payment.amount, 0);
      if (amountPaid + 0.0001 < totals.total) throw conflict('Payment total is less than sale total');
      if (amountPaid > totals.total + 0.0001 && !body.payments.some(p => p.method === 'CASH')) {
        throw conflict('Overpayment is only allowed when cash is included so change can be returned');
      }
      for (const payment of body.payments) {
        const internal = ['STORE_CREDIT','GIFT_CARD','LOYALTY_POINTS'].includes(payment.method);
        if (!internal && payment.method !== 'CASH' && !payment.providerRef) {
          throw conflict(`providerRef is required for ${payment.method} payments until direct payment adapters are configured`);
        }
        if (payment.method === 'GIFT_CARD' && !payment.accountCode) throw conflict('Gift card code is required');
        if (['STORE_CREDIT','LOYALTY_POINTS'].includes(payment.method) && !body.customerId) throw conflict(`${payment.method} requires a customer`);
      }

      const sale = await tx.sale.create({
        data: {
          tenantId: tenant.id,
          locationId: body.locationId,
          registerId: body.registerId,
          registerSessionId: registerSession?.id,
          deviceId: body.deviceId,
          clientReference: body.clientReference,
          offline: body.offline,
          customerId: body.customerId,
          number: businessNumber('SALE'),
          status: SaleStatus.COMPLETED,
          currency: tenant.currency,
          subtotal: totals.subtotal,
          discount: totals.discount,
          tax: totals.tax,
          total: totals.total,
          amountPaid,
          changeDue: Math.max(0, amountPaid - totals.total),
          createdBy: request.auth.userId,
          salespersonUserId,
          completedAt: effectiveAt ?? new Date()
        }
      });

      const createdLines = [];
      for (let index = 0; index < pricedLines.length; index += 1) {
        const line = pricedLines[index];
        const calculated = totals.lines[index];
        let unitCost = line.variant.baseCost;
        if (line.variant.trackStock) {
          await postInventoryMovement(tx, {
            tenantId: tenant.id,
            locationId: body.locationId,
            productVariantId: line.variant.id,
            movementType: InventoryMovementType.SALE,
            quantity: line.quantity,
            referenceType: 'SALE',
            referenceId: sale.id,
            performedBy: request.auth.userId,
            deviceId: body.deviceId,
            allowNegative: body.offline
          });
          if (body.offline) {
            const balance = await tx.inventoryBalance.findUnique({ where: { tenantId_locationId_productVariantId: { tenantId: tenant.id, locationId: body.locationId, productVariantId: line.variant.id } } });
            if (balance) {
              const available = availableFromBalance(balance);
              if (available.lt(0)) await tx.inventoryException.upsert({
                where: { tenantId_saleId_productVariantId_type: { tenantId: tenant.id, saleId: sale.id, productVariantId: line.variant.id, type: 'OFFLINE_OVERSELL' } },
                create: { tenantId: tenant.id, locationId: body.locationId, saleId: sale.id, productVariantId: line.variant.id, type: 'OFFLINE_OVERSELL', quantityShort: available.abs() },
                update: { quantityShort: available.abs(), resolvedAt: null, resolvedBy: null }
              });
            }
          }
          unitCost = await consumeFifoCost(tx, {
            tenantId: tenant.id,
            locationId: body.locationId,
            productVariantId: line.variant.id,
            quantity: line.quantity,
            fallbackUnitCost: line.variant.baseCost
          });
        }
        const createdLine = await tx.saleLine.create({
          data: {
            saleId: sale.id,
            productVariantId: line.variant.id,
            sku: line.variant.sku,
            description: `${line.variant.product.name} — ${line.variant.name}`,
            quantity: line.quantity,
            unitPrice: line.pricing.unitPrice,
            discount: calculated.discount,
            taxRate: line.taxRate,
            taxAmount: calculated.tax,
            lineTotal: calculated.total,
            unitCostSnapshot: unitCost
          }
        });
        for (const allocation of line.lotAllocations) {
          await tx.inventoryLot.update({ where: { id: allocation.lotId }, data: { quantityOnHand: { decrement: allocation.quantity } } });
          await tx.saleLineLotAllocation.create({ data: { saleLineId: createdLine.id, lotId: allocation.lotId, productVariantId: line.variant.id, quantity: allocation.quantity } });
        }
        for (const serialId of line.serialNumberIds) {
          await tx.inventorySerial.update({ where: { id: serialId }, data: { status: 'SOLD' } });
          await tx.saleLineSerial.create({ data: { saleLineId: createdLine.id, serialId, productVariantId: line.variant.id } });
        }
        createdLines.push(createdLine);
      }

      const payments = [];
      for (const payment of body.payments) {
        let providerRef = payment.providerRef;
        if (['STORE_CREDIT','GIFT_CARD','LOYALTY_POINTS'].includes(payment.method)) {
          providerRef = await debitInternalTender(tx, {
            tenantId: tenant.id, customerId: body.customerId,
            method: payment.method as 'STORE_CREDIT'|'GIFT_CARD'|'LOYALTY_POINTS',
            amount: payment.amount, accountCode: payment.accountCode, referenceId: sale.id, userId: request.auth.userId
          });
        }
        payments.push(await tx.payment.create({ data: {
          tenantId: tenant.id, saleId: sale.id, method: PaymentMethod[payment.method], status: PaymentStatus.COMPLETED,
          amount: payment.amount, registerSessionId: registerSession?.id, provider: payment.provider ?? (['STORE_CREDIT','GIFT_CARD','LOYALTY_POINTS'].includes(payment.method) ? 'V79_INTERNAL' : undefined), providerRef
        }}));
      }
      const loyaltyPointsEarned = await earnLoyalty(tx, { tenantId: tenant.id, customerId: body.customerId, saleId: sale.id, eligibleAmount: totals.total });

      for (const [promotionId, discount] of promotionTotals) {
        if (discount > 0) await tx.saleAppliedPromotion.create({ data: { saleId: sale.id, promotionId, discount } });
      }

      const cogsTotal = createdLines.reduce((sum, line) => sum + line.unitCostSnapshot.toNumber() * line.quantity.toNumber(), 0);
      await recordCommission(tx, { tenantId: tenant.id, saleId: sale.id, userId: body.salespersonUserId ?? request.auth.userId, revenue: totals.subtotal - totals.discount, grossProfit: totals.subtotal - totals.discount - cogsTotal });

      await emitEvent(tx, {
        tenantId: tenant.id,
        eventType: 'sale.completed',
        aggregateType: 'Sale',
        aggregateId: sale.id,
        payload: {
          saleNumber: sale.number,
          locationId: sale.locationId,
          customerId: sale.customerId,
          subtotal: totals.subtotal,
          discount: totals.discount,
          tax: totals.tax,
          total: totals.total,
          cogs: cogsTotal,
          loyaltyPointsEarned
        }
      });
      await writeAudit(tx, {
        tenantId: tenant.id,
        actorUserId: request.auth.userId,
        action: 'sale.completed',
        resourceType: 'Sale',
        resourceId: sale.id,
        after: { number: sale.number, total: totals.total, payments: payments.length }
      });

      return { ...sale, lines: createdLines, payments };
    });
  });

  app.post('/v1/sales/:id/returns', { preHandler: requirePermission('sales.refund') }, async request => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const body = z.object({
      reason: z.string().min(3).max(500),
      lines: z.array(z.object({ saleLineId: z.string().min(1), quantity: z.coerce.number().positive(), restock: z.boolean().default(true), lotAllocations:z.array(z.object({lotId:z.string(),quantity:z.coerce.number().positive()})).default([]), serialNumberIds:z.array(z.string()).default([]) })).min(1),
      refunds: z.array(z.object({
        method: z.enum(['CASH', 'CARD', 'EXTERNAL_TERMINAL', 'BANK_TRANSFER', 'MOBILE_WALLET', 'STORE_CREDIT', 'GIFT_CARD', 'LOYALTY_POINTS', 'OTHER']),
        amount: z.coerce.number().positive(),
        provider: z.string().max(100).optional(),
        providerRef: z.string().max(200).optional()
      })).min(1)
    }).parse(request.body);

    return serializable(async tx => {
      const sale = await tx.sale.findFirst({
        where: { id, tenantId: request.auth.tenantId, status: { in: [SaleStatus.COMPLETED, SaleStatus.PARTIALLY_REFUNDED] } },
        include: { lines: { include: { productVariant: { include: { product: true } }, lotAllocations: true, serials: true } } }
      });
      if (!sale) throw notFound('Completed sale not found');
      assertLocationAccess(request, sale.locationId);
      const lineMap = new Map(sale.lines.map(line => [line.id, line]));
      const prepared = [];
      let refundTotal = new Prisma.Decimal(0);
      for (const input of body.lines) {
        const line = lineMap.get(input.saleLineId);
        if (!line) throw conflict('Return line does not belong to this sale');
        const prior = await tx.saleReturnLine.aggregate({
          where: { saleLineId: line.id, saleReturn: { status: 'COMPLETED' } },
          _sum: { quantity: true }
        });
        const alreadyReturned = prior._sum.quantity ?? new Prisma.Decimal(0);
        const qty = new Prisma.Decimal(input.quantity);
        if (alreadyReturned.plus(qty).gt(line.quantity)) throw conflict('Return quantity exceeds quantity originally sold');
        if (line.productVariant.product.productType === 'SERIALIZED') {
          if (!qty.isInteger() || input.serialNumberIds.length !== qty.toNumber()) throw conflict('Serialized returns require the returned serial numbers');
          const soldSerialIds = new Set(line.serials.map(s=>s.serialId));
          if (input.serialNumberIds.some(sid=>!soldSerialIds.has(sid))) throw conflict('Returned serial was not sold on this line');
          const priorSerials = await tx.saleReturnSerial.findMany({ where:{serialId:{in:input.serialNumberIds}} });
          if (priorSerials.length) throw conflict('One or more serial numbers were already returned');
        } else if (input.serialNumberIds.length) throw conflict('Serial numbers supplied for a non-serialized return');
        if (line.productVariant.product.productType === 'LOT_TRACKED' || line.productVariant.requiresExpiry) {
          const allocated=input.lotAllocations.reduce((a,l)=>a+l.quantity,0); if(Math.abs(allocated-qty.toNumber())>0.0001) throw conflict('Return lot allocation must equal return quantity');
          const soldLots=new Map(line.lotAllocations.map(a=>[a.lotId,a.quantity]));
          for(const allocation of input.lotAllocations){const sold=soldLots.get(allocation.lotId);if(!sold) throw conflict('Returned lot was not sold on this line');const priorLot=await tx.saleReturnLotAllocation.aggregate({where:{lotId:allocation.lotId,returnLine:{saleLineId:line.id}},_sum:{quantity:true}});if((priorLot._sum.quantity??new Prisma.Decimal(0)).plus(allocation.quantity).gt(sold)) throw conflict('Return quantity exceeds quantity sold from this lot');}
        } else if (input.lotAllocations.length) throw conflict('Lot allocations supplied for a non-lot return');
        const amount = line.lineTotal.div(line.quantity).mul(qty).toDecimalPlaces(2);
        refundTotal = refundTotal.plus(amount);
        prepared.push({ input, line, qty, amount });
      }
      const refundPaid = body.refunds.reduce((sum, refund) => sum.plus(refund.amount), new Prisma.Decimal(0));
      if (!refundPaid.equals(refundTotal)) throw conflict(`Refund payments must equal ${refundTotal.toFixed(2)}`);
      for (const refund of body.refunds) {
        if (!['CASH','STORE_CREDIT','GIFT_CARD','LOYALTY_POINTS'].includes(refund.method) && !refund.providerRef) throw conflict(`providerRef is required for ${refund.method} refunds`);
        if (refund.method === 'GIFT_CARD' && !refund.providerRef) throw conflict('providerRef must identify the gift card receiving the refund');
      }

      const saleReturn = await tx.saleReturn.create({
        data: { tenantId: request.auth.tenantId, saleId: sale.id, number: businessNumber('RET'), reason: body.reason, total: refundTotal, createdBy: request.auth.userId }
      });
      for (const row of prepared) {
        const returnLine = await tx.saleReturnLine.create({
          data: {
            saleReturnId: saleReturn.id,
            saleLineId: row.line.id,
            productVariantId: row.line.productVariantId,
            quantity: row.qty,
            refundAmount: row.amount,
            unitCostSnapshot: row.line.unitCostSnapshot,
            restocked: row.input.restock
          }
        });
        for (const allocation of row.input.lotAllocations) {
          await tx.saleReturnLotAllocation.create({data:{saleReturnLineId:returnLine.id,lotId:allocation.lotId,quantity:allocation.quantity}});
          if(row.input.restock){const lot=await tx.inventoryLot.findUnique({where:{id:allocation.lotId}});if(lot?.expiryDate&&lot.expiryDate<new Date()) throw conflict('Expired returned lot cannot be placed back into sellable stock');await tx.inventoryLot.update({where:{id:allocation.lotId},data:{quantityOnHand:{increment:allocation.quantity}}});}
        }
        for (const serialId of row.input.serialNumberIds) {
          await tx.saleReturnSerial.create({data:{saleReturnLineId:returnLine.id,serialId}});
          await tx.inventorySerial.update({where:{id:serialId},data:{status:row.input.restock?'AVAILABLE':'RETIRED',locationId:sale.locationId}});
        }
        if (row.input.restock) {
          await postInventoryMovement(tx, {
            tenantId: request.auth.tenantId,
            locationId: sale.locationId,
            productVariantId: row.line.productVariantId,
            movementType: InventoryMovementType.SALE_RETURN,
            quantity: row.qty,
            referenceType: 'SALE_RETURN',
            referenceId: saleReturn.id,
            reason: body.reason,
            performedBy: request.auth.userId
          });
          await tx.inventoryCostLayer.create({
            data: {
              tenantId: request.auth.tenantId,
              locationId: sale.locationId,
              productVariantId: row.line.productVariantId,
              sourceType: 'SALE_RETURN',
              sourceId: saleReturn.id,
              quantityReceived: row.qty,
              quantityRemaining: row.qty,
              unitCost: row.line.unitCostSnapshot,
              receivedAt: new Date()
            }
          });
        }
      }
      for (const refund of body.refunds) {
        let providerRef = refund.providerRef;
        if (['STORE_CREDIT','GIFT_CARD','LOYALTY_POINTS'].includes(refund.method)) {
          providerRef = await creditInternalTender(tx, {
            tenantId: request.auth.tenantId,
            customerId: sale.customerId ?? undefined,
            method: refund.method as 'STORE_CREDIT'|'GIFT_CARD'|'LOYALTY_POINTS',
            amount: refund.amount,
            accountId: refund.method === 'GIFT_CARD' ? refund.providerRef : undefined,
            referenceType: 'SALE_RETURN',
            referenceId: saleReturn.id,
            userId: request.auth.userId
          });
        }
        await tx.refund.create({
          data: {
            tenantId: request.auth.tenantId,
            saleReturnId: saleReturn.id,
            method: PaymentMethod[refund.method],
            amount: refund.amount,
            provider: refund.provider,
            providerRef
          }
        });
      }

      const allReturned = await Promise.all(sale.lines.map(async line => {
        const result = await tx.saleReturnLine.aggregate({ where: { saleLineId: line.id, saleReturn: { status: 'COMPLETED' } }, _sum: { quantity: true } });
        return (result._sum.quantity ?? new Prisma.Decimal(0)).gte(line.quantity);
      }));
      await tx.sale.update({ where: { id: sale.id }, data: { status: allReturned.every(Boolean) ? SaleStatus.REFUNDED : SaleStatus.PARTIALLY_REFUNDED } });
      await reverseCommissionForRefund(tx, { saleId: sale.id, refundAmount: refundTotal.toNumber(), saleTotal: sale.total.toNumber() });
      await emitEvent(tx, {
        tenantId: request.auth.tenantId,
        eventType: 'sale.refunded',
        aggregateType: 'SaleReturn',
        aggregateId: saleReturn.id,
        payload: { saleId: sale.id, saleNumber: sale.number, returnNumber: saleReturn.number, total: refundTotal.toString(), reason: body.reason }
      });
      await writeAudit(tx, {
        tenantId: request.auth.tenantId,
        actorUserId: request.auth.userId,
        action: 'sale.refunded',
        resourceType: 'SaleReturn',
        resourceId: saleReturn.id,
        after: { saleId: sale.id, total: refundTotal.toString(), reason: body.reason }
      });
      return tx.saleReturn.findUnique({ where: { id: saleReturn.id }, include: { lines: true, refunds: true } });
    });
  });

}
