// Guard against accidental rollback to older POS branding during UI upgrades.
// Pin the production favicon approved on 2026-11-06 until the owner authorises
// a new one. This test makes no network, Hub, or production database calls.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const publicRoot = join(process.cwd(), 'apps/api/public');
const sourceRoot = join(process.cwd(), 'apps/api/src');
const read = (file) => readFileSync(join(publicRoot, file), 'utf8');
const assertAsset = (name) =>
  assert.equal(existsSync(join(publicRoot, name)), true, 'Missing approved POS asset ' + name);

const icon = read('favicon.svg');
const faviconSha256 = createHash('sha256').update(icon).digest('hex');
assert.equal(faviconSha256, '9dd62dc8d41b0535966189c4ebccd28895bc025297d73a0ac0ad650216623f3b',
  'POS favicon was modified without an approved branded-asset update');

for (const asset of [
  'brand/favicon.ico', 'brand/favicon-16.png', 'brand/favicon-32.png',
  'brand/apple-touch-icon.png', 'brand/icon-64.png', 'brand/header-dark.png',
  'brand/header-light.png', 'brand/logo-full.png', 'brand/android-chrome-192.png',
  'brand/android-chrome-512.png', 'brand-site.webmanifest',
  'pos-icon.svg', 'pos-logo.svg'
]) assertAsset(asset);

const index = read('index.html');
assert.match(index, /\/brand\/favicon\.ico\?v=20261106/);
assert.match(index, /\/brand\/apple-touch-icon\.png/);
assert.match(index, /\/brand-site\.webmanifest/);
assert.match(index, /Vision79 POS/);

const technician = read('technician.html');
assert.match(technician, /\/brand\/favicon\.ico\?v=20261106/);
assert.match(technician, /\/brand\/icon-64\.png/);

const app = read('app.js');
assert.match(app, /import \{ renderKpiReports \}/);
assert.match(app, /v79-pos-theme/);
assert.match(app, /window\.location\.replace\(["']\/technician["']\)/);
assert.match(app, /"reports"\s*,\s*"Reports"/);
assert.match(app, /"reports\.read"/);
assert.match(app, /\/brand\/header-dark\.png/);
assert.match(app, /data-action="theme"/);

const server = readFileSync(join(sourceRoot, 'server.ts'), 'utf8');
const auth = readFileSync(join(sourceRoot, 'modules/auth/plugin.ts'), 'utf8');
assert.match(server, /\/brand-site\.webmanifest/);
assert.match(server, /app\.get\('\/brand\/'/);
assert.match(auth, /request\.url\.startsWith\('\/brand\/'\)/);

const manifest = JSON.parse(read('brand-site.webmanifest'));
assert.ok(Array.isArray(manifest.icons) && manifest.icons.length > 0);
for (const entry of manifest.icons) {
  const relative = String(entry.src ?? '').replace(/^\/+/, '');
  assert.ok(relative && !relative.includes('..'), 'Invalid branded manifest image');
  assertAsset(relative);
}

console.log('PASS: live POS favicon, logos, manifest, theme, technician redirect and KPI menu preserved');
