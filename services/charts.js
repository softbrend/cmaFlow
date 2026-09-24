// Renders the Descriptive Analytics screen's charts as ready-to-drop-in
// HTML strings (horizontal bar lists + one SVG trend line), so
// views/dashboard/descriptive-analytics.ejs can stay a thin shell that
// just injects them with `<%- %>` instead of carrying chart-layout logic
// itself. Every render function returns a single self-contained
// `.chart-card` — CSS lives in public/css/style.css.
//
// Design choices (see the dataviz skill this was built against):
//   - Every chart here answers "compare magnitude across categories" or
//     "trend over time" for ONE measure — never "tell distinct series
//     apart" — so bars/lines use a single accent hue throughout, not a
//     categorical palette. An "Other" bucket (the folded tail past the
//     top-N categories) renders in a muted de-emphasis tone instead of
//     the accent, so it visibly reads as "everything else," not another
//     real category.
//   - Every value is direct-labeled (never hidden behind hover-only),
//     and every chart carries a <details> "View as table" twin — the
//     WCAG-clean equivalent — so nothing here is chart-only.
//   - All row-derived text (product names, customer names, segments,
//     statuses — original SME CSV cell values) is escaped before it
//     touches an HTML string; see escapeHtml() in services/format.js.
const {
  escapeHtml, formatMoney, formatCount, formatPercent,
} = require('./format');

function emptyCard(title, message) {
  return `<div class="chart-card">
    <div class="chart-title">${escapeHtml(title)}</div>
    <p class="chart-empty">${escapeHtml(message)}</p>
  </div>`;
}

// label · value · delta (optional) · sublabel (optional) — the "stat
// tile" contract: a sentence-case label with no trailing colon, a
// semibold value, and an optional signed delta colored by direction.
function renderStatTile({
  label, value, sublabel = null, delta = null,
}) {
  const deltaHtml = delta === null ? '' : `<div class="stat-delta ${delta >= 0 ? 'is-up' : 'is-down'}">${escapeHtml(formatPercent(delta))}${sublabel ? ` <span class="stat-delta-context">vs ${escapeHtml(sublabel)}</span>` : ''}</div>`;
  return `<div class="stat-tile">
    <div class="stat-label">${escapeHtml(label)}</div>
    <div class="stat-value">${escapeHtml(value)}</div>
    ${deltaHtml}
  </div>`;
}

// Horizontal bar list — the default form for "compare magnitude, low to
// high" across named categories (revenue by product, by monetization
// model, customer segment/region mix, entitlement status, top
// customers). `items` is already ranked+topN'd by services/analytics.js.
// `money` picks formatMoney(currency) vs. formatCount() for the value
// labels and table column.
// `drilldown`, when passed, adds a small 🔍 button to every row that
// isn't a folded-together bucket (item.isOther) — both in the bar list
// and its "View as table" twin — opening a shared right-side drill-down
// panel scoped to that exact row. Two independent shapes, each wired to
// its own panel/script (never both loaded on the same page — see the
// dataSource/activeView guards in descriptive-analytics.ejs), so they
// can't collide even though both use the 🔍 row-button convention:
//   - { by: 'product'|'customer', datasetId } — CMA Canonical Schema
//     Transaction rows (see public/js/revenue-drilldown.js). `by` says
//     which dimension item.label already IS the raw, filterable value
//     for (not a display-only label).
//   - { kind: 'raw-category'|'raw-range', datasetId, fileType, column,
//     colMin?, colMax?, bins? } — a raw uploaded file's own column
//     values, straight from dataset_records, no canonical mapping
//     required (see public/js/raw-row-drilldown.js and services/
//     rawDrillDown.js). 'raw-category' matches item.label as an exact
//     string; 'raw-range' matches item.bucketIndex against a numeric
//     histogram bucket (item.bucketIndex, and colMin/colMax/bins on the
//     shared config, must all be set by the caller — see the numeric-
//     chart branch of buildFullDescriptiveCards() in routes/dashboard.js).
// Optional and off by default so every OTHER renderBarChart() call site
// (there are many, most with no meaningful per-row drill-down) is
// unaffected.
function drillButton(item, drilldown, extraClass, formattedValue) {
  if (!drilldown || item.isOther) return '';
  const safeSummary = escapeHtml(formattedValue || '');
  const safeLabel = escapeHtml(item.label);

  if (drilldown.kind === 'raw-category' || drilldown.kind === 'raw-range' || drilldown.kind === 'raw-month') {
    const safeDataset = escapeHtml(String(drilldown.datasetId));
    const safeFileType = escapeHtml(drilldown.fileType);
    const safeColumn = escapeHtml(drilldown.column);
    const isRange = drilldown.kind === 'raw-range';
    const isMonth = drilldown.kind === 'raw-month';
    const attrs = [
      `data-mode="${isRange ? 'range' : isMonth ? 'month' : 'category'}"`,
      `data-dataset="${safeDataset}"`,
      `data-file-type="${safeFileType}"`,
      `data-column="${safeColumn}"`,
      `data-summary="${safeSummary}"`,
      `data-label="${safeLabel}"`,
    ];
    if (isRange) {
      attrs.push(`data-bucket-index="${escapeHtml(String(item.bucketIndex))}"`);
      attrs.push(`data-col-min="${escapeHtml(String(drilldown.colMin))}"`);
      attrs.push(`data-col-max="${escapeHtml(String(drilldown.colMax))}"`);
      attrs.push(`data-bins="${escapeHtml(String(drilldown.bins))}"`);
    } else {
      // Category mode's value is the raw string label; month mode's is
      // the same "YYYY-MM" key the trend point's own label already is
      // (services/datasetProfiler.js's toMonthKey()) — both travel as
      // one data-value attribute either way.
      attrs.push(`data-value="${safeLabel}"`);
    }
    return `<button type="button" class="drilldown-row-trigger rawrow-drilldown-trigger${extraClass ? ` ${extraClass}` : ''}"
      ${attrs.join(' ')} title="See the ${safeSummary || 'matching'} row(s) behind ${safeLabel}">🔍</button>`;
  }

  const safeDataset = escapeHtml(String(drilldown.datasetId));
  const safeBy = escapeHtml(drilldown.by);
  return `<button type="button" class="drilldown-row-trigger${extraClass ? ` ${extraClass}` : ''}"
    data-dataset="${safeDataset}" data-filter-by="${safeBy}" data-filter-value="${safeLabel}" data-summary="${safeSummary}"
    title="See the details behind ${safeLabel}">🔍</button>`;
}

function renderBarChart({
  title, subtitle = null, items, currency = null, money = true, valueColumnLabel = null,
  emptyMessage = 'No data yet for this dataset.', formatValue = null, drilldown = null,
}) {
  if (!items || items.length === 0) return emptyCard(title, emptyMessage);

  const max = Math.max(...items.map((i) => Math.abs(i.value)), 1);
  const fmt = formatValue || ((v) => (money ? formatMoney(v, currency) : formatCount(v)));

  const rows = items.map((item) => {
    const pct = Math.max((Math.abs(item.value) / max) * 100, item.value === 0 ? 0 : 1.5);
    const safeLabel = escapeHtml(item.label);
    const rawValue = fmt(item.value);
    const safeValue = escapeHtml(rawValue);
    return `<div class="bar-row" title="${safeLabel}: ${safeValue}">
      <div class="bar-label">${safeLabel}</div>
      <div class="bar-area"><div class="bar-fill${item.isOther ? ' is-other' : ''}" style="width:${pct.toFixed(1)}%"></div></div>
      <div class="bar-value">${safeValue}</div>
      ${drillButton(item, drilldown, 'bar-row-drilldown', rawValue)}
    </div>`;
  }).join('');

  const tableRows = items.map((item) => {
    const rawValue = fmt(item.value);
    return `<tr><td>${escapeHtml(item.label)}</td><td>${escapeHtml(rawValue)}</td>${drilldown ? `<td>${drillButton(item, drilldown, '', rawValue)}</td>` : ''}</tr>`;
  }).join('');

  return `<div class="chart-card">
    <div class="chart-title">${escapeHtml(title)}</div>
    ${subtitle ? `<div class="chart-subtitle">${escapeHtml(subtitle)}</div>` : ''}
    <div class="bar-chart">${rows}</div>
    <details class="chart-table-toggle">
      <summary>View as table</summary>
      <table class="table-simple">
        <thead><tr><th>Category</th><th>${escapeHtml(valueColumnLabel || (money ? 'Amount' : 'Count'))}</th>${drilldown ? '<th></th>' : ''}</tr></thead>
        <tbody>${tableRows}</tbody>
      </table>
    </details>
  </div>`;
}

// Single-series line + soft area fill for "trend over time" (revenue by
// month). SVG is embedded inline in the page (not a standalone .svg
// resource), so `var(--accent)` etc. resolve normally against the app's
// existing CSS custom properties.
function renderTrendChart({
  title, subtitle = null, points, currency = null, money = true, valueLabel = 'Revenue', formatValue = null,
  emptyMessage = 'Not enough transaction history yet to show a trend.', drilldown = null,
}) {
  const fmt = formatValue || ((v) => (money ? formatMoney(v, currency) : formatCount(v)));
  if (!points || points.length === 0) return emptyCard(title, emptyMessage);
  if (points.length === 1) {
    return `<div class="chart-card">
      <div class="chart-title">${escapeHtml(title)}</div>
      ${subtitle ? `<div class="chart-subtitle">${escapeHtml(subtitle)}</div>` : ''}
      <p class="chart-empty">Only one month of data so far (${escapeHtml(points[0].label)}: ${escapeHtml(fmt(points[0].value))}) — a trend needs at least two.</p>
    </div>`;
  }

  const W = 680;
  const H = 220;
  const padL = 16;
  const padR = 56;
  // padT must clear the end-value label drawn 14px above its point PLUS
  // that label's own text height (~10px ascender at this font-size) —
  // otherwise a peak landing at the very top of the plot (i.e. exactly
  // at y=padT) clips its own label against the SVG's top edge.
  const padT = 34;
  const padB = 28;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;
  const baselineY = padT + plotH;
  const maxVal = Math.max(...points.map((p) => p.value), 1);

  const x = (i) => padL + (i * (plotW / (points.length - 1)));
  const y = (v) => padT + (1 - (v / maxVal)) * plotH;

  const linePath = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join(' ');
  const areaPath = `${linePath} L${x(points.length - 1).toFixed(1)},${baselineY} L${x(0).toFixed(1)},${baselineY} Z`;

  // Cap ticks at ~6 to avoid crowding when a dataset spans many months —
  // always keep the first and last, sample evenly in between.
  const maxTicks = 6;
  const tickIdxs = points.length <= maxTicks
    ? points.map((_, i) => i)
    : Array.from({ length: maxTicks }, (_, i) => Math.round(i * (points.length - 1) / (maxTicks - 1)));
  const uniqueTickIdxs = [...new Set(tickIdxs)];

  // The first/last tick's label would otherwise center on a point that
  // sits right at the plot's edge, running text past x=0 (or past the
  // viewBox's right edge) where the SVG clips it — anchor those two to
  // "start"/"end" instead so the text grows inward, never past the edge.
  const ticks = uniqueTickIdxs.map((i) => {
    const anchor = i === 0 ? 'start' : i === points.length - 1 ? 'end' : 'middle';
    return `<text x="${x(i).toFixed(1)}" y="${H - 6}" text-anchor="${anchor}" class="viz-axis-label">${escapeHtml(points[i].label)}</text>`;
  }).join('');

  const lastIdx = points.length - 1;
  const endX = x(lastIdx);
  const endY = y(points[lastIdx].value);
  const endLabel = escapeHtml(fmt(points[lastIdx].value));

  const dots = points.map((p, i) => `<circle cx="${x(i).toFixed(1)}" cy="${y(p.value).toFixed(1)}" r="7" fill="var(--bg-panel)"></circle><circle cx="${x(i).toFixed(1)}" cy="${y(p.value).toFixed(1)}" r="4" fill="var(--chart-accent, var(--accent))"><title>${escapeHtml(p.label)}: ${escapeHtml(fmt(p.value))}</title></circle>`).join('');

  const svg = `<svg class="viz-root trend-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="${escapeHtml(title)} trend line">
    <line x1="${padL}" y1="${baselineY}" x2="${W - padR + 12}" y2="${baselineY}" class="viz-baseline" />
    <path d="${areaPath}" fill="var(--chart-accent, var(--accent))" fill-opacity="0.10" stroke="none"></path>
    <path d="${linePath}" fill="none" stroke="var(--chart-accent, var(--accent))" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"></path>
    ${dots}
    <text x="${endX.toFixed(1)}" y="${(endY - 14).toFixed(1)}" text-anchor="end" class="viz-end-label">${endLabel}</text>
    ${ticks}
  </svg>`;

  const tableRows = points.map((p) => {
    const rawValue = fmt(p.value);
    return `<tr><td>${escapeHtml(p.label)}</td><td>${escapeHtml(rawValue)}</td>${drilldown ? `<td>${drillButton(p, drilldown, '', rawValue)}</td>` : ''}</tr>`;
  }).join('');

  return `<div class="chart-card">
    <div class="chart-title">${escapeHtml(title)}</div>
    ${subtitle ? `<div class="chart-subtitle">${escapeHtml(subtitle)}</div>` : ''}
    ${svg}
    <details class="chart-table-toggle">
      <summary>View as table</summary>
      <table class="table-simple">
        <thead><tr><th>Month</th><th>${escapeHtml(valueLabel)}</th>${drilldown ? '<th></th>' : ''}</tr></thead>
        <tbody>${tableRows}</tbody>
      </table>
    </details>
  </div>`;
}

// Scatter plot — the form for "does one measure move with another"
// (resource cost vs. usage, CPU vs. cost), a job none of the charts above
// answer (a bar/trend chart each show ONE measure; this is the only place
// two measures share a plot). Still one axis PER dimension (x for one
// measure, y for the other) — never a third encoded as color/size, which
// would turn this into the same "which encoding means what" ambiguity a
// dual-axis chart creates. Single accent-hue markers at reduced opacity
// (not per-dataviz-skill categorical colors — there is no category here,
// only two continuous measures), so overlapping points visibly darken
// instead of stacking illegibly. Points are a targeted DB SAMPLE (see
// services/fullDescriptiveAnalytics.js's getCorrelationSample()) — the
// cached profile never retains raw pairs, only the Pearson r below.
function renderScatterChart({
  title, subtitle = null, points, xLabel, yLabel, r = null, sampleSize = null,
  formatX = null, formatY = null, emptyMessage = 'Not enough paired numeric data yet to plot this.',
}) {
  if (!points || points.length < 3) return emptyCard(title, emptyMessage);

  const fmtX = formatX || ((v) => formatCount(Math.round(v)));
  const fmtY = formatY || ((v) => formatCount(Math.round(v)));

  const W = 420;
  const H = 300;
  const padL = 54;
  const padR = 16;
  const padT = 16;
  const padB = 40;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;

  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const minX = Math.min(...xs, 0);
  const maxX = Math.max(...xs, 1);
  const minY = Math.min(...ys, 0);
  const maxY = Math.max(...ys, 1);
  const xSpan = maxX - minX || 1;
  const ySpan = maxY - minY || 1;

  const px = (v) => padL + ((v - minX) / xSpan) * plotW;
  const py = (v) => padT + (1 - ((v - minY) / ySpan)) * plotH;

  const dots = points.map((p) => `<circle cx="${px(p.x).toFixed(1)}" cy="${py(p.y).toFixed(1)}" r="4" fill="var(--chart-accent, var(--accent))" fill-opacity="0.35"><title>${escapeHtml(xLabel)}: ${escapeHtml(fmtX(p.x))} · ${escapeHtml(yLabel)}: ${escapeHtml(fmtY(p.y))}</title></circle>`).join('');

  // 4 evenly-spaced ticks per axis — enough to read scale without
  // crowding a 420×300 plot.
  const axisTicks = (n, min, span) => Array.from({ length: n + 1 }, (_, i) => min + (span * (i / n)));
  const xTicks = axisTicks(4, minX, xSpan);
  const yTicks = axisTicks(4, minY, ySpan);

  const xAxisLabels = xTicks.map((v) => `<text x="${px(v).toFixed(1)}" y="${H - padB + 16}" text-anchor="middle" class="viz-axis-label">${escapeHtml(fmtX(v))}</text>`).join('');
  const yAxisLabels = yTicks.map((v) => `<text x="${padL - 8}" y="${(py(v) + 3).toFixed(1)}" text-anchor="end" class="viz-axis-label">${escapeHtml(fmtY(v))}</text>`).join('');
  const gridLines = yTicks.map((v) => `<line x1="${padL}" y1="${py(v).toFixed(1)}" x2="${W - padR}" y2="${py(v).toFixed(1)}" class="viz-baseline" opacity="0.4"></line>`).join('');

  const svg = `<svg class="viz-root" viewBox="0 0 ${W} ${H}" role="img" aria-label="${escapeHtml(title)} scatter plot">
    ${gridLines}
    <line x1="${padL}" y1="${padT}" x2="${padL}" y2="${H - padB}" class="viz-baseline"></line>
    <line x1="${padL}" y1="${H - padB}" x2="${W - padR}" y2="${H - padB}" class="viz-baseline"></line>
    ${dots}
    ${xAxisLabels}
    ${yAxisLabels}
    <text x="${(padL + W - padR) / 2}" y="${H - 2}" text-anchor="middle" class="viz-axis-label">${escapeHtml(xLabel)}</text>
    <text x="12" y="${(padT + H - padB) / 2}" text-anchor="middle" class="viz-axis-label" transform="rotate(-90 12 ${(padT + H - padB) / 2})">${escapeHtml(yLabel)}</text>
  </svg>`;

  const tableRows = points.slice(0, 100).map((p) => `<tr><td>${escapeHtml(fmtX(p.x))}</td><td>${escapeHtml(fmtY(p.y))}</td></tr>`).join('');
  const rSubtitle = r !== null
    ? `${subtitle ? `${subtitle} · ` : ''}Pearson r = ${r.toFixed(2)}${sampleSize !== null ? ` (n=${formatCount(sampleSize)})` : ''}`
    : subtitle;

  return `<div class="chart-card">
    <div class="chart-title">${escapeHtml(title)}</div>
    ${rSubtitle ? `<div class="chart-subtitle">${escapeHtml(rSubtitle)}</div>` : ''}
    ${svg}
    <details class="chart-table-toggle">
      <summary>View as table${points.length > 100 ? ' (first 100 of the sampled points)' : ''}</summary>
      <table class="table-simple">
        <thead><tr><th>${escapeHtml(xLabel)}</th><th>${escapeHtml(yLabel)}</th></tr></thead>
        <tbody>${tableRows}</tbody>
      </table>
    </details>
  </div>`;
}

// Plain data table — deliberately NOT a magnitude bar chart. Used for
// the Pricing Catalog Overview's per-product price listing, where
// products can be priced in genuinely different units ($/API-call vs
// $/GB-month vs $/hour); ranking raw price numbers against each other
// across incomparable units would misstate the data the same way a
// dual-axis chart does, so a table is the honest form here (also the
// prescribed fallback once a breakdown runs past ~7 classes).
function renderCatalogTable({
  title, subtitle = null, rows, emptyMessage = 'No pricing data yet for this dataset.',
}) {
  if (!rows || rows.length === 0) return emptyCard(title, emptyMessage);

  const body = rows.map((r) => {
    let priceRange = '—';
    if (r.minPrice !== null) {
      // Both ends of a min–max range must share one decimal precision —
      // formatting each endpoint independently (formatMoney's normal
      // sub-$1-gets-4-decimals rule) can print "0.0500 – 1.50", mismatched
      // precision that reads as a typo rather than two real numbers.
      // Whichever endpoint is smaller decides the precision both use.
      const decimals = (Math.abs(r.minPrice) < 1 || Math.abs(r.maxPrice) < 1) ? 4 : 2;
      const fmt = (v) => Math.abs(v).toLocaleString('en-US', {
        minimumFractionDigits: decimals, maximumFractionDigits: decimals,
      });
      const span = r.maxPrice !== r.minPrice ? `${fmt(r.minPrice)} – ${fmt(r.maxPrice)}` : fmt(r.minPrice);
      priceRange = `${escapeHtml(r.currency || '')} ${escapeHtml(span)}${r.unit ? ` <span class="table-unit">/ ${escapeHtml(r.unit)}</span>` : ''}`;
    }
    return `<tr>
      <td>${escapeHtml(r.product)}</td>
      <td>${escapeHtml(r.modelLabel)}</td>
      <td>${priceRange}</td>
      <td>${formatCount(r.tierCount)}</td>
      <td>${formatCount(r.skuCount)}</td>
    </tr>`;
  }).join('');

  return `<div class="chart-card">
    <div class="chart-title">${escapeHtml(title)}</div>
    ${subtitle ? `<div class="chart-subtitle">${escapeHtml(subtitle)}</div>` : ''}
    <div class="table-scroll">
      <table class="table-simple">
        <thead><tr><th>Product / service</th><th>Monetization model</th><th>Price range</th><th>Tiers</th><th>SKUs</th></tr></thead>
        <tbody>${body}</tbody>
      </table>
    </div>
  </div>`;
}

module.exports = {
  renderStatTile, renderBarChart, renderTrendChart, renderScatterChart, renderCatalogTable,
};
