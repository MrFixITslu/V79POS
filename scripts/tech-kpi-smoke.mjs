/*
 * LOCAL-ONLY disposable PostgreSQL integration smoke test.
 * Run only with NODE_ENV=development AUTH_MODE=dev and a dedicated test DB.
 * Never run against an existing customer/production tenant.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';

const host = process.env.POS_TEST_API_URL ?? 'http://127.0.0.1:18080';
const url = new URL(host);
if (!['127.0.0.1', 'localhost', '::1'].includes(url.hostname) ||
    process.env.NODE_ENV === 'production' ||
    process.env.AUTH_MODE !== 'dev' ||
    process.env.POS_TEST_CONFIRM !== 'disposable-local-db') {
  throw new Error('Refusing to run outside an explicitly confirmed isolated local test environment');
}
const prisma = new PrismaClient();
let checked = 0;
const tenantId = process.env.POS_TEST_TENANT_ID;
const ownerId = process.env.POS_TEST_OWNER_USER_ID || 'integration-owner';
assert.ok(tenantId?.length);
const base = url.origin;
async function call(userId, method, path, payload, expected = 200, tenant = tenantId) {
  const response = await fetch(base + path, {
    method, headers: {
      origin: base, 'content-type': 'application/json',
      'x-v79-tenant-id': tenant, 'x-dev-user-id': userId
    },
    body: payload == null ? undefined : JSON.stringify(payload)
  });
  const data = response.headers.get('content-type')?.includes('text/csv')
    ? await response.text() : await response.json().catch(() => ({}));
  if (response.status !== expected) {
    throw Error(JSON.stringify({ userId, method, path, expected, actual: response.status, data }));
  }
  checked++;
  return { response, data };
}
const owner = (method, path, payload, status) => call(ownerId, method, path, payload, status);
const tech = (method, path, payload, status) => call('technician-integration', method, path, payload, status);
const idempotency = () => randomUUID();
const pass = message => console.log('PASS ' + message);
try {
  const { data: warehouse } = await owner('POST', '/v1/locations', {
    name: 'Test Warehouse', code: 'WH' + Math.floor(Math.random() * 1e7), type: 'WAREHOUSE'
  });
  const { data: created } = await owner('POST', '/v1/products', {
    name: 'Network connector QA', productType: 'STANDARD',
    variants: [{ sku: 'TEST-' + randomUUID().slice(0, 8), name: 'Connector', baseCost: 2,
      sellPrice: 5, trackStock: true }]
  });
  const variantId = created.variants[0].id;
  await owner('POST', '/v1/inventory/adjustments', {
    locationId: warehouse.id, productVariantId: variantId, type: 'ADJUSTMENT_GAIN',
    quantity: 10, reason: 'Test receipt of connector stock'
  });
  await owner('POST', '/v1/team', { userId: 'technician-integration', roleKey: 'TECHNICIAN', locationIds: [] });
  const { data: assigned } = await owner('POST', '/v1/technician/assign', {
    userId: 'technician-integration', displayName: 'Integration technician'
  });
  const mobileId = assigned.location.id;
  await tech('GET', '/v1/products', null, 403);
  await tech('GET', '/v1/inventory', null, 403);
  await tech('GET', '/v1/reports/trends', null, 403);
  await tech('GET', '/v1/team', null, 403);
  const { data: firstWorkspace } = await tech('GET', '/v1/technician/workspace');
  assert.equal(firstWorkspace.location.id, mobileId);
  assert.equal(JSON.stringify(firstWorkspace).includes('baseCost'), false);
  assert.equal(JSON.stringify(firstWorkspace).includes('unitCost'), false);
  pass('Technician location and financial/warehouse permission isolation');

  const issueInput = {
    requestKey: idempotency(), purpose: 'TECHNICIAN_ISSUE',
    warehouseId: warehouse.id, productVariantId: variantId,
    quantity: 3, reason: 'Equipment for installation', jobReference: 'TEST-JOB-100'
  };
  const { data: issue } = await tech('POST', '/v1/technician/requests', issueInput);
  const { data: sameIssue } = await tech('POST', '/v1/technician/requests', issueInput);
  assert.equal(sameIssue.id, issue.id);
  await tech('POST', '/v1/technician/requests', { ...issueInput, quantity: 4 }, 409);
  await owner('POST', '/v1/transfers/' + issue.id + '/approve', {});
  await owner('POST', '/v1/transfers/' + issue.id + '/dispatch', {});
  await tech('POST', '/v1/transfers/' + issue.id + '/receive', {});
  await tech('POST', '/v1/transfers/' + issue.id + '/receive', {}, 409);
  let { data: workspace } = await tech('GET', '/v1/technician/workspace');
  assert.equal(Number(workspace.inventory.find(v => v.productVariantId === variantId).available), 3);
  pass('Warehouse issue, technician receipt, duplicate receipt and idempotent retry');

  const useInput = { requestKey: idempotency(), productVariantId: variantId, quantity: 1,
    jobReference: 'TEST-JOB-100' };
  const { data: usage } = await tech('POST', '/v1/technician/use', useInput);
  const { data: repeatedUsage } = await tech('POST', '/v1/technician/use', useInput);
  assert.equal(repeatedUsage.id, usage.id);
  await tech('POST', '/v1/technician/use', { ...useInput, quantity: 2 }, 409);
  pass('Job use and exact once stock consumption');

  const returnStock = async purpose => {
    const { data: returned } = await tech('POST', '/v1/technician/requests', {
      requestKey: idempotency(), purpose, warehouseId: warehouse.id,
      productVariantId: variantId, quantity: 1, reason: 'Field return verification',
      jobReference: 'TEST-JOB-100'
    });
    await owner('POST', '/v1/transfers/' + returned.id + '/approve', {});
    await owner('POST', '/v1/transfers/' + returned.id + '/dispatch', {});
    await owner('POST', '/v1/transfers/' + returned.id + '/receive', {});
    return returned;
  };
  const good = await returnStock('TECHNICIAN_RETURN_GOOD');
  const faulty = await returnStock('TECHNICIAN_RETURN_FAULTY');
  ({ data: workspace } = await tech('GET', '/v1/technician/workspace'));
  assert.equal(Number(workspace.inventory.find(v => v.productVariantId === variantId).available), 0);
  const { data: inventory } = await owner('GET', '/v1/inventory?locationId=' + warehouse.id);
  const balance = inventory.inventory.find(v => v.productVariantId === variantId);
  assert.equal(Number(balance.onHand), 9);
  assert.equal(Number(balance.quarantined), 1);
  assert.equal(Number(balance.available), 8);
  pass('Good return and faulty return; warehouse quarantine and balances reconcile');

  // Confirm cross-tenant access is denied, even when an ID is known.
  const foreignId = randomUUID();
  await prisma.tenant.create({ data: { id: foreignId, name: 'Foreign Test Tenant',
    slug: 'foreign-' + randomUUID().slice(0, 12) } });
  const { data: foreignLocation } = await prisma.location.create({
    data: { tenantId: foreignId, code: 'FOREIGN', name: 'Foreign warehouse', type: 'WAREHOUSE' }
  }).then(result => ({ data: result }));
  await owner('GET', '/v1/reports/trends?locationId=' + foreignLocation.id, null, 404);
  await owner('POST', '/v1/inventory/adjustments', {
    locationId: foreignLocation.id, productVariantId: variantId, type: 'ADJUSTMENT_GAIN',
    quantity: 1, reason: 'Cross tenant'
  }, 404);
  await tech('POST', '/v1/technician/requests', {
    ...issueInput, requestKey: idempotency(), warehouseId: foreignLocation.id
  }, 404);
  await call(ownerId, 'GET', '/v1/reports/trends', null, 401, foreignId);
  pass('Cross-tenant location, warehouse, API and report denial');
  await owner('POST','/v1/team',{userId:'scoped-manager',roleKey:'MANAGER',locationIds:[warehouse.id]});
  await call('scoped-manager','GET','/v1/reports/trends?locationId=' + mobileId,null,403);
  await call('scoped-manager','GET','/v1/inventory?locationId=' + mobileId,null,403);
  const { data: managerReport } = await call('scoped-manager','GET','/v1/reports/trends?locationId=' + warehouse.id);
  assert.equal(managerReport.scope,'selected location');
  pass('Restricted managers cannot inspect technician custody outside their assigned warehouse');

  // Completed-period reporting deliberately excludes the ongoing week.
  // Backdate *test-only* completed movements to validate aggregation.
  const { data: preview } = await owner('GET', '/v1/reports/trends?period=week');
  assert.equal(preview.series.length, 12);
  const last = preview.series.at(-1);
  const within = new Date(new Date(last.from).getTime() + 86400_000);
  await prisma.stockTransfer.updateMany({
    where: { tenantId, id: { in: [issue.id, good.id, faulty.id] } },
    data: { receivedAt: within }
  });
  await prisma.technicianUsage.update({ where: { id: usage.id }, data: { createdAt: within } });
  const sale = await prisma.sale.create({
    data: { tenantId, locationId: warehouse.id, number: 'TEST-SALE-' + randomUUID().slice(0,8),
      status: 'COMPLETED', currency: 'XCD', subtotal: 100, tax: 0, total: 100,
      createdBy: ownerId, completedAt: within }
  });
  await prisma.saleReturn.create({
    data: { tenantId, saleId: sale.id, number: 'TEST-RETURN-' + randomUUID().slice(0,8),
      status: 'COMPLETED', reason: 'Test partial return', total: 10,
      createdBy: ownerId, createdAt: within }
  });
  const { data: report } = await owner('GET', '/v1/reports/trends?period=week');
  const lastPoint = report.series.at(-1);
  assert.equal(lastPoint.metrics.netSales, 90);
  assert.equal(lastPoint.metrics.salesCount, 1);
  assert.equal(lastPoint.metrics.refunds, 10);
  assert.equal(lastPoint.metrics.technicianIssues, 3);
  assert.equal(lastPoint.metrics.technicianUses, 1);
  assert.equal(lastPoint.metrics.jobsSupported, 1);
  assert.equal(lastPoint.metrics.goodReturns, 1);
  assert.equal(lastPoint.metrics.faultyReturns, 1);
  assert.equal(report.snapshot.quarantined, 1);
  assert.equal(report.comparison.find(x => x.key === 'netSales').changePercent, null);
  const { response: csvHeaders, data: csv } = await owner('GET', '/v1/reports/trends.csv?period=week');
  assert.ok(csvHeaders.headers.get('content-type').includes('text/csv'));
  assert.ok(csv.includes('Net sales (incl. tax)'));
  assert.ok(csv.includes('Week of'));
  // Fetch text decoding strips the optional UTF-8 BOM; test actual report content.
  assert.ok(csv.includes('V79 POS KPI history'));
  const { data: month } = await owner('GET','/v1/reports/trends?period=month');
  const { data: year } = await owner('GET','/v1/reports/trends?period=year');
  assert.equal(month.series.length,12);
  assert.equal(year.series.length,5);
  pass('Completed-period WoW/MoM/YoY, report scope, refunds by return date and CSV export');


  // Controlled serial-numbered hardware follows the same warehouse custody pipeline.
  const { data: device } = await owner('POST', '/v1/products', {
    name: 'Test serialised router', productType: 'SERIALIZED',
    variants: [{ sku: 'TEST-SERIAL-' + randomUUID().slice(0,8), name: 'Router',
      baseCost: 150, sellPrice: 250, trackStock: true }]
  });
  const serialVariantId = device.variants[0].id;
  await prisma.inventoryBalance.create({
    data: { tenantId, locationId: warehouse.id, productVariantId: serialVariantId, onHand: 2 }
  });
  const serials = await Promise.all([1,2].map(n => prisma.inventorySerial.create({
    data: { tenantId, locationId: warehouse.id, productVariantId: serialVariantId,
      serialNumber: 'TEST-' + n + '-' + randomUUID().slice(0,8) }
  })));
  await prisma.inventoryCostLayer.create({
    data: { tenantId, locationId: warehouse.id, productVariantId: serialVariantId,
      sourceType: 'QA_RECEIPT', sourceId: randomUUID(), quantityReceived: 2,
      quantityRemaining: 2, unitCost: 150 }
  });
  const { data: serialIssue } = await tech('POST','/v1/technician/requests',{
    requestKey: idempotency(), purpose: 'TECHNICIAN_ISSUE',
    warehouseId: warehouse.id, productVariantId: serialVariantId,
    quantity: 2, reason: 'Issue two tracked routers', jobReference: 'TEST-ROUTER-200'
  });
  await owner('POST','/v1/transfers/' + serialIssue.id + '/approve',{});
  await owner('POST','/v1/transfers/' + serialIssue.id + '/dispatch',{},409);
  await owner('POST','/v1/transfers/' + serialIssue.id + '/allocate',{
    serialNumberIds: serials.map(s => s.id), lotAllocations: []
  });
  await owner('POST','/v1/transfers/' + serialIssue.id + '/dispatch',{});
  await tech('POST','/v1/transfers/' + serialIssue.id + '/receive',{});
  const { data: serialUse } = await tech('POST','/v1/technician/use',{
    requestKey: idempotency(), productVariantId: serialVariantId, quantity: 1,
    serialNumberIds: [serials[0].id], jobReference: 'TEST-ROUTER-200'
  });
  assert.equal(Number(serialUse.quantity),1);
  const installed = await prisma.inventorySerial.findUnique({ where: { id: serials[0].id } });
  assert.equal(installed.status,'INSTALLED');
  await tech('POST','/v1/technician/requests',{
    requestKey: idempotency(), purpose:'TECHNICIAN_RETURN_FAULTY',
    warehouseId: warehouse.id, productVariantId: serialVariantId, quantity:1,
    serialNumberIds:[serials[0].id], reason:'Trying to return installed equipment'
  },409);
  const { data: serialReturn } = await tech('POST','/v1/technician/requests',{
    requestKey: idempotency(), purpose:'TECHNICIAN_RETURN_FAULTY',
    warehouseId: warehouse.id, productVariantId: serialVariantId, quantity:1,
    serialNumberIds:[serials[1].id], reason:'Return faulty tracked router'
  });
  await owner('POST','/v1/transfers/' + serialReturn.id + '/approve',{});
  await owner('POST','/v1/transfers/' + serialReturn.id + '/dispatch',{});
  await owner('POST','/v1/transfers/' + serialReturn.id + '/receive',{});
  const damaged = await prisma.inventorySerial.findUnique({ where: { id: serials[1].id } });
  assert.equal(damaged.status,'DAMAGED');
  const { data: afterSerial } = await owner('GET','/v1/inventory?locationId=' + warehouse.id);
  const damagedStock = afterSerial.inventory.find(v => v.productVariantId === serialVariantId);
  assert.equal(Number(damagedStock.quarantined),1);
  assert.equal(Number(damagedStock.available),0);
  pass('Serialised router issue requires allocation; installed serials cannot be returned as unissued stock; faulty return quarantined');

  // Revoke a technician and confirm their existing device session is not an authorisation grant.
  const record = await prisma.membership.findUnique({
    where: { tenantId_userId: { tenantId, userId:'technician-integration' } }
  });
  await prisma.membership.update({ where: { id: record.id }, data: { active:false } });
  await tech('GET','/v1/technician/workspace',null,401);
  await prisma.membership.update({ where: { id: record.id }, data: { active:true } });
  const { data: afterReactivation } = await tech('GET','/v1/technician/workspace');
  assert.equal(afterReactivation.location.id, mobileId);
  pass('Revoked technician loses access; reactivation is auditable and explicitly controlled');

  // One remaining unit may only be consumed once under parallel requests.
  await owner('POST','/v1/inventory/adjustments',{
    locationId:mobileId,productVariantId:variantId,type:'ADJUSTMENT_GAIN',
    quantity:1,reason:'Concurrency test isolated stock'
  });
  const contenders = await Promise.all([
    tech('POST','/v1/technician/use',{requestKey:idempotency(),
      productVariantId:variantId,quantity:1,jobReference:'CONCURRENT-A'},200).then(()=>'success').catch(()=>'denied'),
    tech('POST','/v1/technician/use',{requestKey:idempotency(),
      productVariantId:variantId,quantity:1,jobReference:'CONCURRENT-B'},200).then(()=>'success').catch(()=>'denied')
  ]);
  assert.equal(contenders.filter(x=>x==='success').length,1);
  const { data: concurrentStock } = await tech('GET','/v1/technician/workspace');
  const connector = concurrentStock.inventory.find(x=>x.productVariantId===variantId);
  assert.equal(Number(connector.available),0);
  pass('Parallel stock consumption cannot double-issue the last unit');

  console.log('INTEGRATION_RESULT=PASS');
  console.log('REQUESTS_CHECKED=' + checked);
} finally {
  await prisma.$disconnect();
}
