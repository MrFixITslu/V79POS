import type { FastifyInstance } from 'fastify';
import { promisify } from 'node:util';
import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { CommissionBasis, ShiftStatus } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { conflict, notFound } from '../../lib/errors.js';
import { assertLocationAccess, requirePermission } from '../auth/context.js';
import { issueCashierProof } from '../../lib/cashier-proof.js';
const scrypt=promisify(scryptCb);
async function hashPin(pin:string,salt:string){return (await scrypt(pin,salt,32) as Buffer).toString('base64url');}

export async function workforceRoutes(app: FastifyInstance) {
  app.get('/v1/workforce/profiles', { preHandler: requirePermission('team.read') }, async request=>{
    const locationIds=[...request.auth.locationIds];
    return {profiles:await prisma.teamProfile.findMany({
      where:{
        tenantId:request.auth.tenantId,
        active:true,
        ...(request.auth.allLocations?{}:{membership:{locationAccess:{some:{locationId:{in:locationIds}}}}})
      },
      select:{id:true,tenantId:true,membershipId:true,userId:true,employeeCode:true,displayName:true,hourlyRate:true,commissionBasis:true,commissionRate:true,active:true,createdAt:true,updatedAt:true},
      orderBy:{displayName:'asc'}
    })};
  });
  app.put('/v1/workforce/profiles/:userId', { preHandler: requirePermission('team.write') }, async request=>{
    const {userId}=z.object({userId:z.string()}).parse(request.params);const body=z.object({employeeCode:z.string().min(2).max(50),displayName:z.string().min(1).max(160),hourlyRate:z.coerce.number().nonnegative().optional(),commissionBasis:z.enum(['REVENUE','GROSS_PROFIT']).nullable().optional(),commissionRate:z.coerce.number().min(0).max(1).nullable().optional(),pin:z.string().regex(/^\d{4,8}$/).optional()}).parse(request.body);
    const membership=await prisma.membership.findUnique({where:{tenantId_userId:{tenantId:request.auth.tenantId,userId}}});if(!membership) throw notFound('Team member not found');
    let pinSalt: string|undefined, pinHash:string|undefined;if(body.pin){const salt=randomBytes(16).toString('base64url');pinSalt=salt;pinHash=await hashPin(body.pin,salt);}
    return prisma.teamProfile.upsert({
      where:{membershipId:membership.id},
      create:{tenantId:request.auth.tenantId,membershipId:membership.id,userId,employeeCode:body.employeeCode,displayName:body.displayName,hourlyRate:body.hourlyRate,commissionBasis:body.commissionBasis?CommissionBasis[body.commissionBasis]:undefined,commissionRate:body.commissionRate,pinSalt,pinHash},
      update:{employeeCode:body.employeeCode,displayName:body.displayName,hourlyRate:body.hourlyRate,commissionBasis:body.commissionBasis===null?null:body.commissionBasis?CommissionBasis[body.commissionBasis]:undefined,commissionRate:body.commissionRate,pinSalt,pinHash},
      select:{id:true,tenantId:true,membershipId:true,userId:true,employeeCode:true,displayName:true,hourlyRate:true,commissionBasis:true,commissionRate:true,active:true,createdAt:true,updatedAt:true}
    });
  });
  app.post('/v1/workforce/pin/verify', { config:{rateLimit:{max:10,timeWindow:'1 minute'}}, preHandler: requirePermission('sales.create') }, async request=>{
    const body=z.object({employeeCode:z.string(),pin:z.string().regex(/^\d{4,8}$/),locationId:z.string()}).parse(request.body);assertLocationAccess(request,body.locationId);
    const profile=await prisma.teamProfile.findUnique({where:{tenantId_employeeCode:{tenantId:request.auth.tenantId,employeeCode:body.employeeCode}},include:{membership:{include:{locationAccess:true}}}});if(!profile?.active||!profile.pinSalt||!profile.pinHash||!profile.membership.active) throw notFound('Active cashier profile not found');
    const allowed=profile.membership.roleKey==='OWNER'||profile.membership.roleKey==='ADMIN'||profile.membership.locationAccess.some(l=>l.locationId===body.locationId);if(!allowed) throw conflict('Employee is not assigned to this location');
    const candidate=Buffer.from(await hashPin(body.pin,profile.pinSalt),'base64url'), expected=Buffer.from(profile.pinHash,'base64url');if(candidate.length!==expected.length||!timingSafeEqual(candidate,expected)) throw conflict('Invalid PIN');
    return {verified:true,userId:profile.userId,displayName:profile.displayName,employeeCode:profile.employeeCode,proof:issueCashierProof({tenantId:request.auth.tenantId,locationId:body.locationId,userId:profile.userId})};
  });
  app.post('/v1/shifts/clock-in', { preHandler: requirePermission('shifts.use') }, async request=>{const body=z.object({locationId:z.string(),notes:z.string().max(500).optional()}).parse(request.body);assertLocationAccess(request,body.locationId);const open=await prisma.shift.findFirst({where:{tenantId:request.auth.tenantId,userId:request.auth.userId,status:ShiftStatus.OPEN}});if(open) throw conflict('User already has an open shift');return prisma.shift.create({data:{tenantId:request.auth.tenantId,userId:request.auth.userId,locationId:body.locationId,notes:body.notes}});});
  app.post('/v1/shifts/:id/clock-out', { preHandler: requirePermission('shifts.use') }, async request=>{const {id}=z.object({id:z.string()}).parse(request.params);const body=z.object({breakMinutes:z.coerce.number().int().min(0).max(1440).default(0),notes:z.string().max(500).optional()}).parse(request.body??{});const shift=await prisma.shift.findFirst({where:{id,tenantId:request.auth.tenantId,userId:request.auth.userId,status:ShiftStatus.OPEN}});if(!shift) throw notFound('Open shift not found');return prisma.shift.update({where:{id},data:{status:ShiftStatus.CLOSED,clockedOutAt:new Date(),breakMinutes:body.breakMinutes,notes:body.notes??shift.notes}});});
  app.get('/v1/shifts', { preHandler: requirePermission('team.read') }, async request=>({shifts:await prisma.shift.findMany({where:{tenantId:request.auth.tenantId,...(request.auth.allLocations?{}:{locationId:{in:[...request.auth.locationIds]}})},orderBy:{clockedInAt:'desc'},take:200})}));
  app.get('/v1/commissions', { preHandler: requirePermission('reports.read') }, async request=>{const q=z.object({userId:z.string().optional(),from:z.coerce.date().optional(),to:z.coerce.date().optional()}).parse(request.query);const rows=await prisma.commissionEntry.findMany({where:{tenantId:request.auth.tenantId,userId:q.userId,createdAt:{gte:q.from,lte:q.to},...(request.auth.allLocations?{}:{sale:{locationId:{in:[...request.auth.locationIds]}}})},include:{sale:{select:{number:true,completedAt:true}}},orderBy:{createdAt:'desc'}});return {entries:rows,total:rows.reduce((a,r)=>a+r.amount.minus(r.reversedAmount).toNumber(),0)};});
}
