import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import Fastify from "fastify";

const fixture = vi.hoisted(() => ({
  findMembership: vi.fn(),
  checkEntitlement: vi.fn(),
}));
vi.mock("../../lib/prisma.js", () => ({
  prisma: { membership: { findUnique: fixture.findMembership } },
}));
vi.mock("../../lib/config.js", () => ({
  config: {
    NODE_ENV:"test",AUTH_MODE:"hub",
    JWT_ISSUER:"https://hub.invalid.example",
    JWT_AUDIENCE:"v79-commerce",
    HUB_JWKS_URL:"http://127.0.0.1:1/.well-known/jwks.json",
    HUB_INTERNAL_URL:"http://127.0.0.1:1",
    ENCRYPTION_KEY:"pos-staging-session-key-32-character-long",
    V79_PLATFORM_SHARED_SECRET:"pos-staging-platform-key-32-characters",
    V79_POS_PLATFORM_SHARED_SECRET:"",
    V79_ENTITLEMENT_RECHECK_ENABLED:"1",
    POS_SESSION_HOURS:8,
    POS_PUBLIC_URL:"https://pos.v79sl.com",
  },
}));
vi.mock("../../lib/hubEntitlement.js", () => ({
  createHubEntitlementChecker: () => fixture.checkEntitlement,
}));

describe.sequential("POS actual Fastify authentication middleware", () => {
  let app:any;
  let issueSession:any;
  let sessionA:string;
  let sessionB:string;
  beforeAll(async () => {
    fixture.findMembership.mockImplementation(async ({where}:any) => {
      const {tenantId,userId}=where.tenantId_userId;
      if ((tenantId==="customer-a" && userId==="scoped-a") ||
          (tenantId==="customer-b" && userId==="scoped-b")) {
        return {
          id:"membership-"+tenantId,active:true,
          roleKey:"OWNER",
          tenant:{active:true},
          role:{permissions:[]},
          locationAccess:[],
        };
      }
      return null;
    });
    fixture.checkEntitlement.mockResolvedValue(true);
    const { registerAuth, issuePosSession } = await import("./plugin.js");
    issueSession=issuePosSession;
    app=Fastify();
    await registerAuth(app);
    app.get("/v1/staging-private",async(request:any)=>({
      owner:request.auth.userId,tenant:request.auth.tenantId
    }));
    await app.ready();
    sessionA=await issueSession("scoped-a","customer-a");
    sessionB=await issueSession("scoped-b","customer-b");
  });
  afterAll(async()=>{if(app)await app.close();});
  const run=async(token:string,tenantId:string)=>app.inject({
    method:"GET",url:"/v1/staging-private",
    headers:{cookie:"v79_pos_session="+encodeURIComponent(token),"x-v79-tenant-id":tenantId},
  });
  it("accepts a signed session with verified Hub entitlement",async()=>{
    const r=await run(sessionA,"customer-a");
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({owner:"scoped-a",tenant:"customer-a"});
    expect(fixture.checkEntitlement).toHaveBeenCalledWith({
      organizationId:"customer-a",scopedUserId:"scoped-a"
    });
  });
  it("isolates another customer with their own session",async()=>{
    const r=await run(sessionB,"customer-b");
    expect(r.statusCode).toBe(200);
    expect(r.json().tenant).toBe("customer-b");
  });
  it("denies a signed session selecting another tenant",async()=>{
    const r=await run(sessionA,"customer-b");
    expect(r.statusCode).toBe(401);
  });
  it("denies a revoked entitlement despite a valid POS session",async()=>{
    fixture.checkEntitlement.mockResolvedValue(false);
    const r=await run(sessionA,"customer-a");
    expect(r.statusCode).toBe(401);
    fixture.checkEntitlement.mockResolvedValue(true);
  });
  it("denies an unavailable Hub without trusting the old session",async()=>{
    fixture.checkEntitlement.mockRejectedValueOnce(new Error("staging hub down"));
    const r=await run(sessionA,"customer-a");
    expect(r.statusCode).toBeGreaterThanOrEqual(400);
    expect(r.statusCode).toBeLessThan(500);
  });
  it("denies sessions after membership deactivation",async()=>{
    fixture.findMembership.mockResolvedValueOnce(null);
    const r=await run(sessionA,"customer-a");
    expect(r.statusCode).toBe(401);
  });
});
