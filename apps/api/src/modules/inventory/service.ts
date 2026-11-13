import { InventoryMovementType, Prisma } from '@prisma/client';
import { conflict, notFound } from '../../lib/errors.js';

const D = (value: Prisma.Decimal.Value) => new Prisma.Decimal(value);

export function availableFromBalance(balance: {
  onHand: Prisma.Decimal;
  reserved: Prisma.Decimal;
  committed: Prisma.Decimal;
  quarantined: Prisma.Decimal;
  damaged: Prisma.Decimal;
  expired: Prisma.Decimal;
}) {
  return balance.onHand
    .minus(balance.reserved)
    .minus(balance.committed)
    .minus(balance.quarantined)
    .minus(balance.damaged)
    .minus(balance.expired);
}

type MovementInput = {
  tenantId: string;
  locationId: string;
  productVariantId: string;
  movementType: InventoryMovementType;
  quantity: Prisma.Decimal.Value;
  referenceType: string;
  referenceId: string;
  reason?: string;
  performedBy?: string;
  deviceId?: string;
  metadata?: Prisma.InputJsonValue;
  allowNegative?: boolean;
};

function ledgerDelta(type: InventoryMovementType, qty: Prisma.Decimal) {
  switch (type) {
    case InventoryMovementType.PURCHASE_RECEIPT:
    case InventoryMovementType.SALE_RETURN:
    case InventoryMovementType.TRANSFER_IN:
    case InventoryMovementType.ADJUSTMENT_GAIN:
    case InventoryMovementType.QUARANTINE_RELEASE:
    case InventoryMovementType.RESERVATION_RELEASE:
      return qty;
    default:
      return qty.negated();
  }
}

function balanceChange(type: InventoryMovementType, qty: Prisma.Decimal) {
  const zero = D(0);
  const result = { onHand: zero, reserved: zero, committed: zero, quarantined: zero, damaged: zero, expired: zero };
  switch (type) {
    case InventoryMovementType.PURCHASE_RECEIPT:
    case InventoryMovementType.SALE_RETURN:
    case InventoryMovementType.TRANSFER_IN:
    case InventoryMovementType.ADJUSTMENT_GAIN:
      result.onHand = qty;
      break;
    case InventoryMovementType.SALE:
    case InventoryMovementType.TRANSFER_OUT:
    case InventoryMovementType.TECHNICIAN_USE:
    case InventoryMovementType.ADJUSTMENT_LOSS:
      result.onHand = qty.negated();
      break;
    case InventoryMovementType.DAMAGE:
      result.damaged = qty;
      break;
    case InventoryMovementType.EXPIRY:
      result.expired = qty;
      break;
    case InventoryMovementType.QUARANTINE_IN:
      result.quarantined = qty;
      break;
    case InventoryMovementType.QUARANTINE_RELEASE:
      result.quarantined = qty.negated();
      break;
    case InventoryMovementType.RESERVATION:
      result.reserved = qty;
      break;
    case InventoryMovementType.RESERVATION_RELEASE:
      result.reserved = qty.negated();
      break;
  }
  return result;
}

function requiresSellable(type: InventoryMovementType) {
  const sellableMovements: InventoryMovementType[] = [
    InventoryMovementType.SALE,
    InventoryMovementType.TECHNICIAN_USE,
    InventoryMovementType.TRANSFER_OUT,
    InventoryMovementType.ADJUSTMENT_LOSS,
    InventoryMovementType.DAMAGE,
    InventoryMovementType.EXPIRY,
    InventoryMovementType.QUARANTINE_IN,
    InventoryMovementType.RESERVATION
  ];
  return sellableMovements.includes(type);
}

export async function postInventoryMovement(tx: Prisma.TransactionClient, input: MovementInput) {
  const qty = D(input.quantity);
  if (qty.lte(0)) throw conflict('Inventory movement quantity must be greater than zero');

  const [location, variant, balance] = await Promise.all([
    tx.location.findFirst({ where: { id: input.locationId, tenantId: input.tenantId, active: true } }),
    tx.productVariant.findFirst({
      where: { id: input.productVariantId, tenantId: input.tenantId, active: true, product: { active: true } },
      include: { product: { select: { productType: true } } }
    }),
    tx.inventoryBalance.findUnique({
      where: {
        tenantId_locationId_productVariantId: {
          tenantId: input.tenantId,
          locationId: input.locationId,
          productVariantId: input.productVariantId
        }
      }
    })
  ]);

  if (!location) throw notFound('Location not found');
  if (!variant) throw notFound('Product variant not found');
  if (!variant.trackStock) throw conflict('This product is not stock tracked');

  if (requiresSellable(input.movementType)) {
    const available = balance ? availableFromBalance(balance) : D(0);
    if (available.lt(qty) && !input.allowNegative) {
      throw conflict(`Insufficient available stock. Available ${available.toString()}, requested ${qty.toString()}`);
    }
  }
  if (input.movementType === InventoryMovementType.RESERVATION_RELEASE && (!balance || balance.reserved.lt(qty))) {
    throw conflict('Cannot release more stock than is reserved');
  }
  if (input.movementType === InventoryMovementType.QUARANTINE_RELEASE && (!balance || balance.quarantined.lt(qty))) {
    throw conflict('Cannot release more stock than is quarantined');
  }

  const change = balanceChange(input.movementType, qty);
  const createData = {
    tenantId: input.tenantId,
    locationId: input.locationId,
    productVariantId: input.productVariantId,
    onHand: change.onHand,
    reserved: change.reserved,
    committed: change.committed,
    quarantined: change.quarantined,
    damaged: change.damaged,
    expired: change.expired
  };

  await tx.inventoryBalance.upsert({
    where: {
      tenantId_locationId_productVariantId: {
        tenantId: input.tenantId,
        locationId: input.locationId,
        productVariantId: input.productVariantId
      }
    },
    create: createData,
    update: {
      onHand: { increment: change.onHand },
      reserved: { increment: change.reserved },
      committed: { increment: change.committed },
      quarantined: { increment: change.quarantined },
      damaged: { increment: change.damaged },
      expired: { increment: change.expired }
    }
  });

  return tx.inventoryLedger.create({
    data: {
      tenantId: input.tenantId,
      locationId: input.locationId,
      productVariantId: input.productVariantId,
      movementType: input.movementType,
      deltaQty: ledgerDelta(input.movementType, qty),
      referenceType: input.referenceType,
      referenceId: input.referenceId,
      reason: input.reason,
      performedBy: input.performedBy,
      deviceId: input.deviceId,
      metadata: input.metadata
    }
  });
}
