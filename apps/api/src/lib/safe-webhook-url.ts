import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { config } from './config.js';

function privateIpv4(ip: string) {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a,b] = parts;
  return a === 0
    || a === 10
    || a === 127
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 198 && (b === 18 || b === 19))
    || a >= 224;
}

function privateIp(ip: string) {
  if (isIP(ip) === 4) return privateIpv4(ip);
  if (isIP(ip) !== 6) return true;
  const value = ip.toLowerCase();
  if (value === '::1' || value === '::') return true;
  if (value.startsWith('fc') || value.startsWith('fd') || value.startsWith('fe8') || value.startsWith('fe9') || value.startsWith('fea') || value.startsWith('feb')) return true;
  const mapped = value.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  return mapped ? privateIpv4(mapped) : false;
}

export async function assertSafeWebhookUrl(raw: string) {
  const url = new URL(raw);
  if (!['http:','https:'].includes(url.protocol)) throw new Error('Webhook URL must use HTTP or HTTPS');
  if (config.NODE_ENV === 'production' && url.protocol !== 'https:') throw new Error('Production webhooks must use HTTPS');
  if (url.username || url.password) throw new Error('Webhook URL must not contain embedded credentials');
  const hostname = url.hostname.toLowerCase().replace(/\.$/, '');
  if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local') || hostname.endsWith('.internal')) {
    throw new Error('Webhook URL cannot target a local or internal host');
  }
  if (config.NODE_ENV !== 'production') return url;
  const addresses = isIP(hostname)
    ? [{ address: hostname }]
    : await lookup(hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(row => privateIp(row.address))) throw new Error('Webhook URL resolves to a private or reserved network');
  return url;
}
