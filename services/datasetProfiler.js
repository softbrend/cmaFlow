// General-purpose, dataset-agnostic descriptive-analytics profiler.
//
// Every other analytics module in this app (services/analytics.js,
// diagnosticAnalytics.js, predictiveAnalytics.js, ...) reads from the CMA
// Canonical Schema — Customer/Transaction/Entitlement/MonetizationConfig —
// which requires the SME owner to first run Map & Transform. That's the
// right foundation for monetization-specific analysis, but it means a
// freshly uploaded dataset shows nothing at all in Descriptive Analytics
// until that mapping step is done, and it can never say anything about
// columns that don't correspond to one of those four entities (a
// restaurant's rating, an Airbnb listing's room type, a menu's cuisine —
// none of that is "Customer" or "Transaction" data, but it's exactly what
// a full descriptive-analytics pass over the raw file should surface).
//
// This module runs directly against a file's RAW rows — whatever columns
// they actually have, from any domain — and produces the same *kind* of
// analysis a human analyst would run first on any new dataset: what type
// is each column, what does its distribution look like, which columns
// plausibly measure the business (price/amount/rating), which look like a
// timeline, which look like a join key to another uploaded file, and
// where the data quality problems are. Nothing here is hand-written for
// "food delivery" or "short-term rentals" specifically — see
// claude/full-descriptive-analytics.md for how this was validated against
// both a food-delivery-platform export and a Seattle Airbnb export
// without either one being special-cased.
//
// Pure functions only (no DB, no I/O) — services/fullDescriptiveAnalytics.js
// is the DB-aware layer that calls into this and persists the result.

const HISTOGRAM_BINS = 10;
const TOP_CATEGORY_VALUES = 12;
const MAX_CORRELATION_COLUMNS = 6;

const CURRENCY_PREFIX_RE = /^\s*(?:[$€£₹¥]|USD|PHP|INR|EUR|GBP|CAD|AUD)\s*/i;
const THOUSANDS_RE = /,/g;
const PERCENT_SUFFIX_RE = /%\s*$/;
const BOOL_TRUE = new Set(['true', 't', 'yes', 'y', '1']);
const BOOL_FALSE = new Set(['false', 'f', 'no', 'n', '0']);
const ID_NAME_RE = /(?:^|_)(?:id|uuid|guid)$/i;
const RATING_NAME_RE = /rating|score|stars/i;
const SHORT_CODE_MAX_LEN = 30; // avg value length above this reads as free text, not a code/id, however unique it is
const URL_NAME_RE = /(?:url|link)$/i;
const LAT_NAME_RE = /^lat(?:itude)?$/i;
const LNG_NAME_RE = /^(?:lon|lng|long|longitude)$/i;
const ISO_DATE_RE = /^\d{4}-\d{1,2}-\d{1,2}(?:[ T]\d{1,2}:\d{2}(?::\d{2})?)?/;
const SLASH_DATE_RE = /^\d{1,2}\/\d{1,2}\/\d{2,4}$/;

function isBlank(v) {
  return v === null || v === undefined || String(v).trim() === '';
}

// Strips currency symbols, thousands separators, and a trailing '%' so
// "$1,234.50", "₹ 200", and "12.5%" all parse — the '%' is stripped but
// its presence is what inferColumnKind() uses to classify the column as
// 'percentage' rather than plain 'numeric'.
function tryParseNumber(raw) {
  if (isBlank(raw)) return null;
  const s = String(raw).trim().replace(PERCENT_SUFFIX_RE, '').replace(CURRENCY_PREFIX_RE, '').replace(THOUSANDS_RE, '');
  if (s === '' || s === '-' || s === '.') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function looksLikeDate(raw) {
  if (isBlank(raw)) return false;
  const s = String(raw).trim();
  if (ISO_DATE_RE.test(s) || SLASH_DATE_RE.test(s)) return true;
  if (s.length < 6 || /^-?\d+(\.\d+)?$/.test(s)) return false; // bare numbers parse as dates in JS — exclude them
  return Number.isFinite(Date.parse(s));
}

function toMonthKey(raw) {
  const t = Date.parse(String(raw).trim());
  if (!Number.isFinite(t)) return null;
  const d = new Date(t);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

// Plain reduce, not Math.min(...arr)/Math.max(...arr) — spreading an array
// into a function call blows V8's argument-count limit well before 200,000
// elements (the app's own per-file row cap — see MAX_ROWS_PARSED in
// middleware/browse.js), so a big numeric or date column would crash the
// whole profiling pass.
function arrMin(nums) { return nums.reduce((m, v) => (v < m ? v : m), nums[0]); }
function arrMax(nums) { return nums.reduce((m, v) => (v > m ? v : m), nums[0]); }

function mean(nums) { return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : null; }

// Sample variance (n-1 denominator) — stdev() is just its square root, kept
// as a separate function so profileNumeric() can report BOTH Variance and
// SD (the requested descriptive-statistics menu lists them as two distinct
// fields) without computing the sum-of-squared-deviations pass twice.
function variance(nums, avg) {
  if (nums.length < 2) return 0;
  const m = avg === undefined ? mean(nums) : avg;
  return nums.reduce((s, n) => s + ((n - m) ** 2), 0) / (nums.length - 1);
}
function stdev(nums, avg) { return Math.sqrt(variance(nums, avg)); }

// Most frequent exact value in an array (numbers or already-normalized
// strings) — ties broken by first-encountered, via a Map's stable
// insertion order and a strict `>` comparison so an earlier value is never
// displaced by a later one with an equal count. Returns null on an empty
// array, since "no mode" is a real, distinct answer from "mode is 0."
function mode(values) {
  if (values.length === 0) return null;
  const counts = new Map();
  values.forEach((v) => counts.set(v, (counts.get(v) || 0) + 1));
  let best = null;
  counts.forEach((count, value) => {
    if (!best || count > best.count) best = { value, count };
  });
  return best;
}

function quantileSorted(sorted, q) {
  if (sorted.length === 0) return null;
  const pos = (sorted.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  return sorted[base + 1] !== undefined ? sorted[base] + rest * (sorted[base + 1] - sorted[base]) : sorted[base];
}

// Sample up to `n` values evenly across the array (not just the first n) —
// large CSV exports are frequently sorted or grouped (all of one region's
// rows together, then the next), so an even stride avoids systematically
// missing whole categories the way a first-N sample would.
function evenSample(arr, n) {
  if (arr.length <= n) return arr;
  const step = arr.length / n;
  const out = [];
  for (let i = 0; i < n; i += 1) out.push(arr[Math.floor(i * step)]);
  return out;
}

// Classifies one column from its raw string values plus its own header
// name (a name hint alone is never sufficient — "price" and "id" both
// have to earn their type from the actual values too, since an SME's
// column names are never guaranteed to be self-describing).
function inferColumnKind(name, values) {
  const nonBlank = values.filter((v) => !isBlank(v));
  if (nonBlank.length === 0) return 'empty';

  const sample = evenSample(nonBlank, 2000);
  const n = sample.length;

  // A column literally named "...id"/"...uuid"/"...guid" is a deliberate
  // naming convention from whoever exported the file — trust it outright
  // rather than gating on uniqueness. A FOREIGN key column is supposed to
  // repeat a lot (menu.r_id repeats ~20x per restaurant; calendar.csv's
  // listing_id repeats ~365x per listing) — requiring near-uniqueness
  // here would misclassify exactly the columns most useful for relating
  // one uploaded file to another (see detectRelationships() in
  // services/fullDescriptiveAnalytics.js).
  if (ID_NAME_RE.test(name)) return 'id';

  const boolHits = sample.filter((v) => {
    const s = String(v).trim().toLowerCase();
    return BOOL_TRUE.has(s) || BOOL_FALSE.has(s);
  }).length;
  const distinctLower = new Set(sample.map((v) => String(v).trim().toLowerCase()));
  if (boolHits / n > 0.95 && distinctLower.size <= 4) return 'boolean';

  const numericHits = sample.filter((v) => tryParseNumber(v) !== null).length;
  if (LAT_NAME_RE.test(name) && numericHits / n > 0.9) return 'geo_lat';
  if (LNG_NAME_RE.test(name) && numericHits / n > 0.9) return 'geo_lng';
  if (URL_NAME_RE.test(name) && numericHits / n < 0.5) return 'url';

  const dateHits = sample.filter(looksLikeDate).length;
  if (dateHits / n > 0.85 && numericHits / n < 0.85) return 'date';

  // Scraped/exported "rating" columns very commonly mix real numbers with
  // a placeholder string for "no rating yet" ("--", "NEW", "Too Few
  // Ratings"), which pulls the plain numeric-hit ratio well below a
  // generic 0.85 threshold — a rating-named column gets a much lower bar
  // so it's still recognized as numeric, with the placeholder rows simply
  // excluded from the numeric stats (profileNumeric already does this —
  // anything that doesn't parse just isn't counted in mean/median/etc.).
  const numericThreshold = RATING_NAME_RE.test(name) ? 0.25 : 0.85;
  if (numericHits / n > numericThreshold) {
    const pctHits = sample.filter((v) => PERCENT_SUFFIX_RE.test(String(v).trim())).length;
    if (pctHits / n > 0.5) return 'percentage';
    const currHits = sample.filter((v) => CURRENCY_PREFIX_RE.test(String(v).trim())).length;
    if (currHits / n > 0.5) return 'currency';
    if (RATING_NAME_RE.test(name)) return 'rating';
    return 'numeric';
  }

  const uniqueRatio = distinctLower.size / n;
  const avgLen = sample.reduce((s, v) => s + String(v).length, 0) / n;
  // Near-unique short values with no explicit id-ish name still read as a
  // code/key (a SKU, a license number, a short slug) — but near-unique
  // LONG values (an address, a free-text name/title) are free text, not a
  // key, however few of them repeat.
  if (uniqueRatio > 0.95 && nonBlank.length > 20 && avgLen <= SHORT_CODE_MAX_LEN) return 'id';
  // `distinctLower` only ever covers the (<=2000-value) SAMPLE, so its raw
  // size can't be compared against a threshold scaled off the full
  // column's row count (a genuinely low-cardinality column and a
  // genuinely high-cardinality one look identical by raw sample-distinct-
  // count once the column has more than a couple thousand rows — the
  // sample simply can't show more than 2000 distinct values either way).
  // The sample's uniqueRatio is what actually distinguishes them: real
  // categorical data re-shows the same handful of values throughout a
  // large sample (a review's "room_type" is always one of 3 values, so a
  // 2000-value sample lands on well under 2000 distinct ones); free text
  // (a review comment, a listing description) is different almost every
  // row, so a 2000-value sample stays close to 2000 distinct.
  if (uniqueRatio <= 0.5 || distinctLower.size <= TOP_CATEGORY_VALUES * 3) return 'category';
  return 'text';
}

function buildHistogram(nums, bins = HISTOGRAM_BINS) {
  if (nums.length === 0) return [];
  const min = arrMin(nums);
  const max = arrMax(nums);
  if (min === max) return [{ label: formatBinLabel(min, max), count: nums.length }];
  const width = (max - min) / bins;
  const counts = new Array(bins).fill(0);
  nums.forEach((v) => {
    let idx = Math.floor((v - min) / width);
    if (idx >= bins) idx = bins - 1;
    if (idx < 0) idx = 0;
    counts[idx] += 1;
  });
  return counts.map((count, i) => ({
    label: formatBinLabel(min + i * width, min + (i + 1) * width),
    count,
  }));
}

function formatBinLabel(lo, hi) {
  const round = (v) => (Math.abs(v) >= 100 ? Math.round(v) : Math.round(v * 100) / 100);
  return `${round(lo)}–${round(hi)}`;
}

// Numeric-family stats (numeric / currency / percentage / rating / geo_lat
// / geo_lng share the same underlying computation — this returns the full
// superset the descriptive-statistics spec asks for across all of them
// (Count, Missing, Mean, Median, Mode, SD, Variance, Min, Q1, Q3, Max,
// IQR, CV, plus Sum for Currency's "Total"); which fields a given semantic
// type actually DISPLAYS is a view-layer choice, not a reason to compute
// a different object per kind — Currency simply doesn't show Mode/
// Variance/IQR/CV, Numeric shows all of it, Rating adds a frequency
// distribution on top (see profileRating() below).
function profileNumeric(values) {
  const parsed = values.map(tryParseNumber).filter((v) => v !== null);
  const missing = values.length - parsed.length;
  if (parsed.length === 0) {
    return {
      count: 0, missing, min: null, max: null, mean: null, median: null, mode: null,
      stdev: null, variance: null, q1: null, q3: null, iqr: null, cv: null, sum: null,
      zeroCount: 0, negativeCount: 0, histogram: [],
    };
  }
  const sorted = [...parsed].sort((a, b) => a - b);
  const m = mean(parsed);
  const sd = stdev(parsed, m);
  const q1 = quantileSorted(sorted, 0.25);
  const q3 = quantileSorted(sorted, 0.75);
  const modeResult = mode(parsed);
  return {
    count: parsed.length,
    missing,
    min: sorted[0],
    max: sorted[sorted.length - 1],
    mean: m,
    median: quantileSorted(sorted, 0.5),
    mode: modeResult ? modeResult.value : null,
    stdev: sd,
    variance: variance(parsed, m),
    q1,
    q3,
    // Coefficient of variation, as a percentage of the mean's magnitude —
    // abs() so a measure with a negative mean (a net-loss column, say)
    // still reports a positive dispersion figure rather than a sign that
    // reads like "less variable," and null (not Infinity/NaN) when the
    // mean is exactly 0, since CV is undefined there.
    cv: m ? (sd / Math.abs(m)) * 100 : null,
    iqr: (q1 !== null && q3 !== null) ? q3 - q1 : null,
    sum: parsed.reduce((s, v) => s + v, 0),
    zeroCount: parsed.filter((v) => v === 0).length,
    negativeCount: parsed.filter((v) => v < 0).length,
    histogram: buildHistogram(parsed),
  };
}

// Rating adds a frequency distribution on top of the standard numeric
// stats (Count, Mean, Median, Mode, SD, Min, Max are already covered by
// profileNumeric — Variance/IQR/CV are computed too but simply aren't part
// of Rating's requested display menu). Values are rounded to one decimal
// before grouping so a scale that's genuinely whole-number (1–5 stars)
// groups cleanly, without merging real half-point distinctions (3.5 vs 4)
// on a scale that supports them.
function profileRating(values) {
  const base = profileNumeric(values);
  if (base.count === 0) return { ...base, frequencyDistribution: [] };
  const parsed = values.map(tryParseNumber).filter((v) => v !== null);
  const counts = new Map();
  parsed.forEach((v) => {
    const key = Math.round(v * 10) / 10;
    counts.set(key, (counts.get(key) || 0) + 1);
  });
  const total = parsed.length;
  const frequencyDistribution = [...counts.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([value, count]) => ({ value, count, percentage: (count / total) * 100 }));
  return { ...base, frequencyDistribution };
}

// Also serves as the Geographic semantic type's stats — a geo_dimension
// column (services/businessSemantics.js's business-semantic ROLE, layered
// on top of file-level profiling, not a distinct column KIND here) is
// still a plain 'category' column at this level, so "Unique locations"
// is this same uniqueCount and "frequency and percentage by location" is
// this same top[] array — no separate geographic computation needed.
function profileCategory(values) {
  const nonBlank = values.filter((v) => !isBlank(v)).map((v) => String(v).trim());
  const missing = values.length - nonBlank.length;
  const counts = new Map();
  nonBlank.forEach((v) => counts.set(v, (counts.get(v) || 0) + 1));
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const total = nonBlank.length;
  const top = ranked.slice(0, TOP_CATEGORY_VALUES).map(([label, count]) => ({
    label, count, percentage: total > 0 ? (count / total) * 100 : 0,
  }));
  const otherCount = ranked.slice(TOP_CATEGORY_VALUES).reduce((s, [, c]) => s + c, 0);
  return {
    count: total,
    uniqueCount: counts.size,
    missing,
    mode: ranked.length ? ranked[0][0] : null,
    top,
    otherCount,
    otherPercentage: total > 0 ? (otherCount / total) * 100 : 0,
  };
}

function profileBoolean(values) {
  const nonBlank = values.filter((v) => !isBlank(v)).map((v) => String(v).trim().toLowerCase());
  const missing = values.length - nonBlank.length;
  const trueCount = nonBlank.filter((v) => BOOL_TRUE.has(v)).length;
  const falseCount = nonBlank.filter((v) => BOOL_FALSE.has(v)).length;
  return { trueCount, falseCount, missing, other: nonBlank.length - trueCount - falseCount };
}

const DAY_OF_WEEK_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH_OF_YEAR_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// `byMonth` (chronological "2017-01", "2017-02", ...) already existed —
// it's what the trend charts plot and is left exactly as-is. The
// descriptive-statistics spec's "frequency by day/month/year" is a
// different, complementary view: seasonality, not a timeline — "which day
// of the week gets the most activity," "which calendar month, regardless
// of year," "which year." All three are computed in the same single pass
// over the column's values as byMonth already was, so this adds no extra
// scan of the data.
function profileDate(values) {
  const parsedTimes = values.filter((v) => !isBlank(v)).map((v) => Date.parse(String(v).trim())).filter(Number.isFinite);
  const missing = values.length - parsedTimes.length;
  if (parsedTimes.length === 0) {
    return {
      count: 0, missing, minDate: null, maxDate: null, rangeDays: null,
      byMonth: [], byDayOfWeek: [], byMonthOfYear: [], byYear: [],
    };
  }
  const byMonth = new Map();
  const byDow = new Array(7).fill(0);
  const byMoy = new Array(12).fill(0);
  const byYear = new Map();
  values.forEach((v) => {
    if (isBlank(v)) return;
    const t = Date.parse(String(v).trim());
    if (!Number.isFinite(t)) return;
    const d = new Date(t);
    const monthKey = toMonthKey(v);
    if (monthKey) byMonth.set(monthKey, (byMonth.get(monthKey) || 0) + 1);
    byDow[d.getUTCDay()] += 1;
    byMoy[d.getUTCMonth()] += 1;
    const y = d.getUTCFullYear();
    byYear.set(y, (byYear.get(y) || 0) + 1);
  });
  const monthSeries = [...byMonth.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([month, count]) => ({ month, count }));
  const minT = arrMin(parsedTimes);
  const maxT = arrMax(parsedTimes);
  return {
    count: parsedTimes.length,
    missing,
    minDate: new Date(minT).toISOString().slice(0, 10),
    maxDate: new Date(maxT).toISOString().slice(0, 10),
    rangeDays: Math.round((maxT - minT) / 86400000),
    byMonth: monthSeries,
    byDayOfWeek: DAY_OF_WEEK_NAMES.map((label, i) => ({ label, count: byDow[i] })),
    byMonthOfYear: MONTH_OF_YEAR_NAMES.map((label, i) => ({ label, count: byMoy[i] })),
    byYear: [...byYear.entries()].sort(([a], [b]) => a - b).map(([year, count]) => ({ year, count })),
  };
}

// The FULL distinct value set is kept (not just a display-sized sample) —
// see detectRelationships() in services/fullDescriptiveAnalytics.js, which
// intersects two id columns' distinctValues directly in memory to measure
// how much one file's key actually overlaps with another's. An early
// version of this instead ran a live SQL DISTINCT+JOIN per candidate pair,
// which meant a second full scan of dataset_records per candidate and
// scaled badly once files ran into the hundreds of thousands of rows —
// keeping the set already computed during profiling and comparing it in
// JS avoids that second pass entirely. Bounded by the app's own per-file
// row cap (MAX_ROWS_PARSED in middleware/browse.js), so this is at most
// ~200,000 short strings — a few MB, well within what JSONB stores fine.
function profileId(values) {
  const nonBlank = values.filter((v) => !isBlank(v)).map((v) => String(v).trim());
  const missing = values.length - nonBlank.length;
  const distinct = new Set(nonBlank);
  const dupCount = nonBlank.length - distinct.size;
  return {
    count: nonBlank.length,
    uniqueCount: distinct.size,
    missing,
    duplicateCount: dupCount,
    uniquenessRatio: nonBlank.length > 0 ? distinct.size / nonBlank.length : null,
    distinctValues: [...distinct],
  };
}

function profileText(values) {
  const nonBlank = values.filter((v) => !isBlank(v)).map((v) => String(v));
  const missing = values.length - nonBlank.length;
  const avgLength = nonBlank.length ? Math.round(nonBlank.reduce((s, v) => s + v.length, 0) / nonBlank.length) : 0;
  return { count: nonBlank.length, missing, avgLength };
}

function profileColumn(name, values) {
  const kind = inferColumnKind(name, values);
  let stats;
  switch (kind) {
    case 'numeric': case 'currency': case 'percentage': case 'geo_lat': case 'geo_lng':
      stats = profileNumeric(values); break;
    case 'rating': stats = profileRating(values); break;
    case 'category': stats = profileCategory(values); break;
    case 'boolean': stats = profileBoolean(values); break;
    case 'date': stats = profileDate(values); break;
    case 'id': stats = profileId(values); break;
    case 'url': case 'text': stats = profileText(values); break;
    default: stats = { count: 0, missing: values.length };
  }
  return { name, kind, ...stats };
}

// Pearson correlation over rows where BOTH columns have a parseable value
// (pairwise-complete, not listwise) — the standard approach for a quick
// descriptive correlation pass over messy real-world data where different
// columns are missing on different rows.
function pearson(pairs) {
  const n = pairs.length;
  if (n < 3) return null;
  const xs = pairs.map((p) => p[0]);
  const ys = pairs.map((p) => p[1]);
  const mx = mean(xs);
  const my = mean(ys);
  let num = 0; let dx2 = 0; let dy2 = 0;
  for (let i = 0; i < n; i += 1) {
    const dx = xs[i] - mx;
    const dy = ys[i] - my;
    num += dx * dy;
    dx2 += dx * dx;
    dy2 += dy * dy;
  }
  const denom = Math.sqrt(dx2 * dy2);
  return denom === 0 ? null : num / denom;
}

function computeCorrelations(rows, numericColumnNames) {
  // Cap the column count (not the row count — see MAX_ROWS_PARSED in
  // middleware/browse.js, which already bounds every file to at most
  // 200,000 rows before this module ever sees it) so an n-choose-2 pass
  // stays small even on a wide file.
  const cols = numericColumnNames.slice(0, MAX_CORRELATION_COLUMNS);
  const results = [];
  for (let i = 0; i < cols.length; i += 1) {
    for (let j = i + 1; j < cols.length; j += 1) {
      const a = cols[i];
      const b = cols[j];
      const pairs = [];
      rows.forEach((row) => {
        const va = tryParseNumber(row[a]);
        const vb = tryParseNumber(row[b]);
        if (va !== null && vb !== null) pairs.push([va, vb]);
      });
      const r = pearson(pairs);
      if (r !== null) results.push({ a, b, r, sampleSize: pairs.length });
    }
  }
  return results.sort((x, y) => Math.abs(y.r) - Math.abs(x.r));
}

// Column-name hints for picking which numeric column is "the" business
// measure (price, sales_amount, cost, revenue, ...) vs. an incidental
// number (a bedroom count) or a numeric-looking identifier (a license
// number, a zip code, a phone number) that must NEVER be summed/averaged
// as if it were a measure. STRONG names win the "primary" measure slot
// (used for the trend chart's sum and listed first) over WEAK ones like
// "sales_qty" or "extra_fee" that are still worth surfacing but shouldn't
// out-rank an actual amount/price/revenue column just because they happen
// to come first in the file's own column order.
const STRONG_MEASURE_NAME_RE = /(amount|revenue|price|total|fare|cost|value)/i;
const MEASURE_NAME_RE = /(price|amount|sales|revenue|cost|fare|total|fee|deposit|charge)/i;
const ID_LIKE_MEASURE_EXCLUDE_RE = /(zip|postal|code|^id$|_id$|lic|licence|license|phone|fax|_no$|_num$|number)/i;

function profileFile(fileType, rows) {
  const rowCount = rows.length;
  // A leading blank header (`,col2,col3` in the raw CSV) is pandas'
  // exported row-index column, not real data — drop it rather than
  // profiling a column with no name to show.
  const columnNames = rowCount > 0 ? Object.keys(rows[0]).filter((name) => name.trim() !== '') : [];

  const columns = columnNames.map((name) => profileColumn(name, rows.map((r) => r[name])));

  // "The" business measure(s) — preferred in this order: an explicit
  // currency/rating/percentage column (self-evidently a measure by type),
  // then a plain numeric column whose NAME says it's a measure and whose
  // name doesn't also look like an identifier. Only when neither exists
  // at all does a generic numeric column (still excluding obvious id-like
  // names) get used as a fallback, so a trend/correlation never silently
  // sums a license number or a zip code.
  const typedMeasures = columns.filter((c) => ['currency', 'rating', 'percentage'].includes(c.kind) && c.count > 0);
  const namedMeasures = columns.filter((c) => c.kind === 'numeric' && c.count > 0
    && MEASURE_NAME_RE.test(c.name) && !ID_LIKE_MEASURE_EXCLUDE_RE.test(c.name))
    // Strong names (amount/revenue/price/...) sort ahead of weak ones
    // (sales/qty/fee/...) so e.g. "sales_amount" leads "sales_qty" as the
    // trend chart's primary measure regardless of column order in the file.
    .sort((a, b) => (STRONG_MEASURE_NAME_RE.test(b.name) ? 1 : 0) - (STRONG_MEASURE_NAME_RE.test(a.name) ? 1 : 0));
  let measureCandidates = [...typedMeasures, ...namedMeasures];
  if (measureCandidates.length === 0) {
    measureCandidates = columns.filter((c) => c.kind === 'numeric' && c.count > 0 && !ID_LIKE_MEASURE_EXCLUDE_RE.test(c.name));
  }
  const measureColumns = measureCandidates.map((c) => c.name);

  const dateColumns = columns.filter((c) => c.kind === 'date' && c.count > 0);
  // Prefer a date column with the most non-missing coverage — a file can
  // have several date-shaped columns (created_at, updated_at, cancelled_at)
  // and the most complete one is the best default timeline.
  const dateColumn = dateColumns.sort((a, b) => b.count - a.count)[0] || null;

  let trendByMonth = [];
  if (dateColumn && dateColumn.byMonth.length > 1) {
    const primaryMeasure = measureColumns[0] || null;
    if (primaryMeasure) {
      const sums = new Map();
      rows.forEach((row) => {
        const key = isBlank(row[dateColumn.name]) ? null : toMonthKey(row[dateColumn.name]);
        const val = tryParseNumber(row[primaryMeasure]);
        if (key && val !== null) sums.set(key, (sums.get(key) || 0) + val);
      });
      trendByMonth = [...sums.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([month, sum]) => ({ month, sum, count: dateColumn.byMonth.find((m) => m.month === month).count }));
    } else {
      trendByMonth = dateColumn.byMonth.map((m) => ({ month: m.month, sum: null, count: m.count }));
    }
  }

  const correlations = computeCorrelations(rows, measureColumns);

  return {
    fileType,
    rowCount,
    columns,
    dateColumnName: dateColumn ? dateColumn.name : null,
    measureColumns,
    trendByMonth,
    correlations,
    generatedAt: new Date().toISOString(),
  };
}

module.exports = {
  inferColumnKind,
  profileColumn,
  profileFile,
  tryParseNumber,
  looksLikeDate,
  evenSample,
  MEASURE_NAME_RE,
  HISTOGRAM_BINS,
  toMonthKey,
  // Round 21 — exported so services/predictiveAnalyticsDynamic.js's
  // occupancy/availability-based revenue estimation can recognize the
  // SAME true/false vocabulary this file already uses to profile a
  // boolean column ('t'/'f', 'yes'/'no', '1'/'0', ...), rather than a
  // second, independently-maintained copy of the same literal set.
  BOOL_TRUE,
  BOOL_FALSE,
};
