// Automatic Dataset Intelligence & Analytics Engine — Column Intelligence
// Engine + Business Semantic Mapping Engine.
//
// services/datasetProfiler.js already answers "what TYPE is this column"
// (numeric, currency, date, id, ...) for one file at a time. This module
// answers the next question, ACROSS the whole dataset: what BUSINESS ROLE
// does each column play (revenue, customer identifier, product
// identifier, ...), and what business role does each FILE play (the
// transaction fact table vs. a customer/product/merchant dimension)?
//
// This is the fix for the failure mode a real CMA-FLOW dataset exposed:
// a food-delivery upload's `food.csv` has no revenue or customer column
// at all — those live in `orders.csv`, joined in via `r_id`/`f_id`/
// `user_id`. Reading each file in isolation can never surface revenue
// for a dataset shaped like that; a column's business meaning, and a
// file's role in the dataset, can only be determined by reasoning across
// every uploaded file at once, using both what each column looks like on
// its own AND how it relates to every other file (see
// services/fullDescriptiveAnalytics.js's detectRelationships()).
//
// Deliberately NOT a call to an external AI/LLM API: every score below
// traces to a named, inspectable rule over the column's name, its
// already-computed type/statistics, its file's shape, and measured
// cross-file value overlap — the same discipline already used by
// services/monetizationDiscovery.js's mechanism inference. That keeps
// classification deterministic and reproducible (the same dataset
// uploaded twice, or uploaded by two different SMEs, always produces the
// same semantic model) and keeps every result explainable in plain
// language, which an LLM's classification would not guarantee. An LLM
// remains a legitimate OPTIONAL layer on top of this — turning the
// validated metrics this engine computes into SME-friendly prose — but
// never the thing computing them. See claude/business-semantic-metric-
// engine.md for the full design writeup.
//
// Pure functions only (no DB, no I/O) — services/fullDescriptiveAnalytics.js
// is the DB-aware layer that calls into this and persists the result,
// exactly the same split already used for services/datasetProfiler.js.

const { tryParseNumber } = require('./datasetProfiler');

// ---------------------------------------------------------------------
// Column semantic roles — the vocabulary the Metric Registry (services/
// metricRegistry.js) is written against. Each rule below scores how well
// ONE column fits ONE role; inferColumnSemanticRoles() then picks each
// column's single best-fitting role, if any clears ACCEPT_THRESHOLD.
// ---------------------------------------------------------------------
const ACCEPT_THRESHOLD = 0.5;

// Score(c, r) = NAME_W*name + KIND_W*kind + PATTERN_W*pattern +
//               UNIQUENESS_W*uniqueness + CONTEXT_W*context + RELATIONSHIP_W*relationship
// Weighted toward name + kind (the two strongest, cheapest signals) with
// the remaining, more situational evidence filling in the rest — sums to
// 1.0 so a role that scores full marks on every dimension reads as 1.0.
const NAME_W = 0.35;
const KIND_W = 0.25;
const PATTERN_W = 0.15;
const UNIQUENESS_W = 0.10;
const CONTEXT_W = 0.10;
const RELATIONSHIP_W = 0.05;

const ID_LIKE_EXCLUDE_RE = /(zip|postal|_no$|_num$|number|lic|licence|license|phone|fax)/i;

// A column named "cost"/"expenditure"/"billing_amount"/"spend" must never
// win the REVENUE role just because it also happens to contain a generic
// word like "total" or "amount" (see the 'revenue' rule's nameExcludeRe
// below) — this is the direct fix for CMA-FLOW auto-interpreting a GCP
// Cloud Billing "total_cost" column as SME revenue. Deliberately generic
// (no provider names) so it applies to any vendor-billing/expense export,
// not just GCP.
// Anchored on start/end/underscore/space rather than \b — a real GCP
// billing export's own column is commonly "Total_Cost_INR" or
// "Total_Cost", where "Cost" sits between two underscores; \b never
// creates a boundary next to "_" (itself a \w character), so \bcost\b
// would silently fail to match exactly the column this regex exists for.
// Same fix, same reasoning as cost_category/quantity/geo_dimension above.
const COST_KEYWORD_RE = /(?:^|[_ ])(?:costs?|expenditures?|expenses?|billing[_ ]?amount|spend|spending)(?:$|[_ ])|cloud[_ ]?cost/i;

// Cloud-provider billing vocabulary — used two ways: (1) below, as one of
// several signals that lets services/datasetClassifier.js name a cost
// dataset's business domain "Cloud Computing / IT Services"; (2) by
// reclassifyAmbiguousRevenueAsCost() further down, as one of the signals
// that catches a GENERIC amount/total column (no cost keyword to exclude
// it up front) sitting in what is otherwise clearly a cloud billing
// export. Not a hardcoded GCP-only path — AWS/Azure vocabulary is
// included too, and the reclassification logic that consumes this list
// also fires on a plain vendor/service dimension with no keyword match at
// all (see reclassifyAmbiguousRevenueAsCost).
const CLOUD_BILLING_KEYWORDS = [
  'gcp', 'google cloud', 'aws', 'amazon web services', 'azure', 'microsoft azure',
  'compute engine', 'cloud storage', 'bigquery', 'cloud sql', 'cloud run',
  'app engine', 'cloud function', 'kubernetes engine', 'cloud billing',
  'billing account', 'sku', 'project_id', 'resource_id', 'service_description',
  'usage_start_time', 'usage_end_time', 'cloud spend', 'cloud cost',
  'vm instance', 'virtual machine',
];

function monetaryPatternScore(col) {
  if (col.mean === null || col.count === 0) return 0;
  let score = 0;
  // Mostly non-negative (a handful of negatives read as refunds/discounts,
  // not disqualifying) — a column that's mostly negative is something
  // else (a cost/deduction), not a revenue or price figure.
  const negRatio = col.negativeCount / col.count;
  if (negRatio < 0.1) score += 0.5;
  // Excludes the two other numeric-family shapes this could really be: a
  // 0–5-ish rating (RATING_NAME_RE already routes those to kind
  // 'rating', but a plain 'numeric' column of small bounded values could
  // still be a star count) or a 0–1 fraction (already routed to
  // 'percentage' by kind, but double-checked here defensively).
  const looksRatingBounded = col.max !== null && col.max <= 5 && col.min !== null && col.min >= 0;
  const looksFraction = col.max !== null && col.max <= 1 && col.min !== null && col.min >= 0;
  if (!looksRatingBounded && !looksFraction) score += 0.5;
  return score;
}

// Does this file's column set look like a transaction/event row (one row
// = one sale/order/usage event) rather than a dimension row (one row =
// one customer/product/merchant record)? Used to bias REVENUE vs. PRICE
// and to gate whether a REVENUE-shaped number is likely a fact-table
// measure at all.
function fileLooksTransactional(fileProfile) {
  const hasDate = fileProfile.columns.some((c) => c.kind === 'date' && c.count > 0);
  const hasEventId = fileProfile.columns.some((c) => c.kind === 'id'
    && /\b(order|transaction|invoice|txn|receipt|booking|reservation)s?[_]?id\b|^(order|transaction|txn)$/i.test(c.name));
  const hasCustomerLikeId = fileProfile.columns.some((c) => c.kind === 'id'
    && /\b(customer|user|client|member|buyer|guest|shopper|reviewer)s?[_]?id\b/i.test(c.name));
  return { hasDate, hasEventId, hasCustomerLikeId, looksTransactional: hasDate || hasEventId || hasCustomerLikeId };
}

// Column-role rule table. `nameRe` / `expectedKinds` drive the name and
// kind components; `pattern`, `uniqueness`, and `context` are functions
// of (column, fileProfile) returning 0..1, kept as plain functions (not
// another layer of config) since each role's evidence genuinely differs
// in shape — a role that mostly cares about magnitude (REVENUE) and a
// role that mostly cares about cardinality (CUSTOMER_ID) don't share a
// generic pattern-check.
const ROLE_RULES = [
  {
    role: 'revenue',
    // The bare, generic tokens at the end ("amount"/"amt"/"total"/
    // "takings"/"earnings") are anchored on start/end/underscore/space
    // rather than \b — the same fix as COST_KEYWORD_RE just above, for
    // the same reason: a column named "Total_Amount_USD" or just "Total"
    // sitting between underscores would otherwise never match, since \b
    // never creates a boundary next to "_". The specific multi-word
    // phrases before it (order_total, total_amount, ...) already used
    // [_ ]? rather than \b and were never affected.
    nameRe: /revenue|sales[_ ]?amount|sales[_ ]?amt|gross[_ ]?amount|net[_ ]?amount|order[_ ]?total|grand[_ ]?total|line[_ ]?total|total[_ ]?amount|(?:^|[_ ])(?:amounts?|amt|totals?|takings|earnings)(?:$|[_ ])/i,
    // A column whose name reads as cost/expenditure/billing/spend must
    // never win REVENUE purely because it also matches a generic word
    // like "total" ("total_cost") — see COST_KEYWORD_RE above. This is
    // the column-name-level half of the cost/revenue guardrail; the
    // dataset-level half (a GENERIC "amount" column with no cost keyword
    // at all, sitting in what reads as a cloud/vendor billing export) is
    // caught separately by reclassifyAmbiguousRevenueAsCost() below.
    nameExcludeRe: COST_KEYWORD_RE,
    expectedKinds: new Set(['currency', 'numeric']),
    pattern: (col) => monetaryPatternScore(col),
    uniqueness: () => 0.6, // revenue values aren't expected to be unique OR repeating in any particular way
    context: (col, fp) => {
      const shape = fileLooksTransactional(fp);
      if (shape.hasDate && (shape.hasEventId || shape.hasCustomerLikeId)) return 1;
      if (shape.looksTransactional) return 0.6;
      return 0.2; // a pure dimension file's monetary column reads more like a listed PRICE than realized revenue
    },
  },
  {
    role: 'price',
    // Same underscore-boundary fix as revenue's nameRe above — a listed
    // "Unit_Cost_USD" or "Price_USD" column would otherwise never match.
    nameRe: /(?:^|[_ ])(?:prices?|costs?|rates?|fares?)(?:$|[_ ])|unit[_ ]?price/i,
    expectedKinds: new Set(['currency', 'numeric']),
    pattern: (col) => monetaryPatternScore(col),
    uniqueness: () => 0.6,
    context: (col, fp) => (fileLooksTransactional(fp).looksTransactional ? 0.4 : 1), // a listed price is most confidently a PRICE on a dimension row, not a fact row
  },
  {
    // A REALIZED cost/expenditure figure on a dated event row — e.g. a
    // cloud billing export's daily line-item cost, or any other vendor
    // invoice/expense export. Distinct from 'price' (a listed rate on a
    // dimension row) exactly the same way 'revenue' is distinct from a
    // listed price: this role is for money that was actually charged on
    // an event, not a catalog figure. See claude/monetization-discovery-
    // engine.md's cost-vs-revenue section for why this split exists.
    role: 'cost',
    nameRe: COST_KEYWORD_RE,
    expectedKinds: new Set(['currency', 'numeric']),
    pattern: (col) => monetaryPatternScore(col),
    uniqueness: () => 0.6,
    context: (col, fp) => {
      const shape = fileLooksTransactional(fp);
      // Most confidently a realized cost on a dated event row with no
      // customer-facing dimension (a billing line item, not a sale to a
      // customer) — a customer id doesn't rule it out (e.g. an internal
      // per-customer cost allocation), so it's scored lower, not zeroed.
      if (!shape.hasCustomerLikeId && shape.looksTransactional) return 1;
      if (shape.hasCustomerLikeId) return 0.4;
      return 0.6;
    },
  },
  {
    // The dimension a cost figure is broken down BY — a vendor's service
    // name, SKU, resource type, or line-item description. Generic on
    // purpose: a cloud bill's "service" column and a generic expense
    // export's "vendor" or "line_item" column both fit.
    role: 'cost_category',
    // Deliberately substring-style (no trailing \b after "service"/"sku")
    // rather than fully \b-wrapped: real column names commonly append an
    // underscore-joined suffix ("service_description", "sku_id"), and
    // since "_" is itself a \w character, \bservice\b would never match
    // inside "service_description" — there's no boundary between "e" and
    // "_". Matches the substring-scan style already used for DAAS_KEYWORDS
    // and CLOUD_BILLING_KEYWORDS above, for the same reason.
    nameRe: /service|\bsku\b|resource[_ ]?(?:type|name)?|line[_ ]?item|\bvendor\b|\bprovider\b|usage[_ ]?type|cost[_ ]?category|expense[_ ]?category/i,
    expectedKinds: new Set(['category']),
    pattern: (col) => (col.uniqueCount > 0 && col.uniqueCount <= 200 ? 1 : 0.3),
    uniqueness: () => 0.6,
    context: () => 0.6,
  },
  {
    // Geography dimension — the column CMA-FLOW breaks revenue/cost down
    // by region/state/country/zone/city. Deliberately a COLUMN role, not
    // a file role: this fires whether the geo column sits directly on the
    // fact table itself (a GCP billing export's own "Region_Zone" column)
    // or on an already-joined customer/merchant dimension file (Olist's
    // "customer_state" on customers.csv) — services/fullDescriptiveAnalytics.js
    // resolves both shapes the same way full-descriptive analytics already
    // resolves customer/merchant/product dimension lookups.
    // Substring-style (no \b around "region"/"zone"/"state"/"city") for the
    // exact reason documented on cost_category and quantity above: real
    // column names commonly compound these with an underscore
    // ("customer_state", "seller_city", "region_zone"), and "_" is itself a
    // \w character, so \bstate\b would never match inside "customer_state".
    role: 'geo_dimension',
    // Anchored on underscore/space/start/end rather than plain \b:
    // "customer_state"/"seller_city" are the exact real-world shape this
    // needs to catch, and \b never creates a boundary next to an
    // underscore (same bug already fixed twice above on cost_category and
    // quantity) — but a fully unanchored "state"/"city" substring would in
    // turn false-positive on ordinary English words like "estate",
    // "statement", or "capacity"/"electricity"/"velocity". Requiring the
    // term to start/end at a name boundary (^, $, "_", or " ") catches the
    // compound-name case those two roles need while still ruling those out.
    nameRe: /(?:^|[_ ])(?:region|zone|states?|country|province|territory|cit(?:y|ies))(?:$|[_ ])|geo[_ ]?location/i,
    expectedKinds: new Set(['category']),
    pattern: (col) => (col.uniqueCount > 0 && col.uniqueCount <= 500 ? 1 : 0.3),
    uniqueness: () => 0.6,
    context: () => 0.6,
  },
  {
    role: 'quantity',
    // No leading \b before "qty": "sales_qty"/"order_qty" are extremely
    // common real-world spellings, and the underscore right before "qty"
    // is itself a word character, so \bqty\b would never match them.
    // Same reasoning for the usage[_ ]?(?:amount|quantity|units?) branch —
    // a cloud billing export's "usage_amount"/"usage_quantity" column is
    // the resource-consumption measure services/datasetClassifier.js
    // reports as the dataset's "likely usage measure"; it's scoped to
    // that specific suffix so it doesn't also swallow "usage_type" or
    // "usage_start_time" (different kinds anyway — expectedKinds below
    // already excludes those).
    nameRe: /qty|quantity|usage[_ ]?(?:amount|quantity|units?)|\bunits?\b|_count$|^count$|num[_ ]?items?/i,
    expectedKinds: new Set(['numeric']),
    pattern: (col) => {
      if (col.mean === null) return 0;
      const looksSmallPositive = col.negativeCount === 0 && col.max !== null && col.max < 100000;
      return looksSmallPositive ? 1 : 0.3;
    },
    uniqueness: () => 0.5,
    context: (col, fp) => (fp.columns.some((c) => /price|amount|revenue|cost/i.test(c.name) && ['currency', 'numeric'].includes(c.kind)) ? 1 : 0.3),
  },
  {
    role: 'customer_id',
    nameRe: /\b(customer|user|client|member|buyer|guest|shopper)s?[_]?id\b|^(customer|user|client)$/i,
    expectedKinds: new Set(['id']),
    pattern: () => 0.7,
    uniqueness: (col) => (col.uniqueCount > 0 ? 0.7 : 0.3),
    context: (col, fp) => (fileLooksTransactional(fp).looksTransactional ? 0.6 : 1),
    relationshipTargetRe: /customer|user|client|member|buyer|guest|shopper/i,
  },
  {
    role: 'merchant_id',
    nameRe: /\b(restaurant|merchant|vendor|store|shop|seller|outlet|branch)s?[_]?id\b|^r_id$|^(restaurant|merchant|vendor|store)$/i,
    expectedKinds: new Set(['id']),
    pattern: () => 0.7,
    uniqueness: (col) => (col.uniqueCount > 0 ? 0.7 : 0.3),
    context: () => 0.7,
    relationshipTargetRe: /restaurant|merchant|vendor|store|shop|seller|outlet|branch/i,
  },
  {
    role: 'product_id',
    // "listing" added (Round 21) for booking/rental-calendar-shaped
    // datasets (e.g. a Seattle-Airbnb-style export) — the thing being
    // booked (a listing_id) plays the exact same "what's being sold"
    // role a product_id plays everywhere else in this file: a fact-table
    // row references it, and its own dimension file carries the
    // description/price/category data a what-if scenario or revenue
    // breakdown needs. Same multi-domain-alias style already used here
    // for "food|dish" (a restaurant dataset's menu item).
    nameRe: /\b(product|item|menu|sku|food|dish|listing)s?[_]?id\b|^f_id$|^menu_id$|^(product|item|menu|food|listing)$/i,
    expectedKinds: new Set(['id']),
    pattern: () => 0.7,
    uniqueness: (col) => (col.uniqueCount > 0 ? 0.7 : 0.3),
    context: () => 0.7,
    relationshipTargetRe: /product|item|menu|sku|food|dish|catalog|listing/i,
  },
  {
    role: 'order_id',
    nameRe: /\b(order|transaction|invoice|txn|receipt|booking|reservation)s?[_]?id\b|^(order|transaction|txn)$/i,
    expectedKinds: new Set(['id']),
    pattern: () => 0.7,
    // An order/transaction id is the file's OWN key — expected to be
    // near-unique (one row per event), unlike a foreign key that repeats.
    uniqueness: (col, fp) => (col.uniqueCount / Math.max(fp.rowCount, 1) > 0.9 ? 1 : 0.4),
    context: (col, fp) => (fileLooksTransactional(fp).hasDate ? 1 : 0.5),
  },
  {
    role: 'subscription_plan',
    nameRe: /\bplan\b|\btier\b|subscription|membership[_ ]?type|\bpackage\b/i,
    expectedKinds: new Set(['category']),
    pattern: (col) => (col.uniqueCount > 0 && col.uniqueCount <= 10 ? 1 : 0.3),
    uniqueness: () => 0.6,
    context: () => 0.6,
  },
  {
    // Also scored against kind 'id' columns, not just 'category'/'text':
    // a short, highly-unique text field (e.g. a customer's "name" column
    // in a small dimension file) can itself get typed 'id' by
    // datasetProfiler.js's short-code fallback heuristic (evidenced live
    // in testing — a 60-row "name" column of unique short strings).
    // Without this, such a column would only ever compete against
    // customer_id/merchant_id/product_id/order_id for its role — all of
    // which score it purely on generic id-shaped evidence, with nothing
    // to recognize it as the human-readable label a join should actually
    // display. Explicitly naming it here lets its strong name match win.
    role: 'name_label',
    // Round 21 — "category" was removed from this list. Unlike "cuisine"
    // or "city" (a column that can double as a record's display label
    // when no dedicated name/title field exists), a column literally
    // named "category" almost never IS the record's name — it groups
    // several rows under a shared value. Claiming it here was silently
    // starving services/metricRegistry.js's resolveCategoryColumn()
    // (direct case) and fullDescriptiveAnalytics.js's indirect/dimension
    // case (both gated on `!claimedNames.has(...)`) of the single most
    // common real-world category column name there is — breaking Top
    // Category, category revenue trends, and the ERD-based catalog-price
    // What-if scenario's category grouping for any dataset that simply
    // calls its category column "category". Left unclaimed here, it's
    // now correctly picked up by GENERIC_CATEGORY_NAME_RE instead.
    nameRe: /^(name|title|label|city|cuisine)$/i,
    expectedKinds: new Set(['category', 'text', 'id']),
    pattern: () => 0.7,
    uniqueness: () => 0.5,
    context: () => 0.5,
  },
  // ---------------------------------------------------------------------
  // Round 22 — six roles added to close a gap flagged (but not fixed) in
  // rounds 17 and 20: "Rating/status/boolean/URL columns are recognized
  // as physical *kinds* by the Stage 1 profiler (services/
  // datasetProfiler.js) but have no dedicated weighted *role* rule in
  // ROLE_RULES — a diagnostic/predictive finding that needs a rating or
  // status column currently finds it by profiled kind or name pattern
  // directly, bypassing this module's semantic-role confidence pipeline
  // that revenue/date/category roles already flow through." Adding them
  // here, in the SAME rule-based style as every role above, is what lets
  // the new hybrid embedding+classifier engine (services/
  // semanticFieldEngine.js) score them too — the hybrid engine only ever
  // ranks roles this table already knows about; it never invents one.
  {
    role: 'rating',
    nameRe: /rating|review[_ ]?score|\bstars?\b|\bscore\b|\bcsat\b|satisfaction/i,
    expectedKinds: new Set(['rating', 'numeric']),
    pattern: (col) => {
      if (col.mean === null) return 0;
      // A genuine rating is bounded and small (0-5, 1-5, 0-10) — a
      // "score" column running into the hundreds/thousands is something
      // else (e.g. a credit score or a raw count) wearing a rating-ish
      // name.
      const bounded = col.max !== null && col.max <= 10 && col.min !== null && col.min >= 0;
      return bounded ? 1 : 0.3;
    },
    uniqueness: () => 0.4, // ratings repeat heavily (most values cluster on 4s and 5s) — low uniqueness is expected, not disqualifying
    context: () => 0.6,
  },
  {
    role: 'status',
    // "state" is deliberately excluded here (geo_dimension already owns
    // it for US-state-shaped columns) — this only matches the
    // order/payment/delivery/account-lifecycle sense of "status".
    nameRe: /\bstatus\b|order[_ ]?status|payment[_ ]?status|delivery[_ ]?status|shipment[_ ]?status|account[_ ]?status|\bstage\b/i,
    expectedKinds: new Set(['category']),
    pattern: (col) => (col.uniqueCount > 0 && col.uniqueCount <= 20 ? 1 : 0.3), // a status column is a short enumerated set (delivered/cancelled/pending, ...), never a high-cardinality field
    uniqueness: () => 0.6,
    context: () => 0.6,
  },
  {
    // Same vocabulary as predictiveAnalyticsDynamic.js's own
    // AVAILABILITY_NAME_RE (Round 21) — kept as a separate, duplicated
    // regex rather than a shared import, deliberately: Round 21's
    // findAvailabilityColumn() is proven, tested, and reads directly off
    // fileProfile without depending on this role table at all; wiring it
    // through here instead would be a real refactor with real regression
    // risk to a feature that just shipped, for no behavior change. This
    // entry exists so `availability` is a first-class scoreable role for
    // the NEW hybrid engine and any future finding, without touching
    // Round 21's own code path.
    role: 'availability',
    nameRe: /available|availability|occupied|occupancy|vacan(?:t|cy)|is[_ ]?booked|\bbooked\b|in[_ ]?stock|\bstock\b|inventory/i,
    expectedKinds: new Set(['boolean', 'numeric']),
    pattern: () => 0.7,
    uniqueness: () => 0.3, // a boolean/stock-count field repeats heavily by nature
    context: () => 0.6,
  },
  {
    role: 'discount',
    nameRe: /discount|promo(?:tion)?|\bcoupon\b|markdown|\brebate\b/i,
    expectedKinds: new Set(['numeric', 'percentage', 'currency']),
    pattern: (col) => {
      if (col.mean === null) return 0;
      // A discount is a reduction — small relative to a typical price/
      // revenue figure (either a 0-1/0-100 percentage, or a currency
      // amount that's mostly non-negative and modest in size).
      const looksPercentLike = col.max !== null && col.max <= 100 && col.min !== null && col.min >= 0;
      return looksPercentLike ? 1 : 0.5;
    },
    uniqueness: () => 0.5,
    context: () => 0.6,
  },
  {
    role: 'duration',
    nameRe: /duration|session[_ ]?length|delivery[_ ]?time|\belapsed\b|time[_ ]?taken|\blead[_ ]?time\b|turnaround|response[_ ]?time|handling[_ ]?time/i,
    expectedKinds: new Set(['numeric']),
    pattern: (col) => (col.negativeCount === 0 ? 1 : 0.3), // a duration can never legitimately be negative
    uniqueness: () => 0.5,
    context: () => 0.6,
  },
  {
    role: 'profit',
    // Distinct from 'revenue' the same way 'cost' is: this is a realized
    // margin/net-income figure, not a top-line sales amount. Deliberately
    // no nameExcludeRe — "profit"/"margin"/"net_income" don't collide
    // with COST_KEYWORD_RE's vocabulary.
    nameRe: /\bprofit\b|\bmargin\b|net[_ ]?income|net[_ ]?earnings|net[_ ]?revenue/i,
    expectedKinds: new Set(['currency', 'numeric']),
    // Unlike revenue, a genuine profit/margin figure CAN legitimately run
    // negative (a loss-making period/order) — so this doesn't penalize
    // negative values the way monetaryPatternScore() does for revenue.
    pattern: (col) => (col.mean !== null ? 0.8 : 0),
    uniqueness: () => 0.6,
    context: (col, fp) => (fileLooksTransactional(fp).looksTransactional ? 0.7 : 0.5),
  },
];

function bandName(score) {
  return score >= 0.7 ? 'High' : score >= 0.4 ? 'Medium' : 'Low';
}

// Cross-file relationship evidence for an id-kind column: does it
// actually participate in a detected relationship (name-matched AND
// value-overlap-confirmed — see detectRelationships() in services/
// fullDescriptiveAnalytics.js) whose OTHER side belongs to a file whose
// name fits this role's expected target (e.g. customer_id's target
// pattern matches a file literally named "users" or "customers")?
function relationshipEvidence(fileType, columnName, relationships, targetRe) {
  if (!targetRe) return { score: 0.5, edge: null }; // role has no cross-file expectation — neutral, not a penalty
  const edge = relationships.find((r) => (
    (r.fromFile === fileType && r.fromColumn === columnName && targetRe.test(r.toFile))
    || (r.toFile === fileType && r.toColumn === columnName && targetRe.test(r.fromFile))
  ));
  if (!edge) return { score: 0.2, edge: null }; // no confirmed relationship found — still plausible from name/type alone, just unconfirmed
  return { score: Math.min(1, edge.overlapPct / 50), edge }; // a 50%+ overlap already reads as strong confirmation
}

// Scores every rule against one column, returns EVERY role that passed
// the hard gates (expected kind, name-exclude, name-hint-required for
// non-id kinds) with its own confidence + evidence, sorted best-first —
// not just the winner. Round 22 extraction: this used to be inlined
// inside scoreColumnRoles() below, which only ever kept the single best
// candidate. The new hybrid embedding+classifier engine (services/
// semanticFieldEngine.js) needs the FULL candidate list to blend its own
// per-role signals against — a column where rules say "revenue: 0.55,
// cost: 0.51" is a genuinely close call the hybrid engine should be able
// to re-rank using embedding/classifier evidence, which it never could if
// only the rule engine's single winner ever left this module.
function scoreAllColumnRoleCandidates(col, fileProfile, relationships) {
  if (ID_LIKE_EXCLUDE_RE.test(col.name) && col.kind !== 'id') return []; // license/zip/phone-shaped numbers are never a business measure
  const candidates = [];
  ROLE_RULES.forEach((rule) => {
    if (!rule.expectedKinds.has(col.kind)) return;
    if (rule.nameExcludeRe && rule.nameExcludeRe.test(col.name)) return; // e.g. "total_cost" must never win REVENUE just because it also contains "total"
    const nameScore = rule.nameRe.test(col.name) ? 1 : 0;
    if (nameScore === 0 && col.kind !== 'id') return; // for numeric/category roles, the name has to at least hint at it — a column called "bedrooms" should never accidentally score as revenue
    const kindScore = 1; // already filtered to an expected kind above
    const patternScore = rule.pattern(col, fileProfile);
    const uniquenessScore = rule.uniqueness(col, fileProfile);
    const contextScore = rule.context(col, fileProfile);
    const rel = col.kind === 'id'
      ? relationshipEvidence(fileProfile.fileType, col.name, relationships, rule.relationshipTargetRe)
      : { score: 0.5, edge: null };

    const total = (nameScore * NAME_W) + (kindScore * KIND_W) + (patternScore * PATTERN_W)
      + (uniquenessScore * UNIQUENESS_W) + (contextScore * CONTEXT_W) + (rel.score * RELATIONSHIP_W);

    const evidence = [];
    if (nameScore) evidence.push(`column name "${col.name}" matches the ${rule.role.replace(/_/g, ' ')} naming pattern`);
    evidence.push(`detected type: ${col.kind}`);
    if (patternScore >= 0.7) evidence.push('value distribution is consistent with this role');
    if (rel.edge) evidence.push(`confirmed relationship to ${rel.edge.toFile === fileProfile.fileType ? rel.edge.fromFile : rel.edge.toFile} (${rel.edge.overlapPct.toFixed(1)}% value overlap)`);
    candidates.push({
      role: rule.role, confidence: Math.round(total * 100) / 100, band: bandName(total), evidence, relationshipEdge: rel.edge,
    });
  });
  candidates.sort((a, b) => b.confidence - a.confidence);
  return candidates;
}

// Scores every rule against one column, returns the best-fitting role (if
// it clears ACCEPT_THRESHOLD) with its evidence trail in plain sentences
// — never a bare number handed to the view layer. Unchanged public
// behavior — now a thin wrapper over scoreAllColumnRoleCandidates().
function scoreColumnRoles(col, fileProfile, relationships) {
  const candidates = scoreAllColumnRoleCandidates(col, fileProfile, relationships);
  const best = candidates.length ? candidates[0] : null;
  if (!best || best.confidence < ACCEPT_THRESHOLD) return null;
  return best;
}

// Assigns each column in a file its single best semantic role (or none),
// plus tags the file's own primary date column with role 'date' directly
// — profileFile() already picked the most-complete date column, no need
// to re-derive that here.
function inferColumnSemanticRoles(fileProfile, relationships) {
  const columnRoles = {};
  fileProfile.columns.forEach((col) => {
    if (col.kind === 'date' && col.name === fileProfile.dateColumnName) {
      columnRoles[col.name] = {
        role: 'date', confidence: 1, band: 'High', evidence: [`"${col.name}" is this file's most complete date column`],
      };
      return;
    }
    const scored = scoreColumnRoles(col, fileProfile, relationships);
    if (scored) columnRoles[col.name] = scored;
  });
  return columnRoles;
}

// ---------------------------------------------------------------------
// File-role classification — Business-Entity Classification Engine.
// Given a file's column semantic roles, decide what business ENTITY this
// file represents: the transaction fact table (one row = one sale/order/
// usage event) vs. a dimension table describing customers, products, or
// merchants (one row = one entity record) vs. a subscription/usage log,
// vs. unclassified.
// ---------------------------------------------------------------------
const FILE_NAME_PATTERNS = {
  customer_dimension: /customer|user|client|member|guest|shopper/i,
  merchant_dimension: /restaurant|merchant|vendor|store|shop|seller|outlet|branch/i,
  product_dimension: /product|item|menu|food|dish|sku|catalog/i,
};

function classifyFileRole(fileProfile, columnRoles, relationships, allFileProfiles) {
  const roles = Object.values(columnRoles).map((r) => r.role);
  const hasRevenue = roles.includes('revenue');
  const hasCost = roles.includes('cost');
  const hasPrice = roles.includes('price');
  const hasQuantity = roles.includes('quantity');
  const hasDate = roles.includes('date');
  const hasOrderId = roles.includes('order_id');
  const hasCustomerId = roles.includes('customer_id');
  const hasMerchantId = roles.includes('merchant_id');
  const hasProductId = roles.includes('product_id');
  const hasSubscriptionPlan = roles.includes('subscription_plan');

  const evidence = [];

  // Transaction fact table: a real monetary measure — revenue, a
  // realized COST/expenditure (a cloud billing export's own fact table
  // has no revenue column at all, only cost), price+quantity implying
  // one can be derived, or a bare price column on a row that is already
  // shaped like a transaction event (has a date or order id) — a line-item
  // file such as "order_items.csv" (one row per item, a unit price, no
  // separate quantity column) is exactly this shape and is itself a
  // legitimate summable measure.
  const hasMeasure = hasRevenue || hasCost || (hasPrice && hasQuantity)
    || (hasPrice && (hasDate || hasOrderId));
  const hasFactShape = hasDate || hasOrderId || (hasCustomerId && (hasMerchantId || hasProductId));
  if (hasMeasure && hasFactShape) {
    let confidence = 0.5;
    if (hasRevenue) { confidence += 0.2; evidence.push('has a column scored as REVENUE'); }
    if (hasCost) { confidence += 0.2; evidence.push('has a column scored as COST/EXPENSE'); }
    if (!hasRevenue && !hasCost && hasPrice) { confidence += 0.15; evidence.push('has a column scored as PRICE (a per-item measure that sums to revenue)'); }
    if (hasDate) { confidence += 0.15; evidence.push('has a date column (one row per dated event)'); }
    if (hasOrderId) { confidence += 0.1; evidence.push('has an order/transaction id column'); }
    if (hasCustomerId) { confidence += 0.1; evidence.push('has a customer identifier'); }
    return { role: 'transaction_fact', confidence: Math.min(1, confidence), band: bandName(Math.min(1, confidence)), evidence };
  }

  // Dimension tables: classified by filename pattern + owning an id that
  // other files reference (this file is the "one" side of a one-to-many
  // relationship), and critically, NO revenue or cost column of its own —
  // a dimension row describes an entity, it doesn't record a sale or a
  // billed expense.
  const isReferencedByAnotherFile = relationships.some((r) => r.toFile === fileProfile.fileType || r.fromFile === fileProfile.fileType);
  if (!hasRevenue && !hasCost) {
    const nameEntries = Object.entries(FILE_NAME_PATTERNS);
    for (let i = 0; i < nameEntries.length; i += 1) {
      const [dimRole, re] = nameEntries[i];
      if (re.test(fileProfile.fileType)) {
        let confidence = 0.55;
        evidence.push(`file name "${fileProfile.fileType}" matches the ${dimRole.replace('_dimension', '')} naming pattern`);
        if (isReferencedByAnotherFile) { confidence += 0.25; evidence.push('referenced by another uploaded file via a detected relationship'); }
        if (fileProfile.columns.some((c) => c.kind === 'id')) { confidence += 0.1; evidence.push('has its own identifier column'); }
        return { role: dimRole, confidence: Math.min(1, confidence), band: bandName(Math.min(1, confidence)), evidence };
      }
    }
  }

  // Subscription/entitlement dimension: plan/tier column tied to a
  // customer, no revenue of its own (revenue for a subscription lives in
  // the transaction/billing file, not the plan-membership file).
  if (hasSubscriptionPlan && hasCustomerId && !hasRevenue) {
    return {
      role: 'subscription_dimension', confidence: 0.6, band: 'Medium', evidence: ['has a subscription/plan column tied to a customer identifier'],
    };
  }

  // Usage/event log: a quantity/usage measure over time, no revenue —
  // e.g. an API-call log or app-usage event stream billed elsewhere.
  if (hasQuantity && hasDate && !hasRevenue && (hasCustomerId || hasProductId)) {
    return {
      role: 'usage_log', confidence: 0.55, band: 'Medium', evidence: ['has a quantity/usage measure over time with no revenue column of its own'],
    };
  }

  // Generic dimension fallback: no name match, but this file is clearly
  // referenced by another (it's someone else's foreign key target) and
  // carries no revenue — still worth labeling as SOME kind of dimension
  // rather than leaving it unclassified.
  if (!hasRevenue && isReferencedByAnotherFile && fileProfile.columns.some((c) => c.kind === 'id')) {
    return {
      role: 'generic_dimension', confidence: 0.4, band: 'Low', evidence: ['referenced by another uploaded file, but its business entity could not be named from its filename'],
    };
  }

  return {
    role: 'unclassified', confidence: 0, band: 'Low', evidence: ['no revenue, dimension-naming, subscription, or usage signal was found for this file'],
  };
}

// ---------------------------------------------------------------------
// Revenue -> cost reclassification. A column can win the REVENUE role
// purely on a generic name like "amount"/"total" — there's no cost
// keyword on it for the 'revenue' rule's nameExcludeRe to catch (that
// only handles the OTHER case: a column that already names itself
// cost/expenditure/billing/spend). This is the exact real-world failure
// this catches: a genuine GCP Cloud Billing export whose raw column is
// literally just called "amount", carrying GCP Compute Engine charges —
// a generic name proves nothing about cost vs. revenue on its own, so
// this looks at the file (and dataset) it actually sits in instead. When
// that file has NO customer-facing dimension at all, and either the
// dataset references cloud/vendor billing vocabulary or the same file
// carries a service/SKU/vendor dimension column, the "revenue" reads as
// an expense record wearing a generic label — reclassified to COST.
// A real customer dimension on the file is always trusted as-is; this
// only ever second-guesses a REVENUE call, never a genuine one.
function reclassifyAmbiguousRevenueAsCost(files) {
  const allNames = files.flatMap((f) => [f.fileType, ...Object.keys(f.columnRoles)]).join(' ').toLowerCase();
  const cloudHit = CLOUD_BILLING_KEYWORDS.find((kw) => allNames.includes(kw));

  files.forEach((f) => {
    const revenueEntry = Object.entries(f.columnRoles).find(([, r]) => r.role === 'revenue');
    if (!revenueEntry) return;
    const hasCustomerDim = Object.values(f.columnRoles).some((r) => r.role === 'customer_id');
    if (hasCustomerDim) return; // a real customer dimension is present — trust REVENUE as scored
    const vendorDimEntry = Object.entries(f.columnRoles).find(([, r]) => r.role === 'cost_category');
    if (!cloudHit && !vendorDimEntry) return; // no contextual reason to doubt REVENUE

    const [colName, roleInfo] = revenueEntry;
    const reasons = ['no customer identifier was found in this file'];
    if (vendorDimEntry) reasons.push(`a "${vendorDimEntry[0]}" service/vendor dimension is present instead`);
    if (cloudHit) reasons.push(`this dataset references cloud-provider billing vocabulary ("${cloudHit}")`);
    f.columnRoles[colName] = {
      ...roleInfo,
      role: 'cost',
      evidence: [...roleInfo.evidence, `Reclassified from REVENUE to COST: ${reasons.join(' and ')} — this reads as an expense/billing record, not confirmed customer revenue.`],
    };
  });
}

// ---------------------------------------------------------------------
// Whole-dataset orchestration: classify every file, then pick the single
// best transaction-fact candidate (if any) to anchor cross-file metric
// computation on — services/metricRegistry.js reads from THIS file's
// rows, joined out to whichever dimension files its foreign keys
// actually resolve to.
// ---------------------------------------------------------------------
function buildSemanticModel(fileProfiles, relationships) {
  const files = fileProfiles.map((fp) => {
    const columnRoles = inferColumnSemanticRoles(fp, relationships);
    const fileRole = classifyFileRole(fp, columnRoles, relationships, fileProfiles);
    return {
      fileType: fp.fileType, rowCount: fp.rowCount, ...fileRole, columnRoles,
    };
  });

  reclassifyAmbiguousRevenueAsCost(files);

  // Re-run file-role classification for any file whose measure just
  // changed from REVENUE to COST, so `role`/`evidence` (transaction_fact
  // vs. dimension) reflect the corrected column roles too.
  files.forEach((f, i) => {
    Object.assign(f, classifyFileRole(fileProfiles[i], f.columnRoles, relationships, fileProfiles));
  });

  const factCandidates = files.filter((f) => f.role === 'transaction_fact');
  const factFile = factCandidates.length
    ? factCandidates.sort((a, b) => b.confidence - a.confidence || b.rowCount - a.rowCount)[0]
    : null;

  return { files, factFileType: factFile ? factFile.fileType : null };
}

module.exports = {
  inferColumnSemanticRoles,
  scoreAllColumnRoleCandidates, // Round 22 — full candidate list, for services/semanticFieldEngine.js
  classifyFileRole,
  buildSemanticModel,
  bandName,
  ACCEPT_THRESHOLD,
  ROLE_RULES, // Round 22 — role names + evidence hooks, for the embedding engine's concept-phrase table and the classifier's label set
  ID_LIKE_EXCLUDE_RE, // Round 22 — same license/zip/phone safety net, reused by services/semanticFieldEngine.js
  tryParseNumber, // re-exported for services/metricRegistry.js convenience
  CLOUD_BILLING_KEYWORDS, // re-exported for services/datasetClassifier.js's domain-naming step
};
