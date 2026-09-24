// Shared, dependency-free numeric/date/text helpers used by every module
// that works directly on raw (pre-Map-&-Transform) uploaded rows —
// services/evaluationReport.js and services/reportCatalog.js both need the
// same column-name normalization, loose numeric/date parsing, and
// pandas-compatible descriptive-statistics math, so it lives here once
// instead of being copy-pasted (and risking drift) between them.

function normalizeColumnName(column) {
  return String(column === null || column === undefined ? '' : column)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function parseNumericLoose(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(String(value).replace(/,/g, '').trim());
  return Number.isFinite(n) ? n : null;
}

function parseDateLoose(value) {
  if (value === null || value === undefined || value === '') return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

// Linear-interpolation quantile, matching pandas' default `.quantile()`.
function quantile(sortedValues, p) {
  if (sortedValues.length === 0) return null;
  if (sortedValues.length === 1) return sortedValues[0];
  const idx = p * (sortedValues.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sortedValues[lo];
  const weight = idx - lo;
  return sortedValues[lo] + (sortedValues[hi] - sortedValues[lo]) * weight;
}

function mean(values) {
  return values.length ? values.reduce((s, v) => s + v, 0) / values.length : null;
}

// Sample variance/std (ddof=1, matching pandas' default) and the
// bias-corrected (Fisher-Pearson adjusted) skewness pandas' .skew() uses.
function sampleVarianceAndSkew(values) {
  const n = values.length;
  if (n < 2) return { variance: null, std: null, skewness: null };
  const m = mean(values);
  const variance = values.reduce((s, v) => s + (v - m) ** 2, 0) / (n - 1);
  const std = Math.sqrt(variance);
  let skewness = null;
  if (n > 2 && std > 0) {
    const m3 = values.reduce((s, v) => s + ((v - m) / std) ** 3, 0);
    skewness = (n / ((n - 1) * (n - 2))) * m3;
  }
  return { variance, std, skewness };
}

function histogramBuckets(values, binCount = 10) {
  const clean = values.filter((v) => v !== null && v !== undefined);
  if (clean.length === 0) return [];
  const min = Math.min(...clean);
  const max = Math.max(...clean);
  if (min === max) return [{ label: min.toLocaleString(), value: clean.length }];
  const width = (max - min) / binCount;
  const buckets = new Array(binCount).fill(0);
  clean.forEach((v) => {
    let idx = Math.floor((v - min) / width);
    if (idx >= binCount) idx = binCount - 1;
    if (idx < 0) idx = 0;
    buckets[idx] += 1;
  });
  return buckets.map((count, i) => {
    const lo = min + i * width;
    const hi = min + (i + 1) * width;
    return { label: `${lo.toLocaleString(undefined, { maximumFractionDigits: 1 })}–${hi.toLocaleString(undefined, { maximumFractionDigits: 1 })}`, value: count };
  });
}

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function monthKeyFrom(date) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}
function monthLabelFrom(key) {
  const [y, m] = key.split('-');
  return `${MONTH_NAMES[parseInt(m, 10) - 1]} ${y}`;
}

module.exports = {
  normalizeColumnName,
  parseNumericLoose,
  parseDateLoose,
  quantile,
  mean,
  sampleVarianceAndSkew,
  histogramBuckets,
  monthKeyFrom,
  monthLabelFrom,
  MONTH_NAMES,
  WEEKDAY_NAMES,
};
