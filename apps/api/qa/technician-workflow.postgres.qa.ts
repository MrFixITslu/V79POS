import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import Fastify from 'fastify';
import { technicianRoutes } from '../src/modules/technician/routes.js';
import { transferRoutes } from '../src/modules/inventory/transfers.js';
import { AppError } from '../src/lib/errors.js';
import type { AuthContext } from '../src/modules/auth/context.js';

const url = new URL(process.env.DATABASE_URL || '');
assert.equal(process.env.V79_POS_TECH_QA, '1', 'QA guard absent');
assert.equal(url.hostname, '127.0.0.1', 'QA must use localhost');
assert.equal(url.pathname, '/hubqa', 'QA must use its own database');
assert.equal(process.env.NODE_ENV, 'test');

const prisma = new PrismaClient();
const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const owner = 'qa-owner-' + suffix;
const tech = 'qa-tech-' + suffix;
const other = 'qa-other-' + suffix;
const D = (n: number) => new Prisma.Decimal(n);
let app: ReturnType<typeof Fastify>;

async function main() {
  const tenant = await prisma.tenant.create({ data: { name: 'Disposable Technician QA', slug: 'tech-' + suffix } });
  const tenant2 = await prisma.tenant.create({ data: { name: 'Other QA Tenant', slug: 'other-' + suffix } });
  const warehouse = await prisma.location.create({ data: { tenantId: tenant.id, name: 'QA warehouse', code: 'WH-' + suffix, type: 'WAREHOUSE' } });
  const product = await prisma.product.create({ data: { tenantId: tenant.id, name: 'QA tracked stock', productType: 'LOT_TRACKED' } });
  const variant = await prisma.productVariant.create({ data: { tenantId: tenant.id, productId: product.id, sku: 'STOCK-' + suffix, name: 'QA lot-tracked hardware', sellPrice: D(20), baseCost: D(5) } });
  const warehouseLot = await prisma.inventoryLot.create({ data: { tenantId: tenant.id, locationId: warehouse.id, productVariantId: variant.id, lotNumber: 'LOT-' + suffix, quantityOnHand: D(12), quantityQuarantined: D(0) } });
  await prisma.inventoryBalance.create({ data: { tenantId: tenant.id, locationId: warehouse.id, productVariantId: variant.id, onHand: D(12) } });
  await prisma.inventoryCostLayer.create({ data: { tenantId: tenant.id, locationId: warehouse.id, productVariantId: variant.id, sourceType: 'QA', sourceId: suffix, quantityReceived: D(12), quantityRemaining: D(12), unitCost: D(5), receivedAt: new Date() } });
  for (const [key, permissions] of [
    ['OWNER', ['*']], ['TECHNICIAN', ['inventory.technician', 'inventory.read']]
  ] as const) {
    await prisma.tenantRole.create({ data: { tenantId: tenant.id, key, name: key } });
    // Write role permissions with the actual role ID, never blanket-grant tenant access.
    const role = await prisma.tenantRole.findUniqueOrThrow({ where: { tenantId_key: { tenantId: tenant.id, key } } });
    await prisma.rolePermission.createMany({ data: permissions.map(permission => ({ roleId: role.id, permission })) });
  }
  await prisma.membership.create({ data: { tenantId: tenant.id, userId: owner, roleKey: 'OWNER' } });
  await prisma.membership.create({ data: { tenantId: tenant.id, userId: tech, roleKey: 'TECHNICIAN' } });
  app = Fastify({ logger: false });
  app.decorateRequest('auth', null);
  // This is a guarded in-process HTTP route integration test. Authentication tokens
  // and live Hub SSO are tested separately; membership is read from real QA DB.
  app.addHook('onRequest', async request => {
    const id = String(request.headers['x-qa-user'] || '');
    const requestedTenant = String(request.headers['x-qa-tenant'] || tenant.id);
    const membership = await prisma.membership.findUnique({
      where: { tenantId_userId: { tenantId: requestedTenant, userId: id } },
      include: { role: { include: { permissions: true } }, locationAccess: true }
    });
    if (!membership?.active) throw new AppError('No QA tenant membership', 401, 'UNAUTHORIZED');
    request.auth = {
      userId: id, tenantId: requestedTenant, membershipId: membership.id,
      roleKey: membership.roleKey,
      permissions: new Set(membership.role.permissions.map(p => p.permission)),
      locationIds: new Set(membership.locationAccess.map(p => p.locationId)),
      allLocations: membership.roleKey === 'OWNER' || membership.roleKey === 'ADMIN'
    } satisfies AuthContext;
  });
  app.setErrorHandler((error, _request, reply) => {
    const status = error instanceof AppError ? error.statusCode : (error.statusCode || 500);
    reply.status(status).send({ error: error.message });
  });
  await technicianRoutes(app);
  await transferRoutes(app);
  await app.ready();

  async function post(actor: string, endpoint: string, payload: unknown, expected: number | number[] = 200, targetTenant?: string) {
    const response = await app.inject({ method: 'POST', url: endpoint,
      headers: { 'x-qa-user': actor, ...(targetTenant ? { 'x-qa-tenant': targetTenant } : {}) }, payload });
    const expectedStatuses = Array.isArray(expected) ? expected : [expected];
    assert.ok(expectedStatuses.includes(response.statusCode), `Unexpected ${endpoint} (${actor}): HTTP ${response.statusCode} ${response.body.slice(0,1000)}; expected ${expectedStatuses}`);
    return JSON.parse(response.body);
  }

  await post(tech, '/v1/technician/assign', { userId: tech, displayName: 'QA technician' }, 403);
  await post(tech, '/v1/technician/requests', {
    productVariantId: variant.id, quantity: 1, purpose: 'TECHNICIAN_ISSUE', warehouseId: warehouse.id,
    reason: 'Before custody assignment', requestKey: randomUUID()
  }, 403);
  const assigned = await post(owner, '/v1/technician/assign', { userId: tech, displayName: 'QA technician' });
  const mobileId = assigned.location.id;
  assert.ok(mobileId);
  console.log('PASS: Only owner assigns technician custody; unassigned technician denied');

  const issuePayload = { productVariantId: variant.id, quantity: 4,
    purpose: 'TECHNICIAN_ISSUE', warehouseId: warehouse.id,
    requestKey: randomUUID(), jobReference: 'QA-JOB-001', reason: 'Stock checkout for QA job' };
  const issue = await post(tech, '/v1/technician/requests', issuePayload);
  const retry = await post(tech, '/v1/technician/requests', issuePayload);
  assert.equal(issue.id, retry.id);
  await post(tech, `/v1/transfers/${issue.id}/allocate`, { lotAllocations: [{ lotId: warehouseLot.id, quantity: 4 }] }, 403);
  await post(owner, `/v1/transfers/${issue.id}/allocate`, { lotAllocations: [{ lotId: warehouseLot.id, quantity: 4 }] });
  assert.equal((await post(tech, '/v1/technician/requests', issuePayload)).id, issue.id);
  await post(tech, '/v1/technician/requests', { ...issuePayload, reason: 'Changed issue details' }, 409);
  await post(owner, `/v1/transfers/${issue.id}/approve`, {});
  await post(owner, `/v1/transfers/${issue.id}/dispatch`, {});
  await post(tech, `/v1/transfers/${issue.id}/receive`, {});
  await post(tech, `/v1/transfers/${issue.id}/receive`, {}, 409);
  const mobileLot = await prisma.inventoryLot.findFirstOrThrow({ where: { tenantId: tenant.id, locationId: mobileId, productVariantId: variant.id } });
  assert.equal(mobileLot.quantityOnHand.toNumber(), 4);
  console.log('PASS: Issuance, allocated checkout, permission boundary, dispatch and custody receipt');

  const usePayload = { productVariantId: variant.id, quantity: 1, requestKey: randomUUID(), jobReference: 'QA-JOB-001', lotAllocations: [{ lotId: mobileLot.id, quantity: 1 }] };
  const use = await post(tech, '/v1/technician/use', usePayload);
  const useRetry = await post(tech, '/v1/technician/use', usePayload);
  assert.equal(use.id, useRetry.id);
  await post(tech, '/v1/technician/use', { ...usePayload, lotAllocations: [] }, 409);
  console.log('PASS: Job usage consumes technician inventory once; duplicate idempotency key rejected on changed details');

  async function transferReturn(purpose: 'TECHNICIAN_RETURN_GOOD' | 'TECHNICIAN_RETURN_FAULTY') {
    const body = { purpose, productVariantId: variant.id, quantity: 1, warehouseId: warehouse.id,
      requestKey: randomUUID(), jobReference: 'QA-JOB-001', reason: 'Traceable QA hardware return',
      lotAllocations: [{ lotId: mobileLot.id, quantity: 1 }] };
    const response = await post(tech, '/v1/technician/requests', body);
    await post(tech, '/v1/technician/requests', { ...body, lotAllocations: [] }, 409);
    await post(owner, `/v1/transfers/${response.id}/approve`, {});
    await post(owner, `/v1/transfers/${response.id}/dispatch`, {});
    await post(owner, `/v1/transfers/${response.id}/receive`, {});
    return response;
  }
  await transferReturn('TECHNICIAN_RETURN_GOOD');
  await transferReturn('TECHNICIAN_RETURN_FAULTY');
  const [finalWarehouseLot, finalWarehouseBalance, finalMobileLot] = await Promise.all([
    prisma.inventoryLot.findUniqueOrThrow({ where: { id: warehouseLot.id } }),
    prisma.inventoryBalance.findUniqueOrThrow({ where: { tenantId_locationId_productVariantId: { tenantId: tenant.id, locationId: warehouse.id, productVariantId: variant.id } } }),
    prisma.inventoryLot.findUniqueOrThrow({ where: { id: mobileLot.id } })
  ]);
  assert.equal(finalWarehouseLot.quantityOnHand.toNumber(), 10);
  assert.equal(finalWarehouseLot.quantityQuarantined.toNumber(), 1);
  assert.equal(finalWarehouseBalance.quarantined.toNumber(), 1);
  assert.equal(finalWarehouseBalance.onHand.toNumber(), 10);
  assert.equal(finalMobileLot.quantityOnHand.toNumber(), 1);
  console.log('PASS: Good and faulty returns; faulty stock quarantined, stock and ledger reconcile');

  await post(owner, '/v1/technician/assign', { userId: other, displayName: 'Other tenant' }, 409);
  await post(owner, '/v1/technician/assign', { userId: tech, displayName: 'Cross-tenant impersonation' }, 401, tenant2.id);
  console.log('PASS: Missing and cross-tenant identities denied');
  console.log('POS_TECHNICIAN_ROUTE_POSTGRES_QA=PASSED');
}

main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  if (app) await app.close().catch(() => {});
  await prisma.$disconnect();
});
