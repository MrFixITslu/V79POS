import type { FastifyRequest } from 'fastify';
import { forbidden } from '../../lib/errors.js';

export type AuthContext = {
  userId: string;
  tenantId: string;
  membershipId: string;
  roleKey: string;
  permissions: Set<string>;
  locationIds: Set<string>;
  allLocations: boolean;
};

declare module 'fastify' { interface FastifyRequest { auth: AuthContext; } }

const builtIn: Record<string, string[]> = {
  OWNER: ['*'],
  ADMIN: ['*'],
  MANAGER: [
    'catalogue.read','catalogue.write','inventory.read','inventory.adjust','inventory.transfer','inventory.count','inventory.count.approve',
    'sales.create','sales.read','sales.refund','sales.discount','orders.read','orders.write','register.read','register.open','register.close','register.cash',
    'customers.read','customers.write','pricing.read','pricing.write','loyalty.manage','store_credit.adjust','gift_card.issue','gift_card.read',
    'payments.manage','devices.manage','integrations.manage','procurement.read','procurement.write','procurement.approve','receiving.write',
    'replenishment.read','replenishment.run','replenishment.manage','logistics.read','logistics.write','fulfillment.read','fulfillment.write','fulfillment.dispatch',
    'team.read','team.write','shifts.use','reports.read','audit.read'
  ],
  SUPERVISOR: [
    'catalogue.read','inventory.read','inventory.transfer','inventory.count','sales.create','sales.read','sales.refund','sales.discount',
    'orders.read','orders.write','register.read','register.open','register.close','register.cash','customers.read','customers.write','pricing.read',
    'gift_card.issue','gift_card.read','fulfillment.read','fulfillment.write','fulfillment.dispatch','team.read','shifts.use','reports.read'
  ],
  CASHIER: [
    'catalogue.read','inventory.read','sales.create','sales.read','orders.read','orders.write','register.read','register.open','register.close',
    'customers.read','customers.write','pricing.read','gift_card.read','fulfillment.read','fulfillment.write','shifts.use'
  ],
  INVENTORY: ['catalogue.read','inventory.read','inventory.adjust','inventory.transfer','inventory.count','receiving.write','procurement.read','replenishment.read','replenishment.manage','logistics.read','fulfillment.read','fulfillment.write','shifts.use'],
  PURCHASING: ['catalogue.read','inventory.read','procurement.read','procurement.write','replenishment.read','replenishment.run','replenishment.manage','logistics.read','logistics.write','reports.read','shifts.use'],
  FINANCE: ['sales.read','orders.read','procurement.read','reports.read','audit.read'],
  DELIVERY: ['fulfillment.read','fulfillment.dispatch','shifts.use'],
  TECHNICIAN: ['inventory.technician','shifts.use'],
  AUDITOR: ['sales.read','orders.read','inventory.read','procurement.read','reports.read','audit.read']
};

export function hasPermission(auth: AuthContext, permission: string) { return auth.permissions.has('*') || auth.permissions.has(permission); }
export function builtInPermissions(roleKey: string) { return builtIn[roleKey] ?? []; }
export function builtInRoleKeys() { return Object.keys(builtIn); }
export function requirePermission(permission: string) { return async (request: FastifyRequest) => { if (!hasPermission(request.auth, permission)) throw forbidden(`Missing permission: ${permission}`); }; }
export function assertLocationAccess(request: FastifyRequest, locationId: string) { if (!request.auth.allLocations && !request.auth.locationIds.has(locationId)) throw forbidden('You do not have access to this location'); }
