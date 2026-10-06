import type { FastifyInstance } from 'fastify';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { encryptJson } from '../../lib/crypto.js';
import { requirePermission } from '../auth/context.js';
import { conflict, notFound } from '../../lib/errors.js';
import { assertSafeWebhookUrl } from '../../lib/safe-webhook-url.js';

export async function integrationRoutes(app: FastifyInstance) {
  app.get('/v1/integrations/endpoints', { preHandler: requirePermission('integrations.manage') }, async request => ({
    endpoints: (await prisma.integrationEndpoint.findMany({ where: { tenantId: request.auth.tenantId }, orderBy: { name: 'asc' } })).map(({ encryptedSecret: _s, ...row }) => row)
  }));

  app.post('/v1/integrations/endpoints', { preHandler: requirePermission('integrations.manage') }, async request => {
    const body = z.object({ name: z.string().min(1).max(100), targetType: z.enum(['HUB','FFPRO2','V79MARKETING','CUSTOM']), url: z.string().url(), eventTypes: z.array(z.string().min(2)).min(1), secret: z.string().min(24).optional() }).parse(request.body);
    try { await assertSafeWebhookUrl(body.url); } catch (error) { throw conflict(error instanceof Error ? error.message : 'Unsafe webhook URL'); }
    const secret = body.secret ?? randomBytes(32).toString('hex');
    const row = await prisma.integrationEndpoint.create({ data: { tenantId: request.auth.tenantId, name: body.name, targetType: body.targetType, url: body.url, eventTypes: [...new Set(body.eventTypes)], encryptedSecret: encryptJson({ secret }) } });
    return { ...row, encryptedSecret: undefined, signingSecret: secret };
  });

  app.patch('/v1/integrations/endpoints/:id', { preHandler: requirePermission('integrations.manage') }, async request => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const body = z.object({ active: z.boolean().optional(), url: z.string().url().optional(), eventTypes: z.array(z.string().min(2)).min(1).optional() }).parse(request.body);
    const existing = await prisma.integrationEndpoint.findFirst({ where: { id, tenantId: request.auth.tenantId } });
    if (body.url) {
      try { await assertSafeWebhookUrl(body.url); } catch (error) { throw conflict(error instanceof Error ? error.message : 'Unsafe webhook URL'); }
    }
    if (!existing) throw notFound('Integration endpoint not found');
    const row = await prisma.integrationEndpoint.update({ where: { id }, data: { active: body.active, url: body.url, eventTypes: body.eventTypes ? [...new Set(body.eventTypes)] : undefined } });
    const { encryptedSecret: _s, ...safe } = row;
    return safe;
  });

  app.get('/v1/integrations/deliveries', { preHandler: requirePermission('integrations.manage') }, async request => ({
    deliveries: await prisma.outboxDelivery.findMany({ where: { endpoint: { tenantId: request.auth.tenantId } }, include: { endpoint: { select: { name: true, targetType: true } }, event: { select: { eventType: true, aggregateId: true, createdAt: true } } }, orderBy: { createdAt: 'desc' }, take: 200 })
  }));
}
