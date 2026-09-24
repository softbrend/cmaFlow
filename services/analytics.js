// Descriptive Analytics: "historical and current-state views of how each
// SME account is earning revenue today" (the nav blurb this replaces),
// computed entirely from the CMA Canonical Schema — the four entities
// Map & Transform freezes into canonical_records — for ONE uploaded
// dataset at a time, laid out as eight selectable views matching the
// CMA descriptive-analytics matrix the SME owner asked for:
//
//   Customers               -> customer profiling & segmentation
//   Transactions             -> revenue analysis
//   Monetization mechanisms  -> mechanism performance
//   Entitlements             -> access/entitlement analysis
//   Configuration             -> configuration utilization
//   Switching                 -> monetization-switch history
//   Financial reconciliation  -> expected vs actual revenue, variance
//   Dataset analysis          -> dataset/domain summaries
//
// Like every other screen that reads canonical data after transformation
// (see getMonetizationConfigCandidates in routes/dashboard.js), this only
// ever looks at the LATEST mapping_version per file_type, and only
// status='valid' rows — a re-mapped/re-run file's older canonical batch
// stays in the table for lineage but never double-counts here.
//
// Two views reach outside the selected dataset on purpose:
//   - Configuration & Switching read `monetization_configs` — the SME
//     account's actual chosen revenue-model setup (Set-up Monetization
//     Configuration screen), which is a business-level decision, not
//     something scoped to one dataset upload.
//   - Dataset analysis reads every dataset this account has uploaded, to
//     roll revenue/usage up by `uploaded_datasets.domain` (Olist, AWS,
//     GCP, ...) so datasets can be compared, not just browsed one at a
//     time.
// Every other view stays strictly scoped to the one selected dataset ID.
const pool = require('../db/pool');
const {
  discoverMechanisms, getConfirmedClassifications, mergeConfirmedOverrides,
} = require('./monetizationDiscovery');
const { suggestMapping, guessEntity } = require('./mapping');
const { CANONICAL_ENTITIES } = require('../db/canonicalSchema');

const MODEL_TYPE_LABELS = {
  subscription: '📅 Subscription',
  freemium: '🎁 Freemium',
  pay_per_use: '📈 Pay-per-use',
  data_as_a_service: '🗄️ Data-as-a-Service',
};
const UNCLASSIFIED_LABEL = '❔ Unclassified';

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

async function getLatestValidCanonicalData(accountId, datasetRowId, entity) {
  const { rows } = await pool.query(
    `WITH latest_versions AS (
       SELECT file_type, MAX(mapping_version) AS max_version
         FROM canonical_records
        WHERE account_id = $1 AND dataset_id = $2 AND entity = $3
        GROUP BY file_type
     )
     SELECT cr.data
       FROM canonical_records cr
       JOIN latest_versions lv
         ON lv.file_type = cr.file_type AND lv.max_version = cr.mapping_version
      WHERE cr.account_id = $1 AND cr.dataset_id = $2 AND cr.entity = $3 AND cr.status = 'valid'`,
    [accountId, datasetRowId, entity]
  );
  return rows.map((r) => r.data);
}

// This SME account's actual monetization-configuration history — every
// row ever created on Set-up Monetization Configuration, active or not.
// Account-scoped (not dataset-scoped): the business's chosen revenue
// model isn't tied to any one upload.
// Revenue/usage per dataset this account has uploaded, rolled up by
// `uploaded_datasets.domain` (a free-text field the SME owner fills in on
// upload — "Olist", "AWS", "GCP", "Mobile Game", ...). One row per
// dataset even when it has zero readable Transaction data yet, so a
// domain with a still-empty dataset isn't silently dropped from the
// comparison.
//
// Raw-native: the CMA Canonical Schema (and its Map & Transform step) is
// reserved for a future dissertation extension — see claude/cma-flow-app-
// conceptual-framework-audit.md in the project docs — so this reads each
// dataset's own raw uploaded columns directly via pickRawEntityRows(),
// the same content-aware Transaction detection every other raw-native
// tab in this app already uses, instead of the frozen canonical_records
// table Map & Transform produces. `datasets` is the account's own
// dataset list (already fetched by the caller) so this never re-queries
// uploaded_datasets itself.
async function getDatasetDomainRollupRaw(accountId, datasets) {
  const rollups = await Promise.all(datasets.map(async (d) => {
    const rawByFileType = await getRawRecordsByFileType(accountId, d.id);
    const txn = pickRawEntityRows(rawByFileType, 'Transaction');
    const cleanTxns = txn.rows.filter((t) => t.amount !== null && !Number.isNaN(Number(t.amount)) && t.customer_id);
    const revenue = cleanTxns.reduce((sum, t) => sum + (Number(t.amount) || 0), 0);
    const customerCount = new Set(cleanTxns.map((t) => t.customer_id).filter(Boolean)).size;
    return {
      datasetRowId: d.id,
      datasetCode: d.dataset_id,
      datasetName: d.dataset_name,
      domain: d.domain && String(d.domain).trim() ? d.domain : 'Unspecified',
      transactionCount: cleanTxns.length,
      revenue,
      customerCount,
    };
  }));
  return rollups.sort((a, b) => a.domain.localeCompare(b.domain) || a.datasetCode.localeCompare(b.datasetCode));
}

// Most-frequent non-empty string in a list — used to pick one "the"
// currency/model-type when a dataset technically has several.
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

function monthKey(isoString) {
  return String(isoString || '').slice(0, 7); // 'YYYY-MM'
}

function monthLabel(key) {
  const [y, m] = key.split('-');
  const idx = parseInt(m, 10) - 1;
  return `${MONTH_NAMES[idx] || m} ${y}`;
}

// Ranks entries by value descending and folds everything past the top N
// into a single "Other" bucket — keeps every bar chart under the ~7-class
// ceiling regardless of how many distinct products/segments/statuses a
// dataset actually has.
function topNWithOther(entries, n) {
  const sorted = [...entries].sort((a, b) => b.value - a.value);
  if (sorted.length <= n) return sorted;
  const head = sorted.slice(0, n);
  const otherValue = sorted.slice(n).reduce((sum, e) => sum + e.value, 0);
  if (otherValue > 0) head.push({ label: 'Other', value: otherValue, isOther: true });
  return head;
}

function countBy(rows, field, fallbackLabel, topN = 6) {
  const counts = {};
  rows.forEach((r) => {
    const label = String((r || {})[field] || '').trim() || fallbackLabel;
    counts[label] = (counts[label] || 0) + 1;
  });
  return topNWithOther(Object.entries(counts).map(([label, value]) => ({ label, value })), topN);
}

function revenueByModel(transactionRows, productModelMap) {
  const totals = {};
  transactionRows.forEach((t) => {
    const product = String((t || {}).product_service || '').trim();
    const modelType = (product && productModelMap[product]) || null;
    const label = modelType ? MODEL_TYPE_LABELS[modelType] : UNCLASSIFIED_LABEL;
    totals[label] = (totals[label] || 0) + (Number(t.amount) || 0);
  });
  return Object.entries(totals)
    .map(([label, value]) => ({ label, value, isOther: label === UNCLASSIFIED_LABEL }))
    .sort((a, b) => b.value - a.value);
}

// Mechanism performance detail table (Mechanisms tab) — the same
// per-model split as revenueByModel(), but with transaction count,
// average transaction value, and share-of-total alongside the revenue
// figure, since "mechanism performance" is more than one number.
function mechanismPerformanceTable(transactionRows, productModelMap) {
  const totals = {};
  transactionRows.forEach((t) => {
    const product = String((t || {}).product_service || '').trim();
    const modelType = (product && productModelMap[product]) || null;
    const label = modelType ? MODEL_TYPE_LABELS[modelType] : UNCLASSIFIED_LABEL;
    totals[label] = totals[label] || { label, revenue: 0, count: 0, isOther: label === UNCLASSIFIED_LABEL };
    totals[label].revenue += Number(t.amount) || 0;
    totals[label].count += 1;
  });
  const grandTotal = Object.values(totals).reduce((sum, r) => sum + r.revenue, 0);
  return Object.values(totals)
    .map((r) => ({
      ...r,
      avgValue: r.count ? r.revenue / r.count : 0,
      pctOfTotal: grandTotal ? (r.revenue / grandTotal) * 100 : 0,
    }))
    .sort((a, b) => b.revenue - a.revenue);
}

function revenueByProduct(transactionRows, topN = 6) {
  const totals = {};
  transactionRows.forEach((t) => {
    const label = String((t || {}).product_service || '').trim() || 'Unspecified';
    totals[label] = (totals[label] || 0) + (Number(t.amount) || 0);
  });
  return topNWithOther(Object.entries(totals).map(([label, value]) => ({ label, value })), topN);
}

function revenueTrend(transactionRows) {
  const totals = {};
  transactionRows.forEach((t) => {
    if (!t || !t.timestamp) return;
    const key = monthKey(t.timestamp);
    if (!key) return;
    totals[key] = (totals[key] || 0) + (Number(t.amount) || 0);
  });
  return Object.keys(totals).sort().map((key) => ({ key, label: monthLabel(key), value: totals[key] }));
}

function topCustomersByRevenue(transactionRows, customerRows, topN = 8) {
  const nameById = {};
  customerRows.forEach((c) => {
    if (c && c.customer_id) nameById[c.customer_id] = String(c.name || c.customer_id).trim();
  });
  const totals = {};
  transactionRows.forEach((t) => {
    const id = t && t.customer_id;
    if (!id) return;
    totals[id] = (totals[id] || 0) + (Number(t.amount) || 0);
  });
  const entries = Object.entries(totals)
    .map(([id, value]) => ({ label: nameById[id] || id, value }))
    .sort((a, b) => b.value - a.value);
  return entries.slice(0, topN);
}

// Customers tab, third breakdown alongside segment/region: which
// monetization mechanism each customer is actually being billed under.
// A customer doesn't carry a mechanism field of its own — it's derived
// the same way revenue-by-model is: each of the customer's Transaction
// rows names a product_service, that product maps to a CMA model via
// this dataset's own MonetizationConfig data, and the customer is
// counted under whichever model their transactions land on most often.
// A customer with no transactions yet falls back to their Entitlement
// rows' product_service the same way; with neither, they're Unclassified
// — not dropped, since "not yet billed under any mechanism" is itself a
// real, useful count for the SME owner to see.
function customersByMechanism(customerRows, transactionRows, entitlementRows, productModelMap) {
  const productsByCustomer = {};
  const record = (customerId, product) => {
    if (!customerId || !product) return;
    productsByCustomer[customerId] = productsByCustomer[customerId] || [];
    productsByCustomer[customerId].push(product);
  };
  transactionRows.forEach((t) => record(t.customer_id, String((t || {}).product_service || '').trim()));
  if (Object.keys(productsByCustomer).length === 0) {
    entitlementRows.forEach((e) => record(e.customer_id, String((e || {}).product_service || '').trim()));
  }

  const counts = {};
  customerRows.forEach((c) => {
    const id = c && c.customer_id;
    const products = id ? (productsByCustomer[id] || []) : [];
    const productMode = mode(products);
    const modelType = productMode ? productModelMap[productMode] : null;
    const label = modelType ? MODEL_TYPE_LABELS[modelType] : UNCLASSIFIED_LABEL;
    counts[label] = (counts[label] || 0) + 1;
  });
  return Object.entries(counts)
    .map(([label, value]) => ({ label, value, isOther: label === UNCLASSIFIED_LABEL }))
    .sort((a, b) => b.value - a.value);
}

// Entitlements tab — normalizes each row's free-form `status` text (plus
// a start/end-date fallback for rows that never named a status at all)
// into three buckets an SME owner can act on: Active, Expired, and
// Other/Unspecified (suspended, cancelled, or anything unrecognized).
// "Upgraded" isn't a status value in the canonical schema at all — see
// detectPlanChanges() below, which finds it a different way: by noticing
// when the SAME customer+product's entitlement `plan` changed between one
// record and the next.
function normalizeEntitlementStatus(row, now) {
  const raw = String((row || {}).status || '').trim().toLowerCase();
  if (raw) {
    if (raw.includes('active') && !raw.includes('inactive')) return 'Active';
    if (raw.includes('expire')) return 'Expired';
    if (raw.includes('suspend') || raw.includes('cancel') || raw.includes('inactive')) return 'Suspended / cancelled';
  }
  const end = row && row.end_date ? new Date(row.end_date) : null;
  const start = row && row.start_date ? new Date(row.start_date) : null;
  const endValid = end && !Number.isNaN(end.getTime());
  const startValid = start && !Number.isNaN(start.getTime());
  if (endValid && end < now) return 'Expired';
  if (startValid && start <= now && (!endValid || end >= now)) return 'Active';
  return raw ? 'Other' : 'Unspecified';
}

function entitlementLifecycle(entitlementRows) {
  const now = new Date();
  const buckets = { Active: 0, Expired: 0, 'Suspended / cancelled': 0, Other: 0, Unspecified: 0 };
  entitlementRows.forEach((e) => {
    const bucket = normalizeEntitlementStatus(e, now);
    buckets[bucket] = (buckets[bucket] || 0) + 1;
  });
  const chart = Object.entries(buckets)
    .filter(([, value]) => value > 0)
    .map(([label, value]) => ({ label, value, isOther: label !== 'Active' && label !== 'Expired' }));
  return {
    active: buckets.Active,
    expired: buckets.Expired,
    other: buckets['Suspended / cancelled'] + buckets.Other + buckets.Unspecified,
    total: entitlementRows.length,
    chart,
  };
}

// Shared by the Entitlements tab (an "Upgraded" count) and the Switching
// tab (the detailed history): groups this dataset's Entitlement rows by
// (customer_id, product_service), orders each group by start_date, and
// records every point where the `plan` value actually changed from one
// entitlement record to the next for that same customer+product — e.g.
// "Basic -> Pro". Needs at least two entitlement rows sharing a
// customer+product with a start_date and a plan to detect anything;
// datasets that only ever hold one entitlement snapshot per customer
// (no history) correctly produce zero switches, not a guess.
function detectPlanChanges(entitlementRows) {
  const byKey = {};
  entitlementRows.forEach((e) => {
    if (!e || !e.customer_id) return;
    const key = `${e.customer_id}::${String(e.product_service || '').trim()}`;
    byKey[key] = byKey[key] || [];
    byKey[key].push(e);
  });

  const events = [];
  Object.values(byKey).forEach((list) => {
    const sorted = [...list].sort(
      (a, b) => new Date(a.start_date || 0).getTime() - new Date(b.start_date || 0).getTime()
    );
    for (let i = 1; i < sorted.length; i += 1) {
      const fromPlan = String(sorted[i - 1].plan || '').trim();
      const toPlan = String(sorted[i].plan || '').trim();
      if (fromPlan && toPlan && fromPlan !== toPlan) {
        events.push({
          customerId: sorted[i].customer_id,
          product: String(sorted[i].product_service || '').trim() || 'Unspecified',
          fromPlan,
          toPlan,
          date: sorted[i].start_date || null,
        });
      }
    }
  });
  return events.sort((a, b) => new Date(b.date || 0).getTime() - new Date(a.date || 0).getTime());
}

function switchPairsChart(events, fromKey, toKey, topN = 6) {
  const counts = {};
  events.forEach((e) => {
    const label = `${e[fromKey]} → ${e[toKey]}`;
    counts[label] = (counts[label] || 0) + 1;
  });
  return topNWithOther(Object.entries(counts).map(([label, value]) => ({ label, value })), topN);
}

// Configuration tab — this SME account's actual monetization-configuration
// history from Set-up Monetization Configuration (account-scoped, not
// dataset-scoped: the business's chosen revenue model isn't tied to any
// one upload). "Versions used" = every configuration ever created,
// active or since deactivated; "switching frequency" = how many times
// the account's model_type actually changed from one configuration to
// the next, in creation order (see configSwitchHistory() below for the
// same underlying transitions, reused by the Switching tab).
function configUtilization(configRows) {
  const activeConfigs = configRows.filter((c) => c.is_active);
  const { transitions } = configSwitchHistory(configRows);
  return {
    activeConfigs,
    totalConfigs: configRows.length,
    switchingFrequency: transitions.length,
    timeline: [...configRows].sort(
      (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
    ),
  };
}

// Switching tab, configuration side — treats the account's configs in
// the order they were CREATED as a proxy timeline of "what model this
// account was running," and records a transition wherever the model_type
// changes from one config to the next. This is a simplifying assumption
// (monetization_configs has no explicit "superseded_at" — several
// configs can coexist with is_active=true at once, e.g. one per product)
// documented here rather than hidden: creation order is the best signal
// this schema has for "the account moved from running model A to model
// B," and it degrades safely — zero configs or one config always yields
// zero transitions rather than a fabricated switch.
function configSwitchHistory(configRows) {
  const sorted = [...configRows].sort(
    (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
  );
  const transitions = [];
  for (let i = 1; i < sorted.length; i += 1) {
    const from = sorted[i - 1].model_type;
    const to = sorted[i].model_type;
    if (from && to && from !== to) {
      transitions.push({
        fromLabel: MODEL_TYPE_LABELS[from] || from,
        toLabel: MODEL_TYPE_LABELS[to] || to,
        date: sorted[i].created_at,
        toConfigName: sorted[i].config_name,
      });
    }
  }
  return { timeline: sorted, transitions };
}

// Financial reconciliation tab — "expected vs actual revenue" only means
// something once there's both an actual (a Transaction) and a basis for
// expecting one (a configured MonetizationConfig price) — so, like the
// Pricing Catalog Overview's relationship to a pure rate-card dataset,
// this returns null rather than a fabricated number when either side is
// entirely missing for this dataset.
//
// Expected amount per transaction = its quantity (defaulting to 1 unit
// when the dataset carries no quantity column) times the AVERAGE
// configured price for that product_service — averaged because a
// product can have several tiers at different price points and a single
// transaction's canonical data doesn't say which tier it billed under;
// this is a deliberately simple baseline, not a tier-exact recomputation.
// A transaction whose product has no MonetizationConfig price at all
// can't be reconciled either way, so it's counted separately as
// "unmatched" and excluded from the expected/actual totals rather than
// silently treated as zero-variance.
function buildAveragePriceByProduct(monetizationRows) {
  const byProduct = {};
  monetizationRows.forEach((row) => {
    const product = String((row || {}).product_service || '').trim();
    if (!product || typeof row.price !== 'number') return;
    byProduct[product] = byProduct[product] || [];
    byProduct[product].push(row.price);
  });
  const avg = {};
  Object.entries(byProduct).forEach(([product, prices]) => {
    avg[product] = prices.reduce((sum, v) => sum + v, 0) / prices.length;
  });
  return avg;
}

function financialReconciliation(transactionRows, monetizationRows) {
  if (transactionRows.length === 0 || monetizationRows.length === 0) return null;

  const priceByProduct = buildAveragePriceByProduct(monetizationRows);
  const byProduct = {};
  let unmatchedRevenue = 0;
  let unmatchedCount = 0;

  transactionRows.forEach((t) => {
    const product = String((t || {}).product_service || '').trim() || 'Unspecified';
    const unitPrice = priceByProduct[product];
    const actual = Number(t.amount) || 0;
    if (unitPrice === undefined) {
      unmatchedRevenue += actual;
      unmatchedCount += 1;
      return;
    }
    const qty = Number(t.quantity) > 0 ? Number(t.quantity) : 1;
    byProduct[product] = byProduct[product] || { product, expected: 0, actual: 0, count: 0 };
    byProduct[product].expected += qty * unitPrice;
    byProduct[product].actual += actual;
    byProduct[product].count += 1;
  });

  const rows = Object.values(byProduct)
    .map((r) => ({
      ...r,
      variance: r.actual - r.expected,
      variancePct: r.expected !== 0 ? ((r.actual - r.expected) / Math.abs(r.expected)) * 100 : null,
    }))
    .sort((a, b) => Math.abs(b.variance) - Math.abs(a.variance));

  if (rows.length === 0) {
    // Every transaction's product was unmatched — nothing to reconcile.
    return null;
  }

  const expectedRevenue = rows.reduce((sum, r) => sum + r.expected, 0);
  const actualRevenue = rows.reduce((sum, r) => sum + r.actual, 0);
  const variance = actualRevenue - expectedRevenue;

  return {
    expectedRevenue,
    actualRevenue,
    variance,
    variancePct: expectedRevenue !== 0 ? (variance / Math.abs(expectedRevenue)) * 100 : null,
    unmatchedRevenue,
    unmatchedCount,
    matchedCount: transactionRows.length - unmatchedCount,
    byProduct: rows,
  };
}

// Dataset analysis tab — this dataset's own profile plus a rollup of
// every dataset this account has uploaded, grouped by domain, so the SME
// owner can compare (e.g.) their AWS dataset's revenue against their
// GCP or Olist dataset rather than only ever seeing one at a time.
function buildDatasetDomainAnalysis(rollupRows, currentDatasetRowId) {
  const current = rollupRows.find((r) => r.datasetRowId === currentDatasetRowId) || null;

  const byDomain = {};
  rollupRows.forEach((r) => {
    byDomain[r.domain] = byDomain[r.domain] || {
      domain: r.domain, revenue: 0, transactionCount: 0, customerCount: 0, datasetCount: 0,
    };
    byDomain[r.domain].revenue += r.revenue;
    byDomain[r.domain].transactionCount += r.transactionCount;
    byDomain[r.domain].customerCount += r.customerCount;
    byDomain[r.domain].datasetCount += 1;
  });
  const domains = Object.values(byDomain).sort((a, b) => b.revenue - a.revenue);
  const domainChart = domains.map((d) => ({
    label: d.domain, value: d.revenue, isOther: d.domain === 'Unspecified',
  }));

  return {
    current,
    domains,
    domainChart,
    datasets: [...rollupRows].sort((a, b) => b.revenue - a.revenue),
  };
}

// ------------------------------------------------------------------
// Revenue & Growth — the SME owner's own descriptive-analytics matrix
// (Revenue, Revenue by mechanism/customer/product/period, ARPU, MRR/ARR,
// Customer growth, Usage, Conversion, Churn, Mechanism contribution),
// built as its own tab rather than folded into Transactions/Mechanisms.
// This one function is the shared core for BOTH data sources the SME
// owner can pick from on this tab: the CMA Canonical Schema (the default,
// reviewed/validated Transaction+Entitlement rows every other tab reads)
// and a raw-upload mode that runs the same math directly against
// dataset_records — before Map & Transform — using services/mapping.js's
// own column-guessing heuristics (see buildRawRevenueGrowthAnalytics()
// below). Both paths hand this function the SAME shape of rows
// ({customer_id, product_service, amount, timestamp, quantity, currency}
// for transactions; {customer_id, plan, status} for entitlements), so
// every number here is computed identically regardless of source — only
// how honestly-provisional the input is differs, and that's surfaced to
// the SME owner in the view, not hidden here.
function revenueGrowthMetrics({
  transactionRows, entitlementRows, productModelMap, currency,
}) {
  const totalRevenue = transactionRows.reduce((sum, t) => sum + (Number(t.amount) || 0), 0);
  const payingCustomers = new Set(transactionRows.map((t) => t && t.customer_id).filter(Boolean));
  const arpu = payingCustomers.size ? totalRevenue / payingCustomers.size : null;

  const byMechanism = revenueByModel(transactionRows, productModelMap);
  const mechanismTable = mechanismPerformanceTable(transactionRows, productModelMap);
  const byCustomer = topCustomersByRevenue(transactionRows, [], 8);
  const byProduct = revenueByProduct(transactionRows);
  const byPeriod = revenueTrend(transactionRows);

  // MRR/ARR — deliberately NOT "all revenue this month": that would
  // fabricate a recurring-revenue number out of one-off and usage-billed
  // transactions too. Only transactions whose product is classified (by
  // the Monetization Discovery Engine, confirmed or inferred) as
  // Subscription count toward it, in the most recent month that has any —
  // with zero Subscription-classified evidence anywhere, this returns
  // null rather than a misleading number built on other mechanisms.
  const subscriptionTxns = transactionRows.filter((t) => {
    const product = String((t || {}).product_service || '').trim();
    return product && productModelMap[product] === 'subscription';
  });
  let mrr = null;
  let arr = null;
  let mrrMonthLabel = null;
  if (subscriptionTxns.length > 0) {
    const subTrend = revenueTrend(subscriptionTxns);
    if (subTrend.length > 0) {
      const latest = subTrend[subTrend.length - 1];
      mrr = latest.value;
      arr = mrr * 12;
      mrrMonthLabel = latest.label;
    }
  }

  // Usage — only meaningful when this dataset's transactions actually
  // carry a usage quantity; a dataset with no quantity column anywhere
  // returns null rather than a fabricated "0 units".
  const usageRows = transactionRows.filter((t) => {
    const q = t && t.quantity;
    return q !== null && q !== undefined && q !== '' && Number.isFinite(Number(q));
  });
  let usage = null;
  if (usageRows.length > 0) {
    const totalUsage = usageRows.reduce((sum, t) => sum + Number(t.quantity), 0);
    const byProductTotals = {};
    usageRows.forEach((t) => {
      const label = String((t || {}).product_service || '').trim() || 'Unspecified';
      byProductTotals[label] = (byProductTotals[label] || 0) + Number(t.quantity);
    });
    const byProductUsage = topNWithOther(
      Object.entries(byProductTotals).map(([label, value]) => ({ label, value })), 6
    );
    usage = { totalUsage, coveredTransactions: usageRows.length, byProduct: byProductUsage };
  }

  // Customer growth — active customers per month (distinct customer_id
  // transacting that month) and new customers per month (customers whose
  // EARLIEST transaction, across this dataset's whole history, falls in
  // that month) — two different, both real, questions: "how many
  // customers are transacting" vs. "how many of them are new."
  const firstMonthByCustomer = {};
  transactionRows.forEach((t) => {
    if (!t || !t.customer_id || !t.timestamp) return;
    const key = monthKey(t.timestamp);
    if (!key) return;
    if (!firstMonthByCustomer[t.customer_id] || key < firstMonthByCustomer[t.customer_id]) {
      firstMonthByCustomer[t.customer_id] = key;
    }
  });
  const activeByMonth = {};
  transactionRows.forEach((t) => {
    if (!t || !t.customer_id || !t.timestamp) return;
    const key = monthKey(t.timestamp);
    if (!key) return;
    activeByMonth[key] = activeByMonth[key] || new Set();
    activeByMonth[key].add(t.customer_id);
  });
  const newByMonth = {};
  Object.values(firstMonthByCustomer).forEach((key) => {
    newByMonth[key] = (newByMonth[key] || 0) + 1;
  });
  const months = Object.keys(activeByMonth).sort();
  const customerGrowth = {
    activeTrend: months.map((key) => ({ key, label: monthLabel(key), value: activeByMonth[key].size })),
    newTrend: months.map((key) => ({ key, label: monthLabel(key), value: newByMonth[key] || 0 })),
  };

  // Conversion — Freemium's own question: of the customers who started on
  // a free/trial entitlement, how many ever became a paying customer.
  // Needs an Entitlement `plan` value that actually says "free"/"trial"
  // for at least one customer; without that cohort, returns null rather
  // than a rate computed over the wrong denominator.
  let conversion = null;
  const freeCohort = new Set();
  entitlementRows.forEach((e) => {
    const planText = String((e || {}).plan || '').trim().toLowerCase();
    if (e && e.customer_id && (planText.includes('free') || planText.includes('trial'))) {
      freeCohort.add(e.customer_id);
    }
  });
  if (freeCohort.size > 0) {
    let convertedCount = 0;
    freeCohort.forEach((cid) => { if (payingCustomers.has(cid)) convertedCount += 1; });
    conversion = {
      freeCohortSize: freeCohort.size,
      convertedCount,
      rate: (convertedCount / freeCohort.size) * 100,
    };
  }

  // Churn — the same normalized Active/Expired split entitlementLifecycle()
  // already computes for the Entitlements tab, restated as a rate. Needs
  // at least one Active or Expired entitlement to mean anything.
  let churn = null;
  if (entitlementRows.length > 0) {
    const lifecycle = entitlementLifecycle(entitlementRows);
    const denom = lifecycle.active + lifecycle.expired;
    if (denom > 0) {
      churn = { activeCount: lifecycle.active, expiredCount: lifecycle.expired, rate: (lifecycle.expired / denom) * 100 };
    }
  }

  return {
    currency,
    totalRevenue,
    transactionCount: transactionRows.length,
    payingCustomerCount: payingCustomers.size,
    arpu,
    byMechanism,
    mechanismTable,
    byCustomer,
    byProduct,
    byPeriod,
    mrr,
    arr,
    mrrMonthLabel,
    usage,
    customerGrowth,
    conversion,
    churn,
  };
}

// Every raw row this dataset has ever ingested (dataset_records — BEFORE
// Map & Transform touches anything), grouped by file_type. This is the
// entire input to the raw-upload mode below: no cleaning, normalizing, or
// validation has happened to any of it yet.
async function getRawRecordsByFileType(accountId, datasetRowId) {
  const { rows } = await pool.query(
    `SELECT file_type, data FROM dataset_records
      WHERE account_id = $1 AND dataset_id = $2
      ORDER BY file_type, row_index`,
    [accountId, datasetRowId]
  );
  const map = {};
  rows.forEach((r) => {
    map[r.file_type] = map[r.file_type] || [];
    map[r.file_type].push(r.data);
  });
  return map;
}

// Picks the one raw file (by file_type) that best LOOKS like the given
// canonical entity — reusing services/mapping.js's own guessEntity() on
// that file's actual raw column headers, exactly the same heuristic the
// Map & Transform screen itself starts from — then shapes every row of
// that file into the entity's canonical field names via suggestMapping(),
// coercing declared-numeric fields to numbers. When several raw files
// guess to the same entity, the one with the most rows wins — a
// deliberately simple tie-break, not a claim that it's the "right" file.
// Nothing here is saved, confirmed, or validated: a row with no
// discoverable amount/customer is left as null and filtered out by the
// caller, not silently coerced to 0/"".
function pickRawEntityRows(rawByFileType, entityName) {
  let best = null;
  Object.entries(rawByFileType).forEach(([fileType, rows]) => {
    if (!rows || rows.length === 0) return;
    const columns = Object.keys(rows[0] || {});
    if (guessEntity(fileType, columns) !== entityName) return;
    if (!best || rows.length > best.rows.length) best = { fileType, rows, columns };
  });
  if (!best) return { rows: [], fileType: null, fieldMap: null };

  const fieldMap = suggestMapping(best.columns, entityName);
  const entitySpec = CANONICAL_ENTITIES[entityName];
  const shapedRows = best.rows.map((row) => {
    const shaped = {};
    Object.keys(entitySpec.fields).forEach((key) => {
      const source = fieldMap[key].source;
      if (!source) { shaped[key] = null; return; }
      let value = row[source];
      if (entitySpec.fields[key].type === 'number' && value !== null && value !== undefined && value !== '') {
        const n = Number(String(value).replace(/,/g, ''));
        value = Number.isFinite(n) ? n : null;
      }
      shaped[key] = value === undefined ? null : value;
    });
    return shaped;
  });
  return { rows: shapedRows, fileType: best.fileType, fieldMap };
}

// Raw-upload mode for the Revenue & Growth tab (and, since Round 7, every
// other raw-native mechanism-performance read in this app — Prescriptive's
// baseline included). Auto-detects which raw file looks like Transaction/
// Entitlement/MonetizationConfig data (pickRawEntityRows() above) and
// feeds the SAME revenueGrowthMetrics() core every mode goes through, so
// this only ever differs from a fully-reviewed read in how reviewed the
// input is, never in how a metric is defined or computed. Mechanism
// attribution runs the real Monetization Discovery Engine against these
// guessed rows (it needs nothing canonical-specific — just the same shape
// of rows), so Revenue by mechanism, MRR/ARR, and Mechanism contribution
// can all still be real numbers, not just placeholders — clearly labeled
// "auto-detected, unconfirmed" in the view, never presented as validated.
// The SME owner's own confirmed choice from the Monetization Discovery
// screen (getConfirmedClassifications(), keyed on dataset + product text,
// not a canonical row id) always wins over the live inference here too —
// this is the one place every mechanism-labeled view in the app reads
// from, so a confirmed choice needs to show up everywhere, not just on
// the Monetization Discovery screen itself.
async function buildRawRevenueGrowthAnalytics(accountId, datasetRowId) {
  const rawByFileType = await getRawRecordsByFileType(accountId, datasetRowId);
  if (Object.keys(rawByFileType).length === 0) {
    return { hasTransactionSignal: false };
  }

  const txn = pickRawEntityRows(rawByFileType, 'Transaction');
  if (txn.rows.length === 0) {
    return { hasTransactionSignal: false };
  }
  const ent = pickRawEntityRows(rawByFileType, 'Entitlement');
  const mon = pickRawEntityRows(rawByFileType, 'MonetizationConfig');

  const cleanTxns = txn.rows.filter((t) => t.amount !== null && !Number.isNaN(Number(t.amount)) && t.customer_id);
  const currency = mode(cleanTxns.map((t) => t.currency)) || mode(mon.rows.map((m) => m.currency)) || '';

  const discovery = discoverMechanisms(cleanTxns, ent.rows, mon.rows);
  const confirmedMechanisms = await getConfirmedClassifications(accountId, datasetRowId);
  const productModelMap = mergeConfirmedOverrides(discovery, confirmedMechanisms);

  const metrics = revenueGrowthMetrics({
    transactionRows: cleanTxns, entitlementRows: ent.rows, productModelMap, currency,
  });

  return {
    hasTransactionSignal: true,
    sourceFileType: txn.fileType,
    entitlementFileType: ent.fileType,
    monetizationConfigFileType: mon.fileType,
    rowCounts: { transactions: cleanTxns.length, skippedRows: txn.rows.length - cleanTxns.length },
    ...metrics,
  };
}

// Simple month-over-month delta on the trend series — the last two
// points, if there are at least two — for the Total revenue stat tile.
function trendDelta(trend) {
  if (trend.length < 2) return null;
  const prev = trend[trend.length - 2].value;
  const curr = trend[trend.length - 1].value;
  if (prev === 0) return null;
  return { pct: ((curr - prev) / Math.abs(prev)) * 100, prevLabel: trend[trend.length - 2].label };
}

// Pricing Catalog Overview — the deliberate exception to "every chart
// here needs Transaction data": some uploaded datasets are pure rate
// cards (a cloud provider's SKU/price-list export, for instance) with
// NO usage/billing events and NO customers at all — that's not missing
// data, it's the whole shape of the source file. Revenue, by
// definition, requires an actual transaction; it can never be computed
// from a price list alone, and this module never pretends otherwise —
// "Revenue by X" stays strictly Transaction-derived. What a pure
// MonetizationConfig dataset CAN honestly answer is a different,
// legitimate question: what does this SME's configured pricing catalog
// look like — how many products are priced, under which revenue
// models, at what price points, with how many tiers? This function
// answers exactly that, reading only MonetizationConfig rows, so a
// dataset with rich pricing data but zero transactions still shows
// something real instead of a wall of "no data yet" cards.
//
// Deliberately NOT a magnitude bar chart of "price by product": prices
// across different products are frequently denominated in incomparable
// units (e.g. $/API-call vs $/GB-month vs $/hour), so ranking them by
// raw price would double-encode unlike quantities as if they were one
// measure — the same mistake as a dual-axis chart. A per-product table
// (min–max price, its own unit, tier count) is the honest form here.
// `productModelMap` is the Monetization Discovery Engine's merged
// (confirmed > inferred) mechanism per product — see the
// discoverMechanisms()/mergeConfirmedOverrides() wiring in
// buildDescriptiveAnalytics() below — passed in rather than
// re-derived here so a pure rate-card dataset (no Transaction data to run
// behavioral discovery against at all) still gets the SAME mechanism
// label everywhere it appears, not a second, independently-guessed one.
function buildCatalogOverview(monetizationRows, productModelMap = {}) {
  if (monetizationRows.length === 0) return null;

  const byProduct = {};
  monetizationRows.forEach((row) => {
    const product = String((row || {}).product_service || '').trim() || 'Unspecified';
    byProduct[product] = byProduct[product] || {
      prices: [], tiers: new Set(), currencies: [], units: new Set(), configIds: new Set(),
    };
    const p = byProduct[product];
    if (typeof row.price === 'number') p.prices.push(row.price);
    if (row.tier) p.tiers.add(String(row.tier).trim());
    if (row.currency) p.currencies.push(row.currency);
    if (row.unit) p.units.add(String(row.unit).trim());
    if (row.config_id) p.configIds.add(row.config_id);
  });

  const products = Object.entries(byProduct).map(([product, p]) => {
    const modelType = productModelMap[product] || null;
    return {
      product,
      modelLabel: modelType ? MODEL_TYPE_LABELS[modelType] : UNCLASSIFIED_LABEL,
      minPrice: p.prices.length ? Math.min(...p.prices) : null,
      maxPrice: p.prices.length ? Math.max(...p.prices) : null,
      currency: mode(p.currencies) || '',
      unit: mode([...p.units]) || '',
      tierCount: p.tiers.size,
      skuCount: p.configIds.size || p.prices.length,
    };
  }).sort((a, b) => b.skuCount - a.skuCount);

  const skusByModel = {};
  products.forEach((p) => { skusByModel[p.modelLabel] = (skusByModel[p.modelLabel] || 0) + p.skuCount; });

  return {
    distinctProducts: products.length,
    distinctModels: new Set(products.map((p) => p.modelLabel)).size,
    totalSkus: monetizationRows.length,
    skusByModel: Object.entries(skusByModel)
      .map(([label, value]) => ({ label, value, isOther: label === UNCLASSIFIED_LABEL }))
      .sort((a, b) => b.value - a.value),
    products,
  };
}

// NOTE (Round 7): buildDescriptiveAnalytics() — the CMA Canonical Schema-
// only aggregate this module used to build (Transaction/Customer/
// Entitlement/MonetizationConfig canonical_records, joined against
// account-wide config/domain rollups) — was removed here. Every process
// in this app (Monetization Discovery, Descriptive/Diagnostic/Predictive/
// Prescriptive analytics, and Set-up monetization configuration's import)
// now reads directly from each dataset's own raw uploaded files via
// getRawRecordsByFileType()/pickRawEntityRows() below, never from
// canonical_records — see claude/cma-flow-app-conceptual-framework-audit.md
// in the project docs. getLatestValidCanonicalData() is kept, still
// exported, and still correct, but nothing in routes/dashboard.js calls
// it any more; it's reserved for the CMA Canonical Schema's own future-
// dissertation-extension screens (Map & Transform, the canonical record
// viewer), which are unaffected by this round.

// Exported below so the Phase 2/3/4 analytics modules (services/
// diagnosticAnalytics.js, predictiveAnalytics.js, prescriptiveAnalytics.js
// — see claude/canonical-schema-analytics-roadmap.md) can reuse the same
// raw-data fetch and derived-computation building blocks instead of
// re-querying or re-deriving them differently — "augment, don't overhaul"
// applies to this module's own internals too.
module.exports = {
  MODEL_TYPE_LABELS,
  UNCLASSIFIED_LABEL,
  getLatestValidCanonicalData,
  revenueTrend,
  monthKey,
  monthLabel,
  topNWithOther,
  mode,
  mechanismPerformanceTable,
  financialReconciliation,
  buildCatalogOverview,
  revenueGrowthMetrics,
  buildRawRevenueGrowthAnalytics,
  getRawRecordsByFileType,
  pickRawEntityRows,
  getDatasetDomainRollupRaw,
  buildDatasetDomainAnalysis,
};
