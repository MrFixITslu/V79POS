import { createHash, createHmac } from 'node:crypto';

type CheckInput = { organizationId: string; scopedUserId: string };
type CheckConfig = { baseUrl: string; secret: string; now?: () => number; transport?: typeof fetch };

export function createHubEntitlementChecker({ baseUrl, secret, now = Date.now, transport = fetch }: CheckConfig) {
  if (!/^https?:\/\//.test(baseUrl) || secret.length < 32) {
    throw new Error('Hub POS entitlement revalidation requires a valid URL and service secret');
  }
  const cache = new Map<string, number>();
  const pathname = '/api/platform/entitlement/check';
  const url = new URL(pathname, baseUrl).toString();

  return async function check({ organizationId, scopedUserId }: CheckInput): Promise<boolean> {
    if (!organizationId || !scopedUserId) return false;
    const key = JSON.stringify([organizationId, scopedUserId]);
    const instant = now();
    const cachedUntil = cache.get(key) || 0;
    if (cachedUntil > instant) return true;
    cache.delete(key);
    const payload = JSON.stringify({ product: 'pos', organizationId, scopedUserId });
    const timestamp = String(instant);
    const canonical = ['POST', pathname, timestamp, createHash('sha256').update(payload).digest('hex')].join('\n');
    const signature = createHmac('sha256', secret).update(canonical).digest('hex');
    try {
      const response = await transport(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-v79-service-id': 'v79-pos',
          'x-v79-timestamp': timestamp,
          'x-v79-signature': signature,
        },
        body: payload,
        signal: AbortSignal.timeout(3500),
      });
      if (!response.ok) return false;
      const parsed = (await response.json()) as { allowed?: unknown; validForSeconds?: unknown };
      const seconds = Number(parsed?.validForSeconds);
      if (parsed?.allowed !== true || !Number.isFinite(seconds) || seconds < 1) return false;
      cache.set(key, now() + Math.min(Math.floor(seconds), 30) * 1000);
      return true;
    } catch {
      // Timeout/network/invalid response must deny access, never fall back to a stale permit.
      return false;
    }
  };
}
