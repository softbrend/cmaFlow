// Predictive Analytics — fact-table-native engine.
//
// services/predictiveAnalytics.js's churn score, lifecycle stage, revenue
// forecast, and price what-if scenario are all built on the CMA Canonical
// Schema's Customer/Transaction/Entitlement/MonetizationConfig entities —
// which only exist once a dataset has been through Map & Transform, mapped
// EXPLICITLY enough to link a customer id onto every transaction. A great
// many real datasets (a single order_items-style export, a POS export, a
// subscription-billing CSV) already carry everything these four questions
// need in ONE flat fact table — the same one services/metricRegistry.js
// and services/diagnosticEngine.js already read directly, without waiting
// for Map & Transform. This module answers the same four predictive
// questions straight from that fact table (via services/
// fullDescriptiveAnalytics.js's buildBusinessContext()), so Predictive
// Analytics can be genuinely useful on a dataset the SME owner just
// uploaded, the same "dynamic" spirit as the Dynamic Diagnostics tab and
// the Business Descriptive Summary.
//
// Every function here degrades honestly: a question this fact table
// genuinely doesn't carry the columns for (no customer identifier on the
// order-line file itself, e.g. Olist's order_items.csv — customer_id
// lives on the separate orders.csv) returns applicable:false with a plain-
// language reason, never a fabricated number. This mirrors the same
// "confirmed always wins over inferred, nothing is ever guessed" ladder
// services/predictiveAnalytics.js's canonical engine already uses.
const {
  findRoleColumn, findRevenueColumn, revenueFallbackNote, resolveCategoryColumn, monthKeyOf, titleize, resolveGeo,
  resolveCatalogPrice,
} = require('./metricRegistry');
const { tryParseNumber, BOOL_TRUE, BOOL_FALSE } = require('./datasetProfiler');
const { monthLabel } = require('./analytics');
const {
  cadenceStats, inferCadenceChurn, computeRecencyThresholds, MIN_SAMPLES_FOR_ADAPTIVE_THRESHOLDS, HIGH_VALUE_QUANTILE,
} = require('./predictiveAnalytics');
const { quantile } = require('./statsUtils');
// Round 20 — delivery-delay risk and review-score outlook reuse the SAME
// column-detection and statistical primitives services/diagnosticEngine.js
// already built and verified (computeRowDelays' estimated/actual date-pair
// detection, worstRateGroup's rate-comparison logic, explainBinaryFactorsFor
// /explainFactorsFor's chi-square/Cohen's-d/correlation machinery) rather
// than a second, independently-maintained copy — see diagnosticEngine.js's
// own header on this codebase's documented history of that kind of drift.
const {
  computeRowDelays, worstRateGroup, findRatingColumn, findCategoryColumn, dimensionLabelAccessor,
  findByNamePattern, FREIGHT_NAME_RE, explainBinaryFactorsFor, explainFactorsFor,
} = require('./diagnosticEngine');

function parseDateSafe(v) {
  if (v === null || v === undefined || v === '') return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

// ---------------------------------------------------------------------
// Customer risk + lifecycle stage — the same recency/frequency/cadence
// rules services/predictiveAnalytics.js already uses for a customer with
// no Entitlement data on file (that's exactly what a customer_id straight
// off a fact table amounts to: transaction history, nothing else), just
// grouped directly off this dataset's own fact rows instead of a
// separately-mapped canonical Transaction table. Needs the fact table to
// carry BOTH a customer identifier and a date column on the SAME row —
// when the two live on different uploaded files (Olist's order_items.csv
// has no customer_id at all; it's on the sibling orders.csv), this is
// correctly reported as not applicable rather than guessed at.
const MS_PER_DAY = 24 * 60 * 60 * 1000;

function buildDynamicCustomerFeatures(ctx, now = new Date()) {
  const customerCol = findRoleColumn(ctx.factFile, 'customer_id');
  if (!customerCol) {
    return {
      applicable: false,
      reason: `This fact table (${ctx.factFile.fileType}) doesn't carry a customer identifier column, so customer-level risk can't be computed directly from it. If a customer id lives on a different uploaded file (e.g. a separate orders/customers file), map it onto the transaction row through Map & Transform to unlock this view there instead.`,
    };
  }
  const dateCol = findRoleColumn(ctx.factFile, 'date');
  if (!dateCol) {
    return {
      applicable: false,
      reason: `This fact table (${ctx.factFile.fileType}) has a customer identifier but no date column, so recency/tenure — which every risk and lifecycle rule below depends on — can't be computed.`,
    };
  }
  const revInfo = findRevenueColumn(ctx);
  const orderIdCol = findRoleColumn(ctx.factFile, 'order_id');

  const byCustomer = new Map();
  ctx.factFile.rows.forEach((row) => {
    const custRaw = row[customerCol.name];
    if (custRaw === null || custRaw === undefined || String(custRaw).trim() === '') return;
    const custId = String(custRaw).trim();
    const date = parseDateSafe(row[dateCol.name]);
    if (!date) return;
    if (!byCustomer.has(custId)) byCustomer.set(custId, { txnDates: [], revenue: 0, orderIds: new Set(), rowCount: 0 });
    const bucket = byCustomer.get(custId);
    bucket.txnDates.push(date);
    bucket.rowCount += 1;
    if (revInfo) {
      const v = tryParseNumber(row[revInfo.col.name]);
      if (v !== null) bucket.revenue += v;
    }
    if (orderIdCol) {
      const oid = row[orderIdCol.name];
      if (oid !== null && oid !== undefined && String(oid).trim() !== '') bucket.orderIds.add(String(oid).trim());
    }
  });

  if (byCustomer.size === 0) {
    return { applicable: false, reason: `No row in this fact table has both a customer id and a parseable date, so no customer could be scored.` };
  }

  const basics = [...byCustomer.entries()].map(([customerId, b]) => {
    const sortedDates = [...b.txnDates].sort((a, c) => a - c);
    const tenureDays = Math.max(0, Math.round((now - sortedDates[0]) / MS_PER_DAY));
    const recencyDays = Math.round((now - sortedDates[sortedDates.length - 1]) / MS_PER_DAY);
    const frequency = orderIdCol ? b.orderIds.size : b.rowCount;
    return {
      customerId,
      tenureDays,
      recencyDays,
      frequency,
      monetary: revInfo ? b.revenue : null,
      cadence: cadenceStats(b.txnDates),
    };
  });

  const liveRecencies = basics.map((b) => b.recencyDays);
  const thresholds = computeRecencyThresholds(liveRecencies);
  const monetaryValues = revInfo
    ? basics.map((b) => b.monetary).filter((m) => m > 0).sort((a, c) => a - c)
    : [];
  const highValueCutoff = monetaryValues.length >= MIN_SAMPLES_FOR_ADAPTIVE_THRESHOLDS
    ? quantile(monetaryValues, HIGH_VALUE_QUANTILE)
    : null;

  const features = basics.map((b) => {
    let churnRiskScore = null;
    let churnRiskBand;
    let churnInferred = false;
    let cadenceIntervalDays = null;
    let cadenceStretch = false;

    // This fact table has no explicit churn/cancellation-date concept of
    // its own — the only evidence available is a customer going quiet far
    // longer than their own usual purchase gap, the same cadence-based
    // inference services/predictiveAnalytics.js falls back to when a
    // canonical Entitlement doesn't confirm anything either.
    const cadenceChurn = inferCadenceChurn(b.cadence, now);
    if (cadenceChurn) {
      churnRiskBand = 'Churned';
      churnInferred = true;
      cadenceIntervalDays = cadenceChurn.typicalIntervalDays;
    } else {
      churnRiskScore = 0;
      if (b.recencyDays > thresholds.high) churnRiskScore += 2;
      else if (b.recencyDays > thresholds.medium) churnRiskScore += 1;
      if (b.frequency === 1) churnRiskScore += 1;
      if (b.cadence && b.cadence.cv !== null) {
        const stretchFloor = Math.max(b.cadence.typicalIntervalDays, 10);
        if (b.recencyDays >= stretchFloor) {
          churnRiskScore += 1;
          cadenceStretch = true;
        }
      }
      churnRiskBand = churnRiskScore >= 4 ? 'High' : churnRiskScore >= 2 ? 'Medium' : 'Low';
    }

    let lifecycleStage;
    if (churnInferred) lifecycleStage = 'Churned';
    else if (b.tenureDays <= 30) lifecycleStage = 'New';
    else if (b.recencyDays <= 90) lifecycleStage = 'Active';
    else lifecycleStage = 'At risk';

    return {
      customerId: b.customerId,
      name: b.customerId,
      tenureDays: b.tenureDays,
      recencyDays: b.recencyDays,
      frequency: b.frequency,
      monetary: b.monetary,
      churnRiskScore,
      churnRiskBand,
      churnInferred,
      cadenceIntervalDays,
      cadenceStretch,
      highValue: highValueCutoff !== null && b.monetary !== null && b.monetary >= highValueCutoff,
      lifecycleStage,
      recencyThresholds: thresholds,
    };
  });

  return {
    applicable: true,
    features,
    customerColumn: customerCol.name,
    dateColumn: dateCol.name,
    hasRevenue: !!revInfo,
    revenueIsFallback: !!(revInfo && revInfo.isFallback),
  };
}

// ---------------------------------------------------------------------
// Round 20 — Delivery-delay risk. The user's spec asks for P(LateDelivery
// = 1) with explainable drivers, framed like "Late-delivery risk: 72% —
// High." This app has no ML/stats library and no iterative solver, so —
// exactly like every other place this codebase's own honesty policy
// already refuses to fit logistic regression as a real model (see
// diagnosticEngine.js's header) — this is never a fitted classifier.
// Instead it reuses explainBinaryFactorsFor() (Cohen's d / chi-square)
// to name the real, textbook-exact factors associated with lateness, and
// scores SEGMENTS (seller/category/geography, whichever this fact table
// resolves) by their own historical late-rate, banded High/Medium/Low
// against the dataset's own rate distribution — an explainable score per
// segment an SME owner can act on today, since a raw uploaded fact table
// has no live "score this specific new order" input to predict against
// in the first place.
// ---------------------------------------------------------------------
function bandByQuantile(ranked, valueKey) {
  if (ranked.length < 4) return ranked.map((r) => ({ ...r, band: 'Medium' }));
  const sortedValues = [...ranked.map((r) => r[valueKey])].sort((a, b) => a - b);
  const q75 = quantile(sortedValues, 0.75);
  const q25 = quantile(sortedValues, 0.25);
  return ranked.map((r) => ({
    ...r, band: r[valueKey] >= q75 ? 'High' : r[valueKey] <= q25 ? 'Low' : 'Medium',
  }));
}

function buildDeliveryDelayRisk(ctx) {
  const delayInfo = computeRowDelays(ctx);
  if (!delayInfo) {
    return {
      applicable: false,
      reason: `This fact table doesn't carry both an estimated/expected delivery date and an actual/delivered date on the same row, so a late-delivery risk can't be computed.`,
    };
  }
  const rows = ctx.factFile.rows.map((row, idx) => ({ row, idx })).filter(({ idx }) => delayInfo.delayByRowIndex.has(idx));
  const isLate = (item) => delayInfo.delayByRowIndex.get(item.idx) > 0;
  const lateCount = rows.filter(isLate).length;
  const overallRatePct = rows.length ? (lateCount / rows.length) * 100 : null;

  const candidates = [];
  const freightCol = findByNamePattern(ctx.factFileProfile, FREIGHT_NAME_RE, ['numeric', 'currency']);
  if (freightCol) candidates.push({ label: 'freight cost', type: 'numeric', accessor: (item) => tryParseNumber(item.row[freightCol.name]) });
  const priceCol = findRoleColumn(ctx.factFile, 'price') || findRoleColumn(ctx.factFile, 'revenue');
  if (priceCol) candidates.push({ label: 'price', type: 'numeric', accessor: (item) => tryParseNumber(item.row[priceCol.name]) });
  const catCol = findCategoryColumn(ctx);
  if (catCol) candidates.push({ label: 'category', type: 'categorical', accessor: (item) => item.row[catCol.name] });
  const geo = geoAccessorFor(ctx);
  if (geo) candidates.push({ label: 'geography', type: 'categorical', accessor: (item) => geo(item.row) });
  const merchantDl = dimensionLabelAccessor(ctx, 'merchant_id');
  if (merchantDl) candidates.push({ label: 'seller', type: 'categorical', accessor: (item) => merchantDl.accessor(item.row) });

  const drivers = candidates.length ? explainBinaryFactorsFor(rows, isLate, candidates) : null;

  // Segment table — whichever of seller/category/geography resolves,
  // scored by its own late-rate and banded relative to this dataset's own
  // distribution of segment rates (quartile-based, same "dataset-relative,
  // never a universal fixed cutoff" principle already used for churn
  // recency thresholds elsewhere in this app).
  const segmentDefs = [];
  if (merchantDl) segmentDefs.push({ label: 'seller', accessor: (item) => merchantDl.accessor(item.row) });
  if (catCol) segmentDefs.push({ label: 'category', accessor: (item) => item.row[catCol.name] });
  if (geo) segmentDefs.push({ label: 'geography', accessor: (item) => geo(item.row) });
  const segments = segmentDefs.map((def) => {
    const wg = worstRateGroup(rows, def.accessor, isLate, 5);
    if (!wg) return null;
    return { dimensionLabel: def.label, rows: bandByQuantile(wg.ranked, 'ratePct').slice(0, 10) };
  }).filter(Boolean);

  if (!drivers && segments.length === 0) {
    return { applicable: false, reason: 'None of the available freight/price/category/geography/seller columns had enough data to assess late-delivery risk.' };
  }

  const topSegmentRow = segments.length && segments[0].rows.length ? segments[0].rows[0] : null;
  return {
    applicable: true,
    overallRatePct,
    sampleSize: rows.length,
    narrative: `${overallRatePct !== null ? overallRatePct.toFixed(1) : '—'}% of deliveries in this dataset ran late overall.${topSegmentRow ? ` The highest-risk ${segments[0].dimensionLabel} is "${topSegmentRow.label}" at ${topSegmentRow.ratePct.toFixed(1)}% late — ${topSegmentRow.band}.` : ''}`,
    drivers,
    segments,
  };
}

// ---------------------------------------------------------------------
// Round 20 — Review-score outlook. The user's spec asks for ReviewScore =
// f(delivery, delay, freight, category, seller, geography, price). Same
// honesty constraint as delivery-delay risk above: no fitted regression
// model (no iterative solver in this codebase), so this reuses
// explainFactorsFor() (Pearson correlation / correlation-ratio eta) to
// name the real factors associated with review score, and reports a
// segment-level EXPECTED rating (this dataset's own historical average
// rating for that segment) as the "outlook" — an honest, defensible
// reading of "predict the review score for orders like this," grounded
// in real computed averages rather than a fabricated regression
// coefficient.
// ---------------------------------------------------------------------
function geoAccessorFor(ctx) {
  const geo = resolveGeo(ctx);
  if (!geo) return null;
  return (row) => (geo.indirect ? (geo.lookup.get(String(row[geo.keyCol]).trim()) || null) : row[geo.keyCol]);
}

function buildReviewScoreOutlook(ctx) {
  const ratingCol = findRatingColumn(ctx);
  if (!ratingCol) {
    return { applicable: false, reason: 'No column profiled as a rating/review-score scale was found on this fact table.' };
  }
  const rows = ctx.factFile.rows.map((row, idx) => ({ row, idx }));
  const targetOf = (item) => tryParseNumber(item.row[ratingCol.name]);
  const validRatings = rows.map(targetOf).filter((v) => v !== null && Number.isFinite(v));
  if (validRatings.length < 30) return { applicable: false, reason: 'Needs at least 30 rated rows to build a review-score outlook.' };
  const overallAvg = validRatings.reduce((s, v) => s + v, 0) / validRatings.length;

  const candidates = [];
  const delayInfo = computeRowDelays(ctx);
  if (delayInfo) candidates.push({ label: 'delivery delay (days)', type: 'numeric', accessor: (item) => (delayInfo.delayByRowIndex.has(item.idx) ? delayInfo.delayByRowIndex.get(item.idx) : null) });
  const freightCol = findByNamePattern(ctx.factFileProfile, FREIGHT_NAME_RE, ['numeric', 'currency']);
  if (freightCol) candidates.push({ label: 'freight cost', type: 'numeric', accessor: (item) => tryParseNumber(item.row[freightCol.name]) });
  const priceCol = findRoleColumn(ctx.factFile, 'price') || findRoleColumn(ctx.factFile, 'revenue');
  if (priceCol) candidates.push({ label: 'price', type: 'numeric', accessor: (item) => tryParseNumber(item.row[priceCol.name]) });
  const catCol = findCategoryColumn(ctx);
  if (catCol) candidates.push({ label: 'category', type: 'categorical', accessor: (item) => item.row[catCol.name] });
  const geo = geoAccessorFor(ctx);
  if (geo) candidates.push({ label: 'geography', type: 'categorical', accessor: (item) => geo(item.row) });
  const merchantDl = dimensionLabelAccessor(ctx, 'merchant_id');
  if (merchantDl) candidates.push({ label: 'seller', type: 'categorical', accessor: (item) => merchantDl.accessor(item.row) });

  const drivers = candidates.length ? explainFactorsFor(rows, targetOf, candidates) : null;

  // Outlook segments — expected/typical rating per value of whichever
  // categorical candidate is the STRONGEST associated factor (by eta), so
  // the outlook table highlights the one dimension actually worth reading
  // it by, rather than three redundant tables.
  let outlookSegments = null;
  if (drivers && drivers.categoricalResults.length) {
    const best = [...drivers.categoricalResults].sort((a, b) => b.eta - a.eta)[0];
    const candDef = candidates.find((c) => c.label === best.label);
    if (candDef) {
      const groups = new Map();
      rows.forEach((item) => {
        const g = candDef.accessor(item);
        const y = targetOf(item);
        if (g === null || g === undefined || String(g).trim() === '' || y === null) return;
        const key = String(g).trim();
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(y);
      });
      outlookSegments = {
        dimensionLabel: best.label,
        rows: [...groups.entries()]
          .filter(([, vals]) => vals.length >= 5)
          .map(([label, vals]) => ({ label, expectedRating: vals.reduce((s, v) => s + v, 0) / vals.length, count: vals.length }))
          .sort((a, b) => a.expectedRating - b.expectedRating)
          .slice(0, 10),
      };
    }
  }

  if (!drivers) return { applicable: false, reason: 'None of the available delivery-delay/freight/price/category/geography/seller columns had enough data to assess a review-score outlook.' };

  return {
    applicable: true,
    overallAvg,
    sampleSize: validRatings.length,
    narrative: `Average review score across this dataset is ${overallAvg.toFixed(2)}.${outlookSegments && outlookSegments.rows.length ? ` The lowest-outlook ${outlookSegments.dimensionLabel} is "${outlookSegments.rows[0].label}" at an expected ${outlookSegments.rows[0].expectedRating.toFixed(2)}.` : ''}`,
    drivers,
    outlookSegments,
  };
}

// ---------------------------------------------------------------------
// Revenue forecast — monthly revenue straight off the fact table's own
// resolved revenue column (falling back to a listed price on a dated/
// order-keyed row, same as everywhere else in this codebase), in the
// exact {key, label, value} shape services/predictiveAnalytics.js's own
// revenueForecast() already expects — so the SAME forecasting primitive
// (OLS + R² + the Holt's-linear-smoothing cross-check) is reused
// unmodified, never re-implemented for this data source.
function buildDynamicRevenueTrend(ctx) {
  const dateCol = findRoleColumn(ctx.factFile, 'date');
  const revInfo = findRevenueColumn(ctx);
  if (!dateCol || !revInfo) return { applicable: false, trend: [], revenueIsFallback: false };

  const sums = new Map();
  ctx.factFile.rows.forEach((row) => {
    const key = monthKeyOf(row[dateCol.name]);
    const val = tryParseNumber(row[revInfo.col.name]);
    if (key && val !== null) sums.set(key, (sums.get(key) || 0) + val);
  });
  const trend = [...sums.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => ({ key, label: monthLabel(key), value }));

  return {
    applicable: trend.length >= 3,
    trend,
    revenueIsFallback: revInfo.isFallback,
    reason: trend.length < 3 ? `This fact table only has revenue data for ${trend.length} distinct month(s) — a forecast needs at least 3 to mean anything.` : null,
  };
}

// ---------------------------------------------------------------------
// What-if scenario (price change) — the same "confirmed > inferred >
// assumed-flat" elasticity ladder services/predictiveAnalytics.js already
// uses, minus the "confirmed" rung (a raw fact table has no separate
// MonetizationConfig pricing history to confirm against — every read here
// is inferred straight from the transaction stream itself, same standard
// as services/diagnosticAnalytics.js's inferPriceChangesFromTransactions,
// just grouped by this fact table's own resolved category column instead
// of a canonical product_service field, since a raw product id (Olist has
// 32,951 of them) is too granular to offer as a what-if dropdown, while
// a resolved product category is both human-legible and has enough volume
// per group for a real before/after comparison).
//
// Round 21 — ERD-driven extensions on top of the above, from a direct
// comparison against three worked reference schemas (Olist, a generic
// e-commerce export, and a Seattle-Airbnb-style booking calendar):
//   1. The grouping dimension now honors resolveCategoryColumn()'s own
//      INDIRECT case (a category living on a joined product/merchant
//      dimension file, resolved through the relationship graph) — a
//      real, previously-shipped bug meant every group lookup below read
//      `row[groupCol.name]` against an object that only ever had a
//      `.keyCol` field, so `group` was always `undefined` and every
//      dataset silently fell through to "no comparable price change
//      found," regardless of how much real price-change history it had.
//      See groupValueForRow() below.
//   2. When no category/group dimension exists anywhere in the dataset
//      (a single-product/service SME, or a booking-calendar shape with
//      no category-like field at all), this now falls back to one
//      synthetic "whole dataset" group instead of declaring the entire
//      feature not-applicable — see resolveWhatIfGroupColumn().
//   3. A joined product/merchant dimension's own catalog/listed price
//      (e.g. a generic e-commerce export's products.price, distinct from
//      order_items.item_price) is now surfaced as the scenario's "current
//      price" baseline when resolvable, alongside the empirically-
//      observed average transaction price — see resolveCatalogPriceForGroup().
//   4. A booking-calendar-shaped fact table with a price + availability
//      column but no dedicated revenue/quantity field (Airbnb's own
//      calendar.csv) now estimates revenue from price × BOOKED nights
//      only, rather than every priced night regardless of whether it was
//      actually booked — always disclosed as an estimate, never presented
//      as an observed transaction amount. See findAvailabilityColumn()/
//      isBookedRow() below.
const MIN_SAMPLE_PER_SIDE = 5;
const MAX_PRICE_CV = 0.15;
const MIN_PRICE_CHANGE_PCT = 8;
const WHOLE_DATASET_GROUP_LABEL = 'All products/services';

function unitPriceOf(t) {
  return t.qty > 0 ? t.amount / t.qty : t.amount;
}

function coefVar(values) {
  if (values.length < 2) return null;
  const m = values.reduce((s, v) => s + v, 0) / values.length;
  if (!m) return null;
  const variance = values.reduce((s, v) => s + (v - m) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance) / Math.abs(m);
}

// Resolves the grouping dimension for the what-if scenario: the same
// category column Business Metrics' "Top Category" pair already uses
// (direct on the fact table, or resolved through a joined dimension file
// via resolveCategoryColumn()'s own indirect case), so a category picked
// here always means the same thing it does everywhere else on this
// dataset. Falls back to one synthetic whole-dataset group — never null —
// when no category dimension is resolvable at all, so a single-product/
// service SME (or a dataset shape with no category-like field, e.g. a
// booking calendar) still gets a usable what-if scenario rather than a
// blanket "not applicable."
function resolveWhatIfGroupColumn(ctx) {
  const category = resolveCategoryColumn(ctx);
  if (category) return category;
  return {
    keyCol: null, lookup: null, indirect: false, sourceLabel: WHOLE_DATASET_GROUP_LABEL, wholeDataset: true,
  };
}

// Reads the resolved group VALUE for one fact-table row — the missing
// piece that made the pre-Round-21 code read `row[groupCol.name]`
// (always undefined; resolveCategoryColumn() never returns a `.name`
// field, only `.keyCol`) and, even had that been fixed, still never
// applied the INDIRECT lookup (a category living on a joined dimension
// file, not the fact table's own column). Returns null when this row
// has no resolvable group value.
function groupValueForRow(groupCol, row) {
  if (groupCol.wholeDataset) return groupCol.sourceLabel;
  const raw = row[groupCol.keyCol];
  if (raw === null || raw === undefined || String(raw).trim() === '') return null;
  const key = String(raw).trim();
  if (groupCol.indirect) return groupCol.lookup.get(key) || null;
  return key;
}

function whatIfGroupLabel(groupCol) {
  return groupCol.wholeDataset ? groupCol.sourceLabel : titleize(groupCol.sourceLabel);
}

// A booking-calendar-shaped fact table (e.g. a Seattle-Airbnb-style
// calendar.csv: listing_id + date + price + available) has NO dedicated
// revenue/quantity column at all — its 'price' column only says what a
// night WOULD cost, not whether that night was actually booked. Treating
// every priced row as revenue (this fact table's existing price-as-
// revenue fallback, findRevenueColumn()'s isFallback rung) would silently
// overcount every unbooked night as realized revenue. When a boolean-kind
// column matching this pattern exists on the fact table, callers below
// only count a row toward revenue/volume when it reads as booked — and
// MUST disclose this as an estimate (`revenueIsEstimatedOccupancy`)
// wherever it's used, never presenting it as an observed transaction
// amount.
const AVAILABILITY_NAME_RE = /available|availability|occupied|occupancy|vacan(?:t|cy)|is[_ ]?booked|\bbooked\b/i;

function findAvailabilityColumn(ctx) {
  return findByNamePattern(ctx.factFileProfile, AVAILABILITY_NAME_RE, ['boolean']);
}

// "available: true/t/yes/1" -> not booked; "available: false/f/no/0" ->
// booked. Returns null for a genuinely unrecognized value rather than
// guessing — such a row is excluded from revenue at both call sites
// below, the same "never fabricate" discipline as everywhere else in
// this engine.
function isBookedRow(rawValue) {
  const v = String(rawValue ?? '').trim().toLowerCase();
  if (BOOL_FALSE.has(v)) return true;
  if (BOOL_TRUE.has(v)) return false;
  return null;
}

// Averages a joined product/merchant dimension's own catalog price
// (resolveCatalogPrice(), Round 21) across every product whose resolved
// category matches the what-if scenario's selected group — so "current
// price" for a category can start from what's actually LISTED for that
// category, not only an average of realized transaction prices (which
// can differ from the catalog price: discounts, a price change mid-
// period). Falls back to averaging across every priced product in the
// dimension file (never scoped to a category) when this dataset has no
// category dimension at all (the whole-dataset group) or the price
// dimension has no category column of its own — always disclosed via
// `scopedToGroup`. Returns null when no catalog price dimension is
// resolvable at all (Olist's own shape — order_items.price IS the only
// price anywhere in the dataset, nothing to compare it against).
function resolveCatalogPriceForGroup(ctx, groupCol, group) {
  const priceInfo = resolveCatalogPrice(ctx);
  if (!priceInfo) return null;
  const { dim, viaRole } = priceInfo;
  const canScopeByCategory = !groupCol.wholeDataset && !!dim.categoryLookup;
  const prices = [];
  dim.priceLookup.forEach((price, productId) => {
    if (canScopeByCategory && dim.categoryLookup.get(productId) !== group) return;
    prices.push(price);
  });
  if (prices.length === 0) return null;
  const avgPrice = prices.reduce((s, v) => s + v, 0) / prices.length;
  return {
    avgPrice,
    sampleSize: prices.length,
    sourceLabel: priceInfo.sourceLabel,
    sourceFile: dim.fileType,
    viaRole,
    scopedToGroup: canScopeByCategory,
  };
}

function inferPriceElasticityFromFactTable(ctx) {
  const groupCol = resolveWhatIfGroupColumn(ctx);
  const dateCol = findRoleColumn(ctx.factFile, 'date');
  const revInfo = findRevenueColumn(ctx);
  const qtyCol = findRoleColumn(ctx.factFile, 'quantity');
  const availabilityCol = findAvailabilityColumn(ctx);
  if (!dateCol || !revInfo) {
    return {
      applicable: false,
      results: [],
      groupColumn: groupCol.wholeDataset ? null : groupCol.keyCol,
      reason: `This fact table is missing ${!dateCol ? 'a date column' : 'a resolvable revenue column'}, which a price-change read needs.`,
    };
  }

  const revenueIsEstimatedOccupancy = revInfo.isFallback && !!availabilityCol;

  const byGroup = new Map();
  ctx.factFile.rows.forEach((row) => {
    if (revenueIsEstimatedOccupancy && isBookedRow(row[availabilityCol.name]) !== true) return;
    const group = groupValueForRow(groupCol, row);
    if (group === null) return;
    const ts = parseDateSafe(row[dateCol.name]);
    if (!ts) return;
    const amount = tryParseNumber(row[revInfo.col.name]);
    if (amount === null || amount <= 0) return;
    const qtyRaw = qtyCol ? tryParseNumber(row[qtyCol.name]) : null;
    const qty = qtyRaw !== null && qtyRaw > 0 ? qtyRaw : 1;
    if (!byGroup.has(group)) byGroup.set(group, []);
    byGroup.get(group).push({ ts, amount, qty });
  });

  const results = [];
  byGroup.forEach((txns, group) => {
    const sorted = [...txns].sort((a, b) => a.ts - b.ts);
    const months = [...new Set(sorted.map((t) => monthKeyOf(t.ts.toISOString())))].sort();
    if (months.length < 2) return;

    let best = null;
    for (let i = 1; i < months.length; i += 1) {
      const boundary = new Date(`${months[i]}-01T00:00:00.000Z`);
      const before = sorted.filter((t) => t.ts < boundary);
      const after = sorted.filter((t) => t.ts >= boundary);
      if (before.length < MIN_SAMPLE_PER_SIDE || after.length < MIN_SAMPLE_PER_SIDE) continue;

      const beforePrices = before.map(unitPriceOf);
      const afterPrices = after.map(unitPriceOf);
      const beforeCv = coefVar(beforePrices);
      const afterCv = coefVar(afterPrices);
      if (beforeCv === null || afterCv === null || beforeCv > MAX_PRICE_CV || afterCv > MAX_PRICE_CV) continue;

      const beforeMean = beforePrices.reduce((s, v) => s + v, 0) / beforePrices.length;
      const afterMean = afterPrices.reduce((s, v) => s + v, 0) / afterPrices.length;
      if (beforeMean === 0) continue;
      const pctChange = ((afterMean - beforeMean) / Math.abs(beforeMean)) * 100;
      if (Math.abs(pctChange) < MIN_PRICE_CHANGE_PCT) continue;

      const confidence = Math.abs(pctChange) - (beforeCv + afterCv) * 20;
      if (!best || confidence > best.confidence) {
        best = {
          confidence, boundary, before, after, beforeMean, afterMean, pctChange,
        };
      }
    }
    if (!best) return;

    const beforeRevenue = best.before.reduce((s, t) => s + t.amount, 0);
    const afterRevenue = best.after.reduce((s, t) => s + t.amount, 0);
    const beforeVolume = best.before.reduce((s, t) => s + t.qty, 0);
    const afterVolume = best.after.reduce((s, t) => s + t.qty, 0);
    const volumePctChange = beforeVolume !== 0 ? ((afterVolume - beforeVolume) / beforeVolume) * 100 : null;
    const elasticity = (best.pctChange && volumePctChange !== null) ? (volumePctChange / best.pctChange) : null;

    results.push({
      group,
      effectiveDate: best.boundary.toISOString(),
      oldPrice: best.beforeMean,
      newPrice: best.afterMean,
      pricePctChange: best.pctChange,
      beforeRevenue,
      afterRevenue,
      revenuePctChange: beforeRevenue !== 0 ? ((afterRevenue - beforeRevenue) / beforeRevenue) * 100 : null,
      beforeVolume,
      afterVolume,
      volumePctChange,
      elasticity,
      inferred: true,
    });
  });

  results.sort((a, b) => new Date(b.effectiveDate) - new Date(a.effectiveDate));
  return {
    applicable: true,
    results,
    groupColumn: groupCol.wholeDataset ? null : groupCol.keyCol,
    groupLabel: whatIfGroupLabel(groupCol),
    revenueIsFallback: revInfo.isFallback,
    revenueIsEstimatedOccupancy,
    availabilityColumnName: availabilityCol ? availabilityCol.name : null,
  };
}

function listDynamicWhatIfGroups(ctx) {
  const groupCol = resolveWhatIfGroupColumn(ctx);
  const revInfo = findRevenueColumn(ctx);
  if (!revInfo) return [];
  if (groupCol.wholeDataset) return [groupCol.sourceLabel];
  const availabilityCol = findAvailabilityColumn(ctx);
  const filterToBooked = revInfo.isFallback && !!availabilityCol;
  const totals = new Map();
  ctx.factFile.rows.forEach((row) => {
    if (filterToBooked && isBookedRow(row[availabilityCol.name]) !== true) return;
    const group = groupValueForRow(groupCol, row);
    if (group === null) return;
    const val = tryParseNumber(row[revInfo.col.name]);
    if (val === null) return;
    totals.set(group, (totals.get(group) || 0) + val);
  });
  return [...totals.entries()].sort((a, b) => b[1] - a[1]).map(([group]) => group);
}

function resolveElasticityForGroup(impacts, group) {
  const ownImpact = impacts.find((i) => i.group === group && i.elasticity !== null);
  if (ownImpact) return { elasticity: ownImpact.elasticity, source: 'group-inferred' };
  const others = impacts.filter((i) => i.elasticity !== null);
  if (others.length > 0) {
    const avg = others.reduce((s, i) => s + i.elasticity, 0) / others.length;
    return { elasticity: avg, source: 'dataset-average', sampleSize: others.length };
  }
  return { elasticity: 0, source: 'assumed-flat' };
}

const MIN_PRICE_PCT_CHANGE = -99;

function buildDynamicPriceWhatIfScenario(ctx, impacts, { group, pricePctChange }) {
  const pct = Number(pricePctChange);
  if (!group || !Number.isFinite(pct) || pct <= MIN_PRICE_PCT_CHANGE) {
    return { available: false, reason: 'invalid-input' };
  }
  const groupCol = resolveWhatIfGroupColumn(ctx);
  const dateCol = findRoleColumn(ctx.factFile, 'date');
  const revInfo = findRevenueColumn(ctx);
  const qtyCol = findRoleColumn(ctx.factFile, 'quantity');
  if (!dateCol || !revInfo) return { available: false, reason: 'not-applicable' };

  const availabilityCol = findAvailabilityColumn(ctx);
  const revenueIsEstimatedOccupancy = revInfo.isFallback && !!availabilityCol;

  const groupRows = ctx.factFile.rows
    .map((row) => {
      if (revenueIsEstimatedOccupancy && isBookedRow(row[availabilityCol.name]) !== true) return null;
      if (groupValueForRow(groupCol, row) !== group) return null;
      const ts = parseDateSafe(row[dateCol.name]);
      if (!ts) return null;
      const amount = tryParseNumber(row[revInfo.col.name]);
      if (amount === null) return null;
      const qtyRaw = qtyCol ? tryParseNumber(row[qtyCol.name]) : null;
      const qty = qtyRaw !== null && qtyRaw > 0 ? qtyRaw : 1;
      return { key: monthKeyOf(ts.toISOString()), amount, qty };
    })
    .filter(Boolean);
  if (groupRows.length === 0) return { available: false, reason: 'no-history' };

  const latestMonth = groupRows.reduce((max, r) => (r.key > max ? r.key : max), groupRows[0].key);
  const baselineRows = groupRows.filter((r) => r.key === latestMonth);
  const baselineRevenue = baselineRows.reduce((s, r) => s + r.amount, 0);
  const baselineVolume = baselineRows.reduce((s, r) => s + r.qty, 0);
  if (baselineRevenue <= 0) return { available: false, reason: 'no-history' };

  const { elasticity, source, sampleSize } = resolveElasticityForGroup(impacts, group);

  let projectedVolumePctChange = elasticity * pct;
  if (projectedVolumePctChange < -100) projectedVolumePctChange = -100;
  const projectedVolume = baselineVolume * (1 + projectedVolumePctChange / 100);
  const projectedRevenue = baselineRevenue * (1 + pct / 100) * (1 + projectedVolumePctChange / 100);
  const revenueDelta = projectedRevenue - baselineRevenue;
  const revenueDeltaPct = baselineRevenue !== 0 ? (revenueDelta / baselineRevenue) * 100 : null;

  const empiricalUnitPrice = baselineVolume > 0 ? baselineRevenue / baselineVolume : null;
  // Round 21 — an ERD-resolved catalog/listed price, when a joined
  // product dimension carries one distinct from this fact table's own
  // historical transaction price. Shown ALONGSIDE the empirically-
  // observed average rather than replacing it (see resolveCatalogPriceForGroup()'s
  // own comment) — used as the scenario's baseline "current price" when
  // available, since it's the correct decision-variable reading per this
  // round's reference-schema comparison, falling back to the empirical
  // average when no catalog dimension price exists at all.
  const catalogPriceInfo = resolveCatalogPriceForGroup(ctx, groupCol, group);
  const baselineUnitPrice = catalogPriceInfo ? catalogPriceInfo.avgPrice : empiricalUnitPrice;
  const scenarioUnitPrice = baselineUnitPrice !== null ? baselineUnitPrice * (1 + pct / 100) : null;

  return {
    available: true,
    group,
    groupLabel: whatIfGroupLabel(groupCol),
    baselineMonthKey: latestMonth,
    baselineMonthLabel: monthLabel(latestMonth),
    pricePctChange: pct,
    elasticity,
    elasticitySource: source,
    elasticitySampleSize: sampleSize || null,
    revenueIsFallback: revInfo.isFallback,
    revenueIsEstimatedOccupancy,
    availabilityColumnName: availabilityCol ? availabilityCol.name : null,
    baseline: {
      revenue: baselineRevenue, volume: baselineVolume, unitPrice: baselineUnitPrice, empiricalUnitPrice,
    },
    scenario: { revenue: projectedRevenue, volume: projectedVolume, unitPrice: scenarioUnitPrice },
    volumePctChange: projectedVolumePctChange,
    revenueDelta,
    revenueDeltaPct,
    catalogPrice: catalogPriceInfo,
  };
}

module.exports = {
  buildDynamicCustomerFeatures,
  buildDynamicRevenueTrend,
  inferPriceElasticityFromFactTable,
  listDynamicWhatIfGroups,
  buildDynamicPriceWhatIfScenario,
  revenueFallbackNote,
  // Round 20
  buildDeliveryDelayRisk,
  buildReviewScoreOutlook,
};
