import { randomUUID, createHash, createHmac } from 'node:crypto';
import Fastify from 'fastify';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { prisma } from '../../lib/prisma.js';
import { platformRoutes } from './routes.js';
import { applyHubOrgNameSync, hubOrgNameSchema } from './organization-name-sync.js';

const url = new URL(process.env.DATABASE_URL || '');
if (process.env.V79_POS_ORG_SYNC_QA !== '1' ||
    url.hostname !== '127.0.0.1' || url.pathname !== '/hubqa') {
  throw new Error('POS integration tests require an isolated localhost hubqa database.');
}
if ((process.env.V79_PLATFORM_SHARED_SECRET || '').length < 32) {
  throw new Error('A dedicated 32+ character QA signing key is required.');
}

const app = Fastify();
const endpoint = '/api/platform/organization/name/sync';
beforeAll(async () => {
  await app.register(platformRoutes);
  await app.ready();
});
afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

async function tenant() {
  const id = `qa-${randomUUID()}`;
  await prisma.tenant.create({ data: { id, name: 'Original', slug: `qa-${randomUUID()}` } });
  return id;
}
function message(organizationId: string, nameRevision: number, name: string) {
  return hubOrgNameSchema.parse({
    eventId: randomUUID(), organizationId, destination: 'pos', name, nameRevision,
  });
}
async function sync(body: ReturnType<typeof message>) {
  return prisma.$transaction(tx => applyHubOrgNameSync(tx, body));
}
async function state(id: string) {
  const [name, record, receipts] = await Promise.all([
    prisma.tenant.findUniqueOrThrow({ where: { id }, select: { name: true } }),
    prisma.hubOrgNameState.findUnique({ where: { organizationId: id } }),
    prisma.hubOrgNameReceipt.count({ where: { organizationId: id } }),
  ]);
  return { name: name.name, revision: Number(record?.nameRevision || 0), receipts };
}

function signedHeaders(body: string, serviceId = 'v79-hub') {
  const timestamp = String(Date.now());
  const digest = createHash('sha256').update(body).digest('hex');
  const signature = createHmac('sha256', process.env.V79_PLATFORM_SHARED_SECRET!)
    .update(`POST\n${endpoint}\n${timestamp}\n${digest}`).digest('hex');
  return {
    'content-type': 'application/json',
    'x-v79-service-id': serviceId,
    'x-v79-timestamp': timestamp,
    'x-v79-signature': signature,
  };
}

// These tests run against a disposable PostgreSQL container; never production.
describe('POS Hub rename: isolated real PostgreSQL', () => {
  it('commits tenant name, durable revision and receipt together', async () => {
    const id = await tenant();
    expect(await sync(message(id, 5, 'New Name'))).toEqual({ duplicate: false });
    expect(await state(id)).toEqual({ name: 'New Name', revision: 5, receipts: 1 });
  });

  it('accepts an identical retry without adding a receipt', async () => {
    const id = await tenant();
    const event = message(id, 2, 'First Name');
    expect(await sync(event)).toEqual({ duplicate: false });
    expect(await sync(event)).toEqual({ duplicate: true });
    expect(await state(id)).toEqual({ name: 'First Name', revision: 2, receipts: 1 });
  });

  it('rejects a changed payload with a reused event ID', async () => {
    const id = await tenant();
    const event = message(id, 4, 'Correct Name');
    await sync(event);
    await expect(sync({ ...event, name: 'Tampered Name' })).rejects.toThrow(/reused/i);
    expect(await state(id)).toEqual({ name: 'Correct Name', revision: 4, receipts: 1 });
  });

  it('acknowledges older events without overwriting and rejects same-revision conflicts', async () => {
    const id = await tenant();
    await sync(message(id, 10, 'Current Name'));
    const obsolete = message(id, 9, 'Old Name');
    expect(await sync(obsolete)).toEqual({ duplicate: false, obsolete: true });
    expect(await sync(obsolete)).toEqual({ duplicate: true });
    await expect(sync(message(id, 10, 'Different Name'))).rejects.toThrow(/revision/i);
    expect(await state(id)).toEqual({ name: 'Current Name', revision: 10, receipts: 2 });
  });

  it('rejects an unknown organisation without committing a receipt', async () => {
    const orgId = `unknown-${randomUUID()}`;
    await expect(sync(message(orgId, 2, 'Forbidden'))).rejects.toThrow(/does not exist/i);
    expect(await prisma.hubOrgNameReceipt.count({ where: { organizationId: orgId } })).toBe(0);
  });

  it('concurrent deliveries converge on the highest revision', async () => {
    const id = await tenant();
    const result = await Promise.allSettled([
      sync(message(id, 20, 'Older')),
      sync(message(id, 21, 'Newest')),
    ]);
    expect(result.some(item => item.status === 'fulfilled')).toBe(true);
    expect(await state(id)).toMatchObject({ name: 'Newest', revision: 21 });
  });

  it('signed HTTP request returns an exact committed acknowledgement', async () => {
    const id = await tenant();
    const input = message(id, 7, 'Signed Rename');
    const body = JSON.stringify(input);
    const response = await app.inject({
      method: 'POST', url: endpoint, payload: body, headers: signedHeaders(body),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ accepted: true, ...input });
    expect(await state(id)).toEqual({ name: 'Signed Rename', revision: 7, receipts: 1 });
  });

  it('rejects forged service identity before database mutation', async () => {
    const id = await tenant();
    const input = message(id, 7, 'Must Not Apply');
    const body = JSON.stringify(input);
    const response = await app.inject({
      method: 'POST', url: endpoint, payload: body,
      headers: signedHeaders(body, 'v79-marketing'),
    });
    expect(response.statusCode).toBe(401);
    expect(await state(id)).toEqual({ name: 'Original', revision: 0, receipts: 0 });
  });

  it('rejects a tampered HTTP signature before database mutation', async () => {
    const id = await tenant();
    const input = message(id, 7, 'Must Not Apply');
    const body = JSON.stringify(input);
    const headers = signedHeaders(body);
    headers['x-v79-signature'] = '0'.repeat(64);
    const response = await app.inject({
      method: 'POST', url: endpoint, payload: body, headers,
    });
    expect(response.statusCode).toBe(401);
    expect(await state(id)).toEqual({ name: 'Original', revision: 0, receipts: 0 });
  });
});
