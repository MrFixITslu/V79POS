/**
 * Read-only ticket profitability from reconciled, source-owned snapshots.
 * This does not issue stock, send invoices or trust client-supplied API identity.
 * Monetary amounts are integer minor units (e.g. XCD cents), excluding tax.
 */
export type TicketMaterialEvent = {
  eventId: string;
  tenantId: string;
  ticketId: string;
  currency: string;
  type: 'SERVICE_ISSUE' | 'SERVICE_RETURN';
  fifoCostMinor: number;
  posted: boolean;
};

export type TicketLabourEntry = {
  entryId: string;
  tenantId: string;
  ticketId: string;
  minutes: number;
  costRateMinorPerHour: number;
  approved: boolean;
};

export type TicketCostSnapshot = {
  tenantId: string;
  ticketId: string;
  currency: string;
  revenueExTaxMinor: number | null;
  revenueVerified: boolean;
  materialsReconciled: boolean;
  labourReconciled: boolean;
  otherCostsExTaxMinor: number | null;
  materialEvents: TicketMaterialEvent[];
  labourEntries: TicketLabourEntry[];
};

export type TicketCostResult = {
  status: 'READY' | 'INCOMPLETE';
  reasons: string[];
  currency: string;
  ticketId: string;
  revenueExTaxMinor: number | null;
  materialCostMinor: number | null;
  labourCostMinor: number | null;
  otherCostsExTaxMinor: number | null;
  totalCostMinor: number | null;
  grossProfitMinor: number | null;
  grossMarginPercent: number | null;
};

function checkedMoney(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${field} must be a non-negative safe integer in minor units`);
  return value;
}

function checkedIdentity(id: string, field: string): void {
  if (typeof id !== 'string' || id.trim().length === 0) throw new Error(`${field} is required`);
}

function safeAmount(value: bigint, field: string): number {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`${field} is outside safe money limits`);
  return Number(value);
}

/** A finalised snapshot must carry explicit reconciliation signals from each owner. */
export function calculateTicketCost(snapshot: TicketCostSnapshot): TicketCostResult {
  checkedIdentity(snapshot.tenantId, 'tenantId');
  checkedIdentity(snapshot.ticketId, 'ticketId');
  if (!/^[A-Z]{3}$/.test(snapshot.currency)) throw new Error('currency must be a three-letter ISO code');
  if (!Array.isArray(snapshot.materialEvents) || !Array.isArray(snapshot.labourEntries)) {
    throw new Error('materialEvents and labourEntries must be arrays');
  }
  if (snapshot.revenueExTaxMinor !== null) checkedMoney(snapshot.revenueExTaxMinor, 'revenueExTaxMinor');
  if (snapshot.otherCostsExTaxMinor !== null) checkedMoney(snapshot.otherCostsExTaxMinor, 'otherCostsExTaxMinor');
  if (snapshot.revenueVerified && snapshot.revenueExTaxMinor === null) {
    throw new Error('Verified revenue must have an explicit amount, including zero');
  }

  const reasons: string[] = [];
  if (!snapshot.revenueVerified || snapshot.revenueExTaxMinor === null) reasons.push('revenue_unverified');
  if (!snapshot.materialsReconciled) reasons.push('materials_not_reconciled');
  if (!snapshot.labourReconciled) reasons.push('labour_not_reconciled');
  if (snapshot.otherCostsExTaxMinor === null) reasons.push('other_costs_not_reconciled');

  let materialCents = 0n;
  let pendingMaterials = false;
  const seenMaterials = new Map<string, string>();
  for (const event of snapshot.materialEvents) {
    checkedIdentity(event.eventId, 'material eventId');
    if (event.tenantId !== snapshot.tenantId || event.ticketId !== snapshot.ticketId || event.currency !== snapshot.currency) {
      throw new Error('Material event tenant, ticket or currency mismatch');
    }
    if (event.type !== 'SERVICE_ISSUE' && event.type !== 'SERVICE_RETURN') throw new Error('Invalid service material movement');
    checkedMoney(event.fifoCostMinor, 'fifoCostMinor');
    const identity = JSON.stringify([event.tenantId, event.ticketId, event.currency, event.type, event.fifoCostMinor, event.posted]);
    const existing = seenMaterials.get(event.eventId);
    if (existing !== undefined) {
      if (existing !== identity) throw new Error('Conflicting payload for duplicate material event');
      continue; // Exact retry is counted only once.
    }
    seenMaterials.set(event.eventId, identity);
    if (!event.posted) { pendingMaterials = true; continue; }
    materialCents += BigInt(event.fifoCostMinor) * (event.type === 'SERVICE_RETURN' ? -1n : 1n);
  }
  if (pendingMaterials) reasons.push('pending_material_movements');
  if (materialCents < 0n) throw new Error('Material returns exceed issued FIFO costs');

  let labourCents = 0n;
  let pendingLabour = false;
  const seenLabour = new Map<string, string>();
  for (const entry of snapshot.labourEntries) {
    checkedIdentity(entry.entryId, 'labour entryId');
    if (entry.tenantId !== snapshot.tenantId || entry.ticketId !== snapshot.ticketId) {
      throw new Error('Labour entry tenant or ticket mismatch');
    }
    if (!Number.isSafeInteger(entry.minutes) || entry.minutes < 0) throw new Error('minutes must be a non-negative safe integer');
    checkedMoney(entry.costRateMinorPerHour, 'costRateMinorPerHour');
    const identity = JSON.stringify([entry.tenantId, entry.ticketId, entry.minutes, entry.costRateMinorPerHour, entry.approved]);
    const existing = seenLabour.get(entry.entryId);
    if (existing !== undefined) {
      if (existing !== identity) throw new Error('Conflicting payload for duplicate labour entry');
      continue;
    }
    seenLabour.set(entry.entryId, identity);
    if (!entry.approved) { pendingLabour = true; continue; }
    // Nearest minor unit, half up; never use floats for payroll/cost arithmetic.
    labourCents += (BigInt(entry.minutes) * BigInt(entry.costRateMinorPerHour) + 30n) / 60n;
  }
  if (pendingLabour) reasons.push('unapproved_labour');

  const materialCostMinor = !snapshot.materialsReconciled || pendingMaterials ? null : safeAmount(materialCents, 'material cost');
  const labourCostMinor = !snapshot.labourReconciled || pendingLabour ? null : safeAmount(labourCents, 'labour cost');
  const revenueExTaxMinor = snapshot.revenueVerified ? snapshot.revenueExTaxMinor : null;
  const ready = reasons.length === 0;
  const total = ready ? safeAmount(materialCents + labourCents + BigInt(snapshot.otherCostsExTaxMinor!), 'total cost') : null;
  const profit = ready ? safeAmountSigned(BigInt(snapshot.revenueExTaxMinor!) - BigInt(total!), 'gross profit') : null;
  const revenue = snapshot.revenueExTaxMinor;
  // Percentage is informational; all monetary arithmetic remains in integer minor units.
  const grossMarginPercent = ready && revenue !== null && revenue > 0 ? Math.round((profit! / revenue) * 10_000) / 100 : null;
  return {
    status: ready ? 'READY' : 'INCOMPLETE', reasons, currency: snapshot.currency, ticketId: snapshot.ticketId,
    revenueExTaxMinor, materialCostMinor, labourCostMinor,
    otherCostsExTaxMinor: snapshot.otherCostsExTaxMinor, totalCostMinor: total,
    grossProfitMinor: profit, grossMarginPercent
  };
}

function safeAmountSigned(value: bigint, field: string): number {
  if (value < -BigInt(Number.MAX_SAFE_INTEGER) || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`${field} is outside safe money limits`);
  }
  return Number(value);
}
