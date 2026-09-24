// Monetization Discovery Engine — the step the CMA architecture diagram
// places right after Data Mapping & Transformation / the CMA Canonical
// Schema, and before Descriptive/Diagnostic/Predictive/Prescriptive
// analytics: "identify current mechanism(s), determine customers
// affected, determine revenue generated, calculate revenue per
// mechanism, identify hybrid/composite mechanisms."
//
// The deliberate architectural correction this module makes: CMA-Flow
// must NOT simply ask the SME owner which mechanism they use, and it must
// NOT simply read whatever text happens to be in a MonetizationConfig
// row's `model_type` field either — that's still "asking," just asking
// the data instead of the person, and it's exactly why revenue-by-
// mechanism used to go straight to "Unclassified" for any dataset whose
// pricing file didn't happen to spell out a model_type string. Instead,
// this module INFERS the mechanism from how customers are actually
// behaving in the Transaction/Entitlement data itself:
//   - recurring, evenly-spaced, similarly-sized charges  -> Subscription
//   - charges that scale with quantity/usage, irregular timing -> Pay-per-use
//   - some customers paying nothing while others pay for the same
//     product                                             -> Freemium
//   - the product itself IS a dataset/API/report/feed        -> Data-as-a-Service
// Every inference carries its evidence in plain sentences and a
// confidence score; a stated MonetizationConfig.model_type (when present)
// is folded in as ONE supporting signal, never the deciding one. The SME
// owner reviews and confirms or corrects every product on the
// Monetization Discovery screen (routes/dashboard.js, views/dashboard/
// monetization-discovery.ejs) — confirmed choices are persisted
// (monetization_classifications) and take precedence everywhere
// downstream; an unconfirmed inference is used live in the meantime so
// the analytics pages are never blocked waiting on a manual step, but is
// always shown as "inferred, not yet confirmed."
const pool = require('../db/pool');
const { guessConfigModelType } = require('./mapping');
const { buildRevenueDrillDown, DRILLDOWN_PAGE_SIZE } = require('./revenueDrillDown');

const MODEL_TYPES = ['subscription', 'freemium', 'pay_per_use', 'data_as_a_service'];

// A tiny local copy of services/analytics.js's mode() helper (most-frequent
// non-empty value) — duplicated rather than imported so this module never
// has to require analytics.js, which itself requires this module to run
// discovery; keeping the dependency one-directional avoids a circular
// require between the two.
function mode(values) {
  const counts = {};
  let best = null;
  let bestCount = 0;
  values.forEach((v) => {
    const key = String(v || '').trim();
    if (!key) return;
    counts[key] = (counts[key] || 0) + 1;
    if (counts[key] > bestCount) { bestCount = counts[key]; best = key; }
  });
  return best;
}

// Minimum customers-with-repeat-activity before a behavioral score is
// trusted at full strength — below this, the score is still computed
// (so a tiny dataset isn't silently ignored) but confidence is capped,
// and the evidence says so explicitly rather than implying certainty.
const MIN_CUSTOMERS_FOR_CONFIDENCE = 5;

function toNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function mean(arr) {
  if (arr.length === 0) return null;
  return arr.reduce((s, v) => s + v, 0) / arr.length;
}

function stddev(arr) {
  if (arr.length < 2) return null;
  const m = mean(arr);
  const variance = arr.reduce((s, v) => s + (v - m) ** 2, 0) / (arr.length - 1);
  return Math.sqrt(variance);
}

// Coefficient of variation: stddev / |mean|. Low = tightly consistent
// (e.g. the same $29.99 every time); high = wildly variable. Null when
// there isn't enough data or the mean is zero (CV is undefined there).
function coefVar(arr) {
  if (arr.length < 2) return null;
  const m = mean(arr);
  if (!m) return null;
  const sd = stddev(arr);
  return sd === null ? null : sd / Math.abs(m);
}

function daysBetween(a, b) {
  return Math.abs(new Date(a).getTime() - new Date(b).getTime()) / (1000 * 60 * 60 * 24);
}

function groupBy(rows, keyFn) {
  const out = {};
  rows.forEach((r) => {
    const key = keyFn(r);
    if (key === null || key === undefined || key === '') return;
    out[key] = out[key] || [];
    out[key].push(r);
  });
  return out;
}

// --- Signal 1: Subscription -------------------------------------------
// For each customer with >=2 transactions on this product, sort by time
// and look at the gaps between charges and the charged amounts. A
// customer reads as "subscription-like" when their gaps cluster near a
// regular cadence (weekly/monthly/quarterly/annual, allowing real-world
// jitter) AND the amount charged each time is consistent. The product's
// score is the share of multi-transaction customers that read this way —
// grounded in how many customers actually show the pattern, not a single
// dataset-wide average that one outlier could skew.
const CADENCE_BANDS = [
  { label: 'weekly', min: 5, max: 9 },
  { label: 'monthly', min: 25, max: 35 },
  { label: 'quarterly', min: 80, max: 100 },
  { label: 'annual', min: 350, max: 380 },
];

function scoreSubscription(txnsByCustomer) {
  let eligible = 0;
  let cadenceHits = 0;
  let cadenceLabel = null;
  const cadenceLabelCounts = {};

  Object.values(txnsByCustomer).forEach((txns) => {
    if (txns.length < 2) return;
    eligible += 1;
    const sorted = [...txns].sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
    const gaps = [];
    for (let i = 1; i < sorted.length; i += 1) {
      gaps.push(daysBetween(sorted[i - 1].timestamp, sorted[i].timestamp));
    }
    const avgGap = mean(gaps);
    const gapCv = coefVar(gaps);
    const amountCv = coefVar(sorted.map((t) => Number(t.amount) || 0));
    const band = avgGap === null ? null
      : CADENCE_BANDS.find((b) => avgGap >= b.min && avgGap <= b.max);
    // Regular cadence (low gap variance OR only one gap to judge) AND a
    // consistent charge amount is the actual "subscription" signature —
    // neither alone is enough (irregular-but-fixed-price could still be
    // ad hoc top-ups; regular-but-wildly-different amounts could be
    // metered billing that happens to run on a monthly invoice cycle).
    const regularCadence = band && (gapCv === null || gapCv < 0.35);
    const consistentAmount = amountCv !== null && amountCv < 0.2;
    if (regularCadence && consistentAmount) {
      cadenceHits += 1;
      cadenceLabelCounts[band.label] = (cadenceLabelCounts[band.label] || 0) + 1;
    }
  });

  cadenceLabel = Object.entries(cadenceLabelCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || null;
  const score = eligible > 0 ? cadenceHits / eligible : 0;
  const evidence = [];
  if (eligible === 0) {
    evidence.push('No customer has more than one transaction for this product, so a recurring pattern can\'t be checked yet.');
  } else if (cadenceHits > 0) {
    evidence.push(
      `${cadenceHits} of ${eligible} repeat customers are charged a consistent amount on a regular${cadenceLabel ? ` (${cadenceLabel})` : ''} cadence.`
    );
  } else {
    evidence.push(`${eligible} repeat customer(s) checked — none show a regular billing cadence at a consistent amount.`);
  }
  return { score, evidence, sampleSize: eligible };
}

// --- Signal 2: Pay-per-use ----------------------------------------------
// Two ways this shows up in real data: (a) a `quantity` column is present
// and the per-unit rate (amount / quantity) stays roughly constant while
// the billed amount itself varies with how much was used — the textbook
// case; (b) no quantity column, but charges are irregular in both timing
// and amount, which is what usage-driven billing looks like even without
// a usage column to point to directly (weaker evidence, scored lower).
function scorePayPerUse(txns, txnsByCustomer) {
  const withQty = txns.filter((t) => toNum(t.quantity) !== null && toNum(t.quantity) > 0);
  if (withQty.length >= 3) {
    const unitPrices = withQty.map((t) => (Number(t.amount) || 0) / Number(t.quantity));
    const amounts = withQty.map((t) => Number(t.amount) || 0);
    const quantities = withQty.map((t) => Number(t.quantity));
    const unitPriceCv = coefVar(unitPrices);
    const amountCv = coefVar(amounts);
    const qtyCv = coefVar(quantities);
    const scalesWithUsage = unitPriceCv !== null && unitPriceCv < 0.25
      && amountCv !== null && amountCv > 0.15 && qtyCv !== null && qtyCv > 0.15;
    const score = scalesWithUsage ? Math.min(1, 0.6 + (1 - unitPriceCv) * 0.4) : 0.15;
    const evidence = scalesWithUsage
      ? [`Billed amount scales with a recorded usage quantity at a roughly constant per-unit rate across ${withQty.length} transactions.`]
      : [`A usage quantity is recorded on ${withQty.length} transactions, but price-per-unit isn't consistent enough to call this usage-based billing on its own.`];
    return { score, evidence, sampleSize: withQty.length };
  }

  // No usable quantity column — fall back to the weaker irregular-timing
  // + irregular-amount signal, and say plainly that it's the weaker case.
  let eligible = 0;
  let irregularHits = 0;
  Object.values(txnsByCustomer).forEach((customerTxns) => {
    if (customerTxns.length < 2) return;
    eligible += 1;
    const sorted = [...customerTxns].sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
    const gaps = [];
    for (let i = 1; i < sorted.length; i += 1) gaps.push(daysBetween(sorted[i - 1].timestamp, sorted[i].timestamp));
    const gapCv = coefVar(gaps);
    const amountCv = coefVar(sorted.map((t) => Number(t.amount) || 0));
    if ((gapCv !== null && gapCv > 0.5) && (amountCv !== null && amountCv > 0.3)) irregularHits += 1;
  });
  const score = eligible > 0 ? Math.min(0.55, (irregularHits / eligible) * 0.55) : 0;
  const evidence = eligible === 0
    ? ['No usage-quantity column and not enough repeat charges to judge billing irregularity.']
    : [`No usage-quantity column; ${irregularHits} of ${eligible} repeat customers are charged irregular amounts at irregular intervals (weaker evidence than a direct usage-quantity match).`];
  return { score, evidence, sampleSize: eligible };
}

// --- Signal 3: Freemium --------------------------------------------------
// The strongest version of this signal is behavioral, not label-based:
// among customers who hold an entitlement to this product, some are
// paying nothing at all (no transactions, or transactions totalling $0)
// while others are paying real money for the same product. That
// coexistence — not a "free" word in a plan name — is what Freemium
// actually looks like in the data. A `plan` name containing "free" or
// "trial" is folded in as a secondary, corroborating hint only.
function scoreFreemium(productEntitlements, revenueByCustomer) {
  const customerIds = new Set(productEntitlements.map((e) => e.customer_id).filter(Boolean));
  if (customerIds.size < 2) {
    return { score: 0, evidence: ['Fewer than two customers hold an entitlement to this product — not enough to compare free vs. paying.'], sampleSize: customerIds.size };
  }
  let freeCount = 0;
  let payingCount = 0;
  customerIds.forEach((id) => {
    const revenue = revenueByCustomer[id] || 0;
    if (revenue > 0) payingCount += 1; else freeCount += 1;
  });
  const planTextHasFreeHint = productEntitlements.some((e) => /free|trial|basic\b/i.test(String(e.plan || '')));

  const bothSidesPresent = freeCount >= 1 && payingCount >= 1;
  let score = 0;
  if (bothSidesPresent) {
    // Scaled by how balanced the split is — a single free trial account
    // among 500 paying customers is weaker evidence than a real
    // free-tier population, but still worth surfacing, not zeroing out.
    const minority = Math.min(freeCount, payingCount) / customerIds.size;
    score = Math.min(1, 0.45 + minority);
  }
  if (planTextHasFreeHint) score = Math.min(1, score + 0.15);

  const evidence = [];
  if (bothSidesPresent) {
    evidence.push(`${freeCount} customer(s) hold this product with $0 in transactions while ${payingCount} customer(s) pay for it — a free/paid split.`);
  } else {
    evidence.push(`All ${customerIds.size} customer(s) with an entitlement to this product are on the same side (all free or all paying) — no free/paid split detected.`);
  }
  if (planTextHasFreeHint) evidence.push('A plan name for this product also contains "free" or "trial", supporting the split.');
  return { score, evidence, sampleSize: customerIds.size };
}

// --- Signal 4: Data-as-a-Service -----------------------------------------
// This axis is about WHAT is being sold, not how it's billed — a DaaS
// offering can itself be billed as a subscription or metered by usage.
// Keyword evidence on the product's own name/usage-type/unit is the only
// honest signal available from canonical data for "is this a
// dataset/API/report/feed," so it's treated as a content classifier, not
// a billing-pattern one, and only counts when there's also evidence of
// PAID access (at least one transaction or a priced config) — a free
// public dataset with no revenue isn't a monetization mechanism at all.
const DAAS_KEYWORDS = ['api', 'dataset', 'data feed', 'datafeed', 'data set', 'report', 'feed',
  'export', 'query', 'endpoint', 'data access', 'data product', 'analytics feed'];

function scoreDaaS(productName, txns, monetizationRows) {
  const haystack = [productName, ...txns.map((t) => t.usage_type), ...monetizationRows.map((m) => m.unit)]
    .filter(Boolean).join(' ').toLowerCase();
  const hitKeyword = DAAS_KEYWORDS.find((kw) => haystack.includes(kw));
  const hasPaidEvidence = txns.some((t) => (Number(t.amount) || 0) > 0)
    || monetizationRows.some((m) => (Number(m.price) || 0) > 0);
  if (!hitKeyword) {
    return { score: 0, evidence: ['Nothing in this product\'s name, usage type, or pricing unit reads as a dataset/API/report offering.'], sampleSize: 0 };
  }
  if (!hasPaidEvidence) {
    return { score: 0.1, evidence: [`"${hitKeyword}" appears in this product's data, but no paid transaction or priced configuration was found for it.`], sampleSize: 0 };
  }
  return { score: 0.75, evidence: [`This product's name/usage data references "${hitKeyword}", and paid access to it is recorded — a Data-as-a-Service offering.`], sampleSize: 1 };
}

// --- Combine the four signals into one classification per product -------
function classifyProduct(productName, txns, entitlements, monetizationRows, datasetFinancialProfile) {
  const txnsByCustomer = groupBy(txns, (t) => t.customer_id);
  const revenueByCustomer = {};
  txns.forEach((t) => {
    if (!t.customer_id) return;
    revenueByCustomer[t.customer_id] = (revenueByCustomer[t.customer_id] || 0) + (Number(t.amount) || 0);
  });

  const subscription = scoreSubscription(txnsByCustomer);
  const payPerUse = scorePayPerUse(txns, txnsByCustomer);
  const freemium = scoreFreemium(entitlements, revenueByCustomer);
  const daas = scoreDaaS(productName, txns, monetizationRows);

  // A stated MonetizationConfig.model_type, when present and unambiguous,
  // is folded in as a small corroborating bonus on whichever behavioral
  // score it agrees with — supporting evidence, never the deciding vote.
  // Critically, the bonus only ever REINFORCES a signal that already has
  // some real sample behind it (sampleSize > 0) — a product with zero
  // Transaction/Entitlement rows at all (a pure rate-card/config-only
  // file) has NO behavioral evidence to reinforce, so the bonus alone
  // must never be enough to manufacture a confident-looking mechanism
  // out of nothing but a label. That would be exactly the "just read the
  // label" shortcut this engine exists to replace.
  const rawTypes = monetizationRows.map((m) => m.model_type).filter(Boolean);
  const statedHint = rawTypes.length ? guessConfigModelType(mode(rawTypes)) : null;
  const bonus = (signal, type) => (signal.sampleSize > 0 && statedHint === type ? 0.1 : 0);

  const scores = {
    subscription: subscription.score + bonus(subscription, 'subscription'),
    pay_per_use: payPerUse.score + bonus(payPerUse, 'pay_per_use'),
    freemium: freemium.score + bonus(freemium, 'freemium'),
    data_as_a_service: daas.score, // DaaS's own evidence already requires paid access — see scoreDaaS
  };
  const evidenceByType = {
    subscription: subscription.evidence,
    pay_per_use: payPerUse.evidence,
    freemium: freemium.evidence,
    data_as_a_service: daas.evidence,
  };

  // Data-as-a-Service is a content classification that can override a
  // billing-pattern read (see scoreDaaS's comment) — when its own signal
  // clears a real threshold, it wins outright regardless of the other
  // three scores, rather than competing on the same numeric scale as
  // billing-cadence signals it isn't actually measuring the same thing as.
  let inferredModelType = null;
  let ranked;
  if (scores.data_as_a_service >= 0.6) {
    inferredModelType = 'data_as_a_service';
    ranked = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  } else {
    ranked = Object.entries(scores)
      .filter(([type]) => type !== 'data_as_a_service')
      .sort((a, b) => b[1] - a[1]);
    if (ranked[0][1] > 0) inferredModelType = ranked[0][0];
  }

  const topScore = inferredModelType ? scores[inferredModelType] : 0;
  const runnerUp = ranked.find(([type]) => type !== inferredModelType);
  const isHybrid = !!(inferredModelType && runnerUp && runnerUp[1] >= 0.4 && (topScore - runnerUp[1]) < 0.15);

  const customerCount = new Set([
    ...txns.map((t) => t.customer_id),
    ...entitlements.map((e) => e.customer_id),
  ].filter(Boolean)).size;
  const sampleSize = Math.max(subscription.sampleSize, payPerUse.sampleSize, freemium.sampleSize);
  const confidence = inferredModelType
    ? Math.min(1, topScore) * (sampleSize >= MIN_CUSTOMERS_FOR_CONFIDENCE ? 1 : 0.6)
    : 0;

  const evidence = inferredModelType ? [...evidenceByType[inferredModelType]] : [
    'None of the four CMA mechanisms have a clear signal in this product\'s data yet.',
  ];
  if (inferredModelType && sampleSize < MIN_CUSTOMERS_FOR_CONFIDENCE) {
    evidence.push(`Based on only ${sampleSize} customer(s) with repeat activity — confidence will improve as more data arrives.`);
  }
  if (isHybrid) {
    evidence.push(`A secondary ${MODEL_TYPES.includes(runnerUp[0]) ? runnerUp[0].replace(/_/g, ' ') : runnerUp[0]} signal is nearly as strong — this product may be a hybrid mechanism.`);
  }

  // Cost-vs-revenue guardrail. This engine infers a BILLING PATTERN from
  // real behavioral evidence in the Transaction/Entitlement data — that
  // inference is genuine either way. What it can't know on its own is
  // WHOSE billing it's reading: money this organization's own customers
  // paid in, or money this organization itself paid out to a vendor (a
  // GCP Cloud Billing export is the textbook case — usage-quantity +
  // charge evidence there is real pay-per-use BILLING, just not this
  // organization's own pay-per-use REVENUE). services/datasetClassifier.js
  // already made that call from the dataset's raw columns; when it says
  // there's no confirmed direct customer revenue here, the label is
  // corrected so nobody reads "Pay-per-use" off this screen as "this
  // organization earns pay-per-use revenue from its customers."
  const isCostData = !!(datasetFinancialProfile && datasetFinancialProfile.applicable
    && !datasetFinancialProfile.directRevenuePresent.value);
  if (isCostData && inferredModelType) {
    if (inferredModelType === 'pay_per_use') {
      evidence.unshift('Observed billing mechanism: Pay-per-use/usage-based — this describes how this organization is billed by a vendor/provider, not revenue this organization earns from its own customers.');
    } else {
      evidence.unshift(`This dataset's monetary measure reads as cost/expenditure (${datasetFinancialProfile.primaryFinancialMeasure.label}), not confirmed customer revenue — treat "${inferredModelType.replace(/_/g, ' ')}" here as an observed vendor billing pattern, not this organization's own monetization model.`);
    }
  }

  return {
    productService: productName,
    inferredModelType,
    confidence,
    evidence,
    signals: scores,
    isHybrid,
    secondaryModelType: isHybrid ? runnerUp[0] : null,
    revenue: txns.reduce((sum, t) => sum + (Number(t.amount) || 0), 0),
    transactionCount: txns.length,
    customerCount,
    isCostData,
  };
}

// Runs the full discovery pass for one dataset's already-fetched
// canonical rows — pure/synchronous so it's directly unit-testable, and
// reused as-is by the review screen (routes/dashboard.js) and by
// buildDescriptiveAnalytics (services/analytics.js).
function discoverMechanisms(transactionRows, entitlementRows, monetizationRows, datasetFinancialProfile = null) {
  const productNames = new Set();
  transactionRows.forEach((t) => { if (t.product_service) productNames.add(String(t.product_service).trim()); });
  entitlementRows.forEach((e) => { if (e.product_service) productNames.add(String(e.product_service).trim()); });
  monetizationRows.forEach((m) => { if (m.product_service) productNames.add(String(m.product_service).trim()); });

  const txnsByProduct = groupBy(transactionRows, (t) => String(t.product_service || '').trim());
  const entitlementsByProduct = groupBy(entitlementRows, (e) => String(e.product_service || '').trim());
  const configsByProduct = groupBy(monetizationRows, (m) => String(m.product_service || '').trim());

  return [...productNames]
    .map((product) => classifyProduct(
      product,
      txnsByProduct[product] || [],
      entitlementsByProduct[product] || [],
      configsByProduct[product] || [],
      datasetFinancialProfile,
    ))
    .sort((a, b) => b.revenue - a.revenue);
}

// --- Persistence: SME-confirmed classifications, per dataset+product ----
// Confirmed choices are what "the SME owner confirms or corrects the
// classification" (the user's own framing) actually writes to — every
// re-visit of a dataset re-runs discoverMechanisms() fresh against
// whatever canonical data exists NOW, and only the confirmed override (if
// any) is trusted as final; the live inference is always shown too, so a
// confirmation never goes stale-and-silent as new data arrives — the
// discovery screen simply shows the current inference alongside whatever
// was last confirmed, and re-confirming is how the SME owner updates it.
async function getConfirmedClassifications(accountId, datasetRowId) {
  const { rows } = await pool.query(
    `SELECT product_service, confirmed_model_type
       FROM monetization_classifications
      WHERE account_id = $1 AND dataset_id = $2 AND confirmed_model_type IS NOT NULL`,
    [accountId, datasetRowId]
  );
  const map = {};
  rows.forEach((r) => { map[r.product_service] = r.confirmed_model_type; });
  return map;
}

async function saveConfirmedClassifications(accountId, datasetRowId, entries) {
  // entries: [{ productService, confirmedModelType, inferredModelType, confidence, evidence }]
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const e of entries) {
      await client.query(
        `INSERT INTO monetization_classifications
           (dataset_id, account_id, product_service, inferred_model_type, confidence, evidence, confirmed_model_type, confirmed_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, now(), now())
         ON CONFLICT (dataset_id, product_service) DO UPDATE SET
           inferred_model_type = EXCLUDED.inferred_model_type,
           confidence = EXCLUDED.confidence,
           evidence = EXCLUDED.evidence,
           confirmed_model_type = EXCLUDED.confirmed_model_type,
           confirmed_at = now(),
           updated_at = now()`,
        [
          datasetRowId, accountId, e.productService, e.inferredModelType || null, e.confidence || 0,
          JSON.stringify(e.evidence || []), e.confirmedModelType || null,
        ]
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// --- Drill-down: what a product's KPI tiles/inference are made of ------
// The discovery card shows Revenue/Transactions/Customers and an evidence
// list, but doesn't show the actual rows behind them — the SME owner has
// to take the inference on faith. This gives the confirm/correct decision
// something to look at: the same transaction rows already loaded for
// discoverMechanisms(), reshaped into two views over ONE product:
//   - 'customers': one row per customer (revenue/txn-count/last-purchase
//     for this product), sorted biggest-spender first — matches the
//     "who is this KPI actually made of" question the panel exists to
//     answer.
//   - 'transactions': the raw per-transaction log for this product, most
//     recent first — matches "how was this revenue shown," i.e. exactly
//     what the mechanism-inference evidence itself is reading.
//
// The actual pagination/rollup math now lives in services/revenueDrillDown.js
// — it was generalized for a second caller (the Revenue & Growth tab's
// "Revenue by customer" chart, which needs the mirror-image drill-down:
// one customer -> rolled up by product). This function is now a thin
// product-shaped wrapper kept for the existing call site/route below and
// the existing row-fragment view, unchanged in behavior or field names.
function buildProductDrillDown(transactionRows, customerRows, product, viewMode, offset = 0) {
  const result = buildRevenueDrillDown(transactionRows, customerRows, {
    filterBy: 'product', filterValue: product, viewMode, offset,
  });
  if (result.mode !== 'customers') return result;
  return {
    ...result,
    rows: result.rows.map((r) => ({
      customerId: r.key,
      customerName: r.label !== r.key ? r.label : null,
      revenue: r.revenue,
      transactionCount: r.transactionCount,
      currency: r.currency,
      lastTimestamp: r.lastTimestamp,
    })),
  };
}

// Merges confirmed overrides on top of a fresh discovery pass into the
// flat { [productService]: modelType } shape every existing revenue-by-
// mechanism function in services/analytics.js already expects — this is
// the ONE function that replaces the old label-reading buildProductModelMap()
// as the authoritative source those functions consume.
function mergeConfirmedOverrides(discoveries, confirmedMap) {
  const map = {};
  discoveries.forEach((d) => {
    map[d.productService] = confirmedMap[d.productService] || d.inferredModelType || null;
  });
  return map;
}

module.exports = {
  MODEL_TYPES,
  discoverMechanisms,
  getConfirmedClassifications,
  saveConfirmedClassifications,
  mergeConfirmedOverrides,
  buildProductDrillDown,
  DRILLDOWN_PAGE_SIZE,
};
