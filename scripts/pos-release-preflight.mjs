// Read-only release gate for the rendered POS Docker Compose configuration.
// Never print values from Compose: it may contain credentials.
import { readFileSync } from 'node:fs';

const fail = (reason) => { console.error('POS_RELEASE_BLOCKED: ' + reason); process.exitCode = 2; };
let stack;
try {
  const input = readFileSync(0, 'utf8');
  if (input.length > 1_000_000 || !input.trim()) throw Error('invalid');
  stack = JSON.parse(input);
} catch {
  fail('missing_or_invalid_rendered_compose');
  process.exit();
}
const api = stack?.services?.api;
const postgres = stack?.services?.postgres;
if (!api || !postgres) { fail('api_or_postgres_service_missing'); process.exit(); }
const e = api.environment || {};
if (e.NODE_ENV !== 'production' || e.AUTH_MODE !== 'hub') fail('production_hub_auth_required');
if (e.V79_ENTITLEMENT_RECHECK_ENABLED !== '1') fail('effective_hub_entitlement_recheck_not_enabled');
if (typeof e.POS_PUBLIC_URL !== 'string' || e.POS_PUBLIC_URL !== 'https://pos.v79sl.com') fail('pos_public_origin_not_pinned');
for (const key of ['HUB_INTERNAL_URL', 'HUB_JWKS_URL']) {
  try {
    const u = new URL(e[key]);
    if (!['http:', 'https:'].includes(u.protocol) || !u.hostname || ['localhost', '127.0.0.1', '0.0.0.0'].includes(u.hostname)) throw Error('invalid');
  } catch { fail('hub_' + key.toLowerCase() + '_invalid'); }
}
const secret = e.V79_POS_PLATFORM_SHARED_SECRET || e.V79_PLATFORM_SHARED_SECRET;
if (typeof secret !== 'string' || secret.length < 32 || /change.me|replace.with/i.test(secret)) fail('hub_pos_service_secret_not_ready');
const serviceNets = (svc) => Array.isArray(svc.networks) ? svc.networks : Object.keys(svc.networks || {});
const apiNets = serviceNets(api);
const dbNets = serviceNets(postgres);
const internalNames = Object.keys(stack.networks || {}).filter(n => stack.networks[n]?.internal === true);
if (!internalNames.some(n => dbNets.includes(n) && apiNets.includes(n))) fail('private_database_network_not_proven');
if (dbNets.some(n => !internalNames.includes(n))) fail('database_exposed_to_noninternal_network');
if (process.exitCode) process.exit();
console.log('POS_RELEASE_PREFLIGHT=PASS (configuration only; backup/rollback and live Hub acceptance still required)');
