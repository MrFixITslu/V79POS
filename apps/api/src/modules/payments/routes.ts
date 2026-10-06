import type { FastifyInstance } from 'fastify';
import { PaymentIntentStatus } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { encryptJson, decryptJson, hmacHex, safeEqualHex } from '../../lib/crypto.js';
import { conflict, notFound } from '../../lib/errors.js';
import { requirePermission } from '../auth/context.js';

export async function paymentRoutes(app: FastifyInstance) {
  app.get('/v1/payment-connections', { preHandler: requirePermission('payments.manage') }, async request => {
    const rows = await prisma.paymentProviderConnection.findMany({ where: { tenantId: request.auth.tenantId }, orderBy: { name: 'asc' } });
    return { connections: rows.map(({ encryptedConfig: _c, encryptedWebhookSecret: _w, ...row }) => row) };
  });

  app.post('/v1/payment-connections', { preHandler: requirePermission('payments.manage') }, async request => {
    const body = z.object({ name: z.string().min(1).max(100), providerType: z.string().min(2).max(60), config: z.record(z.string(), z.unknown()).default({}), webhookSecret: z.string().min(16).optional() }).parse(request.body);
    return prisma.paymentProviderConnection.create({ data: { tenantId: request.auth.tenantId, name: body.name, providerType: body.providerType.toUpperCase(), encryptedConfig: encryptJson(body.config), encryptedWebhookSecret: body.webhookSecret ? encryptJson({ secret: body.webhookSecret }) : null } });
  });

  app.post('/v1/payment-intents', { preHandler: requirePermission('sales.create') }, async request => {
    const body = z.object({ connectionId: z.string(), amount: z.coerce.number().positive(), currency: z.string().length(3), idempotencyKey: z.string().min(8).max(200), saleId: z.string().optional(), metadata: z.record(z.string(), z.unknown()).optional() }).parse(request.body);
    const connection = await prisma.paymentProviderConnection.findFirst({ where: { id: body.connectionId, tenantId: request.auth.tenantId, active: true } });
    if (!connection) throw notFound('Payment connection not found');
    if (body.saleId) {
      const sale = await prisma.sale.findFirst({ where: { id: body.saleId, tenantId: request.auth.tenantId } });
      if (!sale) throw notFound('Sale not found for this workspace');
      if (sale.currency !== body.currency.toUpperCase()) throw conflict('Payment intent currency must match the sale currency');
    }
    const existing = await prisma.paymentIntent.findUnique({ where: { tenantId_idempotencyKey: { tenantId: request.auth.tenantId, idempotencyKey: body.idempotencyKey } } });
    if (existing) return existing;
    const config = decryptJson<Record<string, unknown>>(connection.encryptedConfig);
    const manual = connection.providerType === 'MANUAL_TERMINAL';
    return prisma.paymentIntent.create({ data: {
      tenantId: request.auth.tenantId, connectionId: connection.id, saleId: body.saleId, idempotencyKey: body.idempotencyKey,
      amount: body.amount, currency: body.currency.toUpperCase(), status: manual ? PaymentIntentStatus.REQUIRES_ACTION : PaymentIntentStatus.CREATED,
      metadata: { ...(body.metadata ?? {}), adapterConfigured: Object.keys(config).length > 0 }
    }});
  });

  app.post('/v1/payment-intents/:id/confirm-terminal', { preHandler: requirePermission('sales.create') }, async request => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const body = z.object({ approved: z.boolean(), providerRef: z.string().min(1).max(200), failureMessage: z.string().max(500).optional() }).parse(request.body);
    const intent = await prisma.paymentIntent.findFirst({ where: { id, tenantId: request.auth.tenantId }, include: { connection: true } });
    if (!intent) throw notFound('Payment intent not found');
    if (intent.connection.providerType !== 'MANUAL_TERMINAL') throw conflict('Intent is not a manual terminal payment');
    const confirmableStatuses: PaymentIntentStatus[] = [PaymentIntentStatus.CREATED, PaymentIntentStatus.REQUIRES_ACTION, PaymentIntentStatus.PROCESSING];
    if (!confirmableStatuses.includes(intent.status)) throw conflict('Payment intent cannot be confirmed from its current state');
    return prisma.paymentIntent.update({ where: { id }, data: { status: body.approved ? PaymentIntentStatus.SUCCEEDED : PaymentIntentStatus.FAILED, providerRef: body.providerRef, failureMessage: body.approved ? null : body.failureMessage ?? 'Declined at terminal' } });
  });

  app.post('/v1/payments/webhooks/:connectionId', async request => {
    const { connectionId } = z.object({ connectionId: z.string() }).parse(request.params);
    const connection = await prisma.paymentProviderConnection.findUnique({ where: { id: connectionId } });
    if (!connection?.active || !connection.encryptedWebhookSecret) throw notFound('Webhook endpoint not found');
    const signature = String(request.headers['x-v79-signature'] ?? '');
    const { secret } = decryptJson<{secret:string}>(connection.encryptedWebhookSecret);
    const bodyString = JSON.stringify(request.body ?? {});
    if (!safeEqualHex(signature, hmacHex(secret, bodyString))) throw conflict('Invalid webhook signature');
    const body = z.object({ eventId: z.string().min(1), eventType: z.string().min(1), paymentIntentId: z.string().optional(), providerRef: z.string().optional(), status: z.enum(['PROCESSING','SUCCEEDED','FAILED','CANCELLED','REFUNDED']).optional() }).passthrough().parse(request.body);
    const existing = await prisma.paymentWebhookEvent.findUnique({ where: { connectionId_eventId: { connectionId, eventId: body.eventId } } });
    if (existing) return { received: true, duplicate: true };
    await prisma.$transaction(async tx => {
      await tx.paymentWebhookEvent.create({ data: { connectionId, eventId: body.eventId, eventType: body.eventType, payload: body as any } });
      if (body.paymentIntentId && body.status) {
        const intent = await tx.paymentIntent.findFirst({ where: { id: body.paymentIntentId, connectionId } });
        if (intent) await tx.paymentIntent.update({ where: { id: intent.id }, data: { status: PaymentIntentStatus[body.status], providerRef: body.providerRef ?? intent.providerRef } });
      }
      await tx.paymentWebhookEvent.update({ where: { connectionId_eventId: { connectionId, eventId: body.eventId } }, data: { processedAt: new Date() } });
    });
    return { received: true };
  });
}
