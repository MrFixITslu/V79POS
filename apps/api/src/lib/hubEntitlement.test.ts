import { describe, it, expect, vi } from 'vitest';
import { createHmac, createHash } from 'node:crypto';
import { createHubEntitlementChecker } from './hubEntitlement.js';

const secret='test-secret-for-pos-entitlement-123456789';
const id={organizationId:'org-a', scopedUserId:'scoped-a'};
describe('Hub POS entitlement revalidation',()=>{
  it('signs the exact request and caches only 30 seconds', async ()=>{
    let instant=1_800_000_000_000;
    const transport=vi.fn(async (url: any, options: any)=>{
      const hash=createHash('sha256').update(options.body).digest('hex');
      const canonical=['POST','/api/platform/entitlement/check',options.headers['x-v79-timestamp'],hash].join('\n');
      expect(options.headers['x-v79-signature']).toBe(createHmac('sha256',secret).update(canonical).digest('hex'));
      expect(options.headers['x-v79-service-id']).toBe('v79-pos');
      expect(JSON.parse(options.body)).toEqual({product:'pos',...id});
      return {ok:true,json:async()=>({allowed:true,validForSeconds:80})} as Response;
    });
    const check=createHubEntitlementChecker({baseUrl:'http://hub.internal:3040',secret,now:()=>instant,transport:transport as any});
    expect(await check(id)).toBe(true);
    instant+=29_000;expect(await check(id)).toBe(true);
    expect(transport).toHaveBeenCalledTimes(1);
    instant+=1_000;expect(await check(id)).toBe(true);
    expect(transport).toHaveBeenCalledTimes(2);
  });
  it('denies malformed responses, unavailable Hub, and mismatched users',async ()=>{
    const transport=vi.fn(async()=>({ok:true,json:async()=>({allowed:false,validForSeconds:30})} as Response));
    const check=createHubEntitlementChecker({baseUrl:'http://hub.internal:3040',secret,transport:transport as any});
    expect(await check(id)).toBe(false);
    expect(await check({...id,scopedUserId:''})).toBe(false);
    transport.mockRejectedValueOnce(new Error('offline'));
    expect(await check(id)).toBe(false);
  });
  it('requires a strong secret and never caches a denied response',async ()=>{
    expect(()=>createHubEntitlementChecker({baseUrl:'http://hub',secret:'x'})).toThrow();
    const transport=vi.fn().mockResolvedValueOnce({ok:true,json:async()=>({allowed:false,validForSeconds:30})})
      .mockResolvedValueOnce({ok:true,json:async()=>({allowed:true,validForSeconds:1})});
    const check=createHubEntitlementChecker({baseUrl:'http://hub.internal:3040',secret,transport});
    expect(await check(id)).toBe(false);
    expect(await check(id)).toBe(true);
    expect(transport).toHaveBeenCalledTimes(2);
  });
});
