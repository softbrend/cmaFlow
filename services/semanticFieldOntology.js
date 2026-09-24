// Round 22 — Semantic Field Ontology.
//
// The shared vocabulary the hybrid embedding+classifier engine (services/
// semanticFieldEngine.js) is built against. This is deliberately NOT a
// second, competing list of roles — every key below is one of the roles
// already scored by services/businessSemantics.js's ROLE_RULES (plus the
// special-cased 'date' role). This module adds, for each role, the
// evidence the RULE engine can't produce on its own:
//
//   - conceptPhrases: short natural-language phrases a column's own name
//     (turned into readable text — "selling_amt" -> "selling amt") gets
//     compared against via word-embedding cosine similarity. This is what
//     lets CMA-Flow recognize a column it has never literally seen a name
//     for, as long as it reads as semantically close to a role it knows —
//     the worked example from the request that started this round:
//     "revenue", "sales amount", "total amount", "item total", "payment
//     value" should all read as MONETARY_OUTCOME / REVENUE even though no
//     single regex enumerates every SME's spelling of it.
//   - analyticsSupported: which of the four CMA-Flow analytics stages a
//     column playing this role can feed (see buildAnalyticsCapability()
//     below) — the "Analytics Recommendation Engine" step of the
//     integration request: once semantic roles are known, this is what
//     lets CMA-Flow say what combinations of roles present in a dataset
//     unlock which descriptive/diagnostic/predictive/prescriptive
//     capabilities, the same idea already used informally throughout this
//     app's "applicability" disclosures (e.g. "not applicable — no
//     revenue-shaped column was found").
//
// Pure data, no logic — kept separate from semanticEmbeddings.js (which
// does the actual vector math) so the ontology itself stays easy to read,
// extend, and cite in the dissertation's methodology section on its own.
const ROLE_ONTOLOGY = {
  revenue: {
    uiLabel: 'Revenue',
    conceptPhrases: ['revenue', 'sales amount', 'total amount', 'item total', 'payment value', 'gross amount', 'net amount', 'order total', 'grand total', 'earnings', 'takings', 'gross merchandise value'],
    analyticsSupported: ['descriptive', 'diagnostic', 'predictive', 'prescriptive'],
  },
  price: {
    uiLabel: 'Price',
    conceptPhrases: ['price', 'unit price', 'listed price', 'rate', 'fare', 'cost per unit', 'sticker price'],
    analyticsSupported: ['descriptive', 'diagnostic', 'predictive', 'prescriptive'],
  },
  cost: {
    uiLabel: 'Cost',
    conceptPhrases: ['cost', 'expense', 'expenditure', 'billing amount', 'spend', 'spending', 'charge'],
    analyticsSupported: ['descriptive', 'diagnostic', 'predictive', 'prescriptive'],
  },
  profit: {
    uiLabel: 'Profit / margin',
    conceptPhrases: ['profit', 'margin', 'net income', 'net earnings', 'net revenue', 'gross margin'],
    analyticsSupported: ['descriptive', 'diagnostic', 'predictive', 'prescriptive'],
  },
  quantity: {
    uiLabel: 'Quantity',
    conceptPhrases: ['quantity', 'units', 'volume', 'number of items', 'item count', 'units sold', 'order quantity'],
    analyticsSupported: ['descriptive', 'diagnostic', 'predictive', 'prescriptive'],
  },
  cost_category: {
    uiLabel: 'Cost category / vendor',
    conceptPhrases: ['service', 'vendor', 'provider', 'line item', 'resource type', 'expense category', 'sku'],
    analyticsSupported: ['descriptive', 'diagnostic'],
  },
  geo_dimension: {
    uiLabel: 'Geography',
    conceptPhrases: ['region', 'state', 'country', 'city', 'province', 'territory', 'zone', 'location'],
    analyticsSupported: ['descriptive', 'diagnostic'],
  },
  customer_id: {
    uiLabel: 'Customer identifier',
    conceptPhrases: ['customer identifier', 'user identifier', 'client identifier', 'member id', 'buyer id', 'account holder'],
    analyticsSupported: ['descriptive', 'diagnostic', 'predictive'],
  },
  merchant_id: {
    uiLabel: 'Merchant identifier',
    conceptPhrases: ['merchant identifier', 'vendor identifier', 'store identifier', 'seller identifier', 'restaurant identifier'],
    analyticsSupported: ['descriptive', 'diagnostic'],
  },
  product_id: {
    uiLabel: 'Product identifier',
    conceptPhrases: ['product identifier', 'item identifier', 'sku', 'menu item identifier', 'listing identifier'],
    analyticsSupported: ['descriptive', 'diagnostic', 'predictive', 'prescriptive'],
  },
  order_id: {
    uiLabel: 'Order / transaction identifier',
    conceptPhrases: ['order identifier', 'transaction identifier', 'invoice number', 'receipt number', 'booking reference'],
    analyticsSupported: ['descriptive', 'diagnostic'],
  },
  subscription_plan: {
    uiLabel: 'Subscription plan / tier',
    conceptPhrases: ['subscription plan', 'membership tier', 'plan type', 'package', 'pricing tier'],
    analyticsSupported: ['descriptive', 'diagnostic', 'predictive', 'prescriptive'],
  },
  name_label: {
    uiLabel: 'Name / label',
    conceptPhrases: ['name', 'title', 'label', 'display name'],
    analyticsSupported: ['descriptive'],
  },
  rating: {
    uiLabel: 'Rating / review score',
    conceptPhrases: ['rating', 'review score', 'star rating', 'customer satisfaction score', 'feedback score'],
    analyticsSupported: ['descriptive', 'diagnostic', 'predictive'],
  },
  status: {
    uiLabel: 'Status',
    conceptPhrases: ['order status', 'payment status', 'delivery status', 'shipment status', 'account status'],
    analyticsSupported: ['descriptive', 'diagnostic'],
  },
  discount: {
    uiLabel: 'Discount / promo',
    conceptPhrases: ['discount', 'promotion', 'coupon', 'markdown', 'rebate', 'price reduction'],
    analyticsSupported: ['diagnostic', 'prescriptive'],
  },
  availability: {
    uiLabel: 'Availability / stock',
    conceptPhrases: ['availability', 'in stock', 'occupancy', 'vacancy', 'booked', 'inventory level'],
    analyticsSupported: ['diagnostic', 'predictive'],
  },
  duration: {
    uiLabel: 'Duration',
    conceptPhrases: ['duration', 'delivery time', 'session length', 'elapsed time', 'lead time', 'turnaround time'],
    analyticsSupported: ['diagnostic', 'predictive'],
  },
  date: {
    uiLabel: 'Date / time',
    conceptPhrases: ['date', 'timestamp', 'order date', 'transaction date', 'event time'],
    analyticsSupported: ['descriptive', 'diagnostic', 'predictive'],
  },
};

// Common dataset-column abbreviations, expanded to real English words
// before a column name is embedded. Mean-pooled word-embedding vectors
// (see semanticEmbeddings.js) are weak on raw abbreviations — "amt",
// "qty", "no" are frequently out-of-vocabulary tokens that collapse to a
// generic "unknown" vector, which empirically inflated false-positive
// similarity across unrelated columns in this round's own verification
// (see claude/machine-learning-semantic-field-detection-engine.md's
// Method section for the before/after numbers). Deliberately a flat,
// inspectable dictionary — not itself learned — so it stays reviewable
// and citable on its own.
const ABBREVIATION_EXPANSIONS = {
  amt: 'amount', amts: 'amounts', qty: 'quantity', qtys: 'quantities',
  no: 'number', num: 'number', nos: 'numbers', pct: 'percent',
  desc: 'description', cust: 'customer', mfr: 'manufacturer',
  dt: 'date', ts: 'timestamp', addr: 'address', merch: 'merchandise',
  gmv: 'gross merchandise value', qty_ordered: 'quantity ordered',
  disc: 'discount', avail: 'availability', dur: 'duration',
  rev: 'revenue', mgn: 'margin', txn: 'transaction', ord: 'order',
  del: 'delivery', ship: 'shipment', pmt: 'payment', acct: 'account',
};

function knownRoles() {
  return Object.keys(ROLE_ONTOLOGY);
}

// Analytics-capability mapping (proposal item 8: "map semantic roles to
// the four analytics"). Given the SET of roles actually present and
// resolved in a dataset (across every uploaded file, not just the fact
// table), which of the four CMA-Flow analytics stages does that unlock?
// A stage is "unlocked" here in the loose, disclosure-oriented sense this
// app already uses everywhere else — an honest "here's what your data
// supports" read, not a hard gate that blocks a page from rendering (each
// page's own metric/finding-level applicability checks remain the real,
// authoritative gate — see services/metricRegistry.js and services/
// diagnosticEngine.js). This is presented as a dataset-level SUMMARY on
// top of that, not a replacement for it.
function buildAnalyticsCapabilitySummary(resolvedRoles) {
  const roleSet = new Set(resolvedRoles);
  const stages = { descriptive: new Set(), diagnostic: new Set(), predictive: new Set(), prescriptive: new Set() };
  roleSet.forEach((role) => {
    const entry = ROLE_ONTOLOGY[role];
    if (!entry) return;
    entry.analyticsSupported.forEach((stage) => stages[stage].add(role));
  });
  return {
    descriptive: { supported: stages.descriptive.size > 0, byRoles: [...stages.descriptive] },
    diagnostic: { supported: stages.diagnostic.size > 0, byRoles: [...stages.diagnostic] },
    predictive: { supported: stages.predictive.size > 0, byRoles: [...stages.predictive] },
    prescriptive: { supported: stages.prescriptive.size > 0, byRoles: [...stages.prescriptive] },
  };
}

module.exports = {
  ROLE_ONTOLOGY,
  ABBREVIATION_EXPANSIONS,
  knownRoles,
  buildAnalyticsCapabilitySummary,
};
