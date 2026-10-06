import { prisma } from './prisma.js';
import { decryptJson, hmacHex } from './crypto.js';
import { assertSafeWebhookUrl } from './safe-webhook-url.js';

export async function processOutboxBatch(limit = 100) {
  const events = await prisma.outboxEvent.findMany({ where: { publishedAt: null }, orderBy: { createdAt: 'asc' }, take: limit });
  let delivered = 0, failed = 0;
  for (const event of events) {
    const endpoints = await prisma.integrationEndpoint.findMany({ where: { tenantId: event.tenantId, active: true, createdAt: { lte: event.createdAt } } });
    const interested = endpoints.filter(e => e.eventTypes.includes('*') || e.eventTypes.includes(event.eventType));
    if (interested.length === 0) {
      await prisma.outboxEvent.update({ where: { id: event.id }, data: { publishedAt: new Date() } });
      continue;
    }
    for (const endpoint of interested) {
      await prisma.outboxDelivery.upsert({ where: { outboxEventId_endpointId: { outboxEventId: event.id, endpointId: endpoint.id } }, create: { outboxEventId: event.id, endpointId: endpoint.id }, update: {} });
    }
    const due = await prisma.outboxDelivery.findMany({ where: { outboxEventId: event.id, deliveredAt: null, nextAttemptAt: { lte: new Date() } }, include: { endpoint: true } });
    for (const delivery of due) {
      const payload = { id: event.id, eventType: event.eventType, aggregateType: event.aggregateType, aggregateId: event.aggregateId, tenantId: event.tenantId, occurredAt: event.createdAt.toISOString(), data: event.payload };
      const body = JSON.stringify(payload);
      const { secret } = decryptJson<{secret:string}>(delivery.endpoint.encryptedSecret);
      try {
        await assertSafeWebhookUrl(delivery.endpoint.url);
        const response = await fetch(delivery.endpoint.url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-v79-event-id': event.id, 'x-v79-signature': hmacHex(secret, body) }, body, signal: AbortSignal.timeout(15_000) });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        await prisma.outboxDelivery.update({ where: { id: delivery.id }, data: { deliveredAt: new Date(), responseCode: response.status, attempts: { increment: 1 }, lastError: null } });
        delivered += 1;
      } catch (error) {
        const attempts = delivery.attempts + 1;
        const delayMinutes = Math.min(360, 2 ** Math.min(attempts, 8));
        await prisma.outboxDelivery.update({ where: { id: delivery.id }, data: { attempts, lastError: error instanceof Error ? error.message.slice(0, 1000) : String(error).slice(0,1000), nextAttemptAt: new Date(Date.now() + delayMinutes * 60_000) } });
        failed += 1;
      }
    }
    const remaining = await prisma.outboxDelivery.count({ where: { outboxEventId: event.id, deliveredAt: null } });
    if (remaining === 0) await prisma.outboxEvent.update({ where: { id: event.id }, data: { publishedAt: new Date() } });
  }
  return { events: events.length, delivered, failed };
}
