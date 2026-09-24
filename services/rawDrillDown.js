// "What's behind this number" drill-down for the Full Descriptive
// Analytics tab's per-column breakdown charts (services/
// fullDescriptiveAnalytics.js / datasetProfiler.js) — the raw-upload
// counterpart to services/revenueDrillDown.js, which only ever reads
// confirmed CMA Canonical Schema Transaction/Customer rows. This one
// reads a file's raw dataset_records directly, works for ANY column of
// ANY uploaded file (not a fixed set of canonical fields), and shows the
// actual matching rows rather than a rolled-up summary — "Category:
// Supreme, 9 rows" drills straight into those 9 raw rows, nothing to
// roll up to.
//
// Three modes, matching the chart kinds buildFullDescriptiveCards() and
// buildBusinessMetricsCards() (routes/dashboard.js) produce from a
// column's profile:
//   - 'category': an exact match against a category/id column's raw
//     string value (profileCategory()'s own top-N labels).
//   - 'range': a numeric column's histogram BUCKET — re-derives the
//     bucket a row's value falls into with the exact same clamp-to-last-
//     bucket math buildHistogram() (services/datasetProfiler.js) uses,
//     so a drill-down can never disagree with the count on the bar it
//     was opened from.
//   - 'month': a trend chart's month POINT — re-derives the "YYYY-MM" key
//     for a row's date column with the exact same toMonthKey()
//     (services/datasetProfiler.js) used to bucket the chart itself, so a
//     drill-down can never disagree with the point it was opened from.
const pool = require('../db/pool');
const { tryParseNumber, toMonthKey } = require('./datasetProfiler');

const RAW_DRILLDOWN_PAGE_SIZE = 25;

async function getRawRows(accountId, datasetRowId, fileType) {
  const { rows } = await pool.query(
    `SELECT data FROM dataset_records
      WHERE account_id = $1 AND dataset_id = $2 AND file_type = $3
      ORDER BY row_index`,
    [accountId, datasetRowId, fileType]
  );
  return rows.map((r) => r.data);
}

function matchesCategory(row, column, value) {
  if (!row || !(column in row)) return false;
  const raw = row[column];
  if (raw === null || raw === undefined) return false;
  return String(raw).trim() === value;
}

// Mirrors buildHistogram()'s own bucket assignment exactly: floor((v -
// min) / width), clamped into the last bucket rather than overflowing —
// the same clamp is what puts the column's single highest value into the
// last bucket instead of a nonexistent bucket past it.
function bucketIndexOf(value, min, max, bins) {
  if (min === max) return 0;
  const width = (max - min) / bins;
  let idx = Math.floor((value - min) / width);
  if (idx >= bins) idx = bins - 1;
  if (idx < 0) idx = 0;
  return idx;
}

function matchesRange(row, column, bucketIndex, colMin, colMax, bins) {
  if (!row || !(column in row)) return false;
  const n = tryParseNumber(row[column]);
  if (n === null) return false;
  return bucketIndexOf(n, colMin, colMax, bins) === bucketIndex;
}

function matchesMonth(row, column, monthKey) {
  if (!row || !(column in row)) return false;
  const raw = row[column];
  if (raw === null || raw === undefined || String(raw).trim() === '') return false;
  return toMonthKey(raw) === monthKey;
}

// Returns { columns, rows, total, hasMore }. `columns` is that file's own
// column order (from the first matching row, falling back to the first
// row of the file if nothing matched) — never a fixed schema, since a raw
// upload can have any columns at all.
async function buildRawDrillDown(accountId, {
  datasetRowId, fileType, column, mode, value = null, bucketIndex = null, colMin = null, colMax = null,
  bins = 10, offset = 0,
}) {
  const allRows = await getRawRows(accountId, datasetRowId, fileType);

  const matched = mode === 'range'
    ? allRows.filter((row) => matchesRange(row, column, bucketIndex, colMin, colMax, bins))
    : mode === 'month'
      ? allRows.filter((row) => matchesMonth(row, column, value))
      : allRows.filter((row) => matchesCategory(row, column, value));

  const page = matched.slice(offset, offset + RAW_DRILLDOWN_PAGE_SIZE);
  const columns = Object.keys((matched[0] || allRows[0]) || {}).filter((name) => name.trim() !== '');

  return {
    columns,
    rows: page,
    total: matched.length,
    hasMore: offset + RAW_DRILLDOWN_PAGE_SIZE < matched.length,
  };
}

module.exports = { RAW_DRILLDOWN_PAGE_SIZE, buildRawDrillDown };
