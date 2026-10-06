import type { FastifyInstance } from 'fastify';
import { CommerceOrderStatus, CommerceOrderType, InventoryMovementType, PaymentMethod, PaymentStatus, Prisma, SaleStatus } from '@prisma/client';
import { calculateSale } from '@v79/commerce-domain';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { serializable } from '../../lib/transactions.js';
import { businessNumber } from '../../lib/numbering.js';
import { conflict, notFound } from '../../lib/errors.js';
import { assertLocationAccess, requirePermission } from '../auth/context.js';
import { postInventoryMovement } from '../inventory/service.js';
import { consumeFifoCost } from '../inventory/costing.js';
import { debitInternalTender } from '../value/service.js';
import { promotionDiscount, resolvePromotions, resolveUnitPrices } from '../pricing/service.js';
import { emitEvent } from '../../lib/outbox.js';
import { recordCommission } from '../team/commission.js';

const paymentMethods = ['CASH','CARD','EXTERNAL_TERMINAL','BANK_TRANSFER','MOBILE_WALLET','STORE_CREDIT','GIFT_CARD','LOYALTY_POINTS','OTHER'] as const;

async function releaseReservations(tx: Prisma.TransactionClient, order: { id:string; tenantId:string; locationId:string; lines:{productVariantId:string; reservedQty:Prisma.Decimal}[] }, userId:string) {
  for (const line of order.lines) if (line.reservedQty.gt(0)) {
    await postInventoryMovement(tx,{ tenantId:order.tenantId,locationId:order.locationId,productVariantId:line.productVariantId,movementType:InventoryMovementType.RESERVATION_RELEASE,quantity:line.reservedQty,referenceType:'COMMERCE_ORDER',referenceId:order.id,performedBy:userId });
  }
  await tx.inventoryReservation.updateMany({ where:{tenantId:order.tenantId,referenceType:'COMMERCE_ORDER',referenceId:order.id,status:'ACTIVE'}, data:{status:'RELEASED'} });
}

export async function orderRoutes(app: FastifyInstance) {
  app.get('/v1/orders', { preHandler: requirePermission('orders.read') }, async request => {
    const q=z.object({status:z.enum(['DRAFT','SENT','ACCEPTED','PARTIALLY_PAID','PAID','FULFILLING','COMPLETED','CANCELLED','EXPIRED']).optional(),limit:z.coerce.number().int().min(1).max(200).default(50)}).parse(request.query);
    return {orders:await prisma.commerceOrder.findMany({where:{tenantId:request.auth.tenantId,status:q.status as CommerceOrderStatus|undefined,...(request.auth.allLocations?{}:{locationId:{in:[...request.auth.locationIds]}})},include:{customer:true,lines:true,payments:true},orderBy:{createdAt:'desc'},take:q.limit})};
  });

  app.post('/v1/orders', { preHandler: requirePermission('orders.write') }, async request => {
    const body=z.object({locationId:z.string(),customerId:z.string().optional(),type:z.enum(['QUOTE','ORDER','LAYAWAY','INVOICE']),depositRequired:z.coerce.number().nonnegative().optional(),promotionCode:z.string().min(2).max(50).optional(),validUntil:z.coerce.date().optional(),dueAt:z.coerce.date().optional(),notes:z.string().max(2000).optional(),lines:z.array(z.object({productVariantId:z.string(),quantity:z.coerce.number().positive(),discount:z.coerce.number().nonnegative().default(0)})).min(1)}).parse(request.body);
    assertLocationAccess(request,body.locationId);
    return serializable(async tx=>{
      const tenant=await tx.tenant.findUnique({where:{id:request.auth.tenantId}}); if(!tenant) throw notFound('Tenant not found');
      if(body.customerId && !await tx.customer.findFirst({where:{id:body.customerId,tenantId:tenant.id}})) throw notFound('Customer not found');
      const ids=[...new Set(body.lines.map(l=>l.productVariantId))];
      const variants=await tx.productVariant.findMany({where:{id:{in:ids},tenantId:tenant.id,active:true,product:{active:true}},include:{product:true}}); if(variants.length!==ids.length) throw notFound('One or more products not found');
      const byId=new Map(variants.map(v=>[v.id,v]));
      const [customerPrices,promotions]=await Promise.all([
        resolveUnitPrices(tx,{tenantId:tenant.id,customerId:body.customerId,variantIds:ids}),
        resolvePromotions(tx,{tenantId:tenant.id,variantIds:ids,promotionCode:body.promotionCode})
      ]);
      if(body.promotionCode&&promotions.length===0) throw conflict('Promotion code is invalid or inactive');
      const baseSubtotal=body.lines.reduce((sum,l)=>{const v=byId.get(l.productVariantId)!;const unitPrice=customerPrices.get(v.id)??v.sellPrice.toNumber();return sum+unitPrice*l.quantity;},0);
      const eligiblePromotions=promotions.filter(p=>!p.minimumSubtotal||baseSubtotal>=p.minimumSubtotal.toNumber());
      const pricing=body.lines.map(l=>{const v=byId.get(l.productVariantId)!;const unitPrice=customerPrices.get(v.id)??v.sellPrice.toNumber();let automaticDiscount=0;for(const promotion of eligiblePromotions){automaticDiscount=Math.max(automaticDiscount,promotionDiscount({promotion:promotion as any,variantId:v.id,quantity:l.quantity,unitPrice}));}return {quantity:l.quantity,unitPrice,discount:Math.min(l.quantity*unitPrice,l.discount+automaticDiscount),taxRate:v.taxRate.toNumber()};});
      const totals=calculateSale(pricing);
      const prefix=body.type==='QUOTE'?'QTE':body.type==='INVOICE'?'INV':body.type==='LAYAWAY'?'LAY':'ORD';
      const order=await tx.commerceOrder.create({data:{tenantId:tenant.id,locationId:body.locationId,customerId:body.customerId,number:businessNumber(prefix),type:CommerceOrderType[body.type],currency:tenant.currency,subtotal:totals.subtotal,discount:totals.discount,tax:totals.tax,total:totals.total,depositRequired:body.depositRequired,validUntil:body.validUntil,dueAt:body.dueAt,notes:body.notes,createdBy:request.auth.userId}});
      for(let i=0;i<body.lines.length;i++){const input=body.lines[i],v=byId.get(input.productVariantId)!,calc=totals.lines[i]; await tx.commerceOrderLine.create({data:{commerceOrderId:order.id,productVariantId:v.id,sku:v.sku,description:`${v.product.name} — ${v.name}`,quantity:input.quantity,unitPrice:pricing[i].unitPrice,discount:calc.discount,taxRate:v.taxRate,taxAmount:calc.tax,lineTotal:calc.total}});}
      return tx.commerceOrder.findUnique({where:{id:order.id},include:{lines:true,payments:true}});
    });
  });

  app.post('/v1/orders/:id/send', { preHandler: requirePermission('orders.write') }, async request=>{
    const {id}=z.object({id:z.string()}).parse(request.params); const order=await prisma.commerceOrder.findFirst({where:{id,tenantId:request.auth.tenantId,status:'DRAFT'}}); if(!order) throw notFound('Draft order not found'); assertLocationAccess(request,order.locationId);
    return prisma.commerceOrder.update({where:{id},data:{status:CommerceOrderStatus.SENT}});
  });

  app.post('/v1/orders/:id/accept', { preHandler: requirePermission('orders.write') }, async request=>{
    const {id}=z.object({id:z.string()}).parse(request.params);
    return serializable(async tx=>{
      const order=await tx.commerceOrder.findFirst({where:{id,tenantId:request.auth.tenantId,status:{in:[CommerceOrderStatus.DRAFT,CommerceOrderStatus.SENT]}},include:{lines:{include:{productVariant:true}}}}); if(!order) throw notFound('Order not found'); assertLocationAccess(request,order.locationId);
      for(const line of order.lines) if(line.productVariant.trackStock){ await postInventoryMovement(tx,{tenantId:order.tenantId,locationId:order.locationId,productVariantId:line.productVariantId,movementType:InventoryMovementType.RESERVATION,quantity:line.quantity,referenceType:'COMMERCE_ORDER',referenceId:order.id,performedBy:request.auth.userId}); await tx.inventoryReservation.create({data:{tenantId:order.tenantId,locationId:order.locationId,productVariantId:line.productVariantId,referenceType:'COMMERCE_ORDER',referenceId:order.id,quantity:line.quantity}}); await tx.commerceOrderLine.update({where:{id:line.id},data:{reservedQty:line.quantity}}); }
      return tx.commerceOrder.update({where:{id},data:{status:CommerceOrderStatus.ACCEPTED,acceptedAt:new Date()}});
    });
  });

  app.post('/v1/orders/:id/payments', { preHandler: requirePermission('orders.write') }, async request=>{
    const {id}=z.object({id:z.string()}).parse(request.params);
    const body=z.object({registerSessionId:z.string().optional(),method:z.enum(paymentMethods),amount:z.coerce.number().positive(),provider:z.string().max(100).optional(),providerRef:z.string().max(200).optional(),paymentIntentId:z.string().optional(),accountCode:z.string().max(100).optional()}).parse(request.body);
    return serializable(async tx=>{
      const order=await tx.commerceOrder.findFirst({where:{id,tenantId:request.auth.tenantId,status:{notIn:[CommerceOrderStatus.CANCELLED,CommerceOrderStatus.EXPIRED,CommerceOrderStatus.COMPLETED]}}}); if(!order) throw notFound('Open order not found'); assertLocationAccess(request,order.locationId);
      if(order.amountPaid.plus(body.amount).gt(order.total)) throw conflict('Payment exceeds outstanding balance');
      if(body.registerSessionId){const session=await tx.registerSession.findFirst({where:{id:body.registerSessionId,tenantId:order.tenantId,locationId:order.locationId,status:'OPEN'}});if(!session) throw conflict('Register session is not open');}
      let providerRef=body.providerRef;
      let paymentIntentId:string|undefined;
      if(['STORE_CREDIT','GIFT_CARD','LOYALTY_POINTS'].includes(body.method)) providerRef=await debitInternalTender(tx,{tenantId:order.tenantId,customerId:order.customerId??undefined,method:body.method as any,amount:body.amount,accountCode:body.accountCode,referenceType:'COMMERCE_ORDER',referenceId:order.id,userId:request.auth.userId});
      else if(body.method==='CARD'){
        if(!body.paymentIntentId) throw conflict('CARD payments require a succeeded payment intent');
        const intent=await tx.paymentIntent.findFirst({where:{id:body.paymentIntentId,tenantId:order.tenantId,status:'SUCCEEDED',paymentId:null}});
        if(!intent||intent.amount.toNumber()!==body.amount||intent.currency!==order.currency) throw conflict('Payment intent is missing, already used, or does not match this order payment');
        paymentIntentId=intent.id;
        providerRef=intent.providerRef ?? undefined;
      } else if(body.method!=='CASH'&&!providerRef) throw conflict('External payment requires providerRef');
      const payment=await tx.payment.create({data:{tenantId:order.tenantId,commerceOrderId:order.id,registerSessionId:body.registerSessionId,method:PaymentMethod[body.method],status:PaymentStatus.COMPLETED,amount:body.amount,provider:body.provider,providerRef}});
      if(paymentIntentId) await tx.paymentIntent.update({where:{id:paymentIntentId},data:{paymentId:payment.id}});
      const paid=order.amountPaid.plus(body.amount), status=paid.gte(order.total)?CommerceOrderStatus.PAID:CommerceOrderStatus.PARTIALLY_PAID;
      return tx.commerceOrder.update({where:{id},data:{amountPaid:paid,status}});
    });
  });

  app.post('/v1/orders/:id/complete', { preHandler: requirePermission('orders.write') }, async request=>{
    const {id}=z.object({id:z.string()}).parse(request.params);
    return serializable(async tx=>{
      const order=await tx.commerceOrder.findFirst({where:{id,tenantId:request.auth.tenantId,status:{in:[CommerceOrderStatus.ACCEPTED,CommerceOrderStatus.PARTIALLY_PAID,CommerceOrderStatus.PAID,CommerceOrderStatus.FULFILLING]}},include:{lines:{include:{productVariant:true}},payments:true}}); if(!order) throw notFound('Completable order not found'); assertLocationAccess(request,order.locationId);
      if(order.type===CommerceOrderType.LAYAWAY && order.amountPaid.lt(order.total)) throw conflict('Layaway must be paid in full before completion');
      await releaseReservations(tx,order,request.auth.userId);
      const sale=await tx.sale.create({data:{tenantId:order.tenantId,locationId:order.locationId,customerId:order.customerId,number:businessNumber('SALE'),status:SaleStatus.COMPLETED,currency:order.currency,subtotal:order.subtotal,discount:order.discount,tax:order.tax,total:order.total,amountPaid:order.amountPaid,changeDue:0,createdBy:request.auth.userId,completedAt:new Date()}});
      for(const line of order.lines){let cost=line.productVariant.baseCost;if(line.productVariant.trackStock){await postInventoryMovement(tx,{tenantId:order.tenantId,locationId:order.locationId,productVariantId:line.productVariantId,movementType:InventoryMovementType.SALE,quantity:line.quantity,referenceType:'SALE',referenceId:sale.id,performedBy:request.auth.userId});cost=await consumeFifoCost(tx,{tenantId:order.tenantId,locationId:order.locationId,productVariantId:line.productVariantId,quantity:line.quantity,fallbackUnitCost:line.productVariant.baseCost});} await tx.saleLine.create({data:{saleId:sale.id,productVariantId:line.productVariantId,sku:line.sku,description:line.description,quantity:line.quantity,unitPrice:line.unitPrice,discount:line.discount,taxRate:line.taxRate,taxAmount:line.taxAmount,lineTotal:line.lineTotal,unitCostSnapshot:cost}});}
      const saleLines=await tx.saleLine.findMany({where:{saleId:sale.id}});const cogs=saleLines.reduce((a,l)=>a+l.unitCostSnapshot.toNumber()*l.quantity.toNumber(),0);await recordCommission(tx,{tenantId:order.tenantId,saleId:sale.id,userId:request.auth.userId,revenue:order.subtotal.minus(order.discount).toNumber(),grossProfit:order.subtotal.minus(order.discount).toNumber()-cogs});
      await tx.payment.updateMany({where:{commerceOrderId:order.id},data:{saleId:sale.id,commerceOrderId:null}});
      await tx.commerceOrder.update({where:{id},data:{status:CommerceOrderStatus.COMPLETED,completedAt:new Date()}});
      await emitEvent(tx,{tenantId:order.tenantId,eventType:'order.completed',aggregateType:'CommerceOrder',aggregateId:order.id,payload:{orderNumber:order.number,saleId:sale.id,saleNumber:sale.number,total:order.total.toString()}});
      return sale;
    });
  });

  app.post('/v1/orders/:id/cancel', { preHandler: requirePermission('orders.write') }, async request=>{
    const {id}=z.object({id:z.string()}).parse(request.params);
    return serializable(async tx=>{const order=await tx.commerceOrder.findFirst({where:{id,tenantId:request.auth.tenantId,status:{notIn:[CommerceOrderStatus.CANCELLED,CommerceOrderStatus.COMPLETED]}},include:{lines:true}});if(!order) throw notFound('Order not found');assertLocationAccess(request,order.locationId);if(order.amountPaid.gt(0)) throw conflict('Paid orders require refund before cancellation');await releaseReservations(tx,order,request.auth.userId);return tx.commerceOrder.update({where:{id},data:{status:CommerceOrderStatus.CANCELLED}});});
  });
}
