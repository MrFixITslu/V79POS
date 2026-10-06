import type { FastifyInstance } from 'fastify';
import { CashMovementType, PaymentMethod, PaymentStatus, Prisma, RegisterSessionStatus } from '@prisma/client';
import { z } from 'zod';
import { calculateExpectedCash } from '@v79/commerce-domain';
import { prisma } from '../../lib/prisma.js';
import { serializable } from '../../lib/transactions.js';
import { conflict, notFound } from '../../lib/errors.js';
import { assertLocationAccess, requirePermission } from '../auth/context.js';
import { writeAudit } from '../../lib/audit.js';

const D = (v: Prisma.Decimal.Value) => new Prisma.Decimal(v);

async function expectedCash(tx: Prisma.TransactionClient, sessionId: string) {
  const session = await tx.registerSession.findUnique({ where: { id: sessionId } });
  if (!session) throw notFound('Register session not found');

  const cashPayments = await tx.payment.aggregate({
    where: { registerSessionId: sessionId, method: PaymentMethod.CASH, status: { in: [PaymentStatus.COMPLETED, PaymentStatus.PARTIALLY_REFUNDED] } },
    _sum: { amount: true }
  });
  const salesWithCash = await tx.sale.findMany({
    where: { registerSessionId: sessionId, status: { in: ['COMPLETED','PARTIALLY_REFUNDED','REFUNDED'] }, payments: { some: { registerSessionId: sessionId, method: PaymentMethod.CASH } } },
    select: { changeDue: true }
  });
  const refunds = await tx.refund.aggregate({
    where: { saleReturn: { sale: { registerSessionId: sessionId } }, method: PaymentMethod.CASH },
    _sum: { amount: true }
  });
  const movements = await tx.cashMovement.findMany({ where: { registerSessionId: sessionId } });

  const expected = calculateExpectedCash({
    openingFloat: session.openingFloat.toNumber(),
    cashPayments: (cashPayments._sum.amount ?? D(0)).toNumber(),
    changeGiven: salesWithCash.reduce((sum, sale) => sum.plus(sale.changeDue), D(0)).toNumber(),
    cashRefunds: (refunds._sum.amount ?? D(0)).toNumber(),
    movements: movements.map(movement => ({ type: movement.type, amount: movement.amount.toNumber() }))
  });
  return D(expected);
}

export async function registerRoutes(app: FastifyInstance) {
  app.get('/v1/registers', { preHandler: requirePermission('register.read') }, async request => ({
    registers: await prisma.register.findMany({
      where: { tenantId: request.auth.tenantId, active: true, ...(request.auth.allLocations ? {} : { locationId: { in: [...request.auth.locationIds] } }) },
      include: { location: true, sessions: { where: { status: RegisterSessionStatus.OPEN }, take: 1 } },
      orderBy: { name: 'asc' }
    })
  }));

  app.post('/v1/registers/:id/open', { preHandler: requirePermission('register.open') }, async request => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const body = z.object({ openingFloat: z.coerce.number().min(0).default(0) }).parse(request.body ?? {});
    return serializable(async tx => {
      const register = await tx.register.findFirst({ where: { id, tenantId: request.auth.tenantId, active: true } });
      if (!register) throw notFound('Register not found');
      assertLocationAccess(request, register.locationId);
      const existing = await tx.registerSession.findFirst({ where: { registerId: id, status: RegisterSessionStatus.OPEN } });
      if (existing) throw conflict('This register already has an open session');
      const session = await tx.registerSession.create({ data: {
        tenantId: request.auth.tenantId, registerId: id, locationId: register.locationId,
        openedBy: request.auth.userId, openingFloat: body.openingFloat
      }});
      await writeAudit(tx, { tenantId: request.auth.tenantId, actorUserId: request.auth.userId, action: 'register.opened', resourceType: 'RegisterSession', resourceId: session.id, after: { registerId: id, openingFloat: body.openingFloat } });
      return session;
    });
  });

  app.get('/v1/registers/:id/current-session', { preHandler: requirePermission('register.read') }, async request => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const register = await prisma.register.findFirst({ where: { id, tenantId: request.auth.tenantId, active: true } });
    if (!register) throw notFound('Register not found');
    assertLocationAccess(request, register.locationId);
    const session = await prisma.registerSession.findFirst({ where: { registerId: id, status: RegisterSessionStatus.OPEN }, include: { cashMovements: true } });
    if (!session) return { session: null };
    const expected = await prisma.$transaction(tx => expectedCash(tx, session.id));
    return { session, expectedCash: expected };
  });

  app.post('/v1/register-sessions/:id/cash-movements', { preHandler: requirePermission('register.cash') }, async request => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const body = z.object({ type: z.enum(['PAID_IN','PAID_OUT','CASH_DROP','CASH_PICKUP']), amount: z.coerce.number().positive(), reason: z.string().min(2).max(300) }).parse(request.body);
    return serializable(async tx => {
      const session = await tx.registerSession.findFirst({ where: { id, tenantId: request.auth.tenantId, status: RegisterSessionStatus.OPEN } });
      if (!session) throw notFound('Open register session not found');
      assertLocationAccess(request, session.locationId);
      const movement = await tx.cashMovement.create({ data: { tenantId: request.auth.tenantId, registerSessionId: id, type: CashMovementType[body.type], amount: body.amount, reason: body.reason, performedBy: request.auth.userId } });
      await writeAudit(tx, { tenantId: request.auth.tenantId, actorUserId: request.auth.userId, action: 'register.cash_movement', resourceType: 'CashMovement', resourceId: movement.id, after: body });
      return movement;
    });
  });

  app.post('/v1/register-sessions/:id/close', { preHandler: requirePermission('register.close') }, async request => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const body = z.object({ closingCash: z.coerce.number().min(0), notes: z.string().max(1000).optional(), denominationCount: z.record(z.string(), z.coerce.number().min(0)).optional() }).parse(request.body);
    return serializable(async tx => {
      const session = await tx.registerSession.findFirst({ where: { id, tenantId: request.auth.tenantId, status: RegisterSessionStatus.OPEN } });
      if (!session) throw notFound('Open register session not found');
      assertLocationAccess(request, session.locationId);
      const expected = await expectedCash(tx, id);
      const variance = D(body.closingCash).minus(expected);
      const closed = await tx.registerSession.update({ where: { id }, data: {
        status: RegisterSessionStatus.CLOSED, closedBy: request.auth.userId, closedAt: new Date(), closingCash: body.closingCash,
        expectedCash: expected, cashVariance: variance, closingNotes: body.notes, denominationCount: body.denominationCount ?? undefined
      }});
      await writeAudit(tx, { tenantId: request.auth.tenantId, actorUserId: request.auth.userId, action: 'register.closed', resourceType: 'RegisterSession', resourceId: id, after: { expectedCash: expected.toString(), closingCash: body.closingCash, variance: variance.toString() } });
      return closed;
    });
  });

  app.get('/v1/register-sessions/:id/reconciliation', { preHandler: requirePermission('register.read') }, async request => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const session = await prisma.registerSession.findFirst({ where: { id, tenantId: request.auth.tenantId }, include: { register: true, sales: { include: { payments: true, returns: { include: { refunds: true } } } }, cashMovements: true } });
    if (!session) throw notFound('Register session not found');
    assertLocationAccess(request, session.locationId);
    return { session };
  });
}
