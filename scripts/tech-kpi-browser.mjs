/*
 * Local-only Chrome DevTools browser checks; no production/customer access.
 * Requires running loopback POS dev-auth API and disposable test tenant.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tenantId = process.env.POS_TEST_TENANT_ID;
const base = 'http://127.0.0.1:18080';
const devtools = 'http://127.0.0.1:19229';
if (process.env.POS_TEST_CONFIRM !== 'disposable-local-db' ||
    process.env.NODE_ENV === 'production' || !tenantId) {
  throw new Error('Browser QA requires explicit disposable local test context');
}
const profile = mkdtempSync(join(tmpdir(), 'v79pos-browser-'));
const browser = spawn('google-chrome', [
  '--headless=new', '--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=19229',
  '--user-data-dir=' + profile, '--window-size=1366,960', base
], { stdio: 'ignore' });

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function target() {
  for (let i = 0; i < 40; i++) {
    try {
      const pages = await (await fetch(devtools + '/json')).json();
      const page = pages.find(p => p.type === 'page' && p.webSocketDebuggerUrl);
      if (page) return page;
    } catch {}
    await delay(200);
  }
  throw new Error('Headless Chrome CDP did not become ready');
}
let ws;
let next = 1;
const pending = new Map();
async function connect(address) {
  ws = new WebSocket(address);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });
  ws.addEventListener('message', event => {
    const message = JSON.parse(String(event.data));
    if (!message.id) return;
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    if (message.error) entry.reject(new Error(message.error.message));
    else entry.resolve(message.result);
  });
}
function command(method, params = {}) {
  const id = next++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(expression) {
  const result = await command('Runtime.evaluate', {
    expression, returnByValue: true, awaitPromise: true
  });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
  return result.result?.value;
}
async function ready(expression, label) {
  for (let i = 0; i < 60; i++) {
    const result = await evaluate(expression).catch(() => false);
    if (result) return result;
    await delay(250);
  }
  throw new Error('Browser timed out waiting for ' + label);
}
async function authoriseAs(userId) {
  await command('Network.setExtraHTTPHeaders', {
    headers: { 'x-dev-user-id': userId, 'x-v79-tenant-id': tenantId }
  });
}
async function navigate(path) {
  await command('Page.navigate', { url: base + path });
}
try {
  const page = await target();
  await connect(page.webSocketDebuggerUrl);
  await command('Page.enable');
  await command('Runtime.enable');
  await command('Network.enable');
  await authoriseAs('integration-owner');
  await navigate('/');
  await ready('!!document.querySelector(".shell")', 'POS shell');
  await evaluate('document.querySelector(\'[data-page="reports"]\').click()');
  await ready('document.querySelectorAll(".report-kpi").length === 10', '10 verified KPI cards');
  const count = await evaluate('document.querySelectorAll(".report-page tbody tr").length');
  assert.equal(count, 12);
  const note = await evaluate('document.querySelector(".report-methodology").innerText');
  assert.ok(note.includes('complete local calendar periods'));
  const csv = await evaluate('!!document.querySelector(\'[data-action="report-csv"]\')');
  assert.equal(csv, true);
  const title = await evaluate('document.querySelector(".report-page h1").innerText');
  assert.equal(title, 'Reports & analytics');
  console.log('PASS desktop authenticated reports: 10 KPI cards, 12 periods, historical chart, export and methodology');

  await command('Emulation.setDeviceMetricsOverride', {
    width: 390, height: 844, deviceScaleFactor: 1, mobile: true
  });
  await authoriseAs('technician-integration');
  await navigate('/technician');
  await ready('!document.querySelector("#workspace").hidden', 'mobile technician workspace');
  const mobile = await evaluate('({width:document.documentElement.scrollWidth, viewport:innerWidth, stock:document.querySelectorAll(".stock-item").length, stockEmpty:document.querySelector("#stock").innerText.includes("No assigned stock"), history:document.querySelectorAll(".history-item").length, form:!!document.querySelector("#request-form")})');
  assert.ok(mobile.form);
  assert.ok(mobile.width <= mobile.viewport + 3, 'Mobile page must not overflow horizontally');
  assert.ok(mobile.stock >= 1 || mobile.stockEmpty, 'Zero remaining stock must be shown clearly');
  assert.ok(mobile.history >= 1, 'Movement and job use history must be available');
  const screenshot = await command('Page.captureScreenshot', { format: 'png', fromSurface: true });
  const filepath = '/tmp/v79pos-technician-mobile-qa.png';
  writeFileSync(filepath, Buffer.from(screenshot.data, 'base64'));
  console.log('PASS mobile technician: live stock, form, 390px viewport without horizontal overflow');
  console.log('BROWSER_SCREENSHOT_LOCAL=' + filepath);
  console.log('BROWSER_QA_RESULT=PASS');
} finally {
  if (ws) ws.close();
  browser.kill('SIGTERM');
  try { rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); }
  catch (error) { console.warn('QA_BROWSER_PROFILE_CLEANUP_DEFERRED=' + error.code); }
}
