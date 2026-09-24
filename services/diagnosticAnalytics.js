// Diagnostic Analytics — Phase 2 of claude/canonical-schema-analytics-
// roadmap.md ("why did monetization performance move," not just "what
// happened"). Like Descriptive Analytics, this is a derived-computation
// layer over the same four canonical entities — no new schema, no new
// tables — reusing services/analytics.js's raw-data fetch and helpers.
//
// Two of these three views lean on the ten optional Phase 1 fields
// (transaction_type, effective_from/effective_to, cancellation_reason):
// when a dataset doesn't have them mapped yet, the view degrades to an
// explicit "not enough data" state rather than guessing or fabricating a
// number — the same discipline Descriptive Analytics already established
// for a dataset missing Transaction or MonetizationConfig data entirely.
const { topNWithOther, monthKey, monthLabel } = require('./analytics');

// Revenue bridge — the classic SaaS decomposition of month-over-month
// revenue change into New / Expansion / Contraction / Churned, computed
// per customer from ordinary Transaction data (customer_id, amount,
// timestamp — no Phase 1 field required, so every dataset with at least
// two months of transactions can show this). Compares the two most
// recent months present. Returns null when there's fewer than two
// distinct months — a single month has nothing to bridge from, so this
// is an honest "not enough history yet," never a fabricated zero.
function revenueBridge(transactionRows) {
  const byMonth = {};
  transactionRows.forEach((t) => {
    if (!t || !t.timestamp || !t.customer_id) return;
    const key = monthKey(t.timestamp);
    if (!key) return;
    byMonth[key] = byMonth[key] || {};
    byMonth[key][t.customer_id] = (byMonth[key][t.customer_id] || 0) + (Number(t.amount) || 0);
  });
  const months = Object.keys(byMonth).sort();
  if (months.length < 2) return null;

  const prevKey = months[months.length - 2];
  const currKey = months[months.length - 1];
  const prev = byMonth[prevKey];
  const curr = byMonth[currKey];

  let newRevenue = 0; let newCount = 0;
  let expansionRevenue = 0; let expansionCount = 0;
  let contractionRevenue = 0; let contractionCount = 0;
  let churnedRevenue = 0; let churnedCount = 0;

  Object.keys(curr).forEach((custId) => {
    const currAmt = curr[custId];
    if (!(custId in prev)) {
      newRevenue += currAmt; newCount += 1;
      return;
    }
    const prevAmt = prev[custId];
    if (currAmt > prevAmt) { expansionRevenue += currAmt - prevAmt; expansionCount += 1; }
    else if (currAmt < prevAmt) { contractionRevenue += prevAmt - currAmt; contractionCount += 1; }
  });
  Object.keys(prev).forEach((custId) => {
    if (!(custId in curr)) { churnedRevenue += prev[custId]; churnedCount += 1; }
  });

  const prevTotal = Object.values(prev).reduce((s, v) => s + v, 0);
  const currTotal = Object.values(curr).reduce((s, v) => s + v, 0);
  const netNew = currTotal - prevTotal;

  return {
    prevLabel: monthLabel(prevKey),
    currLabel: monthLabel(currKey),
    prevTotal,
    currTotal,
    netNew,
    netNewPct: prevTotal !== 0 ? (netNew / Math.abs(prevTotal)) * 100 : null,
    rows: [
      { category: 'New', amount: newRevenue, count: newCount, sign: 1 },
      { category: 'Expansion', amount: expansionRevenue, count: expansionCount, sign: 1 },
      { category: 'Contraction', amount: -contractionRevenue, count: contractionCount, sign: -1 },
      { category: 'Churned', amount: -churnedRevenue, count: churnedCount, sign: -1 },
    ],
  };
}

// Revenue split by the optional transaction_type field (new/renewal/
// upgrade/downgrade/refund, as the SME's own data labels it) — the
// direct complement to the cohort-based bridge above, when a dataset
// happens to carry this field. Empty items (not a fabricated single
// "Unclassified" bucket) when no row has it set at all.
function revenueByTransactionType(transactionRows, topN = 7) {
  const withType = transactionRows.filter((t) => t && String(t.transaction_type || '').trim());
  if (withType.length === 0) return { coveragePct: 0, items: [] };
  const totals = {};
  withType.forEach((t) => {
    const label = String(t.transaction_type).trim();
    totals[label] = (totals[label] || 0) + (Number(t.amount) || 0);
  });
  return {
    coveragePct: (withType.length / transactionRows.length) * 100,
    items: topNWithOther(Object.entries(totals).map(([label, value]) => ({ label, value })), topN),
  };
}

// Entitlement cancellations ranked by reason — from the optional
// cancellation_reason field. Empty items when the field isn't populated
// anywhere in this dataset.
function cancellationReasonsRanked(entitlementRows, topN = 7) {
  const withReason = entitlementRows.filter((e) => e && String(e.cancellation_reason || '').trim());
  if (withReason.length === 0) return { coveragePct: 0, items: [] };
  const counts = {};
  withReason.forEach((e) => {
    const label = String(e.cancellation_reason).trim();
    counts[label] = (counts[label] || 0) + 1;
  });
  return {
    coveragePct: (withReason.length / entitlementRows.length) * 100,
    items: topNWithOther(Object.entries(counts).map(([label, value]) => ({ label, value })), topN),
  };
}

// Price-change impact — the highest-leverage read the effective_from/
// effective_to fields unlock (see the roadmap doc). For every product
// with two or more MonetizationConfig price points carrying different
// prices AND an effective_from date, compares Transaction revenue/
// volume in the window immediately before vs. after each detected price
// change. A product/transition is only included when there's ACTUAL
// transaction data on both sides of the boundary to compare — no
// before-side or no after-side data means that transition is skipped
// entirely rather than reported with a fabricated half-comparison.
// Reused as-is by services/prescriptiveAnalytics.js for its elasticity
// read (same underlying computation, different summary on top).
function priceChangeImpact(transactionRows, monetizationRows) {
  const byProduct = {};
  monetizationRows.forEach((row) => {
    const product = String((row || {}).product_service || '').trim();
    const from = row && row.effective_from ? new Date(row.effective_from) : null;
    if (!product || !from || Number.isNaN(from.getTime()) || typeof row.price !== 'number') return;
    byProduct[product] = byProduct[product] || [];
    byProduct[product].push({ price: row.price, effectiveFrom: from });
  });

  const txnByProduct = {};
  transactionRows.forEach((t) => {
    const product = String((t || {}).product_service || '').trim();
    if (!product || !t.timestamp) return;
    const ts = new Date(t.timestamp);
    if (Number.isNaN(ts.getTime())) return;
    txnByProduct[product] = txnByProduct[product] || [];
    txnByProduct[product].push({ ts, amount: Number(t.amount) || 0, qty: Number(t.quantity) > 0 ? Number(t.quantity) : 1 });
  });

  const results = [];
  Object.entries(byProduct).forEach(([product, points]) => {
    const sorted = [...points].sort((a, b) => a.effectiveFrom - b.effectiveFrom);
    const txns = (txnByProduct[product] || []).sort((a, b) => a.ts - b.ts);
    if (txns.length === 0) return;

    for (let i = 1; i < sorted.length; i += 1) {
      const prevPoint = sorted[i - 1];
      const currPoint = sorted[i];
      if (prevPoint.price === currPoint.price) continue; // not a real price change — skip

      const boundary = currPoint.effectiveFrom;
      const windowStart = prevPoint.effectiveFrom;
      const windowEnd = i + 1 < sorted.length ? sorted[i + 1].effectiveFrom : null;

      const before = txns.filter((t) => t.ts >= windowStart && t.ts < boundary);
      const after = txns.filter((t) => t.ts >= boundary && (!windowEnd || t.ts < windowEnd));
      if (before.length === 0 || after.length === 0) continue; // nothing to compare — never fabricate

      const beforeRevenue = before.reduce((s, t) => s + t.amount, 0);
      const afterRevenue = after.reduce((s, t) => s + t.amount, 0);
      const beforeVolume = before.reduce((s, t) => s + t.qty, 0);
      const afterVolume = after.reduce((s, t) => s + t.qty, 0);

      const pricePctChange = prevPoint.price !== 0
        ? ((currPoint.price - prevPoint.price) / Math.abs(prevPoint.price)) * 100 : null;
      const volumePctChange = beforeVolume !== 0 ? ((afterVolume - beforeVolume) / beforeVolume) * 100 : null;
      const elasticity = (pricePctChange && pricePctChange !== 0 && volumePctChange !== null)
        ? (volumePctChange / pricePctChange) : null;

      results.push({
        product,
        effectiveDate: boundary,
        oldPrice: prevPoint.price,
        newPrice: currPoint.price,
        pricePctChange,
        beforeRevenue,
        afterRevenue,
        revenuePctChange: beforeRevenue !== 0 ? ((afterRevenue - beforeRevenue) / beforeRevenue) * 100 : null,
        beforeVolume,
        afterVolume,
        volumePctChange,
        elasticity,
      });
    }
  });
  return results.sort((a, b) => new Date(b.effectiveDate) - new Date(a.effectiveDate));
}

// --- Inferred price changes (no MonetizationConfig needed) --------------
// Without a MonetizationConfig upload at all (or when a specific product
// just isn't priced there), priceChangeImpact() above has nothing to work
// from and price-change/elasticity reads go empty — even though many
// datasets' own Transaction history already shows a real price shift
// directly in what customers were actually charged (a subscription price
// hike, a metered rate cut). This infers that shift straight from the
// transaction stream instead of requiring a separate pricing file: for
// each product, it looks for the single month-boundary split where the
// per-unit price is internally consistent on both sides (low variance —
// a real stable price point, not noise) and meaningfully different
// between the two sides — the same "regular and consistent" standard
// services/monetizationDiscovery.js already applies to detect
// subscription billing, just applied to price level instead of cadence.
// Only the single strongest such split per product is reported (unlike
// priceChangeImpact, which can report every config-confirmed change across
// a product's whole pricing history) — enough to unlock a real elasticity
// read without over-claiming precision inference alone can't support.
const MIN_SAMPLE_PER_SIDE = 5;
const MAX_PRICE_CV = 0.15;
const MIN_PRICE_CHANGE_PCT = 8;

function unitPriceOf(t) {
  const amount = Number(t.amount) || 0;
  const qty = Number(t.quantity) > 0 ? Number(t.quantity) : 1;
  return amount / qty;
}

function coefVar(values) {
  if (values.length < 2) return null;
  const m = values.reduce((s, v) => s + v, 0) / values.length;
  if (!m) return null;
  const variance = values.reduce((s, v) => s + (v - m) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance) / Math.abs(m);
}

function inferPriceChangesFromTransactions(transactionRows) {
  const byProduct = {};
  (transactionRows || []).forEach((t) => {
    const product = String((t || {}).product_service || '').trim();
    if (!product || !t.timestamp) return;
    const ts = new Date(t.timestamp);
    if (Number.isNaN(ts.getTime())) return;
    const amount = Number(t.amount) || 0;
    if (amount <= 0) return; // refunds/zero-value rows never anchor a price read
    byProduct[product] = byProduct[product] || [];
    byProduct[product].push({
      ts, amount, unitPrice: unitPriceOf(t), qty: Number(t.quantity) > 0 ? Number(t.quantity) : 1,
    });
  });

  const results = [];
  Object.entries(byProduct).forEach(([product, txns]) => {
    const sorted = [...txns].sort((a, b) => a.ts - b.ts);
    const months = [...new Set(sorted.map((t) => monthKey(t.ts.toISOString())))].sort();
    if (months.length < 2) return; // needs to span at least 2 calendar months

    let best = null;
    // Candidate boundaries: the start of every month present except the
    // first — try each, keep whichever split is both the most stable on
    // both sides and the most genuinely different in price level.
    for (let i = 1; i < months.length; i += 1) {
      const boundary = new Date(`${months[i]}-01T00:00:00.000Z`);
      const before = sorted.filter((t) => t.ts < boundary);
      const after = sorted.filter((t) => t.ts >= boundary);
      if (before.length < MIN_SAMPLE_PER_SIDE || after.length < MIN_SAMPLE_PER_SIDE) continue;

      const beforePrices = before.map((t) => t.unitPrice);
      const afterPrices = after.map((t) => t.unitPrice);
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
      product,
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

  return results.sort((a, b) => new Date(b.effectiveDate) - new Date(a.effectiveDate));
}

// Merges the config-confirmed price-change history with the inferred
// fallback above: a product with real MonetizationConfig-based evidence
// always keeps that (never overridden by a guess), and inference only
// fills in for a product priceChangeImpact() found nothing for — so this
// never contradicts a stated price, it only covers gaps a dataset without
// (or with incomplete) pricing-history data would otherwise leave empty.
// The `inferred` flag on each row is what lets callers show it's an
// estimate, not a confirmed configured price.
function combinedPriceChangeImpact(transactionRows, monetizationRows) {
  const confirmed = priceChangeImpact(transactionRows, monetizationRows);
  const confirmedProducts = new Set(confirmed.map((r) => r.product));
  const inferred = inferPriceChangesFromTransactions(transactionRows)
    .filter((r) => !confirmedProducts.has(r.product));
  return [...confirmed, ...inferred].sort((a, b) => new Date(b.effectiveDate) - new Date(a.effectiveDate));
}

// How much of this dataset's data actually carries the three Phase 1
// fields the deeper diagnostic views need — surfaced as a small
// always-visible coverage readout, the same spirit as the Descriptive
// Analytics "Mapping & transform status" panel: never leave the SME
// owner guessing why a view is thin.
function diagnosticCoverage(transactionRows, entitlementRows, monetizationRows) {
  const txnTypePct = transactionRows.length
    ? (transactionRows.filter((t) => String((t || {}).transaction_type || '').trim()).length / transactionRows.length) * 100
    : 0;
  const cancelReasonPct = entitlementRows.length
    ? (entitlementRows.filter((e) => String((e || {}).cancellation_reason || '').trim()).length / entitlementRows.length) * 100
    : 0;
  const effectiveDatePct = monetizationRows.length
    ? (monetizationRows.filter((m) => m && m.effective_from).length / monetizationRows.length) * 100
    : 0;
  return { txnTypePct, cancelReasonPct, effectiveDatePct };
}

module.exports = {
  revenueBridge, revenueByTransactionType, cancellationReasonsRanked, priceChangeImpact, diagnosticCoverage,
  inferPriceChangesFromTransactions, combinedPriceChangeImpact,
};
