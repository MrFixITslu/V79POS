import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PrismaClient, Prisma, InventoryMovementType } from '@prisma/client';
import { verifySellableLotAllocations } from '../src/lib/lot-quarantine.js';
import { postInventoryMovement } from '../src/modules/inventory/service.js';

const url = new URL(process.env.DATABASE_URL ?? '');
assert.equal(url.hostname, '127.0.0.1', 'Must use localhost');
assert.equal(url.pathname, '/hubqa', 'Must use disposable hubqa DB');
assert.equal(process.env.V79_POS_LOT_QA, '1', 'Explicit QA flag missing');
const prisma = new PrismaClient();
const N = (n: number) => new Prisma.Decimal(n);

async function main() {
  const suffix = randomUUID().slice(0, 12);
  const tenant = await prisma.tenant.create({ data: { name: 'Disposable Lot QA', slug: `lotqa-${suffix}` } });
  const location = await prisma.location.create({ data: { tenantId: tenant.id, name: 'QA warehouse', code: 'W1', type: 'WAREHOUSE' } });
  const product = await prisma.product.create({ data: { tenantId: tenant.id, name: 'QA parts', productType: 'LOT_TRACKED' } });
  const variant = await prisma.productVariant.create({ data: { tenantId: tenant.id, productId: product.id, sku: `qa-${suffix}`, name: 'QA tracked part', sellPrice: N(10) } });
  const lot = await prisma.inventoryLot.create({ data: {
    tenantId: tenant.id, locationId: location.id, productVariantId: variant.id,
    lotNumber: `lot-${suffix}`, quantityOnHand: N(3), quantityQuarantined: N(0)
  }});
  await prisma.inventoryBalance.create({ data: {
    tenantId: tenant.id, locationId: location.id, productVariantId: variant.id, onHand: N(3)
  }});

  // Same atomic movement pattern as receiving a faulty technician lot return.
  await prisma.$transaction(async tx => {
    await tx.inventoryLot.update({ where: { id: lot.id }, data: {
      quantityOnHand: { increment: N(7) }, quantityQuarantined: { increment: N(7) }
    }});
    await postInventoryMovement(tx, {
      tenantId: tenant.id, locationId: location.id, productVariantId: variant.id,
      movementType: InventoryMovementType.TRANSFER_IN, quantity: N(7),
      referenceType: 'FAULTY_QA_RECEIPT', referenceId: suffix
    });
    await postInventoryMovement(tx, {
      tenantId: tenant.id, locationId: location.id, productVariantId: variant.id,
      movementType: InventoryMovementType.QUARANTINE_IN, quantity: N(7),
      referenceType: 'FAULTY_TECHNICIAN_RETURN', referenceId: suffix
    });
  });

  const [updatedLot, balance] = await Promise.all([
    prisma.inventoryLot.findUniqueOrThrow({ where: { id: lot.id } }),
    prisma.inventoryBalance.findUniqueOrThrow({ where: {
      tenantId_locationId_productVariantId: { tenantId: tenant.id, locationId: location.id, productVariantId: variant.id }
    } })
  ]);
  assert.equal(updatedLot.quantityOnHand.toNumber(), 10);
  assert.equal(updatedLot.quantityQuarantined.toNumber(), 7);
  assert.equal(balance.onHand.toNumber(), 10);
  assert.equal(balance.quarantined.toNumber(), 7);
  console.log('PASS: Faulty receipt records physical stock and matching quarantine');

  await prisma.$transaction(tx => verifySellableLotAllocations(
    tx, tenant.id, location.id, variant.id, [{ lotId: lot.id, quantity: 3 }]
  ));
  await assert.rejects(prisma.$transaction(tx => verifySellableLotAllocations(
    tx, tenant.id, location.id, variant.id, [{ lotId: lot.id, quantity: 4 }]
  )), /quarantined/);
  console.log('PASS: Only the three healthy units are selectable');

  await assert.rejects(prisma.inventoryLot.update({ where: { id: lot.id }, data: {
    quantityQuarantined: N(11)
  }}));
  assert.equal((await prisma.inventoryLot.findUniqueOrThrow({ where: { id: lot.id } })).quantityQuarantined.toNumber(), 7);
  console.log('PASS: DB blocks quarantined quantity exceeding on-hand');

  // A good return adds healthy units but does not release faulty units.
  await prisma.$transaction(async tx => {
    await tx.inventoryLot.update({ where: { id: lot.id }, data: { quantityOnHand: { increment: N(2) } } });
    await postInventoryMovement(tx, {
      tenantId: tenant.id, locationId: location.id, productVariantId: variant.id,
      movementType: InventoryMovementType.TRANSFER_IN, quantity: N(2),
      referenceType: 'GOOD_QA_RECEIPT', referenceId: suffix
    });
  });
  const goodLot = await prisma.inventoryLot.findUniqueOrThrow({ where: { id: lot.id } });
  assert.equal(goodLot.quantityOnHand.toNumber(), 12);
  assert.equal(goodLot.quantityQuarantined.toNumber(), 7);
  await prisma.$transaction(tx => verifySellableLotAllocations(
    tx, tenant.id, location.id, variant.id, [{ lotId: lot.id, quantity: 5 }]
  ));
  console.log('PASS: Good return increases sellable stock without releasing faulty stock');

  await assert.rejects(prisma.$transaction(tx => verifySellableLotAllocations(
    tx, 'other-tenant', location.id, variant.id, [{ lotId: lot.id, quantity: 1 }]
  )), /quarantined/);
  console.log('PASS: Cross-tenant allocation rejected');
  console.log('POS_LOT_REAL_POSTGRES_QA=PASSED');
}

main().catch(err => { console.error(err); process.exitCode = 1; })
  .finally(async () => { await prisma.$disconnect(); });
