// Shared number/currency/text formatters for the Descriptive Analytics
// screen (services/analytics.js computes the numbers, services/charts.js
// and the view render them) — kept in one place so a KPI tile, a chart's
// direct label, and its table-view twin never disagree on how a number
// is written.

// Escapes text pulled from canonical_records.data (i.e. originally
// SME-uploaded CSV cells — product names, customer names, segments,
// statuses, ...) before it's concatenated into a raw HTML string in
// services/charts.js. EJS auto-escapes `<%= %>` output, but the chart
// renderers build HTML strings in plain JS (so the view can just drop
// them in with `<%- %>`), so this is the one place that safety net has
// to be re-implemented by hand — every piece of row-derived text MUST
// pass through here before landing in a chart's HTML.
function escapeHtml(value) {
  return String(value === null || value === undefined ? '' : value).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// Plain (non-compact) money formatting — used wherever the number is
// already reasonably sized (chart bar/line value labels, table cells):
// sub-$1 values get 4 decimals (same reasoning as fmtPrice() on the
// Set-up Monetization Configuration screen — a $0.002/unit price would
// otherwise silently round to "0.00"), everything else gets normal
// thousands-grouped 2-decimal formatting.
function formatMoney(value, currency) {
  const n = Number(value) || 0;
  const abs = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  const body = (abs > 0 && abs < 1)
    ? abs.toFixed(4)
    : abs.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${currency ? `${currency} ` : ''}${sign}${body}`;
}

// Compact money formatting for hero/stat-tile numbers — 1,284 / 12.9K /
// $4.2M — so a large total revenue figure reads at a glance instead of
// running off the tile.
function formatCompactMoney(value, currency) {
  const n = Number(value) || 0;
  const abs = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  let body;
  if (abs >= 1e9) body = `${(abs / 1e9).toFixed(abs >= 1e10 ? 0 : 1).replace(/\.0$/, '')}B`;
  else if (abs >= 1e6) body = `${(abs / 1e6).toFixed(abs >= 1e7 ? 0 : 1).replace(/\.0$/, '')}M`;
  else if (abs >= 1e4) body = `${(abs / 1e3).toFixed(abs >= 1e5 ? 0 : 1).replace(/\.0$/, '')}K`;
  else if (abs > 0 && abs < 1) body = abs.toFixed(4);
  else body = abs.toLocaleString('en-US', { maximumFractionDigits: 2 });
  return `${currency ? `${currency} ` : ''}${sign}${body}`;
}

// Plain integer/count formatting (row counts, customer counts, ...).
function formatCount(value) {
  return Number(value || 0).toLocaleString('en-US');
}

// Percentage with a sign, for month-over-month deltas ("+12.4%").
function formatPercent(value) {
  const n = Number(value) || 0;
  const sign = n > 0 ? '+' : '';
  return `${sign}${n.toFixed(1)}%`;
}

module.exports = {
  escapeHtml, formatMoney, formatCompactMoney, formatCount, formatPercent,
};
