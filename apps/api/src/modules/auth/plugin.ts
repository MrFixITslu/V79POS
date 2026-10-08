import type { FastifyInstance, FastifyRequest } from 'fastify';
import { SignJWT, createRemoteJWKSet, jwtVerify } from 'jose';
import { createHmac } from 'node:crypto';
import { prisma } from '../../lib/prisma.js';
import { config } from '../../lib/config.js';
import { unauthorized } from '../../lib/errors.js';
import { createHubEntitlementChecker } from '../../lib/hubEntitlement.js';
import { builtInPermissions, type AuthContext } from './context.js';

const jwks = createRemoteJWKSet(new URL(config.HUB_JWKS_URL));
const checkHubEntitlement = config.V79_ENTITLEMENT_RECHECK_ENABLED === '1'
  ? createHubEntitlementChecker({
      baseUrl: config.HUB_INTERNAL_URL,
      secret: config.V79_POS_PLATFORM_SHARED_SECRET || config.V79_PLATFORM_SHARED_SECRET,
    })
  : null;
const posSessionKey = createHmac('sha256', config.ENCRYPTION_KEY).update('v79-pos/session-signing/v1').digest();

function bearer(request: FastifyRequest) {
  const header = request.headers.authorization;
  if (header) {
    if (!header.startsWith('Bearer ')) throw unauthorized('Bearer token required');
    return header.slice(7);
  }
  const cookie = request.headers.cookie?.split(';').map(part => part.trim()).find(part => part.startsWith('v79_pos_session='));
  if (!cookie) throw unauthorized('Sign in through Vision79 Hub');
  try { return decodeURIComponent(cookie.slice('v79_pos_session='.length)); }
  catch { throw unauthorized('Invalid POS session'); }
}

export async function verifyHubAccessToken(token: string) {
  return jwtVerify(token, jwks, { issuer: config.JWT_ISSUER, audience: config.JWT_AUDIENCE });
}

export async function issuePosSession(userId: string, tenantId: string) {
  return new SignJWT({ tenant_id: tenantId, token_type: 'v79_pos_session' })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(userId)
    .setIssuer('v79-pos')
    .setAudience('v79-pos-session')
    .setIssuedAt()
    .setExpirationTime(`${config.POS_SESSION_HOURS}h`)
    .sign(posSessionKey);
}

async function verifyPosSession(token: string) {
  return jwtVerify(token, posSessionKey, { issuer: 'v79-pos', audience: 'v79-pos-session' });
}

async function userFromRequest(request: FastifyRequest): Promise<{ userId: string; tokenTenantId?: string }> {
  if (config.AUTH_MODE === 'dev') {
    if (config.NODE_ENV === 'production') throw unauthorized('Development authentication is disabled in production');
    const userId = String(request.headers['x-dev-user-id'] ?? '').trim();
    if (!userId) throw unauthorized('x-dev-user-id is required in development auth mode');
    return { userId };
  }

  const token = bearer(request);
  let verified;
  try {
    verified = await verifyHubAccessToken(token);
  } catch {
    try {
      verified = await verifyPosSession(token);
    } catch {
      throw unauthorized('POS session is invalid or expired');
    }
  }
  if (!verified.payload.sub) throw unauthorized('Token subject is missing');
  const tenantClaim = typeof verified.payload.tenant_id === 'string' ? verified.payload.tenant_id : undefined;
  return { userId: verified.payload.sub, tokenTenantId: tenantClaim };
}

export async function registerAuth(app: FastifyInstance) {
  app.decorateRequest('auth', undefined as unknown as AuthContext);

  app.addHook('onRequest', async request => {
    if (request.url === '/' || request.url === '/favicon.svg' || request.url === '/app.js' || request.url === '/app.css' || request.url === '/health' || request.url === '/ready' || request.url === '/auth/launch' || request.url === '/auth/exchange' || request.url === '/auth/logout' || request.url.startsWith('/v1/payments/webhooks/') || request.url.startsWith('/api/platform/')) return;

    if (!request.headers.authorization && !['GET','HEAD','OPTIONS'].includes(request.method) && request.headers.origin !== new URL(config.POS_PUBLIC_URL).origin) {
      throw unauthorized('Invalid request origin');
    }

    const identity = await userFromRequest(request);
    const requestedTenant = String(request.headers['x-v79-tenant-id'] ?? '').trim();
    if (identity.tokenTenantId && requestedTenant && identity.tokenTenantId !== requestedTenant) {
      throw unauthorized('Tenant selection does not match the authenticated token');
    }
    const tenantId = identity.tokenTenantId ?? requestedTenant;
    if (!tenantId) throw unauthorized('Tenant context is required');

    const membership = await prisma.membership.findUnique({
      where: { tenantId_userId: { tenantId, userId: identity.userId } },
      include: {
        tenant: { select: { active: true } },
        role: { include: { permissions: true } },
        locationAccess: { select: { locationId: true } }
      }
    });

    if (!membership?.active || !membership.tenant.active) throw unauthorized('No active membership for this tenant');
    // The session JWT alone is not proof of a still-active Hub subscription.
    // Recheck a signed Hub entitlement at least every 30 seconds; fail closed.
    if (checkHubEntitlement) {
      let entitled = false;
      try {
        entitled = await checkHubEntitlement({
          organizationId: tenantId, scopedUserId: identity.userId,
        });
      } catch {
        // Unexpected Hub checker errors must deny, not become uncaught API failures.
        entitled = false;
      }
      if (!entitled) throw unauthorized('Your V79 Hub subscription is inactive or cannot be verified');
    }

    const permissions = new Set([
      ...builtInPermissions(membership.roleKey),
      ...membership.role.permissions.map(p => p.permission)
    ]);
    const allLocations = membership.roleKey === 'OWNER' || membership.roleKey === 'ADMIN';
    const auth: AuthContext = {
      userId: identity.userId,
      tenantId,
      membershipId: membership.id,
      roleKey: membership.roleKey,
      permissions,
      locationIds: new Set(membership.locationAccess.map(item => item.locationId)),
      allLocations
    };
    request.auth = auth;
  });
}
