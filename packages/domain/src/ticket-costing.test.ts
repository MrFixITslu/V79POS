import { describe, expect, it } from 'vitest';
import { calculateTicketCost, type TicketCostSnapshot } from './ticket-costing.js';

const baseline = (): TicketCostSnapshot => ({
  tenantId: 'tenant-a', ticketId: 'ticket-1', currency: 'XCD',
  revenueExTaxMinor: 30000, revenueVerified: true, materialsReconciled: true, labourReconciled: true,
  otherCostsExTaxMinor: 500,
  materialEvents: [{ eventId: 'issue-1', tenantId: 'tenant-a', ticketId: 'ticket-1', currency: 'XCD', type: 'SERVICE_ISSUE', fifoCostMinor: 7000, posted: true }],
  labourEntries: [{ entryId: 'time-1', tenantId: 'tenant-a', ticketId: 'ticket-1', minutes: 90, costRateMinorPerHour: 4000, approved: true }]
});

describe('calculateTicketCost', () => {
  it('computes genuine net service margin from reconciled amounts', () => {
    expect(calculateTicketCost(baseline())).toMatchObject({
      status: 'READY', revenueExTaxMinor: 30000, materialCostMinor: 7000,
      labourCostMinor: 6000, totalCostMinor: 13500, grossProfitMinor: 16500, grossMarginPercent: 55
    });
  });
  it('deduplicates exact material and labour event retries', () => {
    const input = baseline();
    input.materialEvents.push({ ...input.materialEvents[0] });
    input.labourEntries.push({ ...input.labourEntries[0] });
    expect(calculateTicketCost(input).totalCostMinor).toBe(13500);
  });
  it('rejects changed payloads with reused event identifiers', () => {
    const input = baseline();
    input.materialEvents.push({ ...input.materialEvents[0], fifoCostMinor: 9000 });
    expect(() => calculateTicketCost(input)).toThrow('Conflicting payload');
  });
  it('does not count incomplete or unapproved work as an actual margin', () => {
    const input = baseline();
    input.materialEvents[0].posted = false;
    input.labourEntries[0].approved = false;
    const result = calculateTicketCost(input);
    expect(result.status).toBe('INCOMPLETE');
    expect(result.totalCostMinor).toBeNull();
    expect(result.grossProfitMinor).toBeNull();
    expect(result.reasons).toContain('pending_material_movements');
    expect(result.reasons).toContain('unapproved_labour');
  });
  it('rejects cross-tenant materials and mismatched currencies', () => {
    const wrongTenant = baseline();
    wrongTenant.materialEvents[0].tenantId = 'tenant-b';
    expect(() => calculateTicketCost(wrongTenant)).toThrow('mismatch');
    const wrongCurrency = baseline();
    wrongCurrency.materialEvents[0].currency = 'USD';
    expect(() => calculateTicketCost(wrongCurrency)).toThrow('mismatch');
  });
  it('supports a return and prevents returned cost exceeding issued cost', () => {
    const input = baseline();
    input.materialEvents.push({ eventId: 'return-1', tenantId: 'tenant-a', ticketId: 'ticket-1', currency: 'XCD', type: 'SERVICE_RETURN', fifoCostMinor: 3000, posted: true });
    expect(calculateTicketCost(input).materialCostMinor).toBe(4000);
    input.materialEvents[1].fifoCostMinor = 8000;
    expect(() => calculateTicketCost(input)).toThrow('returns exceed');
  });
  it('never silently treats missing revenue, materials, labour or other costs as zero', () => {
    const input = baseline();
    input.revenueVerified = false;
    input.materialsReconciled = false;
    input.labourReconciled = false;
    input.otherCostsExTaxMinor = null;
    expect(calculateTicketCost(input)).toMatchObject({status:'INCOMPLETE',totalCostMinor:null,grossProfitMinor:null});
  });
  it('handles zero revenue as a loss without inventing a margin percentage', () => {
    const input = baseline();
    input.revenueExTaxMinor = 0;
    expect(calculateTicketCost(input)).toMatchObject({ status: 'READY', grossProfitMinor: -13500, grossMarginPercent: null });
  });
  it('calculates labour minutes deterministically using integer minor units', () => {
    const input = baseline();
    input.labourEntries = [{ ...input.labourEntries[0], minutes: 1, costRateMinorPerHour: 100 }];
    expect(calculateTicketCost(input).labourCostMinor).toBe(2);
  });
});
