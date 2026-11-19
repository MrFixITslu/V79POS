import { describe, expect, it } from 'vitest';
import { Prisma } from '@prisma/client';
import { sellableQuantity, verifySellableLotAllocations } from './lot-quarantine.js';
const D = (v: number) => new Prisma.Decimal(v);

describe('technician lot quarantine', () => {
  it('excludes quarantined quantity from saleable stock', () => {
    expect(sellableQuantity({ quantityOnHand: D(10), quantityQuarantined: D(7) }).toNumber()).toBe(3);
  });
  it('rejects a technician transaction drawing quarantined quantity', async () => {
    const tx = { inventoryLot: { findFirst: async () => ({ quantityOnHand: D(10), quantityQuarantined: D(7) }) } } as unknown as Prisma.TransactionClient;
    await expect(verifySellableLotAllocations(tx, 't', 'l', 'p', [{ lotId: 'lot', quantity: 4 }])).rejects.toThrow(/quarantined/);
    await expect(verifySellableLotAllocations(tx, 't', 'l', 'p', [{ lotId: 'lot', quantity: 3 }])).resolves.toBeUndefined();
  });
  it('fails closed when lot is missing', async () => {
    const tx = { inventoryLot: { findFirst: async () => null } } as unknown as Prisma.TransactionClient;
    await expect(verifySellableLotAllocations(tx, 't', 'l', 'p', [{ lotId: 'missing', quantity: 1 }])).rejects.toThrow(/quarantined/);
  });
});
