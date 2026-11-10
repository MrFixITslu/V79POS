const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({
  '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'
})[c]);
const nfmt = (value, digits = 2) => new Intl.NumberFormat('en-GB', {
  maximumFractionDigits: digits
}).format(Number(value || 0));
const money = (value, currency) => new Intl.NumberFormat('en-LC', {
  style: 'currency', currency: currency || 'XCD', maximumFractionDigits: 2
}).format(Number(value || 0));
const units = (value, unit, currency) =>
  unit === 'XCD' ? money(value, currency) : nfmt(value, unit === 'count' ? 0 : 4);

export function renderKpiReports({ report, period, locationId, metric, locations, demo, error }) {
  if (demo) return '<div class="pagehead"><h1>Reports & analytics</h1></div>' +
    '<section class="card section">Live reporting needs a signed-in V79 Hub business account. Demo figures are not used for performance reports.</section>';
  const filter = '<div class="report-controls"><label for="report-period">Compare</label>' +
    '<select id="report-period" aria-label="Reporting period">' +
    [['week','Week on week'],['month','Month on month'],['year','Year on year']].map(([k, text]) =>
      '<option value="' + k + '"' + (k === period ? ' selected' : '') + '>' + text + '</option>').join('') +
    '</select><label for="report-location">Location</label><select id="report-location" aria-label="Reporting location">' +
    '<option value="">All authorised locations</option>' +
    (locations || []).map(l => '<option value="' + escape(l.id) + '"' +
      (l.id === locationId ? ' selected' : '') + '>' + escape(l.name) + '</option>').join('') +
    '</select><button class="btn" data-action="report-refresh">Refresh</button>' +
    '<button class="btn" data-action="report-csv">Download CSV</button>' +
    '<button class="btn primary" data-action="report-print">Print / Save PDF</button></div>';

  const header = '<div class="pagehead"><div><div class="eyebrow">V79 DIGITAL POS / REPORTING</div>' +
    '<h1>Reports & analytics</h1><p>Verified POS business performance across completed calendar periods</p></div></div>';
  if (!report) return header + filter + '<section class="card section" role="status">' +
    (error ? '<p class="notice error">' + escape(error) + '</p>' : 'Loading live reporting data…') + '</section>';
  const definition = report.definitions.find(d => d.key === metric) || report.definitions[0];
  const formatter = v => units(v, definition.unit, report.currency);
  const points = report.series || [];
  const max = Math.max(1, ...points.map(p => Math.abs(Number(p.metrics[definition.key] || 0))));
  const chart = points.every(p => Number(p.metrics[definition.key] || 0) === 0)
    ? '<p class="empty">No recorded transactions for this KPI in the selected completed periods.</p>'
    : '<div class="report-bars" role="img" aria-label="' + escape(definition.label) + ' across ' +
      escape(report.period) + ' periods">' + points.map(p => {
        const val = Number(p.metrics[definition.key] || 0);
        const height = Math.max(2, Math.round(Math.abs(val) / max * 100));
        return '<div class="report-bar-slot" title="' + escape(p.label + ': ' + formatter(val)) +
          '"><span class="bar-number">' + escape(formatter(val)) + '</span>' +
          '<div class="report-bar ' + (val < 0 ? 'negative' : '') +
          '" style="height:' + height + '%"></div>' +
          '<span class="report-bar-label">' + escape(p.label.replace('Week of ', '')) +
          '</span></div>';
      }).join('') + '</div>';
  const cards = report.comparison.map(k => {
    const delta = k.changePercent === null
      ? 'N/A · zero baseline' : (k.changePercent > 0 ? '+' : '') + nfmt(k.changePercent, 2) + '%';
    return '<article class="card report-kpi"><small>' + escape(k.label) + '</small>' +
      '<strong>' + escape(units(k.current, k.unit, report.currency)) + '</strong>' +
      '<div class="report-delta">' + escape(delta) + ' vs ' +
      escape(units(k.previous, k.unit, report.currency)) + ' previous</div></article>';
  }).join('');
  const snapshot = report.snapshot || {};
  const snapshotHtml = '<section class="card section"><h2>Current stock position</h2>' +
    '<p class="section-note">Live snapshot generated ' +
    escape(new Date(report.generatedAt).toLocaleString('en-LC', { dateStyle: 'medium', timeStyle: 'short' })) +
    '. These are not historical period totals.</p>' +
    '<div class="report-snapshot">' +
    [['Stock on hand',snapshot.onHand], ['Available stock',snapshot.available],
     ['Quarantined units',snapshot.quarantined],
     ['Pending technician transfers',snapshot.pendingTechnicianTransfers],
     ['Unresolved stock exceptions',snapshot.unresolvedStockExceptions]].map(([label,value]) =>
      '<div><small>' + escape(label) + '</small><strong>' + escape(nfmt(value,4)) + '</strong></div>').join('') +
    '</div></section>';

  const selector = '<label for="report-metric">Chart KPI</label><select id="report-metric">' +
    report.definitions.map(d =>
      '<option value="' + escape(d.key) + '"' + (d.key === definition.key ? ' selected' : '') + '>' +
      escape(d.label) + '</option>').join('') + '</select>';
  const chartHtml = '<section class="card section"><div class="row report-chart-head"><div><h2>' +
    escape(definition.label) + '</h2><p class="section-note">' + escape(definition.description) +
    '</p></div><div class="report-metric-select">' + selector + '</div></div>' + chart + '</section>';
  const columns = report.definitions;
  const rows = points.map(p => '<tr><th scope="row">' + escape(p.label) + '</th>' +
    columns.map(d => '<td>' + escape(units(p.metrics[d.key], d.unit, report.currency)) +
      '</td>').join('') + '</tr>').join('');
  const table = '<section class="card section"><h2>Detailed KPI history</h2>' +
    '<p class="section-note">Exact values supporting the trend comparisons and downloaded report.</p>' +
    '<div class="table-wrap"><table class="table"><thead><tr><th scope="col">Period</th>' +
    columns.map(d => '<th scope="col" title="' + escape(d.description) + '">' +
      escape(d.label) + '</th>').join('') + '</tr></thead><tbody>' + rows +
    '</tbody></table></div></section>';
  const notes = '<section class="card section report-methodology"><h2>How these figures are calculated</h2>' +
    '<p class="section-note">Company: ' + escape(report.organisation) + ' · Scope: ' +
    escape(report.scope) + ' · Time zone: ' + escape(report.timeZone) +
    ' · Comparing ' + escape(report.comparisonPeriod.current) + ' with ' +
    escape(report.comparisonPeriod.previous) + '</p>' +
    '<ul>' + report.notes.map(note => '<li>' + escape(note) + '</li>').join('') + '</ul></section>';
  return '<div class="report-page">' + header + filter + '<div class="report-kpis">' + cards +
    '</div>' + chartHtml + snapshotHtml + table + notes + '</div>';
}
