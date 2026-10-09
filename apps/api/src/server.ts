import Fastify from 'fastify';
import helmet from '@fastify/helmet';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import { ZodError } from 'zod';
import { Prisma } from '@prisma/client';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, createHmac } from 'node:crypto';
import { config, corsOrigins } from './lib/config.js';
import { prisma } from './lib/prisma.js';
import { AppError } from './lib/errors.js';
import { issuePosSession, registerAuth, verifyHubAccessToken } from './modules/auth/plugin.js';
import { catalogueRoutes } from './modules/catalogue/routes.js';
import { inventoryRoutes } from './modules/inventory/routes.js';
import { transferRoutes } from './modules/inventory/transfers.js';
import { salesRoutes } from './modules/sales/routes.js';
import { procurementRoutes } from './modules/procurement/routes.js';
import { replenishmentRoutes } from './modules/replenishment/routes.js';
import { customerRoutes } from './modules/customers/routes.js';
import { teamRoutes } from './modules/team/routes.js';
import { workforceRoutes } from './modules/team/workforce.js';
import { logisticsRoutes } from './modules/logistics/routes.js';
import { registerRoutes } from './modules/registers/routes.js';
import { stockCountRoutes } from './modules/inventory/counts.js';
import { pricingRoutes } from './modules/pricing/routes.js';
import { valueRoutes } from './modules/value/routes.js';
import { paymentRoutes } from './modules/payments/routes.js';
import { syncRoutes } from './modules/sync/routes.js';
import { integrationRoutes } from './modules/integrations/routes.js';
import { reportRoutes } from './modules/reports/routes.js';
import { auditRoutes } from './modules/audit/routes.js';
import { orderRoutes } from './modules/orders/routes.js';
import { fulfillmentRoutes } from './modules/fulfillment/routes.js';
import { platformRoutes } from './modules/platform/routes.js';

const trustProxy = config.TRUST_PROXY === 'true' ? true : config.TRUST_PROXY === 'false' ? false : config.TRUST_PROXY;
const app = Fastify({ logger: { level: config.LOG_LEVEL, redact: ['req.headers.authorization','req.headers.cookie','body.cardNumber','body.cvv','body.accountCode'] }, trustProxy, bodyLimit: 1024 * 1024 });
await app.register(helmet);
await app.register(cors, {
  origin: corsOrigins.length === 0 ? false : (origin, callback) => {
    if (!origin || corsOrigins.includes(origin)) callback(null, true);
    else callback(new Error('Origin not allowed'), false);
  },
  credentials: true
});
await app.register(rateLimit, { max: 300, timeWindow: '1 minute' });

// Serve the POS shell from the same origin as the API. The shell is public;
// all merchant data and mutations still require a verified Hub bearer token.
const publicRoot = join(process.cwd(), 'apps/api/public');
for (const [route, filename, mime] of [
  ['/', 'index.html', 'text/html; charset=utf-8'],
  ['/app.css', 'app.css', 'text/css; charset=utf-8'],
  ['/app.js', 'app.js', 'text/javascript; charset=utf-8'],
  ['/favicon.svg', 'favicon.svg', 'image/svg+xml']
] as const) {
  app.get(route, async (_request, reply) => {
    reply.header('content-type', mime);
    reply.header('cache-control', 'no-store');
    return readFile(join(publicRoot, filename));
  });
}

app.get('/health', async () => ({ status: 'ok', service: 'v79-commerce-api', version: '1.0.0-rc.1' }));
app.get('/ready', async (_request, reply) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return { status: 'ready', database: 'ok' };
  } catch {
    return reply.code(503).send({ status: 'not-ready', database: 'unavailable' });
  }
});

// Exchange a single-use Hub launch ticket on the server. The JWT never goes
// into a browser URL or JavaScript state; the browser receives an HttpOnly cookie.
const sessionCookie = (value: string, maxAge: number) => `v79_pos_session=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${config.NODE_ENV === 'production' ? '; Secure' : ''}`;
const posSessionMaxAge = config.POS_SESSION_HOURS * 3600;
app.post('/auth/launch', async (request, reply) => {
  if (request.headers.origin !== new URL(config.POS_PUBLIC_URL).origin) return reply.code(403).send({ error: 'Invalid request origin' });
  const body = (request.body ?? {}) as { ticket?: unknown };
  if (typeof body.ticket !== 'string' || !/^[A-Za-z0-9_-]{32,180}$/.test(body.ticket)) return reply.code(400).send({ error: 'Invalid launch ticket' });
  const pathname = '/api/platform/session/consume';
  const payload = JSON.stringify({ product: 'pos', ticket: body.ticket });
  const timestamp = String(Date.now());
  const digest = createHash('sha256').update(payload).digest('hex');
  const signature = createHmac('sha256', config.V79_POS_PLATFORM_SHARED_SECRET || config.V79_PLATFORM_SHARED_SECRET).update(`POST\n${pathname}\n${timestamp}\n${digest}`).digest('hex');
  try {
    const response = await fetch(new URL(pathname, config.HUB_INTERNAL_URL), {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-v79-service-id': 'v79-pos', 'x-v79-timestamp': timestamp, 'x-v79-signature': signature },
      body: payload,
      signal: AbortSignal.timeout(5000)
    });
    if (!response.ok) return reply.code(response.status === 401 || response.status === 403 ? response.status : 502).send({ error: 'Hub launch was denied or expired. Open POS from Hub again.' });
    const launch = await response.json() as { token?: string; tenantId?: string };
    if (!launch.token || !launch.tenantId) return reply.code(502).send({ error: 'Hub returned an invalid POS launch' });
    const verified = await verifyHubAccessToken(launch.token);
    if (verified.payload.tenant_id !== launch.tenantId || !verified.payload.sub) return reply.code(502).send({ error: 'Hub POS identity mismatch' });
    const session = await issuePosSession(verified.payload.sub, launch.tenantId);
    reply.header('set-cookie', sessionCookie(session, posSessionMaxAge));
    reply.header('cache-control', 'no-store');
    return { connected: true, expiresIn: posSessionMaxAge };
  } catch (error) {
    request.log.warn({ err: error }, 'POS launch exchange failed');
    return reply.code(503).send({ error: 'Hub launch is unavailable. Try again from Hub.' });
  }
});
app.post('/auth/exchange', async (request, reply) => {
  if (request.headers.origin !== new URL(config.POS_PUBLIC_URL).origin) return reply.code(403).send({ error: 'Invalid request origin' });
  const header = request.headers.authorization;
  if (!header?.startsWith('Bearer ')) return reply.code(401).send({ error: 'Hub bearer token required' });
  try {
    const verified = await verifyHubAccessToken(header.slice(7));
    if (!verified.payload.sub || typeof verified.payload.tenant_id !== 'string') return reply.code(401).send({ error: 'Hub POS identity is incomplete' });
    const session = await issuePosSession(verified.payload.sub, verified.payload.tenant_id);
    reply.header('set-cookie', sessionCookie(session, posSessionMaxAge));
    reply.header('cache-control', 'no-store');
    return { connected: true, tenantId: verified.payload.tenant_id, expiresIn: posSessionMaxAge };
  } catch {
    return reply.code(401).send({ error: 'Hub POS token is invalid or expired' });
  }
});

app.post('/auth/logout', async (request, reply) => {
  if (request.headers.origin !== new URL(config.POS_PUBLIC_URL).origin) return reply.code(403).send({ error: 'Invalid request origin' });
  reply.header('set-cookie', sessionCookie('', 0));
  reply.header('cache-control', 'no-store');
  return { signedOut: true };
});

await registerAuth(app);
await platformRoutes(app);
await catalogueRoutes(app);
await customerRoutes(app);
await pricingRoutes(app);
await valueRoutes(app);
await paymentRoutes(app);
await syncRoutes(app);
await integrationRoutes(app);
await reportRoutes(app);
await auditRoutes(app);
await inventoryRoutes(app);
await stockCountRoutes(app);
await transferRoutes(app);
await registerRoutes(app);
await salesRoutes(app);
await orderRoutes(app);
await fulfillmentRoutes(app);
await procurementRoutes(app);
await logisticsRoutes(app);
await replenishmentRoutes(app);
await teamRoutes(app);
await workforceRoutes(app);

app.addHook('onSend', async (request, reply, payload) => { reply.header('x-request-id', request.id); return payload; });

app.setErrorHandler((error, request, reply) => {
  if (error instanceof ZodError) {
    return reply.code(400).send({ code: 'VALIDATION_ERROR', message: 'Request validation failed', issues: error.issues });
  }
  if (error instanceof AppError) {
    return reply.code(error.statusCode).send({ code: error.code, message: error.message, details: error.details });
  }
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (error.code === 'P2002') return reply.code(409).send({ code: 'UNIQUE_CONSTRAINT', message: 'A record with this value already exists' });
    if (error.code === 'P2025') return reply.code(404).send({ code: 'NOT_FOUND', message: 'Record not found' });
  }
  request.log.error({ err: error }, 'Unhandled request error');
  return reply.code(500).send({ code: 'INTERNAL_ERROR', message: 'Unexpected server error' });
});

const close = async () => {
  await app.close();
  await prisma.$disconnect();
};
process.on('SIGTERM', close);
process.on('SIGINT', close);

await app.listen({ port: config.PORT, host: '0.0.0.0' });
