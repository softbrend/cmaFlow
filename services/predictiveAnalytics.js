// Predictive Analytics — Phase 3 of claude/canonical-schema-analytics-
// roadmap.md ("what will happen next"). A feature layer over the same
// four canonical entities feeding a deliberately RULES-BASED churn-risk
// score and a simple linear-trend revenue projection — not a trained
// model. A DIT prototype needs to show its work: every score here traces
// back to a named rule, never a black box, and every computation degrades
// per-customer (or dataset-wide, for the forecast) to an explicit
// "insufficient data" state rather than a guess.
//
// METHODOLOGY UPGRADE (RPIS Week 5 open item — "whether the rules-based
// churn score and linear-trend forecast are sufficient"): both answers
// below are "augment, don't replace" — the original scores stay fully
// rules-based and explainable, but three gaps get closed:
//   1. The churn score used fixed 90/180-day recency cutoffs for every
//      account, regardless of that business's own normal buying rhythm.
//      Cutoffs are now dataset-relative (this account's own recency
//      distribution), falling back to the original fixed days when the
//      customer base is too small to trust a percentile.
//   2. The per-customer cadence math (already used for a binary "churned"
//      call) is now also fed into the coarse score as a soft early-warning
//      point for customers stretching past their own usual gap without
//      yet clearing the harder churn bar.
//   3. The revenue forecast was a single deterministic straight-line
//      number with no stated confidence. It now reports R² (how well a
//      straight line actually explains this dataset's own history) and a
//      second, independent cross-check projection (Holt's linear
//      exponential smoothing, which — unlike OLS — weights recent months
//      more than old ones), so a diverging cross-check is visible instead
//      of hidden inside one confident-looking number.
const { monthKey, monthLabel } = require('./analytics');
const { quantile, mean, sampleVarianceAndSkew } = require('./statsUtils');
const { combinedPriceChangeImpact } = require('./diagnosticAnalytics');

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function parseDateSafe(v) {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

// Cadence-based churn inference — when a customer has no explicit
// churn_date (Customer or Entitlement never said they left), a large
// enough silence since their last purchase relative to THEIR OWN
// historical buying rhythm is itself honest evidence of churn, not a
// generic "90 days since last order" rule that treats a weekly buyer
// and an annual buyer the same way. This mirrors the "regular cadence"
// pattern-detection already used in services/monetizationDiscovery.js:
// a customer only qualifies once they've shown a stable-enough interval
// between purchases (median gap, coefficient-of-variation gated so an
// already-erratic buyer never trips it) AND the silence since their
// last purchase is at least twice that interval. Needs at least 3
// transactions (2 gaps) to say anything at all; returns null — meaning
// "no inference, fall through to the rules-based score" — otherwise.
const MIN_TXNS_FOR_CADENCE = 3;
const MAX_INTERVAL_CV = 0.75; // purchase cadence is naturally noisier than price data
const CHURN_GAP_MULTIPLIER = 2;
const MIN_RECENCY_FLOOR_DAYS = 21; // guards very-frequent buyers from tripping on a tiny gap
const CADENCE_STRETCH_FLOOR_DAYS = 10; // below this, a stretch signal isn't meaningful for any business

// Shared cadence math for a customer's transaction dates — returns null
// when there isn't enough history to say anything (fewer than
// MIN_TXNS_FOR_CADENCE transactions, or a degenerate zero/negative typical
// interval), otherwise the raw stats (typical gap, its coefficient of
// variation, and the last transaction date) that both the hard churn call
// and the softer "stretching past normal" early-warning signal are built
// from — one computation, two uses, so they can never disagree with each
// other about what this customer's "normal" looks like.
function cadenceStats(txnDates) {
  if (!txnDates || txnDates.length < MIN_TXNS_FOR_CADENCE) return null;
  const sorted = [...txnDates].sort((a, b) => a - b);
  const gaps = [];
  for (let i = 1; i < sorted.length; i += 1) {
    gaps.push((sorted[i] - sorted[i - 1]) / MS_PER_DAY);
  }
  const typicalIntervalDays = quantile([...gaps].sort((a, b) => a - b), 0.5);
  if (!typicalIntervalDays || typicalIntervalDays <= 0) return null;

  const gapMean = mean(gaps);
  const { std } = sampleVarianceAndSkew(gaps);
  const cv = std !== null && gapMean ? std / Math.abs(gapMean) : null;

  return { typicalIntervalDays, cv, lastTxnDate: sorted[sorted.length - 1] };
}

function inferCadenceChurn(stats, now) {
  if (!stats || stats.cv === null || stats.cv > MAX_INTERVAL_CV) return null;
  const recencyDays = Math.round((now - stats.lastTxnDate) / MS_PER_DAY);
  const threshold = Math.max(stats.typicalIntervalDays * CHURN_GAP_MULTIPLIER, MIN_RECENCY_FLOOR_DAYS);
  if (recencyDays < threshold) return null;
  return { typicalIntervalDays: Math.round(stats.typicalIntervalDays), threshold: Math.round(threshold) };
}

// Dataset-relative recency thresholds — a customer going quiet for 90 days
// means something very different for a weekly-cadence retailer than for an
// annual B2B renewal business. Derived from the median and 75th percentile
// of THIS dataset's own recency distribution among customers who haven't
// already churned (so a long tail of past churns doesn't drag the cutoffs
// up for everyone still active) — the same "relative to this business's
// own rhythm" principle cadenceStats() already applies per-customer,
// applied dataset-wide for the coarse score. Falls back to the original
// fixed 90/180-day cutoffs when the live customer base is too small
// (under 8) to trust a percentile.
const MIN_SAMPLES_FOR_ADAPTIVE_THRESHOLDS = 8;
const FALLBACK_MEDIUM_RECENCY_DAYS = 90;
const FALLBACK_HIGH_RECENCY_DAYS = 180;
const MIN_ADAPTIVE_MEDIUM_DAYS = 7; // never treat under a week of silence as "gone quiet"

function computeRecencyThresholds(liveRecencies) {
  if (liveRecencies.length < MIN_SAMPLES_FOR_ADAPTIVE_THRESHOLDS) {
    return { medium: FALLBACK_MEDIUM_RECENCY_DAYS, high: FALLBACK_HIGH_RECENCY_DAYS, adaptive: false };
  }
  const sorted = [...liveRecencies].sort((a, b) => a - b);
  const medium = Math.max(MIN_ADAPTIVE_MEDIUM_DAYS, quantile(sorted, 0.5));
  const high = Math.max(medium + 1, quantile(sorted, 0.75));
  return { medium, high, adaptive: true };
}

// High-value cutoff (top quartile of dataset-wide customer revenue, among
// customers with any revenue at all) — not a churn-risk factor by itself
// (a big spender isn't more "at risk"), but flags which at-risk customers
// are worth calling first. Same >=8-sample floor as the recency thresholds
// so a handful of customers doesn't produce a meaningless quartile.
const HIGH_VALUE_QUANTILE = 0.75;

// Per-customer feature layer: tenure (from acquisition_date when present,
// else the customer's earliest transaction — the same honest fallback
// the roadmap doc calls out as "workable but fragile"), recency (days
// since last transaction), frequency (transaction count), monetary
// (total revenue), and a 0-and-up rules-based churn-risk score built
// from recency (against this dataset's own adaptive thresholds), the
// optional auto_renew field, entitlement status, transaction frequency,
// and a soft cadence-stretch signal. A customer with a populated
// churn_date is already gone — reported as 'Churned', not scored. A
// customer with neither transactions nor entitlements gets 'Insufficient
// data' rather than a fabricated risk band.
function buildCustomerFeatures(customerRows, transactionRows, entitlementRows, now = new Date()) {
  const txnByCustomer = {};
  transactionRows.forEach((t) => {
    if (!t || !t.customer_id) return;
    txnByCustomer[t.customer_id] = txnByCustomer[t.customer_id] || [];
    txnByCustomer[t.customer_id].push(t);
  });
  const entByCustomer = {};
  entitlementRows.forEach((e) => {
    if (!e || !e.customer_id) return;
    entByCustomer[e.customer_id] = entByCustomer[e.customer_id] || [];
    entByCustomer[e.customer_id].push(e);
  });

  // Pass 1: basic per-customer features that don't depend on the rest of
  // the dataset. The churn-risk score itself is deferred to pass 2 below —
  // it needs to know how "normal" a given recency gap is relative to this
  // dataset first, which can't be known until every customer's recency has
  // been computed.
  const basics = customerRows.filter((c) => c && c.customer_id).map((c) => {
    const txns = txnByCustomer[c.customer_id] || [];
    const ents = entByCustomer[c.customer_id] || [];

    const txnDates = txns.map((t) => parseDateSafe(t.timestamp)).filter(Boolean);
    const acquisitionDate = parseDateSafe(c.acquisition_date);
    const firstTxnDate = txnDates.length ? new Date(Math.min(...txnDates.map((d) => d.getTime()))) : null;
    const tenureSource = acquisitionDate || firstTxnDate;
    const tenureDays = tenureSource ? Math.max(0, Math.round((now - tenureSource) / MS_PER_DAY)) : null;

    const lastTxnDate = txnDates.length ? new Date(Math.max(...txnDates.map((d) => d.getTime()))) : null;
    const recencyDays = lastTxnDate ? Math.round((now - lastTxnDate) / MS_PER_DAY) : null;

    const frequency = txns.length;
    const monetary = txns.reduce((s, t) => s + (Number(t.amount) || 0), 0);

    const churnDate = parseDateSafe(c.churn_date);
    const autoRenewValues = ents.map((e) => String((e || {}).auto_renew || '').trim().toLowerCase()).filter(Boolean);
    const autoRenewsOff = autoRenewValues.some((v) => ['no', 'false', '0', 'n'].includes(v));
    const hasActiveEntitlement = ents.some((e) => {
      const status = String((e || {}).status || '').trim().toLowerCase();
      return status.includes('active') && !status.includes('inactive');
    });
    const hasExpiredOrCancelled = ents.some((e) => {
      const status = String((e || {}).status || '').trim().toLowerCase();
      return status.includes('expire') || status.includes('cancel') || status.includes('suspend');
    });

    return {
      customerId: c.customer_id,
      name: c.name || c.customer_id,
      tenureDays,
      recencyDays,
      frequency,
      monetary,
      autoRenewsOff,
      churnDate,
      hasEntitlements: ents.length > 0,
      hasActiveEntitlement,
      hasExpiredOrCancelled,
      cadence: cadenceStats(txnDates),
    };
  });

  const liveRecencies = basics.filter((b) => !b.churnDate && b.recencyDays !== null).map((b) => b.recencyDays);
  const thresholds = computeRecencyThresholds(liveRecencies);
  const monetaryValues = basics.map((b) => b.monetary).filter((m) => m > 0).sort((a, b) => a - b);
  const highValueCutoff = monetaryValues.length >= MIN_SAMPLES_FOR_ADAPTIVE_THRESHOLDS
    ? quantile(monetaryValues, HIGH_VALUE_QUANTILE)
    : null;

  // Pass 2: score each customer against the dataset-relative thresholds
  // computed above.
  return basics.map((b) => {
    let churnRiskScore = null;
    let churnRiskBand = 'Insufficient data';
    let churnInferred = false;
    let cadenceIntervalDays = null;
    let cadenceStretch = false;

    if (b.churnDate) {
      churnRiskBand = 'Churned';
    } else {
      // An active Entitlement on file is stronger, more authoritative
      // evidence than a transaction-timing gap — same "confirmed always
      // wins over inferred" rule Feature 1 uses for price changes. A
      // customer can go quiet for legitimate reasons (annual plan mid-
      // term, a usage lull) while still being an active subscriber; only
      // infer churn (hard or soft) from cadence when there's nothing on
      // file actively contradicting it.
      const cadenceChurn = b.hasActiveEntitlement ? null : inferCadenceChurn(b.cadence, now);
      if (cadenceChurn) {
        churnRiskBand = 'Churned';
        churnInferred = true;
        cadenceIntervalDays = cadenceChurn.typicalIntervalDays;
      } else if (b.recencyDays !== null || b.hasEntitlements) {
        churnRiskScore = 0;
        if (b.recencyDays !== null && b.recencyDays > thresholds.high) churnRiskScore += 2;
        else if (b.recencyDays !== null && b.recencyDays > thresholds.medium) churnRiskScore += 1;
        if (b.autoRenewsOff) churnRiskScore += 2;
        if (b.hasExpiredOrCancelled && !b.hasActiveEntitlement) churnRiskScore += 2;
        if (b.frequency === 1) churnRiskScore += 1;

        // Early warning: this customer doesn't (yet) clear the harder
        // 2x-cadence-gap bar for an inferred churn call, but they're
        // already running later than their own usual gap between
        // purchases — worth a soft point now rather than staying silent
        // on it until the harder rule fires, possibly too late to act on.
        if (b.cadence && b.cadence.cv !== null && b.cadence.cv <= MAX_INTERVAL_CV) {
          const stretchFloor = Math.max(b.cadence.typicalIntervalDays, CADENCE_STRETCH_FLOOR_DAYS);
          const recencyFromLastTxn = Math.round((now - b.cadence.lastTxnDate) / MS_PER_DAY);
          if (recencyFromLastTxn >= stretchFloor) {
            churnRiskScore += 1;
            cadenceStretch = true;
          }
        }

        churnRiskBand = churnRiskScore >= 4 ? 'High' : churnRiskScore >= 2 ? 'Medium' : 'Low';
      }
    }

    let lifecycleStage = 'Unclassified';
    if (b.churnDate || churnInferred) lifecycleStage = 'Churned';
    else if (b.tenureDays !== null && b.tenureDays <= 30) lifecycleStage = 'New';
    else if (b.hasActiveEntitlement || (b.recencyDays !== null && b.recencyDays <= 90)) lifecycleStage = 'Active';
    else if (b.recencyDays !== null && b.recencyDays > 90) lifecycleStage = 'At risk';

    return {
      customerId: b.customerId,
      name: b.name,
      tenureDays: b.tenureDays,
      recencyDays: b.recencyDays,
      frequency: b.frequency,
      monetary: b.monetary,
      autoRenewsOff: b.autoRenewsOff,
      churnDate: b.churnDate,
      churnRiskScore,
      churnRiskBand,
      churnInferred,
      cadenceIntervalDays,
      cadenceStretch,
      highValue: highValueCutoff !== null && b.monetary >= highValueCutoff,
      lifecycleStage,
      recencyThresholds: thresholds,
    };
  });
}

function churnRiskDistribution(features) {
  const counts = {};
  features.forEach((f) => { counts[f.churnRiskBand] = (counts[f.churnRiskBand] || 0) + 1; });
  const order = ['Low', 'Medium', 'High', 'Churned', 'Insufficient data'];
  return order.filter((k) => counts[k]).map((label) => ({ label, value: counts[label], isOther: label === 'Insufficient data' }));
}

function lifecycleStageDistribution(features) {
  const counts = {};
  features.forEach((f) => { counts[f.lifecycleStage] = (counts[f.lifecycleStage] || 0) + 1; });
  const order = ['New', 'Active', 'At risk', 'Churned', 'Unclassified'];
  return order.filter((k) => counts[k]).map((label) => ({ label, value: counts[label], isOther: label === 'Unclassified' }));
}

// Coefficient of determination for the OLS fit — how much of the
// month-to-month variation in revenue the straight line actually explains,
// on the dataset's own history (0 = no better than the flat mean, 1 =
// perfect fit). Reported alongside every forecast so "how much should I
// trust this projection" is an explicit number, not implied confidence.
// Null when history is perfectly flat (ssTot = 0) — a horizontal "trend"
// technically fits itself but the statistic says nothing useful there.
function computeR2(xs, ys, slope, intercept) {
  const yMean = mean(ys);
  if (yMean === null) return null;
  let ssRes = 0;
  let ssTot = 0;
  for (let i = 0; i < xs.length; i += 1) {
    const yPred = intercept + slope * xs[i];
    ssRes += (ys[i] - yPred) ** 2;
    ssTot += (ys[i] - yMean) ** 2;
  }
  if (ssTot === 0) return null;
  return Math.max(0, 1 - ssRes / ssTot);
}

// Holt's linear (double exponential smoothing) — a standard, still fully
// transparent step up from a single straight-line OLS fit: instead of
// weighting every month of history equally, it lets the level and trend
// adapt toward whatever has happened most recently, which is exactly what
// a pure OLS line can miss (a recent acceleration or slowdown gets
// averaged away by months from a year ago). The smoothing weights (alpha
// for the level, beta for the trend) are picked from a small, fixed grid
// by whichever combination best explains this dataset's OWN history
// (lowest one-step-ahead squared error) — no external tuning or opaque
// hyperparameters, still traceable to "a handful of standard smoothing
// weights were tried and the one that fit your own numbers best was kept."
// Needs at least 4 months of history (one more than OLS) since the first
// two points are consumed just to seed a starting level and trend before
// any fit error can be measured; returns null otherwise.
const HOLT_MIN_MONTHS = 4;
const HOLT_GRID = [0.2, 0.4, 0.6, 0.8];

function holtLinearForecast(values, monthsAhead, projectMonth) {
  if (!values || values.length < HOLT_MIN_MONTHS) return null;

  let best = null;
  HOLT_GRID.forEach((alpha) => {
    HOLT_GRID.forEach((beta) => {
      let level = values[0];
      let trendComp = values[1] - values[0];
      let sse = 0;
      for (let i = 1; i < values.length; i += 1) {
        const forecastVal = level + trendComp;
        sse += (values[i] - forecastVal) ** 2;
        const newLevel = alpha * values[i] + (1 - alpha) * (level + trendComp);
        const newTrend = beta * (newLevel - level) + (1 - beta) * trendComp;
        level = newLevel;
        trendComp = newTrend;
      }
      if (!best || sse < best.sse) best = { alpha, beta, sse, level, trendComp };
    });
  });
  if (!best) return null;

  const projections = [];
  for (let i = 1; i <= monthsAhead; i += 1) {
    const value = Math.max(0, best.level + i * best.trendComp);
    const key = projectMonth(i);
    projections.push({ key, label: monthLabel(key), value });
  }

  return { alpha: best.alpha, beta: best.beta, projections };
}

// ---------------------------------------------------------------------
// Round 20 — Holt-Winters/ETS as a third forecasting method, plus a real
// backtested accuracy comparison (MAE/RMSE/MAPE) across every method that
// ran, and 80% prediction intervals on the primary OLS projection.
//
// ARIMA was deliberately NOT implemented here. The user's own spec asked
// for Linear -> Holt -> Holt-Winters/ETS -> ARIMA; this app has no ML/
// stats library (every forecast method, including this one, is
// hand-written plain JS — see this file's own header and the diagnostic
// engine's matching honesty policy), and a trustworthy ARIMA needs a real
// parameter-estimation procedure (maximum likelihood or at minimum
// Yule-Walker equations plus a differencing/stationarity check) that a
// fixed smoothing-weight grid search cannot substitute for. A hand-rolled
// ARIMA without that machinery would be exactly the kind of numerically
// shaky approximation this codebase has consistently refused to ship
// elsewhere (see e.g. diagnosticEngine.js's own reasoning for using a
// chi-square critical-value TABLE instead of a hand-rolled regularized
// incomplete gamma function). Holt-Winters is the honest stopping point:
// still a standard, well-understood method with a closed-form update, no
// iterative optimizer required — the same "real, textbook-exact method,
// or explicitly excluded and say why" discipline used throughout this
// app rather than shipping a fourth method on shakier ground.
// ---------------------------------------------------------------------
const HW_SEASON_LENGTH = 12;
const HW_GRID = [0.2, 0.4, 0.6, 0.8];

// Holt-Winters (additive) triple exponential smoothing. Gated on real
// data sufficiency, not just "enough to run the formula without
// crashing": a trustworthy seasonal fit needs at least 2 full cycles of
// history — the same "two-plus full seasonal cycles" threshold already
// used elsewhere in this app to justify NOT implementing STL
// decomposition (see claude/dynamic-diagnostic-analytics.md's platform-
// performance evaluation). With monthly data and a 12-month seasonal
// period, that's >=24 months; a shorter dataset (Olist's own ~20 months
// included) correctly returns null rather than fitting a seasonal
// component to a single cycle, which would just be curve-fitting noise,
// not detecting real seasonality.
function holtWintersForecast(values, monthsAhead, projectMonth, seasonLength = HW_SEASON_LENGTH) {
  const n = values.length;
  if (!values || n < seasonLength * 2) return null;

  // Simple additive initialization (average method): level/trend seeded
  // from the first two seasons' means; each of the first season's
  // seasonal components is that month's own deviation from the first
  // season's mean. A more elaborate multi-cycle-averaged initialization
  // exists in the literature, but with only 2 cycles typically available
  // right at this function's own data-sufficiency gate, this simpler,
  // fully traceable version is the honest choice for the amount of
  // history this app's SME datasets actually have.
  const firstSeason = values.slice(0, seasonLength);
  const secondSeason = values.slice(seasonLength, seasonLength * 2);
  const firstMean = mean(firstSeason);
  const secondMean = mean(secondSeason);
  const initLevel = firstMean;
  const initTrend = (secondMean - firstMean) / seasonLength;
  const initSeasonal = firstSeason.map((v) => v - firstMean);

  let best = null;
  HW_GRID.forEach((alpha) => {
    HW_GRID.forEach((beta) => {
      HW_GRID.forEach((gamma) => {
        let level = initLevel;
        let trendComp = initTrend;
        const seasonal = [...initSeasonal];
        let sse = 0;
        for (let t = seasonLength; t < n; t += 1) {
          const sIdx = t % seasonLength;
          const prevSeasonal = seasonal[sIdx];
          const forecastVal = level + trendComp + prevSeasonal;
          sse += (values[t] - forecastVal) ** 2;
          const newLevel = alpha * (values[t] - prevSeasonal) + (1 - alpha) * (level + trendComp);
          const newTrend = beta * (newLevel - level) + (1 - beta) * trendComp;
          const newSeasonal = gamma * (values[t] - newLevel) + (1 - gamma) * prevSeasonal;
          seasonal[sIdx] = newSeasonal;
          level = newLevel;
          trendComp = newTrend;
        }
        if (!best || sse < best.sse) {
          best = {
            alpha, beta, gamma, sse, level, trendComp, seasonal,
          };
        }
      });
    });
  });
  if (!best) return null;

  const projections = [];
  for (let i = 1; i <= monthsAhead; i += 1) {
    const sIdx = (n + i - 1) % seasonLength;
    const value = Math.max(0, best.level + i * best.trendComp + best.seasonal[sIdx]);
    const key = projectMonth(i);
    projections.push({ key, label: monthLabel(key), value });
  }

  return {
    alpha: best.alpha, beta: best.beta, gamma: best.gamma, seasonLength, projections,
  };
}

// --- Backtested accuracy (MAE/RMSE/MAPE) across every method ----------
// Holds out this dataset's own most recent 1-3 months, fits each method
// on everything before that, forecasts forward, and compares against
// what actually happened — a genuine out-of-sample accuracy check, not
// an in-sample fit statistic like R² (which can look good even when a
// model would have forecast badly).
function olsForecastValues(ys, h) {
  const n = ys.length;
  const xs = ys.map((_, i) => i);
  const xMean = mean(xs);
  const yMean = mean(ys);
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i += 1) {
    num += (xs[i] - xMean) * (ys[i] - yMean);
    den += (xs[i] - xMean) ** 2;
  }
  const slope = den !== 0 ? num / den : 0;
  const intercept = yMean - slope * xMean;
  const out = [];
  for (let i = 1; i <= h; i += 1) out.push(Math.max(0, intercept + slope * (n - 1 + i)));
  return out;
}

// projectMonth is irrelevant to a values-only accuracy check (labels are
// discarded), so a cheap stub is passed to the existing Holt/Holt-Winters
// implementations rather than duplicating their smoothing logic.
const STUB_PROJECT_MONTH = (i) => `stub-${i}`;

// MAPE is a textbook-known-unstable statistic near a zero (or
// near-zero) actual value: a single sparse/partial month (real SME
// datasets often have one — an upload's first or last calendar month is
// frequently incomplete) can produce a percentage error in the
// thousands, which would read as an alarming, misleading number rather
// than a meaningful one. Standard practice (and this app's own "never
// show a number that would mislead" discipline) is to exclude a held-out
// point from the MAPE average when its actual value is small relative to
// the series' own typical scale, and rely on MAE/RMSE for that point
// instead — MAE and RMSE are computed over every point regardless, so
// nothing is hidden, only MAPE's own denominator problem is worked
// around. `scale` is this dataset's own mean absolute value over the
// TRAINING window (never the held-out actuals themselves, which would be
// circular), and a point only counts toward MAPE when its actual is at
// least 5% of that scale.
function accuracyMetrics(actual, predicted, scale = null) {
  if (!actual || !predicted || actual.length !== predicted.length || actual.length === 0) return null;
  const n = actual.length;
  const minActualForMape = scale && scale > 0 ? scale * 0.05 : 0;
  let sae = 0;
  let sse = 0;
  let sape = 0;
  let apeCount = 0;
  let excludedFromMape = 0;
  for (let i = 0; i < n; i += 1) {
    const err = actual[i] - predicted[i];
    sae += Math.abs(err);
    sse += err ** 2;
    if (Math.abs(actual[i]) > minActualForMape) {
      sape += Math.abs(err / actual[i]);
      apeCount += 1;
    } else if (actual[i] !== 0) {
      excludedFromMape += 1;
    }
  }
  return {
    mae: sae / n, rmse: Math.sqrt(sse / n), mape: apeCount > 0 ? (sape / apeCount) * 100 : null, n, excludedFromMape,
  };
}

const BACKTEST_MAX_HOLDOUT = 3;

function backtestForecastMethods(values) {
  const n = values.length;
  const holdoutSize = Math.min(BACKTEST_MAX_HOLDOUT, Math.max(1, Math.floor(n / 4)));
  const trainLen = n - holdoutSize;
  if (trainLen < 3 || holdoutSize < 1) return { holdoutSize: 0, trainLen: n, ols: null, holt: null, holtWinters: null };
  const train = values.slice(0, trainLen);
  const actual = values.slice(trainLen);
  const scale = mean(train.map((v) => Math.abs(v)));

  const ols = accuracyMetrics(actual, olsForecastValues(train, holdoutSize), scale);

  let holt = null;
  if (train.length >= HOLT_MIN_MONTHS) {
    const holtResult = holtLinearForecast(train, holdoutSize, STUB_PROJECT_MONTH);
    if (holtResult) holt = accuracyMetrics(actual, holtResult.projections.map((p) => p.value), scale);
  }

  let holtWinters = null;
  if (train.length >= HW_SEASON_LENGTH * 2) {
    const hwResult = holtWintersForecast(train, holdoutSize, STUB_PROJECT_MONTH);
    if (hwResult) holtWinters = accuracyMetrics(actual, hwResult.projections.map((p) => p.value), scale);
  }

  return {
    holdoutSize, trainLen, ols, holt, holtWinters,
  };
}

// Plain-language reliability note shown next to the forecast — states
// how well the straight line fits this dataset's own history (via R²),
// whether the Holt/Holt-Winters cross-checks are available and agree on
// the near-term number, and what the out-of-sample backtest found. This
// is the direct answer to "is a linear-trend forecast sufficient": rather
// than quietly assuming yes, the app now says how sufficient it is, every
// time — including reporting a real backtested error, not just a fit
// statistic.
const DIVERGENCE_FLAG_PCT = 20;

function buildReliabilityNote(r2, olsProjections, holt, holtWinters, validation) {
  if (r2 === null) return null;
  let fitNote;
  if (r2 >= 0.7) fitNote = `the trend line explains this dataset's own history closely (R² = ${r2.toFixed(2)})`;
  else if (r2 >= 0.4) fitNote = `the trend line explains this dataset's own history only moderately (R² = ${r2.toFixed(2)}) — treat the projection as directional, not precise`;
  else fitNote = `the trend line explains this dataset's own history weakly (R² = ${r2.toFixed(2)}) — history is noisy or non-linear, so treat this as a rough range rather than a point estimate`;
  const capitalized = `${fitNote.charAt(0).toUpperCase()}${fitNote.slice(1)}.`;

  let note = capitalized;

  if (holt && olsProjections && olsProjections.length && holt.projections.length) {
    const olsFirst = olsProjections[0].value;
    const holtFirst = holt.projections[0].value;
    const base = Math.max(Math.abs(olsFirst), Math.abs(holtFirst), 1);
    const diffPct = (Math.abs(olsFirst - holtFirst) / base) * 100;
    note += diffPct > DIVERGENCE_FLAG_PCT
      ? " A recent-momentum cross-check (Holt's linear smoothing) diverges meaningfully for next month, suggesting a shift the straight trend line hasn't caught up to yet — treat the forecast as a range rather than one number."
      : ' A recent-momentum cross-check agrees closely with the straight-line projection.';
  }

  note += holtWinters
    ? ' A seasonal (Holt-Winters) cross-check was also fit, since this dataset has at least two full 12-month cycles of history.'
    : " A seasonal (Holt-Winters) model was not fit — this dataset doesn't yet have at least two full 12-month cycles of history to estimate a seasonal pattern reliably (fitting one on a single cycle would just curve-fit noise, not detect real seasonality).";

  if (validation && validation.holdoutSize > 0 && validation.ols) {
    const errStr = validation.ols.mape !== null ? `${validation.ols.mape.toFixed(1)}% (MAPE)` : `${validation.ols.mae.toFixed(0)} (MAE)`;
    note += ` Backtested on this dataset's own most recent ${validation.holdoutSize} month(s) held out (never seen while fitting): the straight-line trend's forecast missed by ${errStr} on average.`;
    if (validation.holt) {
      const holtErrStr = validation.holt.mape !== null ? `${validation.holt.mape.toFixed(1)}%` : `${validation.holt.mae.toFixed(0)}`;
      note += ` Holt's linear smoothing missed by ${holtErrStr}${validation.holt.mape !== null ? ' (MAPE)' : ' (MAE)'} over the same held-out months.`;
    }
    if (validation.holtWinters) {
      const hwErrStr = validation.holtWinters.mape !== null ? `${validation.holtWinters.mape.toFixed(1)}%` : `${validation.holtWinters.mae.toFixed(0)}`;
      note += ` Holt-Winters missed by ${hwErrStr}${validation.holtWinters.mape !== null ? ' (MAPE)' : ' (MAE)'}.`;
    }
  }

  return note;
}

// Revenue forecast — ordinary least squares fit over (month index ->
// revenue), projected monthsAhead forward, PLUS an R² fit-quality score
// and an independent Holt's-linear-smoothing cross-check (see above).
// Deliberately still the simplest defensible primary method, not a
// time-series model: a DIT prototype's forecast needs to show exactly how
// a number was produced, in one sentence, to a non-technical SME owner —
// the cross-check and R² answer "how much should I trust it" without
// turning the primary method into a black box. Needs at least 3 months of
// trend data; returns null otherwise rather than projecting from too
// little history.
function revenueForecast(trend, monthsAhead = 3) {
  if (!trend || trend.length < 3) return null;
  const n = trend.length;
  const xs = trend.map((_, i) => i);
  const ys = trend.map((p) => p.value);
  const xMean = mean(xs);
  const yMean = mean(ys);
  let num = 0; let den = 0;
  for (let i = 0; i < n; i += 1) {
    num += (xs[i] - xMean) * (ys[i] - yMean);
    den += (xs[i] - xMean) ** 2;
  }
  const slope = den !== 0 ? num / den : 0;
  const intercept = yMean - slope * xMean;
  const r2 = computeR2(xs, ys, slope, intercept);

  const [lastY, lastM] = trend[n - 1].key.split('-').map(Number);
  const projectMonth = (i) => {
    let y = lastY; let m = lastM + i;
    while (m > 12) { m -= 12; y += 1; }
    return `${y}-${String(m).padStart(2, '0')}`;
  };

  // 80% OLS prediction intervals — a textbook formula (SE = s * sqrt(1 +
  // 1/n + (x0-xMean)^2/Sxx)), widening the further out a projection goes,
  // computed from THIS dataset's own residuals — never a fixed +/-X% band
  // applied uniformly. s (residualSe) is the same residual standard error
  // computeR2() already implicitly uses via ssRes, recomputed once here
  // alongside Sxx (den, already in scope) rather than duplicating den's
  // computation.
  let ssRes = 0;
  for (let i = 0; i < n; i += 1) {
    const yPred = intercept + slope * xs[i];
    ssRes += (ys[i] - yPred) ** 2;
  }
  const residualSe = Math.sqrt(ssRes / Math.max(1, n - 2));
  const Z_80 = 1.2816;

  const projections = [];
  for (let i = 1; i <= monthsAhead; i += 1) {
    const idx = n - 1 + i;
    const value = Math.max(0, intercept + slope * idx);
    const key = projectMonth(i);
    let intervalLow = null;
    let intervalHigh = null;
    if (den > 0) {
      const se = residualSe * Math.sqrt(1 + (1 / n) + ((idx - xMean) ** 2) / den);
      intervalLow = Math.max(0, value - Z_80 * se);
      intervalHigh = value + Z_80 * se;
    }
    projections.push({
      key, label: monthLabel(key), value, intervalLow, intervalHigh,
    });
  }

  const holt = holtLinearForecast(ys, monthsAhead, projectMonth);
  const holtWinters = holtWintersForecast(ys, monthsAhead, projectMonth);
  const validation = backtestForecastMethods(ys);

  return {
    slope,
    r2,
    growthRatePct: yMean !== 0 ? (slope / Math.abs(yMean)) * 100 : 0,
    historyMonths: n,
    projections,
    crossCheck: holt,
    holtWinters,
    validation,
    predictionIntervalLevel: 0.80,
    reliabilityNote: buildReliabilityNote(r2, projections, holt, holtWinters, validation),
  };
}

// --- What-if scenario: price change --------------------------------
// The one lever the SME owner asked this tool to expose: "if I changed
// this product's price by X%, what would happen to revenue?" — shown as
// baseline vs. scenario, never the scenario alone, so the owner always
// sees exactly what's being compared against what.
//
// Every product with at least one transaction can be picked; the
// dropdown lists them by total revenue (dataset-wide, whole history) so
// the SME owner sees their biggest products first.
function listWhatIfProducts(transactionRows) {
  const totals = {};
  (transactionRows || []).forEach((t) => {
    const product = String((t || {}).product_service || '').trim();
    if (!product) return;
    totals[product] = (totals[product] || 0) + (Number(t.amount) || 0);
  });
  return Object.entries(totals)
    .sort((a, b) => b[1] - a[1])
    .map(([product]) => product);
}

// Elasticity used for the projection, in order of how much it's grounded
// in THIS dataset's own evidence — the same "confirmed/inferred/nothing,
// never fabricated" ladder Feature 1's price-impact table already shows,
// just with an explicit third rung ("no evidence yet, so assume flat
// volume") since a what-if is inherently hypothetical and needs to
// produce *something* rather than block the whole feature on missing
// history:
//   1. This product's own detected price-change elasticity (confirmed
//      MonetizationConfig read, or the transaction-inferred fallback).
//   2. Failing that, the dataset-wide average elasticity across every
//      OTHER product that has one.
//   3. Failing that, no elasticity evidence exists anywhere in this
//      dataset yet — the projection assumes volume holds flat (a price
//      change flows straight through to revenue with no demand
//      response) and says so plainly rather than guessing a textbook
//      number.
function resolveElasticityForProduct(transactionRows, monetizationRows, product) {
  const impacts = combinedPriceChangeImpact(transactionRows, monetizationRows);
  const ownImpact = impacts.find((i) => i.product === product && i.elasticity !== null);
  if (ownImpact) {
    return {
      elasticity: ownImpact.elasticity,
      source: ownImpact.inferred ? 'product-inferred' : 'product-configured',
    };
  }
  const others = impacts.filter((i) => i.elasticity !== null);
  if (others.length > 0) {
    const avg = others.reduce((s, i) => s + i.elasticity, 0) / others.length;
    return { elasticity: avg, source: 'dataset-average', sampleSize: others.length };
  }
  return { elasticity: 0, source: 'assumed-flat' };
}

const MIN_PRICE_PCT_CHANGE = -99; // a price cut can't reach -100% (free) or below

// Baseline is this PRODUCT's own most recent calendar month with
// transaction data (not necessarily the dataset's latest month overall)
// — a sparser product still gets a real, labeled baseline instead of a
// forced zero. Revenue = price x volume, so the price lever and its
// elasticity-implied volume response compound multiplicatively, matching
// how priceChangeImpact()/elasticitySummary() already define elasticity
// (%volume change / %price change) elsewhere in the app.
function buildPriceWhatIfScenario(transactionRows, monetizationRows, { product, pricePctChange }) {
  const pct = Number(pricePctChange);
  if (!product || !Number.isFinite(pct) || pct <= MIN_PRICE_PCT_CHANGE) {
    return { available: false, reason: 'invalid-input' };
  }

  const productTxns = (transactionRows || []).filter((t) => (
    t && String(t.product_service || '').trim() === product && t.timestamp
  ));
  if (productTxns.length === 0) return { available: false, reason: 'no-history' };

  const withMonth = productTxns
    .map((t) => ({ t, key: monthKey(t.timestamp) }))
    .filter((r) => r.key);
  if (withMonth.length === 0) return { available: false, reason: 'no-history' };
  const latestMonth = withMonth.reduce((max, r) => (r.key > max ? r.key : max), withMonth[0].key);
  const baselineTxns = withMonth.filter((r) => r.key === latestMonth).map((r) => r.t);

  const baselineRevenue = baselineTxns.reduce((s, t) => s + (Number(t.amount) || 0), 0);
  const baselineVolume = baselineTxns.reduce((s, t) => s + (Number(t.quantity) > 0 ? Number(t.quantity) : 1), 0);
  if (baselineRevenue <= 0) return { available: false, reason: 'no-history' };

  const { elasticity, source, sampleSize } = resolveElasticityForProduct(transactionRows, monetizationRows, product);

  let projectedVolumePctChange = elasticity * pct;
  if (projectedVolumePctChange < -100) projectedVolumePctChange = -100; // volume floors at zero
  const projectedVolume = baselineVolume * (1 + projectedVolumePctChange / 100);
  const projectedRevenue = baselineRevenue * (1 + pct / 100) * (1 + projectedVolumePctChange / 100);
  const revenueDelta = projectedRevenue - baselineRevenue;
  const revenueDeltaPct = baselineRevenue !== 0 ? (revenueDelta / baselineRevenue) * 100 : null;

  const baselineUnitPrice = baselineVolume > 0 ? baselineRevenue / baselineVolume : null;
  const scenarioUnitPrice = baselineUnitPrice !== null ? baselineUnitPrice * (1 + pct / 100) : null;

  return {
    available: true,
    product,
    baselineMonthKey: latestMonth,
    baselineMonthLabel: monthLabel(latestMonth),
    pricePctChange: pct,
    elasticity,
    elasticitySource: source,
    elasticitySampleSize: sampleSize || null,
    baseline: {
      revenue: baselineRevenue, volume: baselineVolume, unitPrice: baselineUnitPrice,
    },
    scenario: {
      revenue: projectedRevenue, volume: projectedVolume, unitPrice: scenarioUnitPrice,
    },
    volumePctChange: projectedVolumePctChange,
    revenueDelta,
    revenueDeltaPct,
  };
}

module.exports = {
  buildCustomerFeatures,
  churnRiskDistribution,
  lifecycleStageDistribution,
  revenueForecast,
  listWhatIfProducts,
  buildPriceWhatIfScenario,
  // Exported for services/predictiveAnalyticsDynamic.js — the fact-table-
  // native sibling of this file's canonical-schema engine. Both need to
  // score a customer's purchase cadence and this dataset's own adaptive
  // recency thresholds the exact same way, so those small helpers are
  // shared from here rather than re-implemented (this codebase has a
  // documented history of that kind of logic drifting between copies).
  cadenceStats,
  inferCadenceChurn,
  computeRecencyThresholds,
  MIN_SAMPLES_FOR_ADAPTIVE_THRESHOLDS,
  HIGH_VALUE_QUANTILE,
  // Round 20 — exported for unit testing and reuse (e.g. by services/
  // predictiveAnalyticsDynamic.js's own revenue forecast, which already
  // calls the unmodified revenueForecast() above and picks up all of
  // these automatically; exported individually too in case a future
  // caller wants just the backtest or just Holt-Winters on its own).
  holtWintersForecast,
  backtestForecastMethods,
  accuracyMetrics,
};
