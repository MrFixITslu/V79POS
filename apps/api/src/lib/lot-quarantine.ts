import type { Prisma } from '@prisma/client';
import { conflict } from './errors.js';

export function sellableQuantity(lot: { quantityOnHand: Prisma.Decimal; quantityQuarantined: Prisma.Decimal }) {
  return lot.quantityOnHand.minus(lot.quantityQuarantined);
}

export async function verifySellableLotAllocations(
  tx: Prisma.TransactionClient,
  tenantId: string,
  locationId: string,
  productVariantId: string,
  allocations: readonly { lotId: string; quantity: number }[],
) {
  for (const allocation of allocations) {
    const lot = await tx.inventoryLot.findFirst({ where: {
      id: allocation.lotId, tenantId, locationId, productVariantId
    } });
    if (!lot || sellableQuantity(lot).lt(allocation.quantity)) {
      throw conflict('Lot is unavailable or quarantined');
    }
  }
}
