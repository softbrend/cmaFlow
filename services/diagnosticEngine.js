// Automatic Dataset Intelligence & Analytics Engine — Diagnostic Analytics
// layer. Sibling of services/metricRegistry.js (Analytics Generation):
// where that module answers "what happened" (descriptive metrics), this
// module answers "why" for a fixed catalog of 12 SME-relevant diagnostic
// questions (see claude/ — the follow-up doc this feature ships with),
// each backed by a real statistical method chosen by the shape of the
// variables involved — never a fixed chart wired to one dataset's column
// names.
//
// Design principle (stated directly by the person who commissioned this):
// "CMA-FLOW selects the diagnostic method based on the variable types and
// the descriptive anomaly/finding." In practice that means every one of
// the 12 questions below is answered by one of a SMALL set of reusable
// statistical PRIMITIVES, and each primitive itself branches on whether a
// candidate explanatory column is numeric or categorical to pick the
// right sub-method:
//   - numeric   -> Pearson correlation, a depth-1 regression-tree "split"
//   - categorical -> correlation-ratio (eta) group comparison, chi-square
// This is what "selects the method based on variable type" means here —
// not 12 independent hand-picked computations, but ~6 primitives (A–F
// below) that each already contain that branch.
//
// Honesty policy (explicitly agreed with the person commissioning this,
// since this app has no ML/stats library — every number below is
// hand-written plain JS, same as the rest of this codebase):
//   - Pearson correlation, the correlation ratio (eta), Cohen's d, and the
//     chi-square test are all REAL, textbook statistics, computed exactly.
//   - "Decision tree" here means a genuine depth-1 split (bestNumericSplit
//     below) — the single best-separating threshold/category, exactly what
//     the root node of a real CART tree would pick — not a full multi-level
//     tree.
//   - "Logistic regression" is never fit as a real model here (no
//     iterative solver in this codebase). Wherever the person's own
//     table calls for it, this module instead reports the standardized
//     mean difference between the two outcome groups (Cohen's d) and/or a
//     chi-square association — both correct, well-understood statistics
//     that answer the same underlying question ("does this factor
//     distinguish the two outcomes?") without pretending to be a fitted
//     model. Every place this happens says so in its `method` string.
//   - The chi-square significance call uses a standard critical-value
//     table at alpha = 0.05 (Wilson–Hilferty approximation past df=20),
//     not a continuous p-value — deliberately, to avoid the numerical
//     instability of a hand-rolled regularized incomplete gamma function.
//
// Pure functions only, mirroring services/metricRegistry.js — this module
// never touches the database or renders HTML. services/
// fullDescriptiveAnalytics.js's getOrBuildBusinessIntelligence() builds
// the same `ctx` this module and metricRegistry.js both consume and calls
// evaluateDiagnostics(ctx) alongside evaluateMetrics(ctx); routes/
// dashboard.js turns the plain result objects below into HTML.

const { tryParseNumber, toMonthKey } = require('./datasetProfiler');
const {
  findRoleColumn, resolveGeo, sumColumn, titleize, entityLabelFromIdColumn,
  pluralize, STATUS_NAME_RE, CANCEL_VALUE_RE, GENERIC_CATEGORY_NAME_RE,
  PAYMENT_MECHANISM_NAME_RE, ESTIMATED_DATE_NAME_RE, ACTUAL_DATE_NAME_RE,
  // findRevenueColumn is imported rather than redefined here — see its own
  // comment in metricRegistry.js: this is the one place the "revenue role,
  // falling back to price on a dated/order-keyed row" DECISION lives, so
  // this engine and the Business Metrics registry can never disagree about
  // what counts as revenue for the same dataset. This engine keeps its own
  // revenueFallbackNote() below, though — a different, narrative-sentence-
  // shaped disclosure than metricRegistry.js's provenance-note version, for
  // its own narrative-sentence output shape.
  findRevenueColumn,
} = require('./metricRegistry');
// CAAGA Stage 6 (Priority + Confidence Engine) — see services/
// priorityEngine.js's own header for the full Priority(A) formula and why
// Priority and Confidence are kept as two separate numbers. scoreDiagnostic
// Finding() below is the per-finding-type wiring: it extracts the six
// factors from whatever this file's own generators already computed (never
// a fresh recomputation) and hands them to computePriority()/
// computeConfidence().
const {
  computePriority, computeConfidence, sufficiencyRatio, cramersVFromChiSquare,
  normalizeCohensD, normalizeCorrelation, clamp01,
} = require('./priorityEngine');
const { quantile } = require('./statsUtils');

// ---------------------------------------------------------------------
// Small stats primitives — mean/variance/correlation/chi-square/splits.
// Every one of these is a plain, textbook formula; none of them is an
// approximation dressed up as something fancier than it is.
// ---------------------------------------------------------------------

function mean(values) {
  if (values.length === 0) return null;
  return values.reduce((s, v) => s + v, 0) / values.length;
}

function variance(values, providedMean = null) {
  if (values.length < 2) return 0;
  const m = providedMean === null ? mean(values) : providedMean;
  return values.reduce((s, v) => s + (v - m) ** 2, 0) / values.length;
}

function stdev(values, providedMean = null) {
  return Math.sqrt(variance(values, providedMean));
}

// Pearson product-moment correlation coefficient between two equal-length
// numeric arrays. Returns null when there isn't enough variance or data
// to compute a meaningful value.
function pearsonCorrelation(xs, ys) {
  const n = xs.length;
  if (n < 10) return null;
  const mx = mean(xs);
  const my = mean(ys);
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i += 1) {
    const dx = xs[i] - mx;
    const dy = ys[i] - my;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }
  if (sxx === 0 || syy === 0) return null;
  return sxy / Math.sqrt(sxx * syy);
}

// Correlation ratio (eta) between a categorical grouping and a numeric
// target — the standard ANOVA-style effect size for "how much of this
// numeric measure's variance is explained by which group a row falls
// into," on the same [0, 1] magnitude scale as |Pearson r|, so a
// categorical and a numeric candidate can be ranked side by side honestly.
function correlationRatio(groups) {
  // groups: Map<label, number[]>
  const allValues = [];
  groups.forEach((vals) => allValues.push(...vals));
  if (allValues.length < 10 || groups.size < 2) return null;
  const grandMean = mean(allValues);
  const ssTotal = allValues.reduce((s, v) => s + (v - grandMean) ** 2, 0);
  if (ssTotal === 0) return null;
  let ssBetween = 0;
  groups.forEach((vals) => {
    if (vals.length === 0) return;
    const gMean = mean(vals);
    ssBetween += vals.length * (gMean - grandMean) ** 2;
  });
  return Math.sqrt(Math.max(0, ssBetween / ssTotal));
}

// Cohen's d — standardized mean difference between two groups, using the
// pooled standard deviation. The honest, non-model-fitting stand-in this
// module uses everywhere the person's own table calls for "logistic
// regression" against a numeric candidate (see the file header).
function cohensD(groupA, groupB) {
  if (groupA.length < 5 || groupB.length < 5) return null;
  const mA = mean(groupA);
  const mB = mean(groupB);
  const vA = variance(groupA, mA);
  const vB = variance(groupB, mB);
  const nA = groupA.length;
  const nB = groupB.length;
  const pooledVar = ((nA - 1) * vA + (nB - 1) * vB) / (nA + nB - 2);
  if (pooledVar <= 0) return null;
  return (mA - mB) / Math.sqrt(pooledVar);
}

// Depth-1 regression-tree "stump": scans every midpoint between sorted
// distinct values of a numeric predictor and picks the single threshold
// that best separates the target into two groups (maximum variance
// reduction) — exactly what the root split of a real CART tree would
// choose, just not grown any deeper. Works for a numeric OR a 0/1 binary
// target (variance reduction on a 0/1 target is a legitimate, if simple,
// classification split criterion).
function bestNumericSplit(pairs) {
  // pairs: [{x, y}], x = predictor, y = target
  const sorted = [...pairs].sort((a, b) => a.x - b.x);
  const n = sorted.length;
  if (n < 20) return null;
  const ys = sorted.map((p) => p.y);
  const totalVar = variance(ys);
  if (totalVar === 0) return null;

  const distinctX = [...new Set(sorted.map((p) => p.x))];
  if (distinctX.length < 2) return null;

  // Prefix sums of y and y² over the x-sorted order (built once, O(n)),
  // so each candidate threshold's left/right variance can be read off in
  // O(1) via the one-pass variance formula (E[y²] − E[y]², algebraically
  // identical to variance()'s two-pass mean-then-deviations formula for
  // this app's ordinary business-data value ranges) instead of re-scanning
  // every one of the n rows per threshold. The previous version rebuilt
  // `left`/`right` arrays from scratch for every one of the
  // distinctX.length candidate thresholds, making the whole function
  // O(distinctX.length × n) — on a high-cardinality numeric column (e.g. a
  // price field with thousands of distinct values) against a large fact
  // table (Olist order_items: ~112K rows), that was measured taking over
  // 40 seconds by itself — the single largest cost in a full diagnostic-
  // engine run. This is the standard prefix-sum technique for scanning
  // every single-threshold split of a sorted numeric column and produces
  // the same reduction/threshold results, just without the repeated scans.
  const prefixSum = new Array(n + 1).fill(0);
  const prefixSumSq = new Array(n + 1).fill(0);
  for (let i = 0; i < n; i += 1) {
    prefixSum[i + 1] = prefixSum[i] + ys[i];
    prefixSumSq[i + 1] = prefixSumSq[i] + ys[i] * ys[i];
  }
  const groupVariance = (sum, sumSq, count) => (count === 0 ? 0 : (sumSq / count) - (sum / count) ** 2);

  // All rows sharing a given x value sit in one contiguous block within
  // `sorted` (it's sorted by x); this maps each distinct x to the index of
  // the LAST row carrying it, so "how many rows have x <= distinctX[i]" is
  // a direct lookup rather than a re-scan.
  const lastIndexForX = new Map();
  sorted.forEach((p, idx) => { lastIndexForX.set(p.x, idx); });

  let best = null;
  const MIN_GROUP = Math.max(5, Math.floor(n * 0.1));
  for (let i = 0; i < distinctX.length - 1; i += 1) {
    const threshold = (distinctX[i] + distinctX[i + 1]) / 2;
    const splitIdx = lastIndexForX.get(distinctX[i]) + 1; // rows [0, splitIdx) are <= threshold
    const leftCount = splitIdx;
    const rightCount = n - splitIdx;
    if (leftCount < MIN_GROUP || rightCount < MIN_GROUP) continue;
    const leftSum = prefixSum[splitIdx];
    const leftSumSq = prefixSumSq[splitIdx];
    const rightSum = prefixSum[n] - leftSum;
    const rightSumSq = prefixSumSq[n] - leftSumSq;
    const weightedVar = (leftCount * groupVariance(leftSum, leftSumSq, leftCount)
      + rightCount * groupVariance(rightSum, rightSumSq, rightCount)) / n;
    const reduction = totalVar - weightedVar;
    if (!best || reduction > best.reduction) {
      best = {
        threshold, reduction, leftCount, rightCount, leftMean: leftSum / leftCount, rightMean: rightSum / rightCount,
      };
    }
  }
  if (!best || best.reduction <= 0) return null;
  return { ...best, reductionPct: (best.reduction / totalVar) * 100 };
}

// Chi-square critical value at alpha = 0.05 for a given degrees of
// freedom. The first 20 are a standard textbook table; past that, the
// Wilson–Hilferty cube-root normal approximation (a well-established,
// numerically stable approximation — never a hand-rolled incomplete
// gamma function, which is the numerically risky path this module
// deliberately avoids).
const CHI_SQUARE_CRITICAL_05 = {
  1: 3.841, 2: 5.991, 3: 7.815, 4: 9.488, 5: 11.070,
  6: 12.592, 7: 14.067, 8: 15.507, 9: 16.919, 10: 18.307,
  11: 19.675, 12: 21.026, 13: 22.362, 14: 23.685, 15: 24.996,
  16: 26.296, 17: 27.587, 18: 28.869, 19: 30.144, 20: 31.410,
};
function chiSquareCriticalValue(df) {
  if (CHI_SQUARE_CRITICAL_05[df]) return CHI_SQUARE_CRITICAL_05[df];
  const z = 1.645; // one-sided 95th percentile of the standard normal
  const term = 1 - (2 / (9 * df)) + z * Math.sqrt(2 / (9 * df));
  return df * (term ** 3);
}

// Two-way contingency table + chi-square statistic. `table` is an array
// of rows (row label + one count per column label), already laid out for
// direct rendering.
function chiSquareTest(rowLabels, colLabels, counts) {
  // counts: counts[rowLabel][colLabel] = n
  const rowTotals = rowLabels.map((r) => colLabels.reduce((s, c) => s + (counts[r][c] || 0), 0));
  const colTotals = colLabels.reduce((acc, c) => {
    acc[c] = rowLabels.reduce((s, r) => s + (counts[r][c] || 0), 0);
    return acc;
  }, {});
  const grandTotal = rowTotals.reduce((s, v) => s + v, 0);
  if (grandTotal < 20) return null; // too little data for a trustworthy chi-square

  let chiSquare = 0;
  let maxResidual = null;
  rowLabels.forEach((r, ri) => {
    colLabels.forEach((c) => {
      const observed = counts[r][c] || 0;
      const expected = (rowTotals[ri] * colTotals[c]) / grandTotal;
      if (expected <= 0) return;
      const term = ((observed - expected) ** 2) / expected;
      chiSquare += term;
      const stdResidual = (observed - expected) / Math.sqrt(expected);
      if (!maxResidual || Math.abs(stdResidual) > Math.abs(maxResidual.stdResidual)) {
        maxResidual = {
          row: r, col: c, observed, expected: Math.round(expected * 10) / 10, stdResidual,
        };
      }
    });
  });

  const df = (rowLabels.length - 1) * (colLabels.length - 1);
  if (df < 1) return null;
  const criticalValue = chiSquareCriticalValue(df);
  return {
    chiSquare: Math.round(chiSquare * 100) / 100,
    df,
    criticalValue: Math.round(criticalValue * 100) / 100,
    significant: chiSquare > criticalValue,
    grandTotal,
    mostAssociatedCell: maxResidual,
  };
}

function modeOf(values) {
  const counts = new Map();
  values.forEach((v) => counts.set(v, (counts.get(v) || 0) + 1));
  let best = null;
  counts.forEach((count, label) => { if (!best || count > best.count) best = { label, count }; });
  return best ? best.label : null;
}

// ---------------------------------------------------------------------
// Month-bucketing helpers, matching the same toMonthKey() every trend
// chart and the raw-month drill-down already bucket by (see
// services/datasetProfiler.js) — so a diagnostic's "last two months"
// always agrees with what the descriptive trend charts show.
// ---------------------------------------------------------------------

function bucketByMonth(rows, dateAccessor, valueAccessor, agg = 'sum') {
  const buckets = new Map();
  rows.forEach((row) => {
    const month = toMonthKey(dateAccessor(row));
    if (!month) return;
    const val = valueAccessor(row);
    if (val === null || val === undefined) return;
    if (!buckets.has(month)) buckets.set(month, { sum: 0, count: 0 });
    const b = buckets.get(month);
    b.sum += val;
    b.count += 1;
  });
  return [...buckets.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([month, b]) => ({
      month, value: agg === 'count' ? b.count : agg === 'avg' ? (b.count ? b.sum / b.count : 0) : b.sum, count: b.count,
    }));
}

function lastTwoMonths(monthly) {
  if (monthly.length < 2) return null;
  return { prev: monthly[monthly.length - 2], curr: monthly[monthly.length - 1] };
}

function pctChange(prev, curr) {
  if (prev === 0) return null;
  return ((curr - prev) / Math.abs(prev)) * 100;
}

function directionWord(prev, curr) {
  if (curr > prev) return 'increased';
  if (curr < prev) return 'decreased';
  return 'stayed flat';
}

// ---------------------------------------------------------------------
// Primitive A — period-over-period contribution analysis. Compares the
// two most recent months present for one aggregate measure (sum or
// count), then re-runs the same month-over-month comparison broken down
// by one dimension (category, geography, a customer/merchant/product
// label, ...) to rank which values of that dimension explain most of the
// change. Every per-dimension delta is an exact partition of the total
// delta (barring rows with no value for that dimension) — nothing here is
// modeled or estimated. Covers "Revenue decreased" (#1), "Orders
// decreased" (#2), and the trend half of "Category revenue fell" (#7).
// ---------------------------------------------------------------------
function periodOverPeriodContribution(rows, dateAccessor, valueAccessor, agg = 'sum') {
  const monthly = bucketByMonth(rows, dateAccessor, valueAccessor, agg);
  const pair = lastTwoMonths(monthly);
  if (!pair) return null;
  const { prev, curr } = pair;
  const delta = curr.value - prev.value;
  return {
    prevMonth: prev.month, currMonth: curr.month, prevValue: prev.value, currValue: curr.value, delta, pct: pctChange(prev.value, curr.value), direction: directionWord(prev.value, curr.value),
  };
}

// Same comparison, but grouped by an arbitrary dimension label — restricted
// to rows falling in the two months identified by `overall` (so every
// dimension's numbers are drawn from the exact same two periods as the
// headline figure they're explaining).
function contributionByDimension(rows, dateAccessor, valueAccessor, dimAccessor, overall, agg = 'sum', topN = 8) {
  const groups = new Map();
  rows.forEach((row) => {
    const month = toMonthKey(dateAccessor(row));
    if (month !== overall.prevMonth && month !== overall.currMonth) return;
    const dimRaw = dimAccessor(row);
    if (dimRaw === null || dimRaw === undefined || String(dimRaw).trim() === '') return;
    const dim = String(dimRaw).trim();
    const val = valueAccessor(row);
    if (val === null || val === undefined) return;
    if (!groups.has(dim)) groups.set(dim, { prev: { sum: 0, count: 0 }, curr: { sum: 0, count: 0 } });
    const slot = groups.get(dim)[month === overall.prevMonth ? 'prev' : 'curr'];
    slot.sum += val;
    slot.count += 1;
  });

  const rowsOut = [...groups.entries()].map(([label, g]) => {
    const prevValue = agg === 'count' ? g.prev.count : agg === 'avg' ? (g.prev.count ? g.prev.sum / g.prev.count : 0) : g.prev.sum;
    const currValue = agg === 'count' ? g.curr.count : agg === 'avg' ? (g.curr.count ? g.curr.sum / g.curr.count : 0) : g.curr.sum;
    return { label, prevValue, currValue, delta: currValue - prevValue };
  });

  const totalDelta = overall.delta;
  rowsOut.forEach((r) => { r.pctOfChange = totalDelta !== 0 ? (r.delta / Math.abs(totalDelta)) * 100 : null; });
  rowsOut.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
  return rowsOut.slice(0, topN);
}

// ---------------------------------------------------------------------
// Primitive B — exact decompositions (no residual; see file header for
// why these two are exact, not approximate).
// ---------------------------------------------------------------------

// ΔRevenue = (Δorders × prevAOV) [volume effect] + (currOrders × ΔAOV)
// [price effect]. Covers the decomposition half of "Revenue decreased" (#1).
function priceVolumeDecomposition(prevOrders, prevAOV, currOrders, currAOV) {
  if (!prevOrders || !currOrders) return null;
  const volumeEffect = (currOrders - prevOrders) * prevAOV;
  const priceEffect = currOrders * (currAOV - prevAOV);
  return {
    prevOrders, currOrders, prevAOV, currAOV, volumeEffect, priceEffect, totalDelta: volumeEffect + priceEffect,
  };
}

// Shift-share mix/rate decomposition of a change in average order value
// across categories: mix effect = how much of the AOV change came from
// customers buying a different MIX of categories at unchanged prices;
// rate effect = how much came from the price WITHIN each category moving.
// Exact by construction — mixEffect + rateEffect always equals the total
// AOV delta (see file header derivation). Covers "AOV decreased" (#3).
function mixRateDecomposition(prevByCategory, currByCategory) {
  // prevByCategory / currByCategory: Map<category, {revenue, orders}>
  const categories = new Set([...prevByCategory.keys(), ...currByCategory.keys()]);
  const prevTotalOrders = [...prevByCategory.values()].reduce((s, v) => s + v.orders, 0);
  const currTotalOrders = [...currByCategory.values()].reduce((s, v) => s + v.orders, 0);
  if (!prevTotalOrders || !currTotalOrders) return null;

  let mixEffect = 0;
  let rateEffect = 0;
  const perCategory = [];
  categories.forEach((cat) => {
    const p = prevByCategory.get(cat) || { revenue: 0, orders: 0 };
    const c = currByCategory.get(cat) || { revenue: 0, orders: 0 };
    const prevShare = p.orders / prevTotalOrders;
    const currShare = c.orders / currTotalOrders;
    const prevAOVc = p.orders ? p.revenue / p.orders : 0;
    const currAOVc = c.orders ? c.revenue / c.orders : 0;
    const mixTerm = (currShare - prevShare) * prevAOVc;
    const rateTerm = currShare * (currAOVc - prevAOVc);
    mixEffect += mixTerm;
    rateEffect += rateTerm;
    if (p.orders > 0 || c.orders > 0) {
      perCategory.push({
        label: cat, prevShare: prevShare * 100, currShare: currShare * 100, prevAOV: prevAOVc, currAOV: currAOVc, mixTerm, rateTerm,
      });
    }
  });
  perCategory.sort((a, b) => (Math.abs(b.mixTerm) + Math.abs(b.rateTerm)) - (Math.abs(a.mixTerm) + Math.abs(a.rateTerm)));
  return {
    mixEffect, rateEffect, totalDelta: mixEffect + rateEffect, perCategory: perCategory.slice(0, 10),
  };
}

// ---------------------------------------------------------------------
// Primitive C — explain a NUMERIC target from a mix of numeric and
// categorical candidate columns: Pearson correlation for numeric
// candidates, the correlation ratio (eta) plus a best-split stump for
// categorical candidates, and a depth-1 regression-tree split for numeric
// candidates too. Covers "Freight cost is high" (#4), "Delivery is late"
// (#5), and "Review scores are low" (#6).
// ---------------------------------------------------------------------
function explainFactorsFor(rows, targetAccessor, candidates) {
  const numericResults = [];
  const categoricalResults = [];

  candidates.forEach((cand) => {
    if (cand.type === 'numeric') {
      const xs = [];
      const ys = [];
      rows.forEach((row) => {
        const x = cand.accessor(row);
        const y = targetAccessor(row);
        if (x === null || x === undefined || y === null || y === undefined) return;
        if (!Number.isFinite(x) || !Number.isFinite(y)) return;
        xs.push(x);
        ys.push(y);
      });
      const r = pearsonCorrelation(xs, ys);
      if (r === null) return;
      const split = bestNumericSplit(xs.map((x, i) => ({ x, y: ys[i] })));
      numericResults.push({
        label: cand.label, correlation: r, n: xs.length, split,
      });
    } else {
      const groups = new Map();
      rows.forEach((row) => {
        const g = cand.accessor(row);
        const y = targetAccessor(row);
        if (g === null || g === undefined || String(g).trim() === '') return;
        if (y === null || y === undefined || !Number.isFinite(y)) return;
        const key = String(g).trim();
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(y);
      });
      const eta = correlationRatio(groups);
      if (eta === null) return;
      const overall = mean([...groups.values()].flat());
      let best = null;
      groups.forEach((vals, label) => {
        if (vals.length < 5) return;
        const gMean = mean(vals);
        const dev = Math.abs(gMean - overall);
        if (!best || dev > best.dev) best = { label, mean: gMean, count: vals.length, dev };
      });
      categoricalResults.push({
        label: cand.label, eta, overallMean: overall, bestGroup: best, groupCount: groups.size,
      });
    }
  });

  numericResults.sort((a, b) => Math.abs(b.correlation) - Math.abs(a.correlation));
  categoricalResults.sort((a, b) => b.eta - a.eta);
  if (numericResults.length === 0 && categoricalResults.length === 0) return null;
  return { numericResults, categoricalResults };
}

// ---------------------------------------------------------------------
// Primitive D — performance segmentation: group rows by an arbitrary key
// (a seller, a geography, ...), rank groups by a primary measure, and
// compare the top vs. bottom performers across every requested measure.
// Covers "Seller performance varies" (#8) and "Certain states have lower
// sales" (#10).
// ---------------------------------------------------------------------
function performanceSegmentation(rows, keyAccessor, measures, minGroupSize = 5) {
  // measures: [{key, label, accessor, agg: 'sum'|'avg'}]
  const groups = new Map();
  rows.forEach((row) => {
    const keyRaw = keyAccessor(row);
    if (keyRaw === null || keyRaw === undefined || String(keyRaw).trim() === '') return;
    const key = String(keyRaw).trim();
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  });

  const groupRows = [...groups.entries()]
    .filter(([, groupRowsArr]) => groupRowsArr.length >= minGroupSize)
    .map(([label, groupRowsArr]) => {
      const out = { label, rowCount: groupRowsArr.length };
      measures.forEach((m) => {
        const vals = groupRowsArr.map((r) => m.accessor(r)).filter((v) => v !== null && v !== undefined && Number.isFinite(v));
        if (vals.length === 0) { out[m.key] = null; return; }
        out[m.key] = m.agg === 'avg' ? mean(vals) : vals.reduce((s, v) => s + v, 0);
      });
      return out;
    });

  if (groupRows.length < 4) return null; // not enough distinct, sizeable groups to call this "varies"

  const primary = measures[0].key;
  groupRows.sort((a, b) => (b[primary] || 0) - (a[primary] || 0));
  const primaryValues = groupRows.map((g) => g[primary]).filter((v) => v !== null);
  const spreadMean = mean(primaryValues);
  const spreadStdev = stdev(primaryValues, spreadMean);
  const coefficientOfVariation = spreadMean ? (spreadStdev / Math.abs(spreadMean)) * 100 : null;

  const topN = Math.min(5, Math.floor(groupRows.length / 2));
  return {
    totalGroups: groupRows.length,
    top: groupRows.slice(0, topN),
    bottom: groupRows.slice(-topN).reverse(),
    coefficientOfVariation,
    measures,
  };
}

// ---------------------------------------------------------------------
// Primitive E — explain a BINARY target (canceled vs. not, repeat vs.
// one-time) from numeric and categorical candidates: a real chi-square
// test (with the significance-lookup call, never a continuous p-value —
// see file header) for categorical candidates, Cohen's d + a depth-1
// split for numeric ones. Covers "Cancellations increased" (#9) and
// "Repeat purchasing differs" (#12).
// ---------------------------------------------------------------------
function explainBinaryFactorsFor(rows, targetBinaryAccessor, candidates) {
  const numericResults = [];
  const categoricalResults = [];

  candidates.forEach((cand) => {
    if (cand.type === 'numeric') {
      const trueVals = [];
      const falseVals = [];
      const pairs = [];
      rows.forEach((row) => {
        const x = cand.accessor(row);
        const t = targetBinaryAccessor(row);
        if (x === null || x === undefined || !Number.isFinite(x) || t === null || t === undefined) return;
        (t ? trueVals : falseVals).push(x);
        pairs.push({ x, y: t ? 1 : 0 });
      });
      const d = cohensD(trueVals, falseVals);
      if (d === null) return;
      numericResults.push({
        label: cand.label, cohensD: d, trueMean: mean(trueVals), falseMean: mean(falseVals), trueCount: trueVals.length, falseCount: falseVals.length, split: bestNumericSplit(pairs),
      });
    } else {
      const rowLabelsSet = new Set();
      const counts = {};
      rows.forEach((row) => {
        const g = cand.accessor(row);
        const t = targetBinaryAccessor(row);
        if (g === null || g === undefined || String(g).trim() === '' || t === null || t === undefined) return;
        const key = String(g).trim();
        rowLabelsSet.add(key);
        if (!counts[key]) counts[key] = { true: 0, false: 0 };
        counts[key][t ? 'true' : 'false'] += 1;
      });
      let rowLabels = [...rowLabelsSet];
      // Cap cardinality — a wide categorical column (e.g. hundreds of
      // states/products) folds everything past the top 8 by row count
      // into "Other" so the contingency table stays a real cross-tab, not
      // a 200-row wall.
      if (rowLabels.length > 8) {
        rowLabels.sort((a, b) => (counts[b].true + counts[b].false) - (counts[a].true + counts[a].false));
        const kept = rowLabels.slice(0, 8);
        const rest = rowLabels.slice(8);
        const other = { true: 0, false: 0 };
        rest.forEach((k) => { other.true += counts[k].true; other.false += counts[k].false; });
        rowLabels = [...kept, 'Other'];
        counts.Other = other;
      }
      const test = chiSquareTest(rowLabels, ['true', 'false'], counts);
      if (!test) return;
      categoricalResults.push({
        label: cand.label, test, rowLabels, counts,
      });
    }
  });

  numericResults.sort((a, b) => Math.abs(b.cohensD) - Math.abs(a.cohensD));
  categoricalResults.sort((a, b) => b.test.chiSquare - a.test.chiSquare);
  if (numericResults.length === 0 && categoricalResults.length === 0) return null;
  return { numericResults, categoricalResults };
}

// ---------------------------------------------------------------------
// Primitive F — crosstab + chi-square between two categorical columns.
// Covers "Payment behavior differs" (#11).
// ---------------------------------------------------------------------
function crosstabChiSquare(rows, colAAccessor, colBAccessor) {
  const rowLabelsSet = new Set();
  const colLabelsSet = new Set();
  const counts = {};
  rows.forEach((row) => {
    const a = colAAccessor(row);
    const b = colBAccessor(row);
    if (a === null || a === undefined || String(a).trim() === '') return;
    if (b === null || b === undefined || String(b).trim() === '') return;
    const ak = String(a).trim();
    const bk = String(b).trim();
    rowLabelsSet.add(ak);
    colLabelsSet.add(bk);
    if (!counts[ak]) counts[ak] = {};
    counts[ak][bk] = (counts[ak][bk] || 0) + 1;
  });

  const capLabels = (labelsSet, dim) => {
    let labels = [...labelsSet];
    if (labels.length <= 8) return labels;
    const totals = labels.map((l) => ({
      l,
      total: dim === 'row'
        ? Object.values(counts[l] || {}).reduce((s, v) => s + v, 0)
        : [...rowLabelsSet].reduce((s, r) => s + ((counts[r] || {})[l] || 0), 0),
    }));
    totals.sort((x, y) => y.total - x.total);
    labels = totals.slice(0, 8).map((t) => t.l);
    return labels;
  };

  const rowLabels = capLabels(rowLabelsSet, 'row');
  const colLabels = capLabels(colLabelsSet, 'col');
  // Fold anything outside the kept labels into "Other" on each axis so the
  // table stays square and every original row is still represented.
  const folded = {};
  rowLabels.concat(['Other']).forEach((r) => { folded[r] = {}; });
  Object.entries(counts).forEach(([a, byB]) => {
    const rKey = rowLabels.includes(a) ? a : 'Other';
    Object.entries(byB).forEach(([b, n]) => {
      const cKey = colLabels.includes(b) ? b : 'Other';
      folded[rKey][cKey] = (folded[rKey][cKey] || 0) + n;
    });
  });
  const finalRowLabels = rowLabels.concat(Object.values(folded.Other || {}).some((v) => v > 0) || rowLabels.length < rowLabelsSet.size ? ['Other'] : []);
  const finalColLabels = colLabels.concat(colLabels.length < colLabelsSet.size ? ['Other'] : []);
  if (finalRowLabels.length < 2 || finalColLabels.length < 2) return null;

  const test = chiSquareTest(finalRowLabels, finalColLabels, folded);
  if (!test) return null;
  return {
    rowLabels: finalRowLabels, colLabels: finalColLabels, counts: folded, test,
  };
}

// ---------------------------------------------------------------------
// Column/role detection specific to the diagnostic engine — every one of
// these scans by NAME PATTERN or PROFILED KIND, never a fixed dataset's
// exact column name, matching the rest of this codebase's "generalized
// engine" convention (see services/metricRegistry.js's own header).
// ---------------------------------------------------------------------
const FREIGHT_NAME_RE = /freight|shipping[_ ]?(?:fee|cost|charge)/i;
const WEIGHT_DIMENSION_NAME_RE = /weight|\blength\b|\bheight\b|\bwidth\b|\bvolume\b|\bcm\b|\bkg\b/i;
const INSTALLMENTS_NAME_RE = /installment/i;

function findByNamePattern(factFileProfile, re, kinds) {
  if (!factFileProfile) return null;
  return factFileProfile.columns.find((c) => kinds.includes(c.kind) && re.test(c.name)) || null;
}

function findRatingColumn(ctx) {
  if (!ctx.factFileProfile) return null;
  return ctx.factFileProfile.columns.find((c) => c.kind === 'rating') || null;
}

function findCategoryColumn(ctx) {
  return findByNamePattern(ctx.factFileProfile, GENERIC_CATEGORY_NAME_RE, ['category']);
}

function findPaymentColumn(ctx) {
  return findByNamePattern(ctx.factFileProfile, PAYMENT_MECHANISM_NAME_RE, ['category']);
}

function findCancelStatusColumn(ctx) {
  const statusCol = findByNamePattern(ctx.factFileProfile, STATUS_NAME_RE, ['category']);
  if (!statusCol) return null;
  const hasCancelValue = ctx.factFile.rows.some((row) => CANCEL_VALUE_RE.test(String(row[statusCol.name] || '')));
  return hasCancelValue ? statusCol : null;
}

function findWeightDimensionColumns(ctx) {
  if (!ctx.factFileProfile) return [];
  return ctx.factFileProfile.columns.filter((c) => ['numeric', 'currency'].includes(c.kind) && WEIGHT_DIMENSION_NAME_RE.test(c.name));
}

// Per-row delivery delay in days (actual − estimated), reusing the exact
// same "estimated/expected vs. actual/delivered" date-pair detection as
// services/metricRegistry.js's buildDatePairMetrics() — but returning one
// value PER ROW here (needed as a per-row target/candidate for the
// diagnostics below), where that function only ever returns the aggregate
// average and on-time rate.
function computeRowDelays(ctx) {
  if (!ctx.factFileProfile) return null;
  const estCol = ctx.factFileProfile.columns.find((c) => c.kind === 'date' && ESTIMATED_DATE_NAME_RE.test(c.name));
  const actCol = ctx.factFileProfile.columns.find((c) => c.kind === 'date' && ACTUAL_DATE_NAME_RE.test(c.name));
  if (!estCol || !actCol) return null;
  const MS_PER_DAY = 86400000;
  const delayByRowIndex = new Map();
  ctx.factFile.rows.forEach((row, idx) => {
    const est = Date.parse(String(row[estCol.name] || '').trim());
    const act = Date.parse(String(row[actCol.name] || '').trim());
    if (Number.isFinite(est) && Number.isFinite(act)) delayByRowIndex.set(idx, (act - est) / MS_PER_DAY);
  });
  if (delayByRowIndex.size < 20) return null;
  return { estCol, actCol, delayByRowIndex };
}

function dimensionLabelAccessor(ctx, role) {
  const dim = ctx.dimensions && ctx.dimensions[role];
  const idCol = findRoleColumn(ctx.factFile, role);
  if (!idCol) return null;
  return {
    idCol,
    label: (role === 'merchant_id' ? 'seller' : role === 'customer_id' ? 'customer' : role === 'product_id' ? 'product' : role),
    accessor: (row) => {
      const raw = row[idCol.name];
      if (raw === null || raw === undefined || String(raw).trim() === '') return null;
      const key = String(raw).trim();
      if (dim && dim.lookup && dim.lookup.has(key)) return dim.lookup.get(key);
      return key;
    },
  };
}

// ---------------------------------------------------------------------
// The 12 diagnostic-question definitions. Each returns either
// { applicable: false, reason } or { applicable: true, narrative, ...data
// } — never a mix, matching services/metricRegistry.js's own
// evaluateMetrics() convention, so the view layer never has to guess
// which shape it got.
// ---------------------------------------------------------------------

function notApplicable(reason) {
  return { applicable: false, reason };
}

function moneyStr(n) { return Math.round(n * 100) / 100; }

// Narrative-sentence-shaped revenue-fallback disclosure — a parenthetical
// clause spliced mid-sentence, distinct from metricRegistry.js's own
// revenueFallbackNote() (which appends a trailing sentence to a
// provenance NOTE, not a narrative). findRevenueColumn() itself — the
// actual "revenue role, or price on a dated/order-keyed row" DECISION —
// is imported from metricRegistry.js above rather than redefined here, so
// the two engines can never drift on what counts as revenue.
function revenueFallbackNote(revInfo) {
  return revInfo.isFallback ? ` (using "${revInfo.col.name}" as the revenue measure — no dedicated revenue/amount column was found on this fact table)` : '';
}

// #1 — Revenue decreased
function revenueDrivers(ctx) {
  const revInfo = findRevenueColumn(ctx);
  const dateCol = findRoleColumn(ctx.factFile, 'date');
  if (!revInfo || !dateCol) return notApplicable('Needs a revenue/amount column (or, failing that, a listed price on a dated/order-keyed row) and a date column on the transaction fact table — neither or both could not be identified with enough confidence.');
  const revCol = revInfo.col;

  const valueOf = (row) => tryParseNumber(row[revCol.name]);
  const dateOf = (row) => row[dateCol.name];
  const overall = periodOverPeriodContribution(ctx.factFile.rows, dateOf, valueOf, 'sum');
  if (!overall) return notApplicable('Needs at least two distinct months of dated revenue rows to compare.');

  const dims = [];
  const catCol = findCategoryColumn(ctx);
  if (catCol) dims.push({ label: 'category', accessor: (row) => row[catCol.name] });
  const geo = resolveGeo(ctx);
  if (geo) dims.push({ label: 'geography', accessor: (row) => (geo.indirect ? (geo.lookup.get(String(row[geo.keyCol]).trim()) || null) : row[geo.keyCol]) });
  ['merchant_id', 'customer_id', 'product_id'].forEach((role) => {
    const dl = dimensionLabelAccessor(ctx, role);
    if (dl) dims.push({ label: dl.label, accessor: dl.accessor });
  });

  // Round 20: widened from the top 2 dimensions to the top 4 — the user's
  // own spec asks for "order volume effect + average order value effect +
  // category mix + geographic mix + seller/product contribution" combined,
  // which needs category AND geography AND seller/product all visible,
  // not just whichever two were found first.
  const contributions = dims.slice(0, 4).map((d) => ({
    dimensionLabel: d.label,
    rows: contributionByDimension(ctx.factFile.rows, dateOf, valueOf, d.accessor, overall, 'sum'),
  })).filter((c) => c.rows.length > 0);

  // Price/volume decomposition needs an order count for each period.
  const orderIdCol = findRoleColumn(ctx.factFile, 'order_id');
  const orderCountOf = (row) => 1; // each row already counts as one unit unless a distinct order id says otherwise below
  let decomposition = null;
  const ordersMonthly = orderIdCol
    ? bucketDistinctByMonth(ctx.factFile.rows, dateOf, (row) => row[orderIdCol.name])
    : bucketByMonth(ctx.factFile.rows, dateOf, orderCountOf, 'count');
  const orderPair = lastTwoMonths(ordersMonthly.map((m) => ({ month: m.month, value: m.value })));
  if (orderPair && orderPair.prev.value > 0 && orderPair.curr.value > 0) {
    const prevAOV = overall.prevValue / orderPair.prev.value;
    const currAOV = overall.currValue / orderPair.curr.value;
    decomposition = priceVolumeDecomposition(orderPair.prev.value, prevAOV, orderPair.curr.value, currAOV);
  }

  return {
    applicable: true,
    narrative: `Revenue ${overall.direction} ${overall.pct !== null ? `${Math.abs(overall.pct).toFixed(1)}%` : ''} from ${overall.prevMonth} to ${overall.currMonth} (${moneyStr(overall.prevValue).toLocaleString()} → ${moneyStr(overall.currValue).toLocaleString()})${revenueFallbackNote(revInfo)}.`,
    overall,
    decomposition,
    contributions,
  };
}

function bucketDistinctByMonth(rows, dateAccessor, idAccessor) {
  const buckets = new Map();
  rows.forEach((row) => {
    const month = toMonthKey(dateAccessor(row));
    const id = idAccessor(row);
    if (!month || id === null || id === undefined || String(id).trim() === '') return;
    if (!buckets.has(month)) buckets.set(month, new Set());
    buckets.get(month).add(String(id).trim());
  });
  return [...buckets.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([month, set]) => ({ month, value: set.size }));
}

// #2 — Orders decreased
function ordersDrivers(ctx) {
  const dateCol = findRoleColumn(ctx.factFile, 'date');
  if (!dateCol) return notApplicable('Needs a date column on the transaction fact table.');
  const orderIdCol = findRoleColumn(ctx.factFile, 'order_id');
  const dateOf = (row) => row[dateCol.name];

  const monthly = orderIdCol
    ? bucketDistinctByMonth(ctx.factFile.rows, dateOf, (row) => row[orderIdCol.name])
    : bucketByMonth(ctx.factFile.rows, dateOf, () => 1, 'count');
  const pair = lastTwoMonths(monthly);
  if (!pair) return notApplicable('Needs at least two distinct months of dated order rows to compare.');
  const overall = {
    prevMonth: pair.prev.month, currMonth: pair.curr.month, prevValue: pair.prev.value, currValue: pair.curr.value, delta: pair.curr.value - pair.prev.value, pct: pctChange(pair.prev.value, pair.curr.value), direction: directionWord(pair.prev.value, pair.curr.value),
  };

  const countOf = orderIdCol ? () => 1 : () => 1; // count of rows==orders here regardless (distinct handled below when possible)
  const dims = [];
  const catCol = findCategoryColumn(ctx);
  if (catCol) dims.push({ label: 'category', accessor: (row) => row[catCol.name] });
  const geo = resolveGeo(ctx);
  if (geo) dims.push({ label: 'geography', accessor: (row) => (geo.indirect ? (geo.lookup.get(String(row[geo.keyCol]).trim()) || null) : row[geo.keyCol]) });
  ['merchant_id', 'customer_id'].forEach((role) => {
    const dl = dimensionLabelAccessor(ctx, role);
    if (dl) dims.push({ label: dl.label, accessor: dl.accessor });
  });

  // Round 20: widened from 2 to 4 dimensions — see the matching comment
  // in revenueDrivers() above.
  const contributions = dims.slice(0, 4).map((d) => ({
    dimensionLabel: d.label,
    rows: contributionByDimension(ctx.factFile.rows, dateOf, countOf, d.accessor, overall, 'count'),
  })).filter((c) => c.rows.length > 0);

  return {
    applicable: true,
    narrative: `Orders ${overall.direction} ${overall.pct !== null ? `${Math.abs(overall.pct).toFixed(1)}%` : ''} from ${overall.prevMonth} (${pair.prev.value.toLocaleString()}) to ${overall.currMonth} (${pair.curr.value.toLocaleString()}).`,
    overall,
    contributions,
  };
}

// #3 — AOV decreased
function aovDrivers(ctx) {
  const revInfo = findRevenueColumn(ctx);
  const dateCol = findRoleColumn(ctx.factFile, 'date');
  const catCol = findCategoryColumn(ctx);
  if (!revInfo || !dateCol) return notApplicable('Needs a revenue/amount column (or a listed price on a dated/order-keyed row) and a date column.');
  if (!catCol) return notApplicable('Needs a category-like column on the transaction fact table to separate a change in product mix from a change in price — none was found.');
  const revCol = revInfo.col;

  const orderIdCol = findRoleColumn(ctx.factFile, 'order_id');
  const monthly = bucketByMonth(ctx.factFile.rows, (row) => row[dateCol.name], (row) => tryParseNumber(row[revCol.name]), 'sum');
  const pair = lastTwoMonths(monthly);
  if (!pair) return notApplicable('Needs at least two distinct months of dated revenue rows.');

  const buildByCategory = (monthKey) => {
    const map = new Map();
    ctx.factFile.rows.forEach((row) => {
      if (toMonthKey(row[dateCol.name]) !== monthKey) return;
      const cat = row[catCol.name];
      if (cat === null || cat === undefined || String(cat).trim() === '') return;
      const rev = tryParseNumber(row[revCol.name]);
      if (rev === null) return;
      const key = String(cat).trim();
      if (!map.has(key)) map.set(key, { revenue: 0, orders: 0 });
      const slot = map.get(key);
      slot.revenue += rev;
      slot.orders += 1; // order-count proxy; refined below when an order id exists
    });
    if (orderIdCol) {
      const seen = new Map();
      ctx.factFile.rows.forEach((row) => {
        if (toMonthKey(row[dateCol.name]) !== monthKey) return;
        const cat = row[catCol.name];
        const oid = row[orderIdCol.name];
        if (!cat || !oid) return;
        const key = String(cat).trim();
        if (!seen.has(key)) seen.set(key, new Set());
        seen.get(key).add(String(oid));
      });
      seen.forEach((set, key) => { if (map.has(key)) map.get(key).orders = set.size; });
    }
    return map;
  };

  const prevByCategory = buildByCategory(pair.prev.month);
  const currByCategory = buildByCategory(pair.curr.month);
  const decomposition = mixRateDecomposition(prevByCategory, currByCategory);
  if (!decomposition) return notApplicable('Not enough per-category order volume in the two most recent months to decompose AOV.');

  const prevOrders = [...prevByCategory.values()].reduce((s, v) => s + v.orders, 0);
  const currOrders = [...currByCategory.values()].reduce((s, v) => s + v.orders, 0);
  const prevAOV = prevOrders ? pair.prev.value / prevOrders : null;
  const currAOV = currOrders ? pair.curr.value / currOrders : null;
  const aovPct = (prevAOV && currAOV) ? pctChange(prevAOV, currAOV) : null;
  const direction = (prevAOV !== null && currAOV !== null) ? directionWord(prevAOV, currAOV) : 'changed';
  const dominant = Math.abs(decomposition.mixEffect) > Math.abs(decomposition.rateEffect) ? 'a shift in which categories customers bought (product mix)' : 'prices moving within categories';

  return {
    applicable: true,
    narrative: `Average order value ${direction}${aovPct !== null ? ` ${Math.abs(aovPct).toFixed(1)}%` : ''} from ${pair.prev.month} to ${pair.curr.month}, driven mostly by ${dominant}${revenueFallbackNote(revInfo)}.`,
    prevMonth: pair.prev.month,
    currMonth: pair.curr.month,
    prevAOV,
    currAOV,
    decomposition,
  };
}

// #4 — Freight cost is high
function freightDrivers(ctx) {
  const freightCol = findByNamePattern(ctx.factFileProfile, FREIGHT_NAME_RE, ['numeric', 'currency']);
  if (!freightCol) return notApplicable('No column reading as a freight/shipping cost was found on the transaction fact table.');

  const candidates = [];
  const priceCol = findRoleColumn(ctx.factFile, 'price') || findRoleColumn(ctx.factFile, 'revenue');
  if (priceCol) candidates.push({ label: titleize(priceCol.name), type: 'numeric', accessor: (row) => tryParseNumber(row[priceCol.name]) });
  findWeightDimensionColumns(ctx).forEach((c) => {
    if (c.name === freightCol.name) return;
    candidates.push({ label: titleize(c.name), type: 'numeric', accessor: (row) => tryParseNumber(row[c.name]) });
  });
  const geo = resolveGeo(ctx);
  if (geo) {
    candidates.push({
      label: 'geography', type: 'categorical', accessor: (row) => (geo.indirect ? (geo.lookup.get(String(row[geo.keyCol]).trim()) || null) : row[geo.keyCol]),
    });
  }
  if (candidates.length === 0) return notApplicable('No price, weight/dimension, or geography column was found to test against freight cost.');

  const result = explainFactorsFor(ctx.factFile.rows, (row) => tryParseNumber(row[freightCol.name]), candidates);
  if (!result) return notApplicable('None of the available candidate factors had enough paired data with freight cost to test.');

  const top = [...result.numericResults, ...result.categoricalResults.map((c) => ({ label: c.label, correlation: c.eta }))]
    .sort((a, b) => Math.abs(b.correlation) - Math.abs(a.correlation))[0];
  return {
    applicable: true,
    narrative: top
      ? `${top.label} shows the strongest association with ${titleize(freightCol.name)} (${top.correlation >= 0 ? 'positive' : 'negative'}, strength ${Math.abs(top.correlation).toFixed(2)} on a 0–1 scale).`
      : `No factor tested showed a meaningful association with ${titleize(freightCol.name)}.`,
    targetLabel: titleize(freightCol.name),
    ...result,
  };
}

// #5 — Delivery is late
function deliveryDelayDrivers(ctx) {
  const delayInfo = computeRowDelays(ctx);
  if (!delayInfo) return notApplicable('Needs both an estimated/expected/scheduled date column and an actual/delivered/completed date column, with at least 20 rows carrying both — neither pair was found.');

  const rowsWithIdx = ctx.factFile.rows.map((row, idx) => ({ row, idx })).filter(({ idx }) => delayInfo.delayByRowIndex.has(idx));
  const targetOf = ({ idx }) => delayInfo.delayByRowIndex.get(idx);

  const candidates = [];
  const freightCol = findByNamePattern(ctx.factFileProfile, FREIGHT_NAME_RE, ['numeric', 'currency']);
  if (freightCol) candidates.push({ label: titleize(freightCol.name), type: 'numeric', accessor: ({ row }) => tryParseNumber(row[freightCol.name]) });
  const priceCol = findRoleColumn(ctx.factFile, 'price') || findRoleColumn(ctx.factFile, 'revenue');
  if (priceCol) candidates.push({ label: titleize(priceCol.name), type: 'numeric', accessor: ({ row }) => tryParseNumber(row[priceCol.name]) });
  const catCol = findCategoryColumn(ctx);
  if (catCol) candidates.push({ label: 'category', type: 'categorical', accessor: ({ row }) => row[catCol.name] });
  const geo = resolveGeo(ctx);
  if (geo) candidates.push({ label: 'geography', type: 'categorical', accessor: ({ row }) => (geo.indirect ? (geo.lookup.get(String(row[geo.keyCol]).trim()) || null) : row[geo.keyCol]) });
  const merchantDl = dimensionLabelAccessor(ctx, 'merchant_id');
  if (merchantDl) candidates.push({ label: titleize(merchantDl.label), type: 'categorical', accessor: ({ row }) => merchantDl.accessor(row) });
  if (candidates.length === 0) return notApplicable('No freight, price, category, geography, or seller column was found to test against delivery delay.');

  const result = explainFactorsFor(rowsWithIdx, targetOf, candidates);
  if (!result) return notApplicable('None of the available candidate factors had enough paired data with delivery delay to test.');

  const avgDelay = mean([...delayInfo.delayByRowIndex.values()]);
  const top = [...result.numericResults, ...result.categoricalResults.map((c) => ({ label: c.label, correlation: c.eta }))]
    .sort((a, b) => Math.abs(b.correlation) - Math.abs(a.correlation))[0];
  return {
    applicable: true,
    narrative: `Deliveries run ${avgDelay >= 0 ? 'late' : 'early'} by ${Math.abs(avgDelay).toFixed(1)} days on average (actual vs. ${delayInfo.estCol.name}).${top ? ` ${top.label} shows the strongest association with delay (strength ${Math.abs(top.correlation).toFixed(2)}).` : ''}`,
    avgDelayDays: Math.round(avgDelay * 10) / 10,
    sampleSize: delayInfo.delayByRowIndex.size,
    ...result,
  };
}

// #6 — Review scores are low
function reviewScoreDrivers(ctx) {
  const ratingCol = findRatingColumn(ctx);
  if (!ratingCol) return notApplicable('No column profiled as a rating/review-score scale was found on the transaction fact table.');

  const targetOf = (row) => tryParseNumber(row[ratingCol.name]);
  const candidates = [];
  const delayInfo = computeRowDelays(ctx);
  const rows = ctx.factFile.rows.map((row, idx) => ({ row, idx }));
  const rowTarget = (item) => targetOf(item.row);
  if (delayInfo) {
    candidates.push({ label: 'delivery delay (days)', type: 'numeric', accessor: (item) => (delayInfo.delayByRowIndex.has(item.idx) ? delayInfo.delayByRowIndex.get(item.idx) : null) });
  }
  const freightCol = findByNamePattern(ctx.factFileProfile, FREIGHT_NAME_RE, ['numeric', 'currency']);
  if (freightCol) candidates.push({ label: titleize(freightCol.name), type: 'numeric', accessor: (item) => tryParseNumber(item.row[freightCol.name]) });
  const priceCol = findRoleColumn(ctx.factFile, 'price') || findRoleColumn(ctx.factFile, 'revenue');
  if (priceCol) candidates.push({ label: titleize(priceCol.name), type: 'numeric', accessor: (item) => tryParseNumber(item.row[priceCol.name]) });
  const catCol = findCategoryColumn(ctx);
  if (catCol) candidates.push({ label: 'category', type: 'categorical', accessor: (item) => item.row[catCol.name] });
  const merchantDl = dimensionLabelAccessor(ctx, 'merchant_id');
  if (merchantDl) candidates.push({ label: titleize(merchantDl.label), type: 'categorical', accessor: (item) => merchantDl.accessor(item.row) });
  if (candidates.length === 0) return notApplicable('No delivery-delay, freight, price, category, or seller column was found to test against review score.');

  const result = explainFactorsFor(rows, rowTarget, candidates);
  if (!result) return notApplicable('None of the available candidate factors had enough paired data with review score to test.');

  const avgRating = mean(rows.map(rowTarget).filter((v) => v !== null && Number.isFinite(v)));
  const top = [...result.numericResults, ...result.categoricalResults.map((c) => ({ label: c.label, correlation: c.eta }))]
    .sort((a, b) => Math.abs(b.correlation) - Math.abs(a.correlation))[0];
  return {
    applicable: true,
    narrative: `Average review score is ${avgRating.toFixed(2)}.${top ? ` ${top.label} shows the strongest association with review score (strength ${Math.abs(top.correlation).toFixed(2)}).` : ' No factor tested showed a meaningful association.'}`,
    avgRating: Math.round(avgRating * 100) / 100,
    ...result,
  };
}

// #7 — Category revenue fell (Pareto/contribution across category, and
// secondarily product/seller/geography when available).
function categoryRevenuePareto(ctx) {
  const revInfo = findRevenueColumn(ctx);
  const dateCol = findRoleColumn(ctx.factFile, 'date');
  const catCol = findCategoryColumn(ctx);
  if (!revInfo || !dateCol) return notApplicable('Needs a revenue/amount column (or a listed price on a dated/order-keyed row) and a date column.');
  if (!catCol) return notApplicable('No category-like column was found on the transaction fact table.');
  const revCol = revInfo.col;

  const valueOf = (row) => tryParseNumber(row[revCol.name]);
  const dateOf = (row) => row[dateCol.name];
  const overall = periodOverPeriodContribution(ctx.factFile.rows, dateOf, valueOf, 'sum');
  if (!overall) return notApplicable('Needs at least two distinct months of dated revenue rows.');

  const byCategory = contributionByDimension(ctx.factFile.rows, dateOf, valueOf, (row) => row[catCol.name], overall, 'sum', 20);
  const declining = byCategory.filter((r) => r.delta < 0).sort((a, b) => a.delta - b.delta);
  if (declining.length === 0) return notApplicable('No category shows a revenue decline between the two most recent months.');

  const totalDecline = declining.reduce((s, r) => s + r.delta, 0);
  let running = 0;
  const pareto = declining.map((r) => {
    running += r.delta;
    return { ...r, cumulativePct: (running / totalDecline) * 100 };
  });
  const topCount = pareto.findIndex((r) => r.cumulativePct >= 80) + 1 || pareto.length;

  const secondary = [];
  const geo = resolveGeo(ctx);
  if (geo) {
    secondary.push({
      dimensionLabel: 'geography',
      rows: contributionByDimension(ctx.factFile.rows, dateOf, valueOf, (row) => (geo.indirect ? (geo.lookup.get(String(row[geo.keyCol]).trim()) || null) : row[geo.keyCol]), overall, 'sum').filter((r) => r.delta < 0),
    });
  }
  const merchantDl = dimensionLabelAccessor(ctx, 'merchant_id');
  if (merchantDl) {
    secondary.push({
      dimensionLabel: pluralize(merchantDl.label),
      rows: contributionByDimension(ctx.factFile.rows, dateOf, valueOf, merchantDl.accessor, overall, 'sum').filter((r) => r.delta < 0),
    });
  }

  return {
    applicable: true,
    narrative: `Top ${topCount} of ${pareto.length} declining categories account for ${Math.min(100, pareto[Math.min(topCount, pareto.length) - 1].cumulativePct).toFixed(1)}% of the total revenue decline between ${overall.prevMonth} and ${overall.currMonth}${revenueFallbackNote(revInfo)}.`,
    overall,
    pareto,
    secondary: secondary.filter((s) => s.rows.length > 0),
  };
}

// #8 — Seller performance varies
function sellerPerformanceSegmentation(ctx) {
  const merchantDl = dimensionLabelAccessor(ctx, 'merchant_id');
  const revInfo = findRevenueColumn(ctx);
  if (!merchantDl || !revInfo) return notApplicable('Needs a resolvable seller/merchant identifier and a revenue/amount column (or a listed price on a dated/order-keyed row).');
  const revCol = revInfo.col;

  const delayInfo = computeRowDelays(ctx);
  const ratingCol = findRatingColumn(ctx);
  const measures = [
    { key: 'revenue', label: 'Revenue', accessor: (row) => tryParseNumber(row[revCol.name]), agg: 'sum' },
  ];
  const orderIdCol = findRoleColumn(ctx.factFile, 'order_id');
  if (orderIdCol) measures.push({ key: 'orders', label: 'Orders', accessor: () => 1, agg: 'sum' });
  const rowsForSeg = ctx.factFile.rows.map((row, idx) => ({ ...row, __rowIdx: idx }));
  if (delayInfo) {
    measures.push({
      key: 'avgDelay', label: 'Avg. delivery delay (days)', accessor: (row) => (delayInfo.delayByRowIndex.has(row.__rowIdx) ? delayInfo.delayByRowIndex.get(row.__rowIdx) : null), agg: 'avg',
    });
  }
  if (ratingCol) measures.push({ key: 'avgRating', label: 'Avg. review score', accessor: (row) => tryParseNumber(row[ratingCol.name]), agg: 'avg' });

  const seg = performanceSegmentation(rowsForSeg, (row) => merchantDl.accessor(row), measures);
  if (!seg) return notApplicable('Not enough distinct sellers with at least a handful of orders each to compare performance.');

  return {
    applicable: true,
    narrative: `Revenue per seller varies substantially (coefficient of variation ${seg.coefficientOfVariation !== null ? seg.coefficientOfVariation.toFixed(0) : '—'}%) across ${seg.totalGroups} sellers with enough orders to compare${revenueFallbackNote(revInfo)}.`,
    entityLabel: 'seller',
    ...seg,
  };
}

// #9 — Cancellations increased
function cancellationDrivers(ctx) {
  const statusCol = findCancelStatusColumn(ctx);
  const dateCol = findRoleColumn(ctx.factFile, 'date');
  if (!statusCol) return notApplicable('No status-like column with a "canceled" value was found on the transaction fact table.');

  const isCanceled = (row) => CANCEL_VALUE_RE.test(String(row[statusCol.name] || ''));

  let trend = null;
  if (dateCol) {
    const monthly = bucketByMonth(ctx.factFile.rows, (row) => row[dateCol.name], (row) => (isCanceled(row) ? 1 : 0), 'avg');
    const pair = lastTwoMonths(monthly);
    if (pair) {
      trend = {
        prevMonth: pair.prev.month, currMonth: pair.curr.month, prevRatePct: pair.prev.value * 100, currRatePct: pair.curr.value * 100, direction: directionWord(pair.prev.value, pair.curr.value),
      };
    }
  }

  const candidates = [];
  const catCol = findCategoryColumn(ctx);
  if (catCol) candidates.push({ label: 'category', type: 'categorical', accessor: (row) => row[catCol.name] });
  const paymentCol = findPaymentColumn(ctx);
  if (paymentCol) candidates.push({ label: 'payment type', type: 'categorical', accessor: (row) => row[paymentCol.name] });
  const geo = resolveGeo(ctx);
  if (geo) candidates.push({ label: 'geography', type: 'categorical', accessor: (row) => (geo.indirect ? (geo.lookup.get(String(row[geo.keyCol]).trim()) || null) : row[geo.keyCol]) });
  const priceCol = findRoleColumn(ctx.factFile, 'price') || findRoleColumn(ctx.factFile, 'revenue');
  if (priceCol) candidates.push({ label: titleize(priceCol.name), type: 'numeric', accessor: (row) => tryParseNumber(row[priceCol.name]) });
  const merchantDl = dimensionLabelAccessor(ctx, 'merchant_id');
  if (merchantDl) candidates.push({ label: titleize(merchantDl.label), type: 'categorical', accessor: (row) => merchantDl.accessor(row) });
  if (candidates.length === 0) return notApplicable('No category, payment type, geography, price, or seller column was found to test against cancellation.');

  const result = explainBinaryFactorsFor(ctx.factFile.rows, isCanceled, candidates);
  if (!result) return notApplicable('None of the available candidate factors had enough data to test against cancellation.');

  const topCategorical = result.categoricalResults[0];
  return {
    applicable: true,
    narrative: `${trend ? `Cancellation rate ${trend.direction} from ${trend.prevRatePct.toFixed(1)}% (${trend.prevMonth}) to ${trend.currRatePct.toFixed(1)}% (${trend.currMonth}). ` : ''}${topCategorical ? `${titleize(topCategorical.label)} is ${topCategorical.test.significant ? '' : 'not '}significantly associated with cancellation (χ²=${topCategorical.test.chiSquare}, df=${topCategorical.test.df}).` : ''}`,
    trend,
    ...result,
  };
}

// #10 — Certain states have lower sales
function geoSalesSegmentation(ctx) {
  const geo = resolveGeo(ctx);
  const revInfo = findRevenueColumn(ctx);
  if (!geo || !revInfo) return notApplicable('Needs a resolvable geography column (direct or via a joined customer/merchant dimension) and a revenue/amount column (or a listed price on a dated/order-keyed row).');
  const revCol = revInfo.col;

  const geoAccessor = (row) => (geo.indirect ? (geo.lookup.get(String(row[geo.keyCol]).trim()) || null) : row[geo.keyCol]);
  const measures = [{ key: 'revenue', label: 'Revenue', accessor: (row) => tryParseNumber(row[revCol.name]), agg: 'sum' }];
  const freightCol = findByNamePattern(ctx.factFileProfile, FREIGHT_NAME_RE, ['numeric', 'currency']);
  if (freightCol) measures.push({ key: 'avgFreight', label: `Avg. ${titleize(freightCol.name)}`, accessor: (row) => tryParseNumber(row[freightCol.name]), agg: 'avg' });
  const delayInfo = computeRowDelays(ctx);
  const rowsForSeg = ctx.factFile.rows.map((row, idx) => ({ ...row, __rowIdx: idx }));
  if (delayInfo) {
    measures.push({
      key: 'avgDelay', label: 'Avg. delivery delay (days)', accessor: (row) => (delayInfo.delayByRowIndex.has(row.__rowIdx) ? delayInfo.delayByRowIndex.get(row.__rowIdx) : null), agg: 'avg',
    });
  }

  const seg = performanceSegmentation(rowsForSeg, geoAccessor, measures);
  if (!seg) return notApplicable('Not enough distinct geographies with sufficient rows each to compare.');

  return {
    applicable: true,
    narrative: `Revenue by geography varies substantially (coefficient of variation ${seg.coefficientOfVariation !== null ? seg.coefficientOfVariation.toFixed(0) : '—'}%) across ${seg.totalGroups} geographies with enough rows to compare${revenueFallbackNote(revInfo)}.`,
    entityLabel: 'geography',
    ...seg,
  };
}

// #11 — Payment behavior differs
function paymentBehaviorCrosstab(ctx) {
  const paymentCol = findPaymentColumn(ctx);
  if (!paymentCol) return notApplicable('No payment type/method/mode column was found on the transaction fact table.');

  const otherCatCol = findCancelStatusColumn(ctx) || findByNamePattern(ctx.factFileProfile, STATUS_NAME_RE, ['category']) || findCategoryColumn(ctx);
  let crosstab = null;
  if (otherCatCol && otherCatCol.name !== paymentCol.name) {
    crosstab = crosstabChiSquare(ctx.factFile.rows, (row) => row[paymentCol.name], (row) => row[otherCatCol.name]);
  }

  // Round 20: geography crosstab, added alongside the pre-existing
  // status/category crosstab above — the user's spec asks whether payment
  // behavior differs "by order value, geography, or category," and
  // geography wasn't covered before (only whichever ONE of status/category
  // findCancelStatusColumn()/findCategoryColumn() happened to resolve as
  // otherCatCol).
  const geo = resolveGeo(ctx);
  let geoCrosstab = null;
  if (geo) {
    const geoAccessor = (row) => (geo.indirect ? (geo.lookup.get(String(row[geo.keyCol]).trim()) || null) : row[geo.keyCol]);
    geoCrosstab = crosstabChiSquare(ctx.factFile.rows, (row) => row[paymentCol.name], geoAccessor);
  }

  const installmentsCol = findByNamePattern(ctx.factFileProfile, INSTALLMENTS_NAME_RE, ['numeric']);
  let installmentsByPayment = null;
  if (installmentsCol) {
    const groups = new Map();
    ctx.factFile.rows.forEach((row) => {
      const pay = row[paymentCol.name];
      const inst = tryParseNumber(row[installmentsCol.name]);
      if (!pay || inst === null) return;
      const key = String(pay).trim();
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(inst);
    });
    const eta = correlationRatio(groups);
    if (eta !== null) {
      installmentsByPayment = {
        eta,
        groups: [...groups.entries()].map(([label, vals]) => ({ label, avgInstallments: mean(vals), count: vals.length })).sort((a, b) => b.avgInstallments - a.avgInstallments),
      };
    }
  }

  // Round 20: order value by payment type — the same correlation-ratio
  // (eta) group-comparison primitive used everywhere else in this file a
  // categorical grouping is compared against a numeric measure, applied
  // here to price/revenue per row grouped by payment type. Completes the
  // "order value, geography, or category" trio the user's spec asked for.
  let orderValueByPayment = null;
  const revForPayment = findRevenueColumn(ctx);
  const priceOrRevCol = findRoleColumn(ctx.factFile, 'price') || (revForPayment && revForPayment.col);
  if (priceOrRevCol) {
    const groups = new Map();
    ctx.factFile.rows.forEach((row) => {
      const pay = row[paymentCol.name];
      const val = tryParseNumber(row[priceOrRevCol.name]);
      if (!pay || val === null) return;
      const key = String(pay).trim();
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(val);
    });
    const eta = correlationRatio(groups);
    if (eta !== null) {
      orderValueByPayment = {
        eta,
        columnLabel: titleize(priceOrRevCol.name),
        groups: [...groups.entries()].map(([label, vals]) => ({ label, avgValue: mean(vals), count: vals.length })).sort((a, b) => b.avgValue - a.avgValue),
      };
    }
  }

  if (!crosstab && !installmentsByPayment && !geoCrosstab && !orderValueByPayment) return notApplicable('No order-status/category, geography, installments, or price column was found to compare against payment type.');

  const parts = [];
  if (crosstab) parts.push(`Payment type is ${crosstab.test.significant ? '' : 'not '}significantly associated with ${titleize(otherCatCol.name)} (χ²=${crosstab.test.chiSquare}, df=${crosstab.test.df}).`);
  if (geoCrosstab) parts.push(`Payment type is ${geoCrosstab.test.significant ? '' : 'not '}significantly associated with geography (χ²=${geoCrosstab.test.chiSquare}, df=${geoCrosstab.test.df}).`);
  if (installmentsByPayment) parts.push(`Average installments range from ${installmentsByPayment.groups[installmentsByPayment.groups.length - 1].avgInstallments.toFixed(1)} to ${installmentsByPayment.groups[0].avgInstallments.toFixed(1)} depending on payment type.`);
  if (orderValueByPayment) parts.push(`${orderValueByPayment.columnLabel} varies by payment type (effect size η=${orderValueByPayment.eta.toFixed(2)}), from ${orderValueByPayment.groups[orderValueByPayment.groups.length - 1].avgValue.toFixed(2)} to ${orderValueByPayment.groups[0].avgValue.toFixed(2)}.`);

  return {
    applicable: true,
    narrative: parts.join(' '),
    crosstab,
    otherColumnLabel: otherCatCol ? titleize(otherCatCol.name) : null,
    geoCrosstab,
    installmentsByPayment,
    orderValueByPayment,
  };
}

// #12 — Repeat purchasing differs
function repeatPurchaseDrivers(ctx) {
  const custDl = dimensionLabelAccessor(ctx, 'customer_id');
  const revInfo = findRevenueColumn(ctx);
  if (!custDl || !revInfo) return notApplicable('Needs a resolvable customer identifier and a revenue/amount column (or a listed price on a dated/order-keyed row).');
  const revCol = revInfo.col;
  const orderIdCol = findRoleColumn(ctx.factFile, 'order_id');
  const catCol = findCategoryColumn(ctx);
  const ratingCol = findRatingColumn(ctx);
  const delayInfo = computeRowDelays(ctx);

  const customers = new Map();
  ctx.factFile.rows.forEach((row, idx) => {
    const custKey = custDl.idCol ? row[custDl.idCol.name] : null;
    if (custKey === null || custKey === undefined || String(custKey).trim() === '') return;
    const key = String(custKey).trim();
    if (!customers.has(key)) {
      customers.set(key, {
        orderIds: new Set(), rowCount: 0, revenueSum: 0, revenueCount: 0, ratingSum: 0, ratingCount: 0, delaySum: 0, delayCount: 0, categories: [],
      });
    }
    const c = customers.get(key);
    c.rowCount += 1;
    if (orderIdCol && row[orderIdCol.name]) c.orderIds.add(String(row[orderIdCol.name]));
    const rev = tryParseNumber(row[revCol.name]);
    if (rev !== null) { c.revenueSum += rev; c.revenueCount += 1; }
    if (ratingCol) {
      const rt = tryParseNumber(row[ratingCol.name]);
      if (rt !== null) { c.ratingSum += rt; c.ratingCount += 1; }
    }
    if (delayInfo && delayInfo.delayByRowIndex.has(idx)) { c.delaySum += delayInfo.delayByRowIndex.get(idx); c.delayCount += 1; }
    if (catCol && row[catCol.name]) c.categories.push(String(row[catCol.name]).trim());
  });

  const custRows = [...customers.entries()].map(([label, c]) => {
    const orderCount = orderIdCol ? c.orderIds.size : c.rowCount;
    return {
      label,
      isRepeat: orderCount >= 2,
      aov: c.revenueCount ? c.revenueSum / orderCount : null,
      avgRating: c.ratingCount ? c.ratingSum / c.ratingCount : null,
      avgDelay: c.delayCount ? c.delaySum / c.delayCount : null,
      topCategory: c.categories.length ? modeOf(c.categories) : null,
    };
  });

  const repeatCount = custRows.filter((c) => c.isRepeat).length;
  const oneTimeCount = custRows.length - repeatCount;
  if (repeatCount < 10 || oneTimeCount < 10) return notApplicable('Needs at least 10 repeat customers and 10 one-time customers to compare characteristics reliably.');

  const candidates = [];
  candidates.push({ label: 'average order value', type: 'numeric', accessor: (c) => c.aov });
  if (ratingCol) candidates.push({ label: 'average review score', type: 'numeric', accessor: (c) => c.avgRating });
  if (delayInfo) candidates.push({ label: 'average delivery delay (days)', type: 'numeric', accessor: (c) => c.avgDelay });
  if (catCol) candidates.push({ label: 'most-purchased category', type: 'categorical', accessor: (c) => c.topCategory });

  const result = explainBinaryFactorsFor(custRows, (c) => c.isRepeat, candidates);
  if (!result) return notApplicable('None of the available customer-level factors had enough data to test against repeat-purchase status.');

  const top = [...result.numericResults.map((r) => ({ label: r.label, strength: Math.abs(r.cohensD) })), ...result.categoricalResults.map((r) => ({ label: r.label, strength: r.test.chiSquare / 10 }))]
    .sort((a, b) => b.strength - a.strength)[0];
  return {
    applicable: true,
    narrative: `${repeatCount.toLocaleString()} of ${custRows.length.toLocaleString()} customers (${((repeatCount / custRows.length) * 100).toFixed(1)}%) placed more than one order.${top ? ` ${titleize(top.label)} shows the strongest difference between repeat and one-time customers.` : ''}`,
    repeatCount,
    oneTimeCount,
    ...result,
  };
}

// ---------------------------------------------------------------------
// Round 20 — five additional findings, commissioned directly against a
// pasted Olist ERD and a detailed diagnostic-analytics spec: a genuine
// sequential drill-down for low reviews (not just a flat factor list), an
// exact customers x orders-per-customer x AOV decomposition for "why is
// this geography highest," a whole-history Pareto concentration analysis
// (not conditioned on decline, unlike #7), a freight-to-order-VALUE ratio
// view (distinct from #4, which explains freight cost in isolation), and
// a sales-vs-reviews category quadrant matrix. Every one of these reuses
// the SAME primitives (A-F) and column-detection helpers above rather
// than inventing new statistical machinery — see each function's own
// comment for which primitive/helper it's built from.
// ---------------------------------------------------------------------

// Primitive G — worst-rate group: given a subset of rows and a binary
// "is this the bad outcome" predicate, ranks every value of a candidate
// grouping column by its OWN rate of the bad outcome (not raw count) and
// returns the single worst-performing group. This is the building block
// lowReviewDrillDownTree() below calls once per drill level to decide
// which value to narrow into next — a genuine funnel, not four
// independent breakdowns.
function worstRateGroup(rows, groupAccessor, isBadAccessor, minGroupSize = 5) {
  const groups = new Map();
  rows.forEach((row) => {
    const g = groupAccessor(row);
    if (g === null || g === undefined || String(g).trim() === '') return;
    const key = String(g).trim();
    if (!groups.has(key)) groups.set(key, { total: 0, bad: 0 });
    const slot = groups.get(key);
    slot.total += 1;
    if (isBadAccessor(row)) slot.bad += 1;
  });
  const overallTotal = rows.length;
  const overallBad = rows.filter(isBadAccessor).length;
  const overallRate = overallTotal ? (overallBad / overallTotal) * 100 : null;
  const ranked = [...groups.entries()]
    .filter(([, g]) => g.total >= minGroupSize)
    .map(([label, g]) => ({
      label, total: g.total, bad: g.bad, ratePct: (g.bad / g.total) * 100,
    }))
    .sort((a, b) => b.ratePct - a.ratePct);
  if (ranked.length === 0) return null;
  return { overallRate, ranked, worst: ranked[0] };
}

// Primitive G2 — most-concentrated group (lift): worstRateGroup() only
// works when the row-set it's given still has room for a bad-outcome
// RATE to vary across groups. Once a subset has already been narrowed to
// rows that are ALL the bad outcome (e.g. lowReviewDrillDownTree()'s
// currentRows past step 1, which is by construction 100% low-review),
// every group's own bad-outcome rate is trivially 100% and worstRateGroup
// degenerates to an arbitrary tie. The fix for an already-homogeneous
// subset is a lift/over-representation comparison instead: for each
// candidate group, compare its SHARE of the current narrowed subset
// against its share of the original, un-narrowed base population. A
// group makes up, say, 40% of the narrowed subset but only 8% of the
// base population is 5x over-represented (lift = 5) — genuinely
// informative even though its within-subset "bad rate" can't discriminate
// anything. Returns null when no candidate group clears minGroupSize.
function mostConcentratedGroup(subsetRows, baseRows, groupAccessor, minGroupSize = 5) {
  const subsetTotal = subsetRows.length;
  if (subsetTotal === 0) return null;
  const baseTotal = baseRows.length;
  if (baseTotal === 0) return null;

  const countByGroup = (rows) => {
    const m = new Map();
    rows.forEach((row) => {
      const g = groupAccessor(row);
      if (g === null || g === undefined || String(g).trim() === '') return;
      const key = String(g).trim();
      m.set(key, (m.get(key) || 0) + 1);
    });
    return m;
  };
  const subsetGroups = countByGroup(subsetRows);
  const baseGroups = countByGroup(baseRows);

  const ranked = [...subsetGroups.entries()]
    .filter(([, count]) => count >= minGroupSize)
    .map(([label, count]) => {
      const subsetShare = (count / subsetTotal) * 100;
      const baseCount = baseGroups.get(label) || 0;
      const baseShare = baseTotal ? (baseCount / baseTotal) * 100 : null;
      const lift = baseShare && baseShare > 0 ? subsetShare / baseShare : null;
      return {
        label, count, subsetShare, baseCount, baseShare, lift,
      };
    })
    .sort((a, b) => (b.lift ?? -Infinity) - (a.lift ?? -Infinity));
  if (ranked.length === 0) return null;
  return {
    subsetTotal, baseTotal, ranked, top: ranked[0],
  };
}

// #13 — Review diagnosis: a literal drill-down tree — "was delivery
// late? -> which seller? -> which category? -> which state? -> is
// freight high? -> specific orders/products" — narrowing the row-set one
// level at a time rather than reporting flat, independent associations
// (that's what REVIEW_SCORE_DRIVERS/#6 already does). "Low review" is
// this dataset's OWN bottom 20th percentile of its rating column, not an
// assumed fixed scale (hardcoding "<=2" would silently assume a 1-5
// scale and be wrong on a 1-10 one) — the same dataset-relative-threshold
// principle already used for churn recency cutoffs elsewhere in this app.
function lowReviewDrillDownTree(ctx) {
  const ratingCol = findRatingColumn(ctx);
  if (!ratingCol) return notApplicable('No column profiled as a rating/review-score scale was found on the transaction fact table.');

  const ratedRows = ctx.factFile.rows
    .map((row, idx) => ({ row, idx, value: tryParseNumber(row[ratingCol.name]) }))
    .filter((r) => r.value !== null && Number.isFinite(r.value));
  if (ratedRows.length < 30) return notApplicable('Needs at least 30 rated rows to build a reliable low-review drill-down.');

  const sortedVals = ratedRows.map((r) => r.value).sort((a, b) => a - b);
  const p20 = quantile(sortedVals, 0.20);
  const isLowIdx = new Set(ratedRows.filter((r) => r.value <= p20).map((r) => r.idx));
  if (isLowIdx.size < 20) return notApplicable("Not enough distinctly low-rated rows (this dataset's own bottom 20% of ratings) to drill down reliably.");

  let currentRows = ratedRows.map(({ row, idx }) => ({ row, idx }));
  // Captured before any narrowing — this is the base population that
  // mostConcentratedGroup() below compares each level's subset against,
  // since by the time we reach levels 2-4 currentRows is already 100%
  // low-review (see the comment on mostConcentratedGroup() above).
  const baseRatedRows = currentRows;
  const isLow = (item) => isLowIdx.has(item.idx);
  const steps = [];

  // Step 1 — was delivery late?
  const delayInfo = computeRowDelays(ctx);
  if (delayInfo) {
    const isLate = (item) => delayInfo.delayByRowIndex.has(item.idx) && delayInfo.delayByRowIndex.get(item.idx) > 0;
    const lowSubset = currentRows.filter(isLow);
    const okSubset = currentRows.filter((r) => !isLow(r));
    const lateRateLow = lowSubset.length ? (lowSubset.filter(isLate).length / lowSubset.length) * 100 : null;
    const lateRateOk = okSubset.length ? (okSubset.filter(isLate).length / okSubset.length) * 100 : null;
    if (lateRateLow !== null && lateRateOk !== null) {
      const narrow = lateRateLow > lateRateOk && lowSubset.filter(isLate).length >= 20;
      steps.push({
        question: 'Was delivery late?',
        finding: `${lateRateLow.toFixed(1)}% of low-review orders had a late delivery, vs. ${lateRateOk.toFixed(1)}% of other orders.`,
        narrowed: narrow,
      });
      currentRows = narrow ? lowSubset.filter(isLate) : lowSubset;
    } else {
      currentRows = lowSubset;
    }
  } else {
    currentRows = currentRows.filter(isLow);
  }

  // Steps 2-4 — seller, category, geography, each narrowing into the
  // worst-rate group found at that level before moving to the next
  // dimension (a genuine funnel, via worstRateGroup() above).
  const levelDefs = [];
  const merchantDl = dimensionLabelAccessor(ctx, 'merchant_id');
  if (merchantDl) levelDefs.push({ label: 'seller', accessor: (item) => merchantDl.accessor(item.row) });
  const catCol = findCategoryColumn(ctx);
  if (catCol) levelDefs.push({ label: 'category', accessor: (item) => item.row[catCol.name] });
  const geo = resolveGeo(ctx);
  if (geo) levelDefs.push({ label: 'geography', accessor: (item) => (geo.indirect ? (geo.lookup.get(String(item.row[geo.keyCol]).trim()) || null) : item.row[geo.keyCol]) });

  levelDefs.forEach((level) => {
    if (currentRows.length < 20) return; // funnel already too narrow to drill further
    // currentRows is, by construction, already 100% low-review at this
    // point (see baseRatedRows comment above) — a within-subset "worst
    // rate" comparison has nothing left to discriminate, so this uses a
    // lift/over-representation comparison against the full rated
    // population instead of worstRateGroup().
    const mc = mostConcentratedGroup(currentRows, baseRatedRows, level.accessor, 5);
    if (!mc) return;
    const { top } = mc;
    const narrow = top.lift !== null && top.lift > 1.2 && top.count >= 10;
    const liftText = top.lift !== null ? `${top.lift.toFixed(1)}x over-represented` : 'lift not computable (absent from the base population)';
    steps.push({
      question: `Which ${level.label} concentrates low reviews most?`,
      finding: `${titleize(level.label)} "${top.label}" makes up ${top.subsetShare.toFixed(1)}% of this narrowed group (${top.count} of ${mc.subsetTotal} rows) but ${top.baseShare !== null ? `only ${top.baseShare.toFixed(1)}%` : 'an unmeasurable share'} of all rated orders — ${liftText}.`,
      narrowed: narrow,
      table: mc.ranked.slice(0, 5),
    });
    if (narrow) currentRows = currentRows.filter((item) => String(level.accessor(item) || '').trim() === top.label);
  });

  // Step 5 — is freight high in the narrowed subset vs. the dataset overall?
  const freightCol = findByNamePattern(ctx.factFileProfile, FREIGHT_NAME_RE, ['numeric', 'currency']);
  if (freightCol && currentRows.length >= 10) {
    const subsetFreights = currentRows.map((item) => tryParseNumber(item.row[freightCol.name])).filter((v) => v !== null);
    const allFreights = ctx.factFile.rows.map((row) => tryParseNumber(row[freightCol.name])).filter((v) => v !== null);
    if (subsetFreights.length >= 5 && allFreights.length >= 20) {
      const subsetAvg = mean(subsetFreights);
      const overallAvg = mean(allFreights);
      const pct = overallAvg ? (((subsetAvg - overallAvg) / overallAvg) * 100) : null;
      steps.push({
        question: 'Is freight high in this narrowed group?',
        finding: `Average ${titleize(freightCol.name)} in this narrowed group is ${subsetAvg.toFixed(2)}, vs. ${overallAvg.toFixed(2)} overall${pct !== null ? ` (${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%)` : ''}.`,
        narrowed: null,
      });
    }
  }

  // Step 6 — specific orders/products worth inspecting, from whatever
  // subset the funnel narrowed down to.
  const orderIdCol = findRoleColumn(ctx.factFile, 'order_id');
  const productDl = dimensionLabelAccessor(ctx, 'product_id');
  const specifics = currentRows.slice(0, 8).map((item) => ({
    orderId: orderIdCol ? item.row[orderIdCol.name] : null,
    product: productDl ? productDl.accessor(item.row) : null,
    rating: tryParseNumber(item.row[ratingCol.name]),
  })).filter((s) => s.orderId || s.product);

  if (steps.length === 0) return notApplicable('None of the available delivery-delay/seller/category/geography/freight columns produced a usable drill-down for low reviews.');

  return {
    applicable: true,
    narrative: `Starting from ${isLowIdx.size.toLocaleString()} low-rated rows (this dataset's own bottom 20% of ratings), the drill-down below narrows step by step toward the specific conditions most concentrating low reviews.`,
    steps,
    specifics,
    lowThreshold: p20,
    lowReviewCount: isLowIdx.size,
  };
}

// #14 — Geographic diagnosis: an EXACT decomposition of why one
// geography leads — revenue = customers x (orders / customer) x (revenue
// / order) — so "why is <top geography> highest" is answered by WHICH of
// the three factors is most different from other geographies' own
// average, not just "it has more sales." Degrades to a 2-factor (orders x
// AOV) read when no resolvable customer identifier exists, disclosed
// explicitly rather than silently dropping the customer dimension.
function geoMarketDecomposition(ctx) {
  const geo = resolveGeo(ctx);
  const revInfo = findRevenueColumn(ctx);
  if (!geo || !revInfo) return notApplicable('Needs a resolvable geography column (direct or via a joined customer/merchant dimension) and a revenue/amount column (or a listed price on a dated/order-keyed row).');
  const revCol = revInfo.col;
  const geoAccessor = (row) => (geo.indirect ? (geo.lookup.get(String(row[geo.keyCol]).trim()) || null) : row[geo.keyCol]);
  const orderIdCol = findRoleColumn(ctx.factFile, 'order_id');
  const custDl = dimensionLabelAccessor(ctx, 'customer_id');

  const groups = new Map();
  ctx.factFile.rows.forEach((row) => {
    const g = geoAccessor(row);
    if (g === null || g === undefined || String(g).trim() === '') return;
    const key = String(g).trim();
    if (!groups.has(key)) groups.set(key, { revenue: 0, orderIds: new Set(), customerIds: new Set(), rowCount: 0 });
    const slot = groups.get(key);
    const rev = tryParseNumber(row[revCol.name]);
    if (rev !== null) slot.revenue += rev;
    slot.rowCount += 1;
    if (orderIdCol && row[orderIdCol.name]) slot.orderIds.add(String(row[orderIdCol.name]).trim());
    if (custDl && custDl.idCol && row[custDl.idCol.name]) slot.customerIds.add(String(row[custDl.idCol.name]).trim());
  });

  const rows = [...groups.entries()]
    .map(([label, g]) => {
      const orders = orderIdCol ? g.orderIds.size : g.rowCount;
      const customers = custDl ? g.customerIds.size : null;
      const ordersPerCustomer = customers ? orders / customers : null;
      const aov = orders ? g.revenue / orders : null;
      return {
        label, revenue: g.revenue, orders, customers, ordersPerCustomer, aov,
      };
    })
    .filter((r) => r.orders >= 5)
    .sort((a, b) => b.revenue - a.revenue);
  if (rows.length < 3) return notApplicable('Not enough distinct geographies with sufficient order volume to decompose.');

  const top = rows[0];
  const others = rows.slice(1);
  const avgOf = (key) => {
    const vals = others.map((r) => r[key]).filter((v) => v !== null && Number.isFinite(v) && v > 0);
    return vals.length ? mean(vals) : null;
  };
  const othersAvgCustomers = avgOf('customers');
  const othersAvgOrdersPerCustomer = avgOf('ordersPerCustomer');
  const othersAvgAov = avgOf('aov');

  const ratios = [];
  if (top.customers && othersAvgCustomers) ratios.push({ factor: 'number of customers (market size)', ratio: top.customers / othersAvgCustomers });
  if (top.ordersPerCustomer && othersAvgOrdersPerCustomer) ratios.push({ factor: 'orders per customer (purchase frequency)', ratio: top.ordersPerCustomer / othersAvgOrdersPerCustomer });
  if (top.aov && othersAvgAov) ratios.push({ factor: 'average order value (spending intensity)', ratio: top.aov / othersAvgAov });
  ratios.sort((a, b) => Math.abs(Math.log(b.ratio)) - Math.abs(Math.log(a.ratio)));
  const dominant = ratios[0] || null;

  return {
    applicable: true,
    narrative: `${titleize(top.label)} leads with ${moneyStr(top.revenue).toLocaleString()} in revenue${revenueFallbackNote(revInfo)}.${dominant ? ` This is driven mostly by ${dominant.factor} — ${dominant.ratio.toFixed(2)}x the average of other geographies — rather than the other factor(s) alone.` : ' Not enough data in other geographies yet to compare which factor drives this.'}${!custDl ? ' (No resolvable customer identifier was found, so this decomposition covers orders x average order value only, not customer count.)' : ''}`,
    top,
    rows: rows.slice(0, 10),
    dominant,
  };
}

// #15 — Standalone Pareto concentration analysis: what share of TOTAL
// revenue (over this fact table's whole history, unlike CATEGORY_REVENUE_
// PARETO/#7's two-month decline window) comes from the top categories,
// products, and sellers — the classic 80/20 framing the user's spec asked
// for directly ("what percentage of sales comes from the top categories/
// products/sellers?").
function totalsPareto(rows, groupAccessor, valueAccessor, minGroups = 3) {
  const totals = new Map();
  rows.forEach((row) => {
    const g = groupAccessor(row);
    if (g === null || g === undefined || String(g).trim() === '') return;
    const key = String(g).trim();
    const v = valueAccessor(row);
    if (v === null || v === undefined || !Number.isFinite(v)) return;
    totals.set(key, (totals.get(key) || 0) + v);
  });
  const sorted = [...totals.entries()].map(([label, value]) => ({ label, value })).sort((a, b) => b.value - a.value);
  if (sorted.length < minGroups) return null;
  const grandTotal = sorted.reduce((s, r) => s + r.value, 0);
  if (grandTotal <= 0) return null;
  let running = 0;
  const withCumulative = sorted.map((r) => {
    running += r.value;
    return { ...r, pctOfTotal: (r.value / grandTotal) * 100, cumulativePct: (running / grandTotal) * 100 };
  });
  const vitalFewCount = withCumulative.findIndex((r) => r.cumulativePct >= 80) + 1 || withCumulative.length;
  return {
    totalGroups: sorted.length, vitalFewCount, grandTotal, rows: withCumulative.slice(0, 15),
  };
}

function paretoConcentrationAnalysis(ctx) {
  const revInfo = findRevenueColumn(ctx);
  if (!revInfo) return notApplicable('Needs a revenue/amount column (or a listed price on a dated/order-keyed row).');
  const revCol = revInfo.col;
  const valueOf = (row) => tryParseNumber(row[revCol.name]);

  const dims = [];
  const catCol = findCategoryColumn(ctx);
  if (catCol) dims.push({ label: 'category', accessor: (row) => row[catCol.name] });
  const productDl = dimensionLabelAccessor(ctx, 'product_id');
  if (productDl) dims.push({ label: 'product', accessor: productDl.accessor });
  const merchantDl = dimensionLabelAccessor(ctx, 'merchant_id');
  if (merchantDl) dims.push({ label: 'seller', accessor: merchantDl.accessor });

  const panels = dims
    .map((d) => ({ dimensionLabel: d.label, pareto: totalsPareto(ctx.factFile.rows, d.accessor, valueOf) }))
    .filter((p) => p.pareto);
  if (panels.length === 0) return notApplicable('No category, product, or seller column was found to concentrate revenue by.');

  const sentences = panels.map((p) => `${p.pareto.vitalFewCount} of ${p.pareto.totalGroups} ${pluralize(p.dimensionLabel)} (led by ${p.pareto.rows[0].label}, ${p.pareto.rows[0].pctOfTotal.toFixed(1)}%) account for 80% of revenue`);
  return {
    applicable: true,
    narrative: `${sentences.join('; ')}${revenueFallbackNote(revInfo)}.`,
    panels,
  };
}

// #16 — Freight-impact analysis: the freight-to-order-VALUE RATIO (not
// freight cost in isolation, which is FREIGHT_DRIVERS/#4's job),
// segmented by category and geography, plus its correlation with review
// score where a rating column exists.
function freightImpactAnalysis(ctx) {
  const freightCol = findByNamePattern(ctx.factFileProfile, FREIGHT_NAME_RE, ['numeric', 'currency']);
  const priceCol = findRoleColumn(ctx.factFile, 'price') || findRoleColumn(ctx.factFile, 'revenue');
  if (!freightCol || !priceCol) return notApplicable('Needs both a freight/shipping-cost column and a price/revenue column on the transaction fact table to compute a freight-to-order-value ratio.');

  const ratioOf = (row) => {
    const freight = tryParseNumber(row[freightCol.name]);
    const price = tryParseNumber(row[priceCol.name]);
    if (freight === null || price === null || price <= 0) return null;
    return (freight / price) * 100;
  };
  const rowsWithRatio = ctx.factFile.rows.map((row, idx) => ({ row, idx, ratio: ratioOf(row) })).filter((r) => r.ratio !== null);
  if (rowsWithRatio.length < 20) return notApplicable('Not enough rows with both a valid freight and price value to compute a freight-to-order-value ratio.');

  const overallRatio = mean(rowsWithRatio.map((r) => r.ratio));

  const segments = [];
  const catCol = findCategoryColumn(ctx);
  if (catCol) {
    const rowsForSeg = rowsWithRatio.map((r) => ({ ...r.row, __ratio: r.ratio }));
    const seg = performanceSegmentation(rowsForSeg, (row) => row[catCol.name], [{ key: 'ratio', label: 'Freight-to-value ratio (%)', accessor: (row) => row.__ratio, agg: 'avg' }]);
    if (seg) segments.push({ dimensionLabel: 'category', seg });
  }
  const geo = resolveGeo(ctx);
  if (geo) {
    const geoAccessor = (row) => (geo.indirect ? (geo.lookup.get(String(row[geo.keyCol]).trim()) || null) : row[geo.keyCol]);
    const rowsForSeg = rowsWithRatio.map((r) => ({ ...r.row, __ratio: r.ratio }));
    const seg = performanceSegmentation(rowsForSeg, geoAccessor, [{ key: 'ratio', label: 'Freight-to-value ratio (%)', accessor: (row) => row.__ratio, agg: 'avg' }]);
    if (seg) segments.push({ dimensionLabel: 'geography', seg });
  }

  let reviewCorrelation = null;
  const ratingCol = findRatingColumn(ctx);
  if (ratingCol) {
    const xs = [];
    const ys = [];
    rowsWithRatio.forEach((r) => {
      const rating = tryParseNumber(r.row[ratingCol.name]);
      if (rating === null) return;
      xs.push(r.ratio);
      ys.push(rating);
    });
    reviewCorrelation = pearsonCorrelation(xs, ys);
  }

  return {
    applicable: true,
    narrative: `Freight averages ${overallRatio.toFixed(1)}% of order value across ${rowsWithRatio.length.toLocaleString()} rows.${segments.length ? ` This ratio varies by ${segments.map((s) => s.dimensionLabel).join(' and ')}.` : ''}${reviewCorrelation !== null ? ` A higher freight-to-value ratio shows a ${reviewCorrelation < 0 ? 'negative' : 'positive'} association with review score (strength ${Math.abs(reviewCorrelation).toFixed(2)}).` : ''}`,
    overallRatio,
    segments,
    reviewCorrelation,
  };
}

// #17 — Category-performance matrix: classifies each category into one
// of four quadrants (High/Low sales x High/Low reviews), split at this
// dataset's own MEDIAN revenue and median review score across categories
// — a dataset-relative threshold, never an assumed universal cutoff.
function categoryPerformanceMatrix(ctx) {
  const catCol = findCategoryColumn(ctx);
  const revInfo = findRevenueColumn(ctx);
  const ratingCol = findRatingColumn(ctx);
  if (!catCol || !revInfo) return notApplicable('Needs a category-like column and a revenue/amount column (or a listed price on a dated/order-keyed row).');
  if (!ratingCol) return notApplicable('Needs a column profiled as a rating/review-score scale to compare against sales by category — none was found.');
  const revCol = revInfo.col;

  const groups = new Map();
  ctx.factFile.rows.forEach((row) => {
    const cat = row[catCol.name];
    if (cat === null || cat === undefined || String(cat).trim() === '') return;
    const key = String(cat).trim();
    if (!groups.has(key)) groups.set(key, {
      revenue: 0, ratingSum: 0, ratingCount: 0, rowCount: 0,
    });
    const g = groups.get(key);
    const rev = tryParseNumber(row[revCol.name]);
    if (rev !== null) g.revenue += rev;
    const rating = tryParseNumber(row[ratingCol.name]);
    if (rating !== null) { g.ratingSum += rating; g.ratingCount += 1; }
    g.rowCount += 1;
  });

  const rows = [...groups.entries()]
    .filter(([, g]) => g.rowCount >= 10 && g.ratingCount >= 5)
    .map(([label, g]) => ({
      label, revenue: g.revenue, avgRating: g.ratingSum / g.ratingCount, rowCount: g.rowCount,
    }));
  if (rows.length < 4) return notApplicable('Not enough distinct categories with sufficient revenue and rated orders to build a performance matrix.');

  const medianRev = quantile([...rows.map((r) => r.revenue)].sort((a, b) => a - b), 0.5);
  const medianRating = quantile([...rows.map((r) => r.avgRating)].sort((a, b) => a - b), 0.5);

  const classified = rows.map((r) => {
    const highSales = r.revenue >= medianRev;
    const highReview = r.avgRating >= medianRating;
    let quadrant;
    if (highSales && highReview) quadrant = 'High sales / High reviews';
    else if (highSales && !highReview) quadrant = 'High sales / Low reviews';
    else if (!highSales && highReview) quadrant = 'Low sales / High reviews';
    else quadrant = 'Low sales / Low reviews';
    return { ...r, quadrant };
  }).sort((a, b) => b.revenue - a.revenue);

  const risky = classified.filter((r) => r.quadrant === 'High sales / Low reviews');
  const opportunity = classified.filter((r) => r.quadrant === 'Low sales / High reviews');

  return {
    applicable: true,
    narrative: `${classified.length} categories classified against this dataset's own median revenue (${moneyStr(medianRev).toLocaleString()}) and median review score (${medianRating.toFixed(2)}).${risky.length ? ` ${risky.length} categor${risky.length > 1 ? 'ies' : 'y'} (${risky.map((r) => r.label).slice(0, 3).join(', ')}) show high sales but low reviews — a retention risk worth investigating.` : ''}${opportunity.length ? ` ${opportunity.length} categor${opportunity.length > 1 ? 'ies' : 'y'} (${opportunity.map((r) => r.label).slice(0, 3).join(', ')}) show high reviews but low sales — a possible growth opportunity.` : ''}`,
    medianRevenue: medianRev,
    medianRating,
    rows: classified,
  };
}

// ---------------------------------------------------------------------
// CAAGA Stage 6 wiring — Priority + Confidence per finding.
//
// R (business relevance) — a declared, disclosed weight per diagnostic
// TYPE (not per dataset), reflecting how directly the question touches a
// core financial KPI an SME watches first (revenue/orders/AOV/category
// mix) versus a one-step-removed operational or segmentation signal.
// These are fixed constants, not learned or tuned per run — exactly what
// the CAAGA document's own validation-plan section asks for ("weights
// should be fixed during an experiment... not silently changed between
// benchmark runs"). A future validation round can run the ablation the
// document also proposes (drop or reweight one factor, compare the
// resulting ranking against expert judgment) without touching anything
// but this table.
// ---------------------------------------------------------------------
const RELEVANCE_BY_ID = {
  REVENUE_DRIVERS: 1.00,
  ORDERS_DRIVERS: 0.95,
  AOV_DRIVERS: 0.90,
  CATEGORY_REVENUE_PARETO: 0.85,
  DELIVERY_DELAY_DRIVERS: 0.80,
  REVIEW_SCORE_DRIVERS: 0.80,
  CANCELLATION_DRIVERS: 0.80,
  REPEAT_PURCHASE_DRIVERS: 0.75,
  FREIGHT_DRIVERS: 0.75,
  SELLER_PERFORMANCE_SEGMENTATION: 0.70,
  PARETO_CONCENTRATION: 0.70,
  GEO_SALES_SEGMENTATION: 0.65,
  LOW_REVIEW_DRILLDOWN: 0.72,
  FREIGHT_IMPACT_ANALYSIS: 0.68,
  CATEGORY_PERFORMANCE_MATRIX: 0.68,
  GEO_MARKET_DECOMPOSITION: 0.62,
  PAYMENT_BEHAVIOR_CROSSTAB: 0.55,
};

// Average confidence across the semantic-role columns (see services/
// businessSemantics.js's scoreColumnRoles()) a finding actually depended
// on — e.g. a revenue-driver finding is only as semantically trustworthy
// as CAAGA Stage 2's own confidence that the columns it read really ARE
// revenue and date. Ignores nulls (a role the finding didn't need);
// falls back to a neutral 0.6 only if none of the supplied columns
// resolved, which should not happen for an `applicable: true` result.
function avgConfidence(...cols) {
  const vals = cols.filter((c) => c && Number.isFinite(c.confidence)).map((c) => c.confidence);
  if (vals.length === 0) return 0.6;
  return vals.reduce((s, v) => s + v, 0) / vals.length;
}

// The strongest single association out of explainFactorsFor()'s combined
// numeric (Pearson r) + categorical (eta) candidate results — the exact
// same "top" selection each of FREIGHT_DRIVERS/DELIVERY_DELAY_DRIVERS/
// REVIEW_SCORE_DRIVERS already computes for its own narrative sentence,
// reused here rather than recomputed differently. `n` is the numeric
// candidate's own paired-row count when the winner is numeric; eta-based
// categorical results carry no total-n field (see services/
// diagnosticEngine.js's explainFactorsFor()), so the fact table's own row
// count stands in as an documented upper-bound approximation for those.
function resolveTopAssociation(result, factRowCount) {
  if (!result) return null;
  const numeric = result.numericResults[0];
  const categorical = result.categoricalResults[0];
  const numericStrength = numeric ? normalizeCorrelation(numeric.correlation) : -1;
  const categoricalStrength = categorical ? clamp01(categorical.eta) : -1;
  if (numericStrength < 0 && categoricalStrength < 0) return null;
  if (numericStrength >= categoricalStrength) {
    return {
      strength: numericStrength, n: numeric.n, actionable: !!numeric.split,
    };
  }
  return {
    strength: categoricalStrength, n: factRowCount, actionable: !!categorical.bestGroup,
  };
}

// Same idea as resolveTopAssociation() above but for explainBinaryFactorsFor
// ()'s output (Cohen's d for numeric candidates, a real chi-square test —
// converted to Cramér's V so it's on the same [0,1] scale as everything
// else — for categorical ones). Covers CANCELLATION_DRIVERS and
// REPEAT_PURCHASE_DRIVERS.
function resolveTopBinaryAssociation(result) {
  if (!result) return null;
  const numeric = result.numericResults[0];
  const categorical = result.categoricalResults[0];
  const numericStrength = numeric ? normalizeCohensD(numeric.cohensD) : -1;
  const categoricalStrength = categorical
    ? cramersVFromChiSquare(categorical.test.chiSquare, categorical.test.grandTotal, categorical.rowLabels.length, 2)
    : -1;
  if (numericStrength < 0 && categoricalStrength < 0) return null;
  if (numericStrength >= categoricalStrength) {
    return {
      strength: numericStrength, n: numeric.trueCount + numeric.falseCount, actionable: !!numeric.split,
    };
  }
  return {
    strength: categoricalStrength, n: categorical.test.grandTotal, actionable: !!categorical.test.mostAssociatedCell,
  };
}

// Percent-change magnitude, same formula as pctChange() above, exposed
// here because AOV_DRIVERS' own return object keeps prevAOV/currAOV but
// not the derived percentage (its narrative sentence computes it inline
// and discards it) — recomputed from the SAME two numbers already
// returned, never re-derived from raw rows.
function pctMagnitude(prev, curr) {
  if (prev === null || curr === null || prev === 0) return null;
  return Math.abs(((curr - prev) / Math.abs(prev)) * 100);
}

// Scans-the-whole-fact-table cost proxy — every diagnostic in this file
// reads ctx.factFile.rows at least once, so K is currently the SAME value
// across all 12 findings within one dataset (it only varies BETWEEN
// datasets of different scale). It's kept in the formula for completeness
// with the CAAGA document's Priority(A) definition and because a future
// round could wire in real per-finding cost (the way round 16's temporary
// [PERF] instrumentation measured FREIGHT_DRIVERS specifically) rather
// than this dataset-wide proxy — see claude/cma-flow-app-conceptual-
// framework-audit.md's Round 17 "Still open" note.
function costProxy(factRowCount) {
  return clamp01(factRowCount / 200000);
}

// The one function this whole block exists for: given a diagnostic
// definition, the (applicable) result its generator produced, and the ctx
// it was computed from, extract R/S/Q/C/X/K and return
// { priorityScore, priorityBand, confidence, confidenceBand, factors }.
// Every extraction reads fields the generator ABOVE already computed —
// nothing here recomputes a statistic differently than the finding's own
// narrative already reports it.
function scoreDiagnosticFinding(def, result, ctx) {
  const relevance = RELEVANCE_BY_ID[def.id] ?? 0.7;
  const factRowCount = ctx.factFile.rows.length;
  const K = costProxy(factRowCount);
  const dateCol = findRoleColumn(ctx.factFile, 'date');
  let strength = 0.5; let quality = 0.5; let confidence = 0.6; let actionability = 0.6;

  switch (def.id) {
    case 'REVENUE_DRIVERS': {
      const revInfo = findRevenueColumn(ctx);
      strength = clamp01(Math.abs(result.overall.pct || 0) / 50);
      quality = sufficiencyRatio(factRowCount, 100);
      confidence = avgConfidence(revInfo && revInfo.col, dateCol);
      actionability = result.decomposition ? 1.0 : (result.contributions.length ? 0.8 : 0.5);
      break;
    }
    case 'ORDERS_DRIVERS': {
      strength = clamp01(Math.abs(result.overall.pct || 0) / 50);
      quality = sufficiencyRatio(factRowCount, 100);
      confidence = avgConfidence(dateCol);
      actionability = result.contributions.length ? 0.8 : 0.5;
      break;
    }
    case 'AOV_DRIVERS': {
      const revInfo = findRevenueColumn(ctx);
      const pct = pctMagnitude(result.prevAOV, result.currAOV);
      strength = pct === null ? 0.4 : clamp01(pct / 30);
      quality = sufficiencyRatio(factRowCount, 100);
      confidence = avgConfidence(revInfo && revInfo.col, dateCol);
      actionability = 1.0; // AOV_DRIVERS only returns applicable:true once mixRateDecomposition() succeeded
      break;
    }
    case 'FREIGHT_DRIVERS': {
      const top = resolveTopAssociation(result, factRowCount);
      strength = top ? top.strength : 0.3;
      quality = top ? sufficiencyRatio(top.n, 30) : 0.3;
      confidence = avgConfidence(findRoleColumn(ctx.factFile, 'price'));
      actionability = top ? (top.actionable ? 1.0 : 0.6) : 0.4;
      break;
    }
    case 'DELIVERY_DELAY_DRIVERS': {
      const top = resolveTopAssociation(result, factRowCount);
      strength = top ? top.strength : 0.3;
      quality = sufficiencyRatio(result.sampleSize || 0, 20);
      confidence = 0.75; // delay itself comes from two date columns already gated by computeRowDelays()'s own >=20-row check
      actionability = top ? (top.actionable ? 1.0 : 0.6) : 0.4;
      break;
    }
    case 'REVIEW_SCORE_DRIVERS': {
      const top = resolveTopAssociation(result, factRowCount);
      strength = top ? top.strength : 0.3;
      quality = top ? sufficiencyRatio(top.n, 30) : 0.3;
      confidence = 0.75; // rating column identified by profiled kind, not a name-only guess
      actionability = top ? (top.actionable ? 1.0 : 0.6) : 0.4;
      break;
    }
    case 'CATEGORY_REVENUE_PARETO': {
      const revInfo = findRevenueColumn(ctx);
      const topCount = result.pareto.length ? result.pareto.findIndex((r) => r.cumulativePct >= 80) + 1 || result.pareto.length : 1;
      strength = clamp01(1 - ((topCount - 1) / Math.max(1, result.pareto.length)));
      quality = sufficiencyRatio(result.pareto.length, 3);
      confidence = avgConfidence(revInfo && revInfo.col, dateCol);
      actionability = 1.0; // always names specific declining categories by construction
      break;
    }
    case 'SELLER_PERFORMANCE_SEGMENTATION':
    case 'GEO_SALES_SEGMENTATION': {
      strength = clamp01((result.coefficientOfVariation || 0) / 100);
      quality = sufficiencyRatio(result.totalGroups, 4);
      confidence = avgConfidence(findRevenueColumn(ctx) && findRevenueColumn(ctx).col);
      actionability = 1.0; // top/bottom performer lists are concrete, named entities
      break;
    }
    case 'CANCELLATION_DRIVERS': {
      const top = resolveTopBinaryAssociation(result);
      strength = top ? top.strength : 0.3;
      quality = top ? sufficiencyRatio(top.n, 20) : 0.3;
      confidence = 0.75; // status/cancellation value matched by pattern, not a formal semantic role
      actionability = top ? (top.actionable ? 1.0 : 0.6) : 0.4;
      break;
    }
    case 'REPEAT_PURCHASE_DRIVERS': {
      const top = resolveTopBinaryAssociation(result);
      strength = top ? top.strength : 0.3;
      quality = sufficiencyRatio(Math.min(result.repeatCount, result.oneTimeCount), 10);
      confidence = avgConfidence(findRevenueColumn(ctx) && findRevenueColumn(ctx).col);
      actionability = top ? (top.actionable ? 1.0 : 0.6) : 0.4;
      break;
    }
    case 'PAYMENT_BEHAVIOR_CROSSTAB': {
      const crosstabV = result.crosstab ? cramersVFromChiSquare(result.crosstab.test.chiSquare, result.crosstab.test.grandTotal, result.crosstab.rowLabels.length, result.crosstab.colLabels.length) : -1;
      const installEta = result.installmentsByPayment ? clamp01(result.installmentsByPayment.eta) : -1;
      strength = Math.max(crosstabV, installEta, 0.3);
      quality = sufficiencyRatio(result.crosstab ? result.crosstab.test.grandTotal : factRowCount, 20);
      confidence = 0.7; // payment/installments matched by name pattern, not a formal semantic role
      actionability = (result.crosstab && result.crosstab.test.mostAssociatedCell) ? 1.0 : 0.6;
      break;
    }
    case 'LOW_REVIEW_DRILLDOWN': {
      strength = clamp01(result.steps.filter((s) => s.narrowed).length / Math.max(1, result.steps.length));
      quality = sufficiencyRatio(result.lowReviewCount || 20, 30);
      confidence = 0.7; // rating column identified by profiled kind; each drill level's own group-size gate is applied inline
      actionability = (result.specifics && result.specifics.length) ? 1.0 : 0.6;
      break;
    }
    case 'GEO_MARKET_DECOMPOSITION': {
      strength = result.dominant ? clamp01(Math.abs(Math.log(result.dominant.ratio)) / Math.log(3)) : 0.3;
      quality = sufficiencyRatio(result.rows.length, 5);
      confidence = avgConfidence(findRevenueColumn(ctx) && findRevenueColumn(ctx).col);
      actionability = result.dominant ? 1.0 : 0.5;
      break;
    }
    case 'PARETO_CONCENTRATION': {
      const p = result.panels[0].pareto;
      strength = clamp01(1 - ((p.vitalFewCount - 1) / Math.max(1, p.totalGroups)));
      quality = sufficiencyRatio(p.totalGroups, 5);
      confidence = avgConfidence(findRevenueColumn(ctx) && findRevenueColumn(ctx).col);
      actionability = 1.0; // always names specific top categories/products/sellers by construction
      break;
    }
    case 'FREIGHT_IMPACT_ANALYSIS': {
      strength = result.reviewCorrelation !== null ? normalizeCorrelation(result.reviewCorrelation) : 0.4;
      quality = sufficiencyRatio(result.segments.length ? result.segments[0].seg.totalGroups : 4, 4);
      confidence = 0.7; // freight/price matched by name pattern and role, not a formal semantic role
      actionability = result.segments.length ? 1.0 : 0.5;
      break;
    }
    case 'CATEGORY_PERFORMANCE_MATRIX': {
      strength = clamp01(result.rows.filter((r) => r.quadrant === 'High sales / Low reviews').length / Math.max(1, result.rows.length));
      quality = sufficiencyRatio(result.rows.length, 6);
      confidence = 0.72; // rating column identified by profiled kind
      actionability = 1.0; // always names specific categories per quadrant by construction
      break;
    }
    default:
      break;
  }

  const priority = computePriority({
    relevance, strength, quality, confidence, actionability, cost: K,
  });
  const conf = computeConfidence({
    semanticConfidence: confidence, sampleSufficiency: quality, missingnessRatio: 0, stability: quality,
  });
  return {
    priorityScore: priority.score,
    priorityBand: priority.band,
    confidence: conf.score,
    confidenceBand: conf.band,
    priorityFactors: priority.factors,
  };
}

// ---------------------------------------------------------------------
// Orchestrator — analogous to metricRegistry.js's evaluateMetrics(ctx).
// Every generator is wrapped individually so one failing pattern (a
// coding edge case, an unexpected data shape) never breaks the whole
// page — it degrades to an honest "not applicable" instead. As of CAAGA
// Stage 6 (Round 17), every applicable finding is also scored and the
// full set is returned RANKED by priority — applicable findings sorted
// highest-priority-first, not-applicable ones (still shown, for
// transparency about what was checked and why it didn't qualify) pushed
// to the end — rather than the previous fixed DIAGNOSTIC_DEFINITIONS
// declaration order.
// ---------------------------------------------------------------------
const DIAGNOSTIC_DEFINITIONS = [
  {
    id: 'REVENUE_DRIVERS', label: 'Revenue decreased', question: 'What contributed to the change?', method: 'Period-over-period contribution analysis + price/volume decomposition', generator: revenueDrivers,
  },
  {
    id: 'ORDERS_DRIVERS', label: 'Orders decreased', question: 'Which segments contributed most?', method: 'Drill-down + contribution analysis', generator: ordersDrivers,
  },
  {
    id: 'AOV_DRIVERS', label: 'AOV decreased', question: 'Was it caused by product mix or lower prices?', method: 'Segmentation + mix/rate decomposition', generator: aovDrivers,
  },
  {
    id: 'FREIGHT_DRIVERS', label: 'Freight cost is high', question: 'What factors are associated with freight cost?', method: 'Correlation + regression-tree split', generator: freightDrivers,
  },
  {
    id: 'DELIVERY_DELAY_DRIVERS', label: 'Delivery is late', question: 'What characteristics are associated with delays?', method: 'Group comparison + correlation/regression-tree split', generator: deliveryDelayDrivers,
  },
  {
    id: 'REVIEW_SCORE_DRIVERS', label: 'Review scores are low', question: 'What factors are associated with poor ratings?', method: 'Correlation, group comparison, decision-tree split', generator: reviewScoreDrivers,
  },
  {
    id: 'CATEGORY_REVENUE_PARETO', label: 'Category revenue fell', question: 'Which products/sellers/geographies contributed?', method: 'Drill-down + Pareto/contribution analysis', generator: categoryRevenuePareto,
  },
  {
    id: 'SELLER_PERFORMANCE_SEGMENTATION', label: 'Seller performance varies', question: 'What differentiates higher/lower performers?', method: 'Segmentation + comparative statistics', generator: sellerPerformanceSegmentation,
  },
  {
    id: 'CANCELLATION_DRIVERS', label: 'Cancellations increased', question: 'What characteristics distinguish canceled orders?', method: 'Chi-square + standardized group-difference (Cohen\'s d)', generator: cancellationDrivers,
  },
  {
    id: 'GEO_SALES_SEGMENTATION', label: 'Certain geographies have lower sales', question: 'Why do geographic results differ?', method: 'Segmentation + comparative analysis', generator: geoSalesSegmentation,
  },
  {
    id: 'PAYMENT_BEHAVIOR_CROSSTAB', label: 'Payment behavior differs', question: 'Is payment type associated with order characteristics?', method: 'Crosstab + chi-square', generator: paymentBehaviorCrosstab,
  },
  {
    id: 'REPEAT_PURCHASE_DRIVERS', label: 'Repeat purchasing differs', question: 'Which observable characteristics are associated with repeat purchasing?', method: 'Cohort segmentation + chi-square / standardized group-difference', generator: repeatPurchaseDrivers,
  },
  // Round 20 additions — see each generator's own header comment above.
  {
    id: 'LOW_REVIEW_DRILLDOWN', label: 'Review diagnosis (drill-down)', question: 'What specific conditions concentrate low reviews?', method: 'Sequential drill-down funnel (late delivery -> seller -> category -> geography -> freight -> specific orders)', generator: lowReviewDrillDownTree,
  },
  {
    id: 'GEO_MARKET_DECOMPOSITION', label: 'Why does the top geography lead?', question: 'Is it more customers, more frequent purchases, or higher spending per order?', method: 'Exact decomposition: customers x orders/customer x average order value', generator: geoMarketDecomposition,
  },
  {
    id: 'PARETO_CONCENTRATION', label: 'Sales concentration (Pareto)', question: 'What share of sales comes from the top categories/products/sellers?', method: '80/20 Pareto concentration analysis, whole-history totals', generator: paretoConcentrationAnalysis,
  },
  {
    id: 'FREIGHT_IMPACT_ANALYSIS', label: 'Freight impact on satisfaction', question: 'How large is freight relative to order value, and does it relate to reviews?', method: 'Freight-to-order-value ratio, segmented by category/geography, correlated with review score', generator: freightImpactAnalysis,
  },
  {
    id: 'CATEGORY_PERFORMANCE_MATRIX', label: 'Category performance matrix', question: 'Which categories combine high/low sales with high/low reviews?', method: 'Quadrant classification against this dataset\'s own median revenue and median review score', generator: categoryPerformanceMatrix,
  },
];

function evaluateDiagnostics(ctx) {
  const findings = DIAGNOSTIC_DEFINITIONS.map((def) => {
    let result;
    try {
      result = def.generator(ctx);
    } catch (err) {
      result = notApplicable('Not applicable — an unexpected data shape prevented this diagnostic from being computed.');
    }
    let score = {};
    if (result.applicable) {
      // Scoring is a pure post-processing step over a finding that's
      // already fully computed and narratable — a bug in the NEW scoring
      // code must never take down a finding that would otherwise have
      // rendered correctly, so it degrades to "unscored" (no priority/
      // confidence fields) rather than throwing past this point.
      try {
        score = scoreDiagnosticFinding(def, result, ctx);
      } catch (err) {
        score = {};
      }
    }
    return {
      id: def.id, label: def.label, question: def.question, method: def.method, ...result, ...score,
    };
  });
  // Rank: applicable findings first, highest priority first; not-applicable
  // findings keep their original catalog order at the end (nothing to rank
  // them by, and their relative order was never meaningful to begin with).
  const applicableIdx = new Map(findings.map((f, i) => [f.id, i]));
  return [...findings].sort((a, b) => {
    if (a.applicable !== b.applicable) return a.applicable ? -1 : 1;
    if (a.applicable && b.applicable) return (b.priorityScore || 0) - (a.priorityScore || 0);
    return applicableIdx.get(a.id) - applicableIdx.get(b.id);
  });
}

module.exports = {
  evaluateDiagnostics,
  // Exported for unit testing (scratch scripts) and potential reuse.
  pearsonCorrelation,
  correlationRatio,
  cohensD,
  bestNumericSplit,
  chiSquareTest,
  chiSquareCriticalValue,
  priceVolumeDecomposition,
  mixRateDecomposition,
  periodOverPeriodContribution,
  performanceSegmentation,
  explainFactorsFor,
  explainBinaryFactorsFor,
  crosstabChiSquare,
  findRevenueColumn,
  // Round 20 — exported so services/predictiveAnalyticsDynamic.js's new
  // delivery-delay-risk and review-score-outlook engines can reuse the
  // SAME column-detection and rate-comparison logic rather than
  // maintaining a second copy (this codebase has a documented history of
  // that kind of drift — see this file's own header).
  computeRowDelays,
  worstRateGroup,
  mostConcentratedGroup,
  findRatingColumn,
  findCategoryColumn,
  dimensionLabelAccessor,
  findByNamePattern,
  FREIGHT_NAME_RE,
};
