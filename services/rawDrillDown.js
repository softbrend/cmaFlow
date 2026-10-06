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
// Three further modes serve the Evaluation Report's "Data profile" table
// (views/dashboard/evaluation-report.ejs), one per number in that table:
//   - 'values': the "Unique" count — the column's distinct values with how
//     many rows hold each (and the share of all rows), most frequent first,
//     "(blank)" last. Same trimming rule profileColumns() uses to count
//     distinct values, so the list's length always equals the Unique cell.
//   - 'missing': the "Missing" count — the raw rows whose value in that
//     column is empty/null/whitespace (profileColumns()'s own definition).
//   - 'duplicates': the "duplicate row(s)" count — every row that repeats
//     an earlier row (same key countDuplicateRows() builds), i.e. the rows
//     that would be removed to de-duplicate the file.
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
const PROFILE_MODES = ['values', 'missing', 'duplicates'];

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

function isBlank(raw) {
  return raw === null || raw === undefined || String(raw).trim() === '';
}

// Distinct non-blank values of `column` (trimmed, like profileColumns()),
// most frequent first, then a "(blank)" line when any row is empty.
function valueCounts(allRows, column) {
  const counts = new Map();
  let blanks = 0;
  allRows.forEach((row) => {
    const raw = row ? row[column] : undefined;
    if (isBlank(raw)) { blanks += 1; return; }
    const key = String(raw).trim();
    counts.set(key, (counts.get(key) || 0) + 1);
  });
  const total = allRows.length || 1;
  const share = (n) => `${((n / total) * 100).toFixed(1)}%`;
  const out = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([value, n]) => ({ Value: value, Rows: String(n), 'Share of rows': share(n) }));
  if (blanks > 0) out.push({ Value: '(blank)', Rows: String(blanks), 'Share of rows': share(blanks) });
  return out;
}

// Rows that repeat an earlier row — same key as countDuplicateRows() in
// services/evaluationReport.js (every column's value, "" for undefined).
function duplicateRows(allRows) {
  const cols = Object.keys(allRows[0] || {});
  const seen = new Set();
  const dupes = [];
  allRows.forEach((row) => {
    const key = cols.map((c) => String(row[c] === undefined ? '' : row[c])).join('');
    if (seen.has(key)) dupes.push(row); else seen.add(key);
  });
  return dupes;
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

  if (mode === 'values') {
    const list = valueCounts(allRows, column);
    return {
      columns: ['Value', 'Rows', 'Share of rows'],
      rows: list.slice(offset, offset + RAW_DRILLDOWN_PAGE_SIZE),
      total: list.length,
      hasMore: offset + RAW_DRILLDOWN_PAGE_SIZE < list.length,
    };
  }

  const matched = mode === 'missing'
    ? allRows.filter((row) => row && isBlank(row[column]))
    : mode === 'duplicates'
    ? duplicateRows(allRows)
    : mode === 'range'
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

module.exports = { RAW_DRILLDOWN_PAGE_SIZE, PROFILE_MODES, buildRawDrillDown };
