// Synthetic preflight positives/negatives; never reads the real .env.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const script = path.join(path.dirname(fileURLToPath(import.meta.url)), 'pos-release-preflight.mjs');
const make = () => ({
  services: {
    api: { networks: ['pos_internal', 'proxy_network'], environment: {
      NODE_ENV: 'production', AUTH_MODE: 'hub',
      V79_ENTITLEMENT_RECHECK_ENABLED: '1',
      POS_PUBLIC_URL: 'https://pos.v79sl.com',
      HUB_INTERNAL_URL: 'http://v79-hub:3040',
      HUB_JWKS_URL: 'http://v79-hub:3040/.well-known/jwks.json',
      V79_PLATFORM_SHARED_SECRET: 'synthetic-ci-only-secret-long-enough-2026',
    } },
    postgres: { networks: ['pos_internal'] },
    redis: { networks: ['pos_internal'] },
  },
  networks: { pos_internal: { internal: true }, proxy_network: { external: true } },
});
function check(stack, expected, label) {
  const r = spawnSync(process.execPath, [script], { input: JSON.stringify(stack), encoding: 'utf8' });
  assert.equal(r.status === 0, expected, label + ' (exit ' + r.status + ')');
  const output = r.stdout + r.stderr;
  assert.ok(!output.includes('synthetic-ci-only-secret'), 'No secrets in diagnostics');
  assert.match(output, expected ? /POS_RELEASE_PREFLIGHT=PASS/ : /POS_RELEASE_BLOCKED/);
}
check(make(), true, 'expected protected Hub mode');
for (const [name, change] of [
  ['entitlement disabled', s => { s.services.api.environment.V79_ENTITLEMENT_RECHECK_ENABLED = '0'; }],
  ['missing entitlement', s => { delete s.services.api.environment.V79_ENTITLEMENT_RECHECK_ENABLED; }],
  ['dev auth', s => { s.services.api.environment.AUTH_MODE = 'dev'; }],
  ['wrong public origin', s => { s.services.api.environment.POS_PUBLIC_URL = 'http://localhost:8080'; }],
  ['weak secret', s => { s.services.api.environment.V79_PLATFORM_SHARED_SECRET = 'weak'; }],
  ['missing Hub JWKS', s => { delete s.services.api.environment.HUB_JWKS_URL; }],
  ['unprotected DB network', s => { s.services.postgres.networks.push('proxy_network'); }],
  ['missing internal DB', s => { s.networks.pos_internal.internal = false; }],
  ['external JWKS origin', s => { s.services.api.environment.HUB_JWKS_URL = 'https://evil.example/.well-known/jwks.json'; }],
  ['different JWKS port', s => { s.services.api.environment.HUB_JWKS_URL = 'http://v79-hub:3041/.well-known/jwks.json'; }],
  ['different JWKS path', s => { s.services.api.environment.HUB_JWKS_URL = 'http://v79-hub:3040/fake'; }],
  ['Hub URL credentials', s => { s.services.api.environment.HUB_INTERNAL_URL = 'http://user:pass@v79-hub:3040'; }],
  ['wrong Hub host', s => { s.services.api.environment.HUB_INTERNAL_URL = 'http://public.example:3040'; }],
  ['database published port', s => { s.services.postgres.ports = ['5432:5432']; }],
  ['redis published port', s => { s.services.redis.ports = ['6379:6379']; }],
  ['redis external network', s => { s.services.redis.networks.push('proxy_network'); }],
  ['database host networking', s => { s.services.postgres.network_mode = 'host'; }],
  ['privileged api', s => { s.services.api.privileged = true; }],
]) {
  const s = make(); change(s); check(s, false, name);
}
console.log('PASS: POS release gate fail-closed synthetic cases');
