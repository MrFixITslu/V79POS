import type { FastifyInstance } from 'fastify';
import { InventoryMovementType, StockTransferStatus, StockTransferPurpose, Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { serializable } from '../../lib/transactions.js';
import { businessNumber } from '../../lib/numbering.js';
import { conflict, forbidden, notFound } from '../../lib/errors.js';
import { emitEvent } from '../../lib/outbox.js';
import { writeAudit } from '../../lib/audit.js';
import { assertLocationAccess, hasPermission, requirePermission } from '../auth/context.js';
import { postInventoryMovement } from './service.js';
import { consumeFifoCost } from './costing.js';

const stockQty = z.coerce.number().finite().min(0.0001).max(1000000000)
  .refine(value => Number(value.toFixed(4)) === value, 'Use at most four decimal places');

const transferSchema = z.object({
  fromLocationId: z.string().min(1),
  toLocationId: z.string().min(1),
  notes: z.string().max(1000).optional(),
  lines: z.array(z.object({ productVariantId: z.string().min(1), quantity: stockQty, lotAllocations: z.array(z.object({lotId:z.string(),quantity:stockQty})).default([]), serialNumberIds:z.array(z.string()).default([]) })).min(1)
});

export async function transferRoutes(app: FastifyInstance) {
  app.get('/v1/transfers', { preHandler: requirePermission('inventory.read') }, async request => {
    const rows = await prisma.stockTransfer.findMany({
      where: { tenantId: request.auth.tenantId }, include: { fromLocation: true, toLocation: true, lines: { include: { productVariant: { include: { product: true } } } } }, orderBy: { createdAt: 'desc' }, take: 100
    });
    return { transfers: rows.filter(row => request.auth.allLocations || request.auth.locationIds.has(row.fromLocationId) || request.auth.locationIds.has(row.toLocationId)) };
  });

  app.post('/v1/transfers', { preHandler: requirePermission('inventory.transfer') }, async request => {
    const body = transferSchema.parse(request.body);
    if (body.fromLocationId === body.toLocationId) throw conflict('Transfer locations must be different');
    assertLocationAccess(request, body.fromLocationId);
    assertLocationAccess(request, body.toLocationId);
    if (new Set(body.lines.map(l=>l.productVariantId)).size !== body.lines.length) throw conflict('Duplicate product lines are not allowed in a transfer');
    const variants = await prisma.productVariant.findMany({ where: { tenantId: request.auth.tenantId, id: { in: body.lines.map(l => l.productVariantId) }, trackStock: true, active: true }, include: { product: true } });
    if (variants.length !== new Set(body.lines.map(l => l.productVariantId)).size) throw notFound('One or more transfer products were not found');
    return serializable(async tx => {
      const byId = new Map(variants.map(v=>[v.id,v]));
      for (const input of body.lines) {
        const variant=byId.get(input.productVariantId)!;
        if (variant.product.productType==='SERIALIZED') {
          if(!Number.isInteger(input.quantity)||input.serialNumberIds.length!==input.quantity||new Set(input.serialNumberIds).size!==input.serialNumberIds.length) throw conflict('Serialized transfer requires distinct serials for each unit');
          const serials=await tx.inventorySerial.findMany({where:{id:{in:input.serialNumberIds},tenantId:request.auth.tenantId,locationId:body.fromLocationId,productVariantId:variant.id,status:'AVAILABLE'}});
          if(serials.length!==input.serialNumberIds.length) throw conflict('One or more serials are not available at the source location');
        } else if(input.serialNumberIds.length) throw conflict('Serials supplied for a non-serialized product');
        if(variant.product.productType==='LOT_TRACKED'||variant.requiresExpiry){if(new Set(input.lotAllocations.map(a=>a.lotId)).size!==input.lotAllocations.length) throw conflict('Duplicate lot allocation');const sum=input.lotAllocations.reduce((a,l)=>a+l.quantity,0);if(Math.abs(sum-input.quantity)>0.0001) throw conflict('Transfer lot allocation must equal line quantity');for(const a of input.lotAllocations){const lot=await tx.inventoryLot.findFirst({where:{id:a.lotId,tenantId:request.auth.tenantId,locationId:body.fromLocationId,productVariantId:variant.id}});if(!lot||lot.quantityOnHand.lt(a.quantity)) throw conflict('Lot is unavailable or insufficient');}} else if(input.lotAllocations.length) throw conflict('Lots supplied for a non-lot product');
      }
      const transfer=await tx.stockTransfer.create({data:{tenantId:request.auth.tenantId,number:businessNumber('TRF'),fromLocationId:body.fromLocationId,toLocationId:body.toLocationId,notes:body.notes,createdBy:request.auth.userId,lines:{create:body.lines.map(line=>({productVariantId:line.productVariantId,quantity:line.quantity}))}},include:{lines:true}});
      const lineMap=new Map(transfer.lines.map(l=>[l.productVariantId,l]));
      for(const input of body.lines){const line=lineMap.get(input.productVariantId)!;if(input.lotAllocations.length) await tx.stockTransferLotAllocation.createMany({data:input.lotAllocations.map(a=>({stockTransferLineId:line.id,lotId:a.lotId,quantity:a.quantity}))});if(input.serialNumberIds.length) await tx.stockTransferSerialAllocation.createMany({data:input.serialNumberIds.map(serialId=>({stockTransferLineId:line.id,serialId}))});}
      return tx.stockTransfer.findUnique({where:{id:transfer.id},include:{lines:{include:{lotAllocations:true,serialAllocations:true}}}});
    });
  });

  // Warehouse-controlled allocations for individually traceable technician issues.
  // Allocation is always performed against the warehouse source, never client-assigned custody.
  app.post('/v1/transfers/:id/allocate', { preHandler: requirePermission('inventory.transfer') }, async request => {
    const { id } = z.object({ id: z.string().min(1) }).parse(request.params);
    const body = z.object({
      serialNumberIds: z.array(z.string().min(1)).max(100).default([]),
      lotAllocations: z.array(z.object({ lotId: z.string().min(1),
        quantity: stockQty })).max(100).default([])
    }).parse(request.body);
    return serializable(async tx => {
      const transfer = await tx.stockTransfer.findFirst({
        where: { id, tenantId: request.auth.tenantId },
        include: { lines: { include: { productVariant: { include: { product: true } } } } }
      });
      if (!transfer) throw notFound('Transfer not found');
      assertLocationAccess(request, transfer.fromLocationId);
      if (transfer.purpose !== StockTransferPurpose.TECHNICIAN_ISSUE ||
          !['REQUESTED','APPROVED'].includes(transfer.status)) {
        throw conflict('Only pending technician issue requests can be allocated');
      }
      if (transfer.lines.length !== 1) throw conflict('Technician issue must contain exactly one stock item');
      const line = transfer.lines[0];
      const product = line.productVariant;
      if (product.product.productType === 'SERIALIZED') {
        if (!Number.isInteger(Number(line.quantity)) ||
            body.serialNumberIds.length !== Number(line.quantity) ||
            new Set(body.serialNumberIds).size !== body.serialNumberIds.length) {
          throw conflict('One distinct serial number is required for each issued unit');
        }
        if (body.lotAllocations.length) throw conflict('Serialised stock cannot have lot allocations');
        const serials = await tx.inventorySerial.findMany({
          where: { id: { in: body.serialNumberIds }, tenantId: request.auth.tenantId,
            locationId: transfer.fromLocationId, productVariantId: line.productVariantId,
            status: 'AVAILABLE' }
        });
        if (serials.length !== body.serialNumberIds.length) throw conflict('Requested serials are unavailable');
      } else if (product.product.productType === 'LOT_TRACKED' || product.requiresExpiry) {
        if (body.serialNumberIds.length) throw conflict('Lot stock cannot have serial allocations');
        if (new Set(body.lotAllocations.map(a => a.lotId)).size !== body.lotAllocations.length ||
            !body.lotAllocations.reduce((sum,a) => sum.plus(a.quantity), new Prisma.Decimal(0))
              .equals(line.quantity)) {
          throw conflict('Lot allocations must total the exact issued quantity');
        }
        for (const a of body.lotAllocations) {
          const lot = await tx.inventoryLot.findFirst({ where: {
            id: a.lotId, tenantId: request.auth.tenantId, locationId: transfer.fromLocationId,
            productVariantId: line.productVariantId
          } });
          if (!lot || lot.quantityOnHand.lt(a.quantity)) throw conflict('Selected lot is unavailable or insufficient');
        }
      } else if (body.serialNumberIds.length || body.lotAllocations.length) {
        throw conflict('This item does not require serial or lot allocation');
      }
      await tx.stockTransferSerialAllocation.deleteMany({ where: { stockTransferLineId: line.id } });
      await tx.stockTransferLotAllocation.deleteMany({ where: { stockTransferLineId: line.id } });
      if (body.serialNumberIds.length) await tx.stockTransferSerialAllocation.createMany({
        data: body.serialNumberIds.map(serialId => ({ stockTransferLineId: line.id, serialId }))
      });
      if (body.lotAllocations.length) await tx.stockTransferLotAllocation.createMany({
        data: body.lotAllocations.map(a => ({ stockTransferLineId: line.id, lotId: a.lotId, quantity: a.quantity }))
      });
      await writeAudit(tx, {
        tenantId: request.auth.tenantId, actorUserId: request.auth.userId,
        action: 'technician.issue_allocated', resourceType: 'StockTransfer', resourceId: transfer.id,
        after: { allocatedSerialCount: body.serialNumberIds.length,
          allocatedLotCount: body.lotAllocations.length, sourceLocationId: transfer.fromLocationId }
      });
      return { transferId: transfer.id, allocatedSerials: body.serialNumberIds.length,
        allocatedLots: body.lotAllocations.length, status: transfer.status };
    });
  });

  app.post('/v1/transfers/:id/approve', { preHandler: requirePermission('inventory.transfer') }, async request => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const transfer = await prisma.stockTransfer.findFirst({ where: { id, tenantId: request.auth.tenantId } });
    if (!transfer) throw notFound('Transfer not found');
    if (transfer.purpose === StockTransferPurpose.TECHNICIAN_RETURN_GOOD ||
        transfer.purpose === StockTransferPurpose.TECHNICIAN_RETURN_FAULTY) {
      assertLocationAccess(request, transfer.toLocationId);
    } else {
      assertLocationAccess(request, transfer.fromLocationId);
      if (transfer.purpose === StockTransferPurpose.GENERAL) assertLocationAccess(request, transfer.toLocationId);
    }
    if (transfer.status !== StockTransferStatus.REQUESTED) throw conflict('Transfer is not awaiting approval');
    // The status predicate also rejects simultaneous approvals and stale page actions.
    const changed = await prisma.stockTransfer.updateMany({
      where: { id, tenantId: request.auth.tenantId, status: StockTransferStatus.REQUESTED },
      data: { status: StockTransferStatus.APPROVED, approvedBy: request.auth.userId }
    });
    if (changed.count !== 1) throw conflict('Transfer was already processed');
    return prisma.stockTransfer.findUnique({ where: { id } });
  });

  app.post('/v1/transfers/:id/dispatch', { preHandler: requirePermission('inventory.transfer') }, async request => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    return serializable(async tx => {
      const transfer = await tx.stockTransfer.findFirst({ where: { id, tenantId: request.auth.tenantId }, include: { lines: { include: { productVariant: { include: { product: true } }, lotAllocations: { include: { lot: true } }, serialAllocations: true } } } });
      if (!transfer) throw notFound('Transfer not found');
      if (transfer.purpose === StockTransferPurpose.TECHNICIAN_RETURN_GOOD ||
          transfer.purpose === StockTransferPurpose.TECHNICIAN_RETURN_FAULTY) {
        assertLocationAccess(request, transfer.toLocationId);
      } else assertLocationAccess(request, transfer.fromLocationId);
      if (transfer.status !== StockTransferStatus.APPROVED) throw conflict('Transfer must be approved before dispatch');
      for (const line of transfer.lines) {
        if (line.productVariant.product.productType === 'SERIALIZED' &&
            (line.serialAllocations.length !== Number(line.quantity) ||
              new Set(line.serialAllocations.map(a => a.serialId)).size !== line.serialAllocations.length)) {
          throw conflict('Transfer serial allocation must match line quantity');
        }
        if (line.productVariant.product.productType === 'LOT_TRACKED' || line.productVariant.requiresExpiry) {
          const total = line.lotAllocations.reduce((v, a) => v.plus(a.quantity), new Prisma.Decimal(0));
          if (!total.equals(line.quantity) ||
              new Set(line.lotAllocations.map(a => a.lotId)).size !== line.lotAllocations.length) {
            throw conflict('Transfer lot allocation must match line quantity');
          }
        }
        for (const allocation of line.lotAllocations) {
          const changed = await tx.inventoryLot.updateMany({
            where: { id: allocation.lotId, tenantId: request.auth.tenantId,
              locationId: transfer.fromLocationId, productVariantId: line.productVariantId,
              quantityOnHand: { gte: allocation.quantity } },
            data: { quantityOnHand: { decrement: allocation.quantity } }
          });
          if (changed.count !== 1) throw conflict('Lot was already moved or is insufficient');
        }
        for (const allocation of line.serialAllocations) {
          const changed = await tx.inventorySerial.updateMany({
            where: { id: allocation.serialId, tenantId: request.auth.tenantId,
              locationId: transfer.fromLocationId, productVariantId: line.productVariantId, status: 'AVAILABLE' },
            data: { status: 'IN_TRANSIT' }
          });
          if (changed.count !== 1) throw conflict('Serial was already moved or is unavailable');
        }
        await postInventoryMovement(tx, {
          tenantId: request.auth.tenantId,
          locationId: transfer.fromLocationId,
          productVariantId: line.productVariantId,
          movementType: InventoryMovementType.TRANSFER_OUT,
          quantity: line.quantity,
          referenceType: 'STOCK_TRANSFER',
          referenceId: transfer.id,
          performedBy: request.auth.userId
        });
        const cost = await consumeFifoCost(tx, {
          tenantId: request.auth.tenantId,
          locationId: transfer.fromLocationId,
          productVariantId: line.productVariantId,
          quantity: line.quantity,
          fallbackUnitCost: line.productVariant.baseCost
        });
        await tx.stockTransferLine.update({ where: { id: line.id }, data: { unitCostSnapshot: cost } });
      }
      const updated = await tx.stockTransfer.update({ where: { id: transfer.id }, data: { status: StockTransferStatus.IN_TRANSIT, dispatchedBy: request.auth.userId, dispatchedAt: new Date() } });
      await writeAudit(tx, { tenantId: request.auth.tenantId, actorUserId: request.auth.userId, action: 'inventory.transfer_dispatched', resourceType: 'StockTransfer', resourceId: transfer.id });
      return updated;
    });
  });

  app.post('/v1/transfers/:id/receive', async request => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    return serializable(async tx => {
      const transfer = await tx.stockTransfer.findFirst({ where: { id, tenantId: request.auth.tenantId }, include: { lines: { include: { lotAllocations: { include: { lot: true } }, serialAllocations: { include: { serial: true } } } } } });
      if (!transfer) throw notFound('Transfer not found');
      const isCustodian = hasPermission(request.auth, 'inventory.technician') &&
        !!(await tx.location.findFirst({ where: { id: transfer.toLocationId, tenantId: request.auth.tenantId,
          custodianUserId: request.auth.userId, active: true, type: 'MOBILE' } })) &&
        request.auth.locationIds.has(transfer.toLocationId);
      const isWarehouseReceiver = hasPermission(request.auth, 'inventory.transfer') &&
        (request.auth.allLocations || request.auth.locationIds.has(transfer.toLocationId));
      if (!isCustodian && !isWarehouseReceiver) throw forbidden('Only the receiving location can confirm stock');
      if (transfer.status !== StockTransferStatus.IN_TRANSIT) throw conflict('Only in-transit stock can be received');
      for (const line of transfer.lines) {
        if (line.unitCostSnapshot == null) throw conflict('Transfer cost snapshot is missing');
        await postInventoryMovement(tx, {
          tenantId: request.auth.tenantId,
          locationId: transfer.toLocationId,
          productVariantId: line.productVariantId,
          movementType: InventoryMovementType.TRANSFER_IN,
          quantity: line.quantity,
          referenceType: 'STOCK_TRANSFER',
          referenceId: transfer.id,
          performedBy: request.auth.userId
        });
        for (const allocation of line.lotAllocations) {
          await tx.inventoryLot.upsert({ where:{tenantId_locationId_productVariantId_lotNumber:{tenantId:request.auth.tenantId,locationId:transfer.toLocationId,productVariantId:line.productVariantId,lotNumber:allocation.lot.lotNumber}}, create:{tenantId:request.auth.tenantId,locationId:transfer.toLocationId,productVariantId:line.productVariantId,lotNumber:allocation.lot.lotNumber,expiryDate:allocation.lot.expiryDate,quantityOnHand:allocation.quantity}, update:{quantityOnHand:{increment:allocation.quantity},expiryDate:allocation.lot.expiryDate} });
        }
        const faulty = transfer.purpose === StockTransferPurpose.TECHNICIAN_RETURN_FAULTY;
        for (const allocation of line.serialAllocations) {
          const changed = await tx.inventorySerial.updateMany({
            where: { id: allocation.serialId, tenantId: request.auth.tenantId,
              locationId: transfer.fromLocationId, status: 'IN_TRANSIT', productVariantId: line.productVariantId },
            data: { locationId: transfer.toLocationId, status: faulty ? 'DAMAGED' : 'AVAILABLE' }
          });
          if (changed.count !== 1) throw conflict('Serial was not in transit for this transfer');
        }
        if (faulty) {
          await postInventoryMovement(tx, {
            tenantId: request.auth.tenantId, locationId: transfer.toLocationId,
            productVariantId: line.productVariantId, movementType: InventoryMovementType.QUARANTINE_IN,
            quantity: line.quantity, referenceType: 'FAULTY_TECHNICIAN_RETURN',
            referenceId: transfer.id, performedBy: request.auth.userId,
            reason: transfer.notes ?? 'Faulty hardware returned by technician'
          });
        }
        await tx.inventoryCostLayer.create({
          data: {
            tenantId: request.auth.tenantId,
            locationId: transfer.toLocationId,
            productVariantId: line.productVariantId,
            sourceType: 'STOCK_TRANSFER',
            sourceId: transfer.id,
            quantityReceived: line.quantity,
            quantityRemaining: line.quantity,
            unitCost: line.unitCostSnapshot,
            receivedAt: new Date()
          }
        });
      }
      const updated = await tx.stockTransfer.update({ where: { id: transfer.id }, data: { status: StockTransferStatus.RECEIVED, receivedBy: request.auth.userId, receivedAt: new Date() } });
      await emitEvent(tx, { tenantId: request.auth.tenantId, eventType: 'inventory.transferred', aggregateType: 'StockTransfer', aggregateId: transfer.id, payload: { number: transfer.number, fromLocationId: transfer.fromLocationId, toLocationId: transfer.toLocationId } });
      await writeAudit(tx, { tenantId: request.auth.tenantId, actorUserId: request.auth.userId, action: 'inventory.transfer_received', resourceType: 'StockTransfer', resourceId: transfer.id });
      return updated;
    });
  });
}
