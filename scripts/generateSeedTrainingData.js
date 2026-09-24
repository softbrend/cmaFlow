// Round 22 — generates the SEED labeled training dataset for the semantic
// field classifier (services/semanticFieldClassifier.js).
//
// Disclosed limitation, deliberately not hidden anywhere this data is
// used: there is no real corpus yet of "column name -> SME-confirmed
// semantic role" pairs across multiple uploaded datasets — every example
// below is synthetic, built from (a) the column-name synonym lists
// already documented in services/businessSemantics.js's ROLE_RULES and
// services/semanticFieldOntology.js's concept phrases, plus the specific
// worked examples the integration request itself gave (revenue,
// sales_amount, total_amount, item_total, payment_value, ...), and (b)
// programmatically varied, plausible-but-invented value statistics per
// role (a revenue-shaped column gets a randomized currency-like mean/max/
// cv; a customer_id-shaped column gets a randomized high uniqueness
// ratio; ...). This is a legitimate, disclosed BOOTSTRAP — a first-pass
// baseline that gets the classifier running and evaluable end-to-end —
// not a claim that its accuracy numbers reflect real-world SME data.
// Real, SME-confirmed labels accumulate via the confirmation UI (services/
// semanticFieldEngine.js's confidence-gated flagging + the
// field_role_feedback table) and get folded in by scripts/
// retrainSemanticClassifier.js, at which point the classifier's reported
// metrics start meaning something closer to what the dissertation's
// evaluation section should ultimately report.
//
// Run: node scripts/generateSeedTrainingData.js
// Writes: ml-data/seed-training-data.json
const fs = require('fs');
const path = require('path');
const { extractColumnFeatures } = require('../services/semanticFeatureExtraction');

function seededRandom(seed) {
  let s = seed % 2147483647;
  if (s <= 0) s += 2147483646;
  return function next() {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
}
const rand = seededRandom(20260922);
function randRange(min, max) { return min + rand() * (max - min); }
function randInt(min, max) { return Math.floor(randRange(min, max + 1)); }
function pick(arr) { return arr[randInt(0, arr.length - 1)]; }

// role -> { names: [column-name variants], kind, statGen(rand) -> partial col fields, context (optional overrides) }
const ROLE_EXAMPLES = {
  revenue: {
    names: ['revenue', 'sales_amount', 'sales_amt', 'total_amount', 'item_total', 'payment_value', 'gross_amount', 'net_amount', 'order_total', 'grand_total', 'earnings', 'takings', 'selling_amt', 'gross_merch_value', 'gmv', 'amount', 'total'],
    kind: 'currency',
    stat: () => ({ mean: randRange(50, 8000), max: randRange(200, 30000), min: 0, cv: randRange(20, 120), negativeCount: randInt(0, 3), count: randInt(80, 5000) }),
    context: { hasDate: true, hasEventId: true },
  },
  price: {
    names: ['price', 'unit_price', 'listed_price', 'rate', 'fare', 'cost_per_unit', 'item_price', 'sticker_price'],
    kind: 'currency',
    stat: () => ({ mean: randRange(5, 500), max: randRange(20, 2000), min: 1, cv: randRange(15, 80), negativeCount: 0, count: randInt(50, 2000) }),
    context: { hasDate: false, hasEventId: false },
  },
  cost: {
    names: ['cost', 'expense', 'expenditure', 'billing_amount', 'spend', 'spending', 'charge', 'unit_cost', 'total_cost'],
    kind: 'currency',
    stat: () => ({ mean: randRange(10, 3000), max: randRange(50, 10000), min: 0, cv: randRange(20, 100), negativeCount: randInt(0, 2), count: randInt(80, 3000) }),
    context: { hasDate: true, hasEventId: false, hasCustomerLikeId: false },
  },
  profit: {
    names: ['profit', 'margin', 'net_income', 'net_earnings', 'net_revenue', 'gross_margin'],
    kind: 'currency',
    stat: () => ({ mean: randRange(-200, 2000), max: randRange(100, 5000), min: randRange(-1000, 0), cv: randRange(30, 150), negativeCount: randInt(0, 20), count: randInt(80, 2000) }),
    context: { hasDate: true },
  },
  quantity: {
    names: ['qty', 'quantity', 'units', 'volume', 'unit_count', 'num_items', 'order_qty', 'sales_qty', 'usage_amount', 'usage_quantity'],
    kind: 'numeric',
    stat: () => ({ mean: randRange(1, 50), max: randRange(5, 500), min: 1, cv: randRange(20, 90), negativeCount: 0, count: randInt(80, 3000) }),
    context: { hasDate: true },
  },
  cost_category: {
    names: ['service', 'vendor', 'provider', 'line_item', 'resource_type', 'expense_category', 'sku', 'service_description'],
    kind: 'category',
    stat: () => ({ uniqueCount: randInt(3, 150), count: randInt(80, 3000) }),
  },
  geo_dimension: {
    names: ['region', 'state', 'country', 'city', 'province', 'territory', 'zone', 'customer_state', 'seller_city', 'geo_location'],
    kind: 'category',
    stat: () => ({ uniqueCount: randInt(3, 300), count: randInt(80, 5000) }),
  },
  customer_id: {
    names: ['customer_id', 'user_id', 'client_id', 'member_id', 'buyer_id', 'guest_id', 'shopper_id', 'customer_no', 'cust_id'],
    kind: 'id',
    stat: () => { const count = randInt(80, 5000); return { count, uniqueCount: Math.round(count * randRange(0.4, 1)) }; },
  },
  merchant_id: {
    names: ['restaurant_id', 'merchant_id', 'vendor_id', 'store_id', 'seller_id', 'outlet_id', 'branch_id'],
    kind: 'id',
    stat: () => { const count = randInt(50, 2000); return { count, uniqueCount: Math.round(count * randRange(0.3, 0.95)) }; },
  },
  product_id: {
    names: ['product_id', 'item_id', 'menu_id', 'sku_id', 'food_id', 'dish_id', 'listing_id'],
    kind: 'id',
    stat: () => { const count = randInt(50, 3000); return { count, uniqueCount: Math.round(count * randRange(0.3, 0.95)) }; },
  },
  order_id: {
    names: ['order_id', 'transaction_id', 'invoice_id', 'txn_id', 'receipt_id', 'booking_id', 'reservation_id'],
    kind: 'id',
    stat: () => { const count = randInt(80, 5000); return { count, uniqueCount: Math.round(count * randRange(0.9, 1)) }; },
    context: { hasDate: true },
  },
  subscription_plan: {
    names: ['plan', 'tier', 'subscription', 'membership_type', 'package', 'plan_type', 'pricing_tier'],
    kind: 'category',
    stat: () => ({ uniqueCount: randInt(2, 8), count: randInt(80, 3000) }),
  },
  name_label: {
    names: ['name', 'title', 'label', 'display_name'],
    kind: 'text',
    stat: () => ({ count: randInt(80, 2000), avgLength: randInt(5, 40) }),
  },
  rating: {
    names: ['rating', 'review_score', 'star_rating', 'customer_satisfaction_score', 'feedback_score', 'stars'],
    kind: 'rating',
    stat: () => ({ mean: randRange(2.5, 4.8), max: pick([5, 10]), min: pick([0, 1]), cv: randRange(10, 40), negativeCount: 0, count: randInt(80, 3000) }),
  },
  status: {
    names: ['status', 'order_status', 'payment_status', 'delivery_status', 'shipment_status', 'account_status'],
    kind: 'category',
    stat: () => ({ uniqueCount: randInt(2, 10), count: randInt(80, 3000) }),
  },
  discount: {
    names: ['discount', 'promo', 'promotion', 'coupon', 'markdown', 'rebate', 'discount_pct'],
    kind: 'percentage',
    stat: () => ({ mean: randRange(2, 30), max: randRange(10, 80), min: 0, cv: randRange(20, 100), negativeCount: 0, count: randInt(50, 2000) }),
  },
  availability: {
    names: ['available', 'availability', 'occupied', 'occupancy', 'vacancy', 'is_booked', 'booked', 'in_stock', 'stock', 'inventory'],
    kind: 'boolean',
    stat: () => ({ count: randInt(80, 5000) }),
  },
  duration: {
    names: ['duration', 'session_length', 'delivery_time', 'elapsed_time', 'lead_time', 'turnaround_time', 'response_time', 'handling_time'],
    kind: 'numeric',
    stat: () => ({ mean: randRange(2, 200), max: randRange(10, 1000), min: 0, cv: randRange(30, 150), negativeCount: 0, count: randInt(50, 2000) }),
  },
  date: {
    names: ['date', 'order_date', 'timestamp', 'transaction_date', 'event_time', 'purchase_dt', 'order_dt'],
    kind: 'date',
    stat: () => ({ count: randInt(80, 5000) }),
  },
};

// Negative class — columns that plausibly appear in real SME datasets but
// don't map to any business role in the ontology. Essential so the
// classifier doesn't force every unfamiliar column into its nearest role
// — the same "don't force it, flag it as novel" principle the hybrid
// engine's UNKNOWN_NEW_ROLE path implements at the rule/embedding level.
const NONE_EXAMPLES = {
  names: ['bedrooms', 'bathrooms', 'description', 'notes', 'comments', 'phone', 'fax', 'zip_code', 'postal_code', 'url', 'image_url', 'latitude', 'longitude', 'is_active', 'created_by', 'updated_by', 'color', 'size', 'weight_kg', 'square_feet'],
  kinds: ['numeric', 'text', 'category', 'boolean'],
  stat: (kind) => {
    if (kind === 'numeric') return { mean: randRange(1, 100), max: randRange(10, 500), min: 0, cv: randRange(10, 80), negativeCount: 0, count: randInt(50, 2000) };
    if (kind === 'category') return { uniqueCount: randInt(2, 50), count: randInt(50, 2000) };
    if (kind === 'boolean') return { count: randInt(50, 2000) };
    return { count: randInt(50, 2000), avgLength: randInt(3, 60) };
  },
};

const VARIATIONS_PER_NAME = 3;

function buildFileProfile(contextOverrides) {
  const ctx = { hasDate: false, hasEventId: false, hasCustomerLikeId: false, ...contextOverrides };
  const cols = [];
  if (ctx.hasDate) cols.push({ name: 'order_date', kind: 'date', count: 500 });
  if (ctx.hasEventId) cols.push({ name: 'order_id', kind: 'id', count: 500 });
  if (ctx.hasCustomerLikeId) cols.push({ name: 'customer_id', kind: 'id', count: 500 });
  return { columns: cols };
}

function main() {
  const rows = [];
  Object.entries(ROLE_EXAMPLES).forEach(([role, spec]) => {
    spec.names.forEach((name) => {
      for (let i = 0; i < VARIATIONS_PER_NAME; i += 1) {
        const col = { name, kind: spec.kind, missing: randInt(0, 5), ...spec.stat() };
        const fp = buildFileProfile(spec.context);
        const { vector } = extractColumnFeatures(col, fp);
        rows.push({ columnName: name, role, vector });
      }
    });
  });
  NONE_EXAMPLES.names.forEach((name) => {
    for (let i = 0; i < VARIATIONS_PER_NAME; i += 1) {
      const kind = pick(NONE_EXAMPLES.kinds);
      const col = { name, kind, missing: randInt(0, 5), ...NONE_EXAMPLES.stat(kind) };
      const fp = buildFileProfile({});
      const { vector } = extractColumnFeatures(col, fp);
      rows.push({ columnName: name, role: 'none', vector });
    }
  });

  // Shuffle (Fisher-Yates, same seeded RNG) so train/test splitting later
  // doesn't accidentally bucket a whole role's examples together.
  for (let i = rows.length - 1; i > 0; i -= 1) {
    const j = randInt(0, i);
    [rows[i], rows[j]] = [rows[j], rows[i]];
  }

  const outPath = path.join(__dirname, '..', 'ml-data', 'seed-training-data.json');
  fs.writeFileSync(outPath, JSON.stringify({
    generatedAt: new Date().toISOString(),
    source: 'synthetic-seed',
    disclosure: 'Every row here is synthetic (invented names/statistics from documented synonym lists), NOT real SME-confirmed data. See scripts/generateSeedTrainingData.js header.',
    rowCount: rows.length,
    roleCounts: rows.reduce((acc, r) => { acc[r.role] = (acc[r.role] || 0) + 1; return acc; }, {}),
    rows,
  }, null, 0));
  console.log(`Wrote ${rows.length} labeled rows to ${outPath}`);
  console.log('Role distribution:', rows.reduce((acc, r) => { acc[r.role] = (acc[r.role] || 0) + 1; return acc; }, {}));
}

main();
