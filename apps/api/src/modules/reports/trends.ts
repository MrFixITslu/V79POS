import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { assertLocationAccess, requirePermission } from '../auth/context.js';
import { notFound } from '../../lib/errors.js';
import { completedBuckets, bucketFor, relativeChange, type ReportPeriod } from './periods.js';

export const reportQuery = z.object({
  period: z.enum(['week', 'month', 'year']).default('week'),
  locationId: z.string().min(1).optional()
});
export type KpiCode = 'netSales' | 'salesCount' | 'refunds' | 'stockReceived' | 'technicianIssues' |
  'technicianUses' | 'jobsSupported' | 'goodReturns' | 'faultyReturns' | 'stockLosses';

export const reportKpis: { key: KpiCode; label: string; unit: 'XCD' | 'units' | 'count'; description: string }[] = [
  { key: 'netSales', label: 'Net sales (incl. tax)', unit: 'XCD', description: 'Completed sale totals minus returns recorded during the period; return dates may differ from original sale dates.' },
  { key: 'salesCount', label: 'Completed sales', unit: 'count', description: 'Sales completed in the period, excluding voided transactions.' },
  { key: 'refunds', label: 'Refunds and returns', unit: 'XCD', description: 'Value of completed sale returns recorded in the period.' },
  { key: 'stockReceived', label: 'Supplier stock received', unit: 'units', description: 'Quantity posted by purchase receipt transactions; excludes technician and store transfers.' },
  { key: 'technicianIssues', label: 'Issued to technicians', unit: 'units', description: 'Quantity on technician issue transfers fully received during the period.' },
  { key: 'technicianUses', label: 'Equipment used on jobs', unit: 'units', description: 'Quantity recorded by technicians against jobs in the period.' },
  { key: 'jobsSupported', label: 'Jobs supported', unit: 'count', description: 'Distinct job references with recorded technician stock use in the period.' },
  { key: 'goodReturns', label: 'Good equipment returned', unit: 'units', description: 'Quantity on good technician return transfers received by a warehouse.' },
  { key: 'faultyReturns', label: 'Faulty equipment returned', unit: 'units', description: 'Quantity on faulty technician return transfers received and quarantined by a warehouse.' },
  { key: 'stockLosses', label: 'Stock losses / damage flags', unit: 'units', description: 'Adjustment losses, damage and expiry movements posted in the period. Flags are not equivalent to financial write-offs.' }
];
const values = (): Record<KpiCode, number> => ({
  netSales: 0, salesCount: 0, refunds: 0, stockReceived: 0, technicianIssues: 0,
  technicianUses: 0, jobsSupported: 0, goodReturns: 0, faultyReturns: 0, stockLosses: 0
});

export async function buildTrends(request: FastifyRequest, period: ReportPeriod, locationId?: string) {
  if (locationId) assertLocationAccess(request, locationId);
  const tenantId = request.auth.tenantId;
  // An owner has broad location permission, but requested IDs must still belong
  // to the authenticated tenant (never silently accept foreign identifiers).
  if (locationId) {
    const ownLocation = await prisma.location.findFirst({
      where: { id: locationId, tenantId, active: true }, select: { id: true }
    });
    if (!ownLocation) throw notFound('Reporting location was not found');
  }
  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId }, select: { timezone: true, currency: true, name: true }
  });
  if (!tenant) throw new Error('The organisation could not be found');
  const timeZone = tenant.timezone;
  const numberOfPeriods = period === 'year' ? 5 : 12;
  const buckets = completedBuckets(period, numberOfPeriods, timeZone);
  const from = buckets[0].from;
  const to = buckets[buckets.length - 1].to;
  const allowedLocations = locationId ? [locationId] :
    request.auth.allLocations ? null : [...request.auth.locationIds];
  const allowed = allowedLocations ? { locationId: { in: allowedLocations } } : {};
  const transfersInRange = { tenantId, status: 'RECEIVED' as const, receivedAt: { gte: from, lt: to } };
  const target = allowedLocations ? { toLocationId: { in: allowedLocations } } : {};
  const source = allowedLocations ? { fromLocationId: { in: allowedLocations } } : {};

  // Every query is tenant-scoped; location-restricted users see only their assigned scope.
  const [sales, returns, ledger, transfers, uses, currentStock, outstanding, exceptions] = await Promise.all([
    prisma.sale.findMany({
      where: { tenantId, ...allowed, completedAt: { gte: from, lt: to },
        status: { in: ['COMPLETED', 'PARTIALLY_REFUNDED', 'REFUNDED'] } },
      select: { completedAt: true, total: true }
    }),
    prisma.saleReturn.findMany({
      where: { tenantId, status: 'COMPLETED', createdAt: { gte: from, lt: to },
        ...(allowedLocations ? { sale: { locationId: { in: allowedLocations } } } : {}) },
      select: { createdAt: true, total: true }
    }),
    prisma.inventoryLedger.findMany({
      where: { tenantId, ...allowed, createdAt: { gte: from, lt: to },
        movementType: { in: ['PURCHASE_RECEIPT', 'ADJUSTMENT_LOSS', 'DAMAGE', 'EXPIRY'] } },
      select: { createdAt: true, deltaQty: true, movementType: true }
    }),
    prisma.stockTransfer.findMany({
      where: { ...transfersInRange, OR: [
        { purpose: 'TECHNICIAN_ISSUE', ...source },
        { purpose: 'TECHNICIAN_RETURN_GOOD', ...target },
        { purpose: 'TECHNICIAN_RETURN_FAULTY', ...target }
      ] },
      select: { purpose: true, receivedAt: true, lines: { select: { quantity: true } } }
    }),
    prisma.technicianUsage.findMany({
      where: { tenantId, ...allowed, createdAt: { gte: from, lt: to } },
      select: { createdAt: true, quantity: true, jobReference: true }
    }),
    prisma.inventoryBalance.findMany({
      where: { tenantId, ...allowed },
      select: { onHand: true, quarantined: true, damaged: true, expired: true,
        reserved: true, committed: true }
    }),
    prisma.stockTransfer.count({
      where: { tenantId, status: { in: ['REQUESTED', 'APPROVED', 'IN_TRANSIT'] }, OR: [
        { purpose: 'TECHNICIAN_ISSUE', ...source },
        { purpose: 'TECHNICIAN_RETURN_GOOD', ...target },
        { purpose: 'TECHNICIAN_RETURN_FAULTY', ...target }
      ] }
    }),
    prisma.inventoryException.count({ where: { tenantId, ...allowed, resolvedAt: null } })
  ]);

  const series = buckets.map(bucket => ({
    periodKey: bucket.key, label: bucket.label,
    from: bucket.from.toISOString(), toExclusive: bucket.to.toISOString(),
    metrics: values()
  }));
  const jobs = buckets.map(() => new Set<string>());
  const targetMetrics = (at: Date | null) => {
    if (!at) return null;
    const i = bucketFor(at, buckets);
    return i >= 0 ? { metrics: series[i].metrics, index: i } : null;
  };

  for (const sale of sales) {
    const group = targetMetrics(sale.completedAt);
    if (!group) continue;
    group.metrics.netSales += sale.total.toNumber();
    group.metrics.salesCount += 1;
  }
  for (const returned of returns) {
    const group = targetMetrics(returned.createdAt);
    if (!group) continue;
    group.metrics.refunds += returned.total.toNumber();
    group.metrics.netSales -= returned.total.toNumber();
  }
  for (const movement of ledger) {
    const group = targetMetrics(movement.createdAt);
    if (!group) continue;
    if (movement.movementType === 'PURCHASE_RECEIPT') group.metrics.stockReceived += movement.deltaQty.abs().toNumber();
    else group.metrics.stockLosses += movement.deltaQty.abs().toNumber();
  }
  for (const transfer of transfers) {
    const group = targetMetrics(transfer.receivedAt);
    if (!group) continue;
    const count = transfer.lines.reduce((sum, line) => sum + line.quantity.toNumber(), 0);
    if (transfer.purpose === 'TECHNICIAN_ISSUE') group.metrics.technicianIssues += count;
    if (transfer.purpose === 'TECHNICIAN_RETURN_GOOD') group.metrics.goodReturns += count;
    if (transfer.purpose === 'TECHNICIAN_RETURN_FAULTY') group.metrics.faultyReturns += count;
  }
  for (const use of uses) {
    const group = targetMetrics(use.createdAt);
    if (!group) continue;
    group.metrics.technicianUses += use.quantity.toNumber();
    jobs[group.index].add(use.jobReference);
  }
  series.forEach((point, i) => {
    point.metrics.jobsSupported = jobs[i].size;
    // Currency is stored to four decimals, reports show cents; quantity retains four decimals.
    for (const def of reportKpis) point.metrics[def.key] =
      Math.round(point.metrics[def.key] * 10000) / 10000;
  });
  const latest = series[series.length - 1];
  const prior = series[series.length - 2];
  const comparison = reportKpis.map(kpi => ({
    ...kpi, current: latest.metrics[kpi.key], previous: prior.metrics[kpi.key],
    changePercent: relativeChange(latest.metrics[kpi.key], prior.metrics[kpi.key])
  }));
  const snapshot = currentStock.reduce((total, b) => {
    total.onHand += b.onHand.toNumber();
    total.quarantined += b.quarantined.toNumber();
    total.available += b.onHand.minus(b.reserved).minus(b.committed)
      .minus(b.quarantined).minus(b.damaged).minus(b.expired).toNumber();
    return total;
  }, { onHand: 0, quarantined: 0, available: 0 });
  const scope = locationId ? 'selected location' :
    request.auth.allLocations ? 'all company locations' : 'assigned locations only';
  return {
    generatedAt: new Date().toISOString(), organisation: tenant.name,
    period, timeZone, currency: tenant.currency, scope, locationId: locationId ?? null,
    comparisonPeriod: { current: latest.label, previous: prior.label },
    definitions: reportKpis, comparison, series,
    snapshot: { ...snapshot, pendingTechnicianTransfers: outstanding, unresolvedStockExceptions: exceptions },
    notes: [
      'Comparisons use complete local calendar periods. The current incomplete week, month or year is intentionally excluded.',
      'Net sales comprise completed sale totals (including tax) less completed sale returns posted in the period. Returns are assigned to their own date.',
      'Stock snapshot values are current at report generation time, not historical balances.',
      'When a comparison baseline is zero, percentage change is unavailable (N/A), not infinite.',
      'Jobs supported count unique references with recorded technician stock consumption, not all Tiquet jobs.'
    ]
  };
}

function csvField(value: string | number | null | undefined): string {
  // Numbers remain numeric, including negative refunds/net sales.
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  const str = value == null ? '' : String(value);
  // Prevent spreadsheet formula execution if text ever derives from a user-supplied value.
  const cleaned = /^[\s]*[=+\-@\t\r]/.test(str) ? "'" + str : str;
  return '"' + cleaned.replaceAll('"', '""') + '"';
}
export function trendsCsv(report: Awaited<ReturnType<typeof buildTrends>>): string {
  const headings = ['Period', 'Start (UTC)', 'End exclusive (UTC)', ...reportKpis.map(k => k.label)];
  const rows = report.series.map(point => [
    point.label, point.from, point.toExclusive, ...reportKpis.map(k => point.metrics[k.key])
  ]);
  const intro = [
    ['V79 POS KPI history', report.organisation],
    ['Calendar', report.period], ['Time zone', report.timeZone],
    ['Scope', report.scope], ['Generated (UTC)', report.generatedAt],
    ['Note', 'Completed calendar periods; current stock snapshot is separate from history.']
  ];
  return '\uFEFF' + [...intro, [], headings, ...rows]
    .map(row => row.map(csvField).join(',')).join('\r\n') + '\r\n';
}

export async function trendRoutes(app: FastifyInstance) {
  app.get('/v1/reports/trends', { preHandler: requirePermission('reports.read') }, async (request, reply) => {
    reply.header('cache-control', 'private, no-store');
    const query = reportQuery.parse(request.query);
    return buildTrends(request, query.period, query.locationId);
  });
  app.get('/v1/reports/trends.csv', { preHandler: requirePermission('reports.read') }, async (request, reply) => {
    const query = reportQuery.parse(request.query);
    const report = await buildTrends(request, query.period, query.locationId);
    reply.header('content-type', 'text/csv; charset=utf-8');
    reply.header('cache-control', 'private, no-store');
    reply.header('content-disposition', 'attachment; filename="v79-pos-kpis-' + report.period + '.csv"');
    return trendsCsv(report);
  });
}
