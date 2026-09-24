// Descriptive Analytics Decision Framework — a schema-driven report
// selector for arbitrary, multi-file raw dataset uploads (e.g. Olist's
// eight linked CSVs: orders, order_items, products, customers, sellers,
// order_payments, order_reviews, geolocation), ported from the SME
// researcher's own design document ("Descriptive Analytics Decision
// Framework for SME Raw Dataset Uploads").
//
// This is a THIRD kind of raw-file analysis, distinct from the other two
// already in this app:
//   - services/evaluationReport.js runs on ONE raw file at a time and
//     asks "is this file's data clean and ready?"
//   - services/monetizationDiscovery.js runs on the CMA CANONICAL
//     SCHEMA (post Map & Transform) and asks "what pricing mechanism is
//     this product actually run under?"
//   - this module runs on EVERY raw file in a dataset TOGETHER (joined
//     on shared key columns, exactly like the source document's Section
//     6 worked example) and asks "given whichever columns this SME
//     actually uploaded, which of a standard catalog of 30 e-commerce
//     descriptive-analytics reports can be computed correctly right
//     now, and what's the SME one column away from unlocking?" It is
//     deliberately framed around a different domain model (Order /
//     Item / Seller / Payment / Delivery / Review) than the app's own
//     CMA Canonical Schema (Customer / Transaction / Entitlement /
//     MonetizationConfig) — this is a generic descriptive layer for
//     "whatever transactional shape the SME happened to upload," not a
//     replacement for the canonical pipeline.
//
// Runs entirely on dataset_records (BEFORE Map & Transform), the same
// place Browse Dataset and the Evaluation Report already read from.
const {
  normalizeColumnName, parseNumericLoose, parseDateLoose, quantile, mean,
  histogramBuckets, monthKeyFrom, monthLabelFrom, WEEKDAY_NAMES,
} = require('./statsUtils');

// ------------------------------------------------------------------
// Section 2 — Canonical Field Roles
// ------------------------------------------------------------------
const CANONICAL_ROLES = {
  ORD: { label: 'Order ID', dtype: 'id', aliases: ['order_id', 'order_number', 'order_no', 'orderid'] },
  DATE: { label: 'Order Date', dtype: 'date', aliases: ['order_purchase_timestamp', 'order_date', 'purchase_date', 'order_datetime', 'date', 'transaction_date', 'order_time'] },
  CUST: { label: 'Customer ID', dtype: 'id', aliases: ['customer_id', 'customer_unique_id', 'client_id', 'buyer_id'] },
  CAT: { label: 'Product Category', dtype: 'category', aliases: ['product_category_name', 'product_category', 'category', 'product_category_name_english'] },
  PROD: { label: 'Product ID', dtype: 'id', aliases: ['product_id', 'item_id', 'sku', 'product_code'] },
  PRICE: { label: 'Item Price', dtype: 'numeric', aliases: ['price', 'item_price', 'sales', 'revenue', 'amount', 'line_total'] },
  QTY: { label: 'Quantity', dtype: 'numeric', aliases: ['quantity', 'qty', 'item_count', 'units', 'order_item_id'] },
  FREIGHT: { label: 'Freight Value', dtype: 'numeric', aliases: ['freight_value', 'freight', 'shipping_cost', 'shipping_fee'] },
  SELL: { label: 'Seller ID', dtype: 'id', aliases: ['seller_id', 'vendor_id', 'merchant_id'] },
  PTYPE: { label: 'Payment Type', dtype: 'category', aliases: ['payment_type', 'payment_method'] },
  PINST: { label: 'Payment Installments', dtype: 'numeric', aliases: ['payment_installments', 'installments'] },
  PVAL: { label: 'Payment Value', dtype: 'numeric', aliases: ['payment_value', 'payment_amount'] },
  REV: { label: 'Review Score', dtype: 'numeric', aliases: ['review_score', 'rating', 'review_rating', 'score'] },
  STAT: { label: 'Order Status', dtype: 'category', aliases: ['order_status', 'status'] },
  DACT: { label: 'Actual Delivery Date', dtype: 'date', aliases: ['order_delivered_customer_date', 'delivered_date', 'actual_delivery_date', 'delivery_date'] },
  DEST: { label: 'Estimated Delivery Date', dtype: 'date', aliases: ['order_estimated_delivery_date', 'estimated_delivery_date', 'eta'] },
  CGEO: { label: 'Customer Geography', dtype: 'category', aliases: ['customer_state', 'customer_city', 'customer_geo', 'customer_location'] },
  SGEO: { label: 'Seller Geography', dtype: 'category', aliases: ['seller_state', 'seller_city', 'seller_geo', 'seller_location'] },
};
const ROLE_KEYS = Object.keys(CANONICAL_ROLES);
// "Unit price" is a distinct alias only used by the Rule 6 derivation
// below (multiply by quantity) — it is NOT in PRICE.aliases itself,
// because a column literally named "price" in an item-grain file (e.g.
// Olist's order_items.csv) already IS the line's revenue, not a
// per-unit rate to be multiplied — conflating the two would double- or
// under-count revenue depending on which shape the SME uploaded.
const UNIT_PRICE_ALIASES = ['unit_price', 'price_per_unit', 'unit_cost'];
// A distinct, higher-priority alias for the "true" customer identity
// (Rule 7) — Olist reuses customer_id per order, so customer_unique_id
// is preferred for repeat-purchase analysis specifically when present.
const CUSTOMER_UNIQUE_ID_ALIASES = ['customer_unique_id'];

const COMPLETENESS_THRESHOLD = 0.7; // Section 5, Rule 2
const DTYPE_VALID_RATE = 0.9; // "validate dtype" (Rule 1) — tolerant, not pandas-strict

function findColumn(normalizedColumns, aliases) {
  for (let i = 0; i < normalizedColumns.length; i += 1) {
    const col = normalizedColumns[i];
    for (let j = 0; j < aliases.length; j += 1) {
      const a = aliases[j];
      if (col === a || col.startsWith(`${a}_`) || col.endsWith(`_${a}`)) return col;
    }
  }
  return null;
}

// ------------------------------------------------------------------
// Section 4 — Descriptive Analytics Report Catalog (30 reports, 9
// categories). `compute` is looked up by id in REPORT_COMPUTE below,
// kept separate from this metadata table to keep the catalog itself
// readable as a direct transcription of the source document's tables.
// ------------------------------------------------------------------
const REPORT_CATALOG = [
  { id: 1, category: 'A. Executive & Revenue Overview', title: 'Executive Sales Summary', measures: 'Total sales/revenue, total orders, items sold, unique customers, average order value', requiredRoles: ['ORD', 'PRICE', 'CUST'], tier: 'T1', visualization: 'KPI cards' },
  { id: 2, category: 'A. Executive & Revenue Overview', title: 'Revenue Over Time', measures: 'Revenue by day, month, quarter, year', requiredRoles: ['DATE', 'PRICE'], tier: 'T1', visualization: 'Line chart' },
  { id: 3, category: 'A. Executive & Revenue Overview', title: 'Order Volume Over Time', measures: 'Number of orders by month/year', requiredRoles: ['DATE', 'ORD'], tier: 'T1', visualization: 'Line/column chart' },
  { id: 4, category: 'A. Executive & Revenue Overview', title: 'Average Order Value', measures: 'Total sales ÷ number of orders', requiredRoles: ['ORD', 'PRICE'], tier: 'T1', visualization: 'KPI + trend line' },

  { id: 5, category: 'B. Product Analysis', title: 'Revenue by Product Category', measures: 'Sales value per product category', requiredRoles: ['CAT', 'PRICE'], tier: 'T2', visualization: 'Bar chart' },
  { id: 6, category: 'B. Product Analysis', title: 'Top Product Categories', measures: 'Categories ranked by revenue, items sold, orders', requiredRoles: ['CAT', 'PRICE', 'QTY'], tier: 'T2', visualization: 'Horizontal bar chart' },
  { id: 7, category: 'B. Product Analysis', title: 'Product Performance', measures: 'Price, quantity sold, revenue, freight by product', requiredRoles: ['PROD', 'PRICE', 'QTY', 'FREIGHT'], tier: 'T2', visualization: 'Table/bar chart' },
  { id: 28, category: 'B. Product Analysis', title: 'Product Price Analysis', measures: 'Min, max, mean, median, quartiles', requiredRoles: ['PRICE'], tier: 'T1', visualization: 'Histogram/box plot' },

  { id: 8, category: 'C. Customer Analysis', title: 'Customer Geographic Distribution', measures: 'Customers by state/city', requiredRoles: ['CUST', 'CGEO'], tier: 'T2', visualization: 'Map (shown as ranked bar/table)' },
  { id: 9, category: 'C. Customer Analysis', title: 'Revenue by Customer Location', measures: 'Revenue by state/city', requiredRoles: ['CGEO', 'PRICE'], tier: 'T2', visualization: 'Map/bar chart (shown as ranked bar)' },
  { id: 10, category: 'C. Customer Analysis', title: 'Customer Purchase Analysis', measures: 'Unique customers, repeat customers, orders/customer', requiredRoles: ['CUST', 'ORD'], tier: 'T1', visualization: 'KPI/bar chart' },
  { id: 11, category: 'C. Customer Analysis', title: 'Repeat Purchase Analysis', measures: 'Customers with 1, 2, 3+ orders', requiredRoles: ['CUST', 'ORD'], tier: 'T1', visualization: 'Histogram/bar chart' },

  { id: 12, category: 'D. Seller Analysis', title: 'Seller Performance', measures: 'Revenue, orders, items sold by seller', requiredRoles: ['SELL', 'PRICE', 'ORD'], tier: 'T2', visualization: 'Ranked bar/table' },
  { id: 13, category: 'D. Seller Analysis', title: 'Seller Geographic Distribution', measures: 'Sellers by state/city', requiredRoles: ['SELL', 'SGEO'], tier: 'T2', visualization: 'Map (shown as ranked bar/table)' },
  { id: 26, category: 'D. Seller Analysis', title: 'Revenue by Seller', measures: 'Seller contribution to total revenue', requiredRoles: ['SELL', 'PRICE'], tier: 'T2', visualization: 'Pareto chart (shown as ranked bar)' },
  { id: 27, category: 'D. Seller Analysis', title: 'Revenue Concentration', measures: '% revenue from top sellers/categories', requiredRoles: ['SELL', 'PRICE'], tier: 'T2', visualization: 'Pareto chart (shown as ranked bar)' },

  { id: 14, category: 'E. Payment Analysis', title: 'Payment Method Analysis', measures: 'Credit card, boleto, voucher, debit card usage', requiredRoles: ['PTYPE'], tier: 'T2', visualization: 'Donut/bar chart (shown as bar)' },
  { id: 15, category: 'E. Payment Analysis', title: 'Payment Value Analysis', measures: 'Revenue by payment type', requiredRoles: ['PTYPE', 'PVAL'], tier: 'T2', visualization: 'Bar chart' },
  { id: 16, category: 'E. Payment Analysis', title: 'Installment Analysis', measures: 'Orders/revenue by number of installments', requiredRoles: ['PINST'], tier: 'T2', visualization: 'Histogram/bar chart' },

  { id: 17, category: 'F. Order Status & Delivery Operations', title: 'Order Status Report', measures: 'Delivered, shipped, canceled, unavailable, etc.', requiredRoles: ['STAT'], tier: 'T1', visualization: 'Donut/bar chart (shown as bar)' },
  { id: 18, category: 'F. Order Status & Delivery Operations', title: 'Delivery Performance', measures: 'Average delivery time', requiredRoles: ['DATE', 'DACT'], tier: 'T2', visualization: 'KPI + histogram' },
  { id: 19, category: 'F. Order Status & Delivery Operations', title: 'On-Time vs Late Delivery', measures: 'Orders delivered before/after estimated date', requiredRoles: ['DACT', 'DEST'], tier: 'T2', visualization: 'Stacked bar' },
  { id: 20, category: 'F. Order Status & Delivery Operations', title: 'Freight Analysis', measures: 'Total freight, average freight, freight/revenue ratio', requiredRoles: ['FREIGHT', 'PRICE'], tier: 'T2', visualization: 'KPI/bar chart' },
  { id: 21, category: 'F. Order Status & Delivery Operations', title: 'Freight by Geography', measures: 'Average freight by state', requiredRoles: ['FREIGHT', 'CGEO'], tier: 'T2', visualization: 'Map/bar chart (shown as ranked bar)' },

  { id: 22, category: 'G. Customer Satisfaction', title: 'Customer Satisfaction', measures: 'Average review score', requiredRoles: ['REV'], tier: 'T2', visualization: 'KPI' },
  { id: 23, category: 'G. Customer Satisfaction', title: 'Review Score Distribution', measures: 'Number/% of 1-5 star reviews', requiredRoles: ['REV'], tier: 'T2', visualization: 'Bar chart' },
  { id: 24, category: 'G. Customer Satisfaction', title: 'Satisfaction by Product Category', measures: 'Average review by category', requiredRoles: ['REV', 'CAT'], tier: 'T3', visualization: 'Ranked bar' },
  { id: 25, category: 'G. Customer Satisfaction', title: 'Satisfaction vs Delivery', measures: 'Review score for early/on-time/late orders', requiredRoles: ['REV', 'DACT', 'DEST'], tier: 'T3', visualization: 'Box/bar chart' },

  { id: 29, category: 'H. Seasonality', title: 'Seasonal Sales Analysis', measures: 'Revenue/orders by month, weekday, hour', requiredRoles: ['DATE'], tier: 'T3', visualization: 'Heatmap' },

  { id: 30, category: 'I. Integrated Dashboard', title: 'Business Performance Dashboard', measures: 'Revenue, orders, AOV, customers, sellers, delivery, reviews', requiredRoles: ['ORD', 'DATE', 'PRICE', 'CUST', 'SELL', 'DACT', 'REV'], tier: 'T3', visualization: 'Integrated dashboard' },
];

// ------------------------------------------------------------------
// Section 5, Rules 1-2 — per-file role detection with dtype validation
// and a completeness threshold.
// ------------------------------------------------------------------
function detectFileRoles(columns, rows) {
  const normalizedColumns = columns.map(normalizeColumnName);
  const originalByNormalized = {};
  columns.forEach((c, i) => { originalByNormalized[normalizedColumns[i]] = c; });

  const found = {}; // roleKey -> normalized column name
  ROLE_KEYS.forEach((roleKey) => {
    const role = CANONICAL_ROLES[roleKey];
    const col = findColumn(normalizedColumns, role.aliases);
    if (!col) return;

    const values = rows.map((r) => r[originalByNormalized[col]]);
    const nonNull = values.filter((v) => v !== null && v !== undefined && String(v).trim() !== '');
    const completeness = rows.length ? nonNull.length / rows.length : 0;
    if (completeness < COMPLETENESS_THRESHOLD) return;

    if (role.dtype === 'numeric') {
      const validCount = nonNull.filter((v) => parseNumericLoose(v) !== null).length;
      if (nonNull.length && validCount / nonNull.length < DTYPE_VALID_RATE) return;
    } else if (role.dtype === 'date') {
      const validCount = nonNull.filter((v) => parseDateLoose(v) !== null).length;
      if (nonNull.length && validCount / nonNull.length < DTYPE_VALID_RATE) return;
    }
    // 'id' and 'category' roles: presence + completeness is enough —
    // Section 5 doesn't ask for cardinality checks on top of that, and
    // over-rejecting a legitimately-diverse category column on a small
    // sample would be a worse failure mode than accepting it.
    found[roleKey] = col;
  });

  // Rule 6 — derive revenue from quantity × unit price when no direct
  // price/value column was found.
  let derivedPriceCol = null;
  if (!found.PRICE) {
    const unitPriceCol = findColumn(normalizedColumns, UNIT_PRICE_ALIASES);
    // Deliberately NOT the same as found.QTY here: QTY's own alias list
    // includes 'order_item_id' as a presence-only proxy for "this file
    // is item-grain" (Olist's order_items.csv has no literal quantity
    // column — one row already IS one item), never as a real quantity
    // VALUE to multiply by. Rule 6's derivation needs an actual quantity
    // value column, so it matches a narrower alias set directly.
    const qtyValueCol = findColumn(normalizedColumns, ['quantity', 'qty', 'item_count', 'units']);
    if (unitPriceCol && qtyValueCol) {
      const upOrig = originalByNormalized[unitPriceCol];
      const qtyOrig = originalByNormalized[qtyValueCol];
      const derived = rows.map((r) => {
        const up = parseNumericLoose(r[upOrig]);
        const q = parseNumericLoose(r[qtyOrig]);
        return up !== null && q !== null ? up * q : null;
      });
      const nonNull = derived.filter((v) => v !== null);
      if (rows.length && nonNull.length / rows.length >= COMPLETENESS_THRESHOLD) {
        found.PRICE = '__derived_price__';
        derivedPriceCol = derived; // parallel array, same row order as `rows`
      }
    }
  }

  // Rule 7 — prefer customer_unique_id over customer_id when present.
  const customerUniqueIdCol = findColumn(normalizedColumns, CUSTOMER_UNIQUE_ID_ALIASES);

  return {
    found, // roleKey -> normalized column name (or '__derived_price__')
    originalByNormalized,
    derivedPriceCol, // parallel array or null
    customerUniqueIdOriginal: customerUniqueIdCol ? originalByNormalized[customerUniqueIdCol] : null,
  };
}

function classifyRawFiles(rawByFileType) {
  return Object.entries(rawByFileType).map(([fileType, rows]) => {
    const columns = rows.length > 0 ? Object.keys(rows[0]) : [];
    const detection = detectFileRoles(columns, rows);
    return {
      fileType, columns, rowCount: rows.length, rows, detection,
    };
  });
}

// ------------------------------------------------------------------
// Section 6 — the join engine. Picks a base "fact" grain (item-level if
// available, else whatever grain the richest file already has), then
// enriches each base row with roles pulled from other files via lookup
// maps keyed on ORD / PROD / CUST / SELL — exactly the join keys the
// source document's worked example uses.
// ------------------------------------------------------------------
function rowValue(row, detection, roleKey, index) {
  if (roleKey === 'PRICE' && detection.found.PRICE === '__derived_price__') {
    return detection.derivedPriceCol[index];
  }
  const col = detection.found[roleKey];
  if (!col) return null;
  return row[detection.originalByNormalized[col]];
}

function pickLookupSource(files, roleKeys, keyRole) {
  // Among every file that supplies the key role plus at least one of
  // roleKeys, pick the one covering the MOST of roleKeys — not simply
  // the first such file in whatever order `files` happens to be in
  // (that order isn't upload order: getRawRecordsByFileType() sorts by
  // file_type alphabetically, and a bundle like DATE/CUST/STAT/DACT/DEST
  // can otherwise lock onto a file that only coincidentally matches one
  // generic-aliased role — e.g. order_reviews.csv's review_creation_date
  // satisfying DATE's bare "date" alias — while a richer file (orders.csv,
  // with all five) sits later in iteration order and never gets tried).
  // Ties keep the earliest candidate, mirroring pickBaseFile()'s own
  // score-the-candidates approach just above.
  const candidates = files.filter((f) => f.detection.found[keyRole]
    && roleKeys.some((rk) => f.detection.found[rk]));
  if (candidates.length === 0) return null;
  const score = (f) => roleKeys.filter((rk) => f.detection.found[rk]).length;
  return candidates.reduce((best, f) => (score(f) > score(best) ? f : best), candidates[0]);
}

function buildLookup(files, roleKeys, keyRole) {
  const source = pickLookupSource(files, roleKeys, keyRole);
  if (!source) return null;

  const map = new Map();
  source.rows.forEach((row, i) => {
    const keyVal = rowValue(row, source.detection, keyRole, i);
    if (keyVal === null || keyVal === undefined || keyVal === '') return;
    const key = String(keyVal);
    if (!map.has(key)) {
      const entry = {};
      roleKeys.forEach((rk) => { entry[rk] = rowValue(row, source.detection, rk, i); });
      map.set(key, entry);
    }
  });
  return map;
}

// Payment and review data are per-order but can span MULTIPLE rows per
// order (Olist's order_payments.csv has one row per payment installment
// method; order_reviews.csv can have more than one review per order) —
// these need aggregation across rows sharing an order id, not a plain
// first-match lookup like buildLookup() above.
function buildAggregatedLookup(files, roleKeys, keyRole, aggregate) {
  const source = pickLookupSource(files, roleKeys, keyRole);
  if (!source) return null;

  const grouped = new Map();
  source.rows.forEach((row, i) => {
    const keyVal = rowValue(row, source.detection, keyRole, i);
    if (keyVal === null || keyVal === undefined || keyVal === '') return;
    const key = String(keyVal);
    if (!grouped.has(key)) grouped.set(key, []);
    const entry = {};
    roleKeys.forEach((rk) => { entry[rk] = rowValue(row, source.detection, rk, i); });
    grouped.get(key).push(entry);
  });

  const result = new Map();
  grouped.forEach((entries, key) => { result.set(key, aggregate(entries)); });
  return result;
}

function pickBaseFile(files) {
  const itemCandidates = files.filter((f) => f.detection.found.ORD && f.detection.found.PRICE);
  if (itemCandidates.length > 0) {
    return itemCandidates.sort((a, b) => {
      const score = (f) => ['PROD', 'SELL', 'FREIGHT', 'QTY'].filter((rk) => f.detection.found[rk]).length;
      return score(b) - score(a);
    })[0];
  }
  // No file has ORD+PRICE together — fall back to whichever file
  // detected the most roles overall (covers a single flat upload with
  // whatever subset of columns it happens to have).
  return [...files].sort((a, b) => Object.keys(b.detection.found).length - Object.keys(a.detection.found).length)[0] || null;
}

function buildEnrichedFacts(files) {
  const base = pickBaseFile(files);
  if (!base) return { facts: [], baseFileType: null };

  const others = files.filter((f) => f !== base);

  const ordersLookup = buildLookup(others.concat([base]), ['DATE', 'CUST', 'STAT', 'DACT', 'DEST'], 'ORD');
  const productLookup = buildLookup(others.concat([base]), ['CAT'], 'PROD');
  const customerLookup = buildLookup(others.concat([base]), ['CGEO'], 'CUST');
  const sellerLookup = buildLookup(others.concat([base]), ['SGEO'], 'SELL');
  const paymentLookup = buildAggregatedLookup(others.concat([base]), ['PTYPE', 'PINST', 'PVAL'], 'ORD', (entries) => {
    const ptypeCounts = {};
    let maxPinst = null;
    let sumPval = null;
    entries.forEach((e) => {
      if (e.PTYPE) ptypeCounts[e.PTYPE] = (ptypeCounts[e.PTYPE] || 0) + 1;
      const pinst = parseNumericLoose(e.PINST);
      if (pinst !== null) maxPinst = maxPinst === null ? pinst : Math.max(maxPinst, pinst);
      const pval = parseNumericLoose(e.PVAL);
      if (pval !== null) sumPval = (sumPval || 0) + pval;
    });
    const topPtype = Object.entries(ptypeCounts).sort((a, b) => b[1] - a[1])[0];
    return { PTYPE: topPtype ? topPtype[0] : null, PINST: maxPinst, PVAL: sumPval };
  });
  const reviewLookup = buildAggregatedLookup(others.concat([base]), ['REV'], 'ORD', (entries) => {
    const scores = entries.map((e) => parseNumericLoose(e.REV)).filter((v) => v !== null);
    return { REV: scores.length ? mean(scores) : null };
  });
  // customer_unique_id: from whichever file carries both CUST and that
  // column (typically the same file that supplies CGEO, e.g. customers.csv).
  const uniqueIdSource = files.find((f) => f.detection.found.CUST && f.detection.customerUniqueIdOriginal);
  const customerUniqueIdLookup = uniqueIdSource ? (() => {
    const map = new Map();
    uniqueIdSource.rows.forEach((row, i) => {
      const custVal = rowValue(row, uniqueIdSource.detection, 'CUST', i);
      if (custVal === null || custVal === undefined || custVal === '') return;
      const uniqueVal = row[uniqueIdSource.detection.customerUniqueIdOriginal];
      if (uniqueVal !== null && uniqueVal !== undefined && uniqueVal !== '' && !map.has(String(custVal))) {
        map.set(String(custVal), String(uniqueVal));
      }
    });
    return map;
  })() : null;

  const facts = base.rows.map((row, i) => {
    const fact = {};
    ['ORD', 'PROD', 'SELL', 'CUST'].forEach((rk) => { fact[rk] = rowValue(row, base.detection, rk, i); });
    ['DATE', 'PRICE', 'QTY', 'FREIGHT', 'CAT', 'PTYPE', 'PINST', 'PVAL', 'REV', 'STAT', 'DACT', 'DEST', 'CGEO', 'SGEO'].forEach((rk) => {
      fact[rk] = rowValue(row, base.detection, rk, i);
    });

    const ordKey = fact.ORD !== null && fact.ORD !== undefined ? String(fact.ORD) : null;
    if (ordersLookup && ordKey && ordersLookup.has(ordKey)) {
      const o = ordersLookup.get(ordKey);
      if (fact.DATE === null && o.DATE !== undefined) fact.DATE = o.DATE;
      if (fact.CUST === null && o.CUST !== undefined) fact.CUST = o.CUST;
      if (fact.STAT === null && o.STAT !== undefined) fact.STAT = o.STAT;
      if (fact.DACT === null && o.DACT !== undefined) fact.DACT = o.DACT;
      if (fact.DEST === null && o.DEST !== undefined) fact.DEST = o.DEST;
    }
    const prodKey = fact.PROD !== null && fact.PROD !== undefined ? String(fact.PROD) : null;
    if (fact.CAT === null && productLookup && prodKey && productLookup.has(prodKey)) {
      fact.CAT = productLookup.get(prodKey).CAT;
    }
    const custKeyForGeo = fact.CUST !== null && fact.CUST !== undefined ? String(fact.CUST) : null;
    if (fact.CGEO === null && customerLookup && custKeyForGeo && customerLookup.has(custKeyForGeo)) {
      fact.CGEO = customerLookup.get(custKeyForGeo).CGEO;
    }
    const sellKey = fact.SELL !== null && fact.SELL !== undefined ? String(fact.SELL) : null;
    if (fact.SGEO === null && sellerLookup && sellKey && sellerLookup.has(sellKey)) {
      fact.SGEO = sellerLookup.get(sellKey).SGEO;
    }
    if (paymentLookup && ordKey && paymentLookup.has(ordKey)) {
      const p = paymentLookup.get(ordKey);
      if (fact.PTYPE === null) fact.PTYPE = p.PTYPE;
      if (fact.PINST === null) fact.PINST = p.PINST;
      if (fact.PVAL === null) fact.PVAL = p.PVAL;
    }
    if (fact.REV === null && reviewLookup && ordKey && reviewLookup.has(ordKey)) {
      fact.REV = reviewLookup.get(ordKey).REV;
    }
    fact.CUST_UNIQUE = (customerUniqueIdLookup && custKeyForGeo && customerUniqueIdLookup.has(custKeyForGeo))
      ? customerUniqueIdLookup.get(custKeyForGeo)
      : fact.CUST;

    return fact;
  });

  return { facts, baseFileType: base.fileType };
}

// ------------------------------------------------------------------
// Final role presence — recomputed on the ENRICHED fact table (not
// per-file), since a join's coverage can be less than 100% (e.g. not
// every order_id in order_items necessarily has a matching row in
// orders.csv) — Section 5 Rule 2's completeness threshold is meant to
// gate the data actually available to a report, which is the joined
// result, not any one input file in isolation.
// ------------------------------------------------------------------
function computeFinalRolePresence(facts) {
  const present = new Set();
  if (facts.length === 0) return present;
  ROLE_KEYS.forEach((roleKey) => {
    const nonNull = facts.filter((f) => f[roleKey] !== null && f[roleKey] !== undefined && f[roleKey] !== '').length;
    if (nonNull / facts.length >= COMPLETENESS_THRESHOLD) present.add(roleKey);
  });
  return present;
}

// ------------------------------------------------------------------
// Section 5 — applicability engine.
// ------------------------------------------------------------------
function evaluateApplicability(presentRoles) {
  const enabled = [];
  const nearMiss = [];
  REPORT_CATALOG.forEach((report) => {
    const missing = report.requiredRoles.filter((rk) => !presentRoles.has(rk));
    if (missing.length === 0) {
      enabled.push(report);
    } else if (missing.length === 1) {
      nearMiss.push({ ...report, missingRole: missing[0], missingLabel: CANONICAL_ROLES[missing[0]].label });
    }
  });
  return { enabled, nearMiss };
}

// ------------------------------------------------------------------
// Report metric computation — one function per catalog id, dispatched
// from buildReportCatalogAnalysis(). Each returns a small, render-
// agnostic data shape (kpis / items / points / table rows) that
// routes/dashboard.js turns into chart HTML via services/charts.js,
// exactly the same split evaluationReport.js and analytics.js already
// use elsewhere in this app.
// ------------------------------------------------------------------
function groupSum(facts, roleKey, valueRoleKey) {
  const totals = {};
  facts.forEach((f) => {
    const raw = f[roleKey];
    if (raw === null || raw === undefined || raw === '') return;
    const label = String(raw).trim() || 'Unspecified';
    const val = parseNumericLoose(f[valueRoleKey]) || 0;
    totals[label] = (totals[label] || 0) + val;
  });
  return Object.entries(totals).map(([label, value]) => ({ label, value })).sort((a, b) => b.value - a.value);
}

function groupCount(facts, roleKey) {
  const counts = {};
  facts.forEach((f) => {
    const raw = f[roleKey];
    if (raw === null || raw === undefined || raw === '') return;
    const label = String(raw).trim() || 'Unspecified';
    counts[label] = (counts[label] || 0) + 1;
  });
  return Object.entries(counts).map(([label, value]) => ({ label, value })).sort((a, b) => b.value - a.value);
}

function distinctValues(facts, roleKey) {
  return new Set(facts.map((f) => f[roleKey]).filter((v) => v !== null && v !== undefined && v !== ''));
}

// The enriched fact table is ITEM-grain (one row per order line), but
// several roles — PTYPE, PINST, PVAL, STAT, DATE/DACT/DEST, REV — are
// really ORDER-grain values that got broadcast onto every item row of
// their order during the join (so a report can see them at all). Any
// report about payments, order status, delivery timing, or reviews
// must first collapse back to one row per order, or a multi-item order
// gets counted/summed multiple times over for a value that only
// happened once. `groupSum`/`groupCount`/`mean` above stay item-grain
// on purpose (PRICE, CAT, FREIGHT, PROD, SELL genuinely vary per item).
function dedupeFactsByOrder(facts) {
  const seen = new Set();
  const out = [];
  facts.forEach((f) => {
    if (f.ORD === null || f.ORD === undefined || f.ORD === '') { out.push(f); return; } // no order id to dedupe on — keep as-is
    const key = String(f.ORD);
    if (seen.has(key)) return;
    seen.add(key);
    out.push(f);
  });
  return out;
}

// Distinct-count-by-group — for "how many customers/sellers per
// state/city," not "how many item rows," which groupCount() would give
// since CGEO/SGEO repeat across every item belonging to the same
// customer/seller.
function groupDistinctCount(facts, groupRoleKey, distinctRoleKey) {
  const sets = {};
  facts.forEach((f) => {
    const raw = f[groupRoleKey];
    const distinctRaw = f[distinctRoleKey];
    if (raw === null || raw === undefined || raw === '' || distinctRaw === null || distinctRaw === undefined || distinctRaw === '') return;
    const label = String(raw).trim() || 'Unspecified';
    sets[label] = sets[label] || new Set();
    sets[label].add(String(distinctRaw));
  });
  return Object.entries(sets).map(([label, s]) => ({ label, value: s.size })).sort((a, b) => b.value - a.value);
}

function revenueByMonth(facts) {
  const totals = {};
  facts.forEach((f) => {
    const d = parseDateLoose(f.DATE);
    const price = parseNumericLoose(f.PRICE);
    if (!d || price === null) return;
    const key = monthKeyFrom(d);
    totals[key] = (totals[key] || 0) + price;
  });
  return Object.keys(totals).sort().map((key) => ({ key, label: monthLabelFrom(key), value: totals[key] }));
}

const REPORT_COMPUTE = {
  1: (facts) => {
    const revenueValues = facts.map((f) => parseNumericLoose(f.PRICE)).filter((v) => v !== null);
    const totalRevenue = revenueValues.reduce((s, v) => s + v, 0);
    const orders = distinctValues(facts, 'ORD');
    const customers = distinctValues(facts, 'CUST');
    return {
      kind: 'kpis',
      kpis: [
        { label: 'Total revenue', value: totalRevenue },
        { label: 'Total orders', value: orders.size, isCount: true },
        { label: 'Items sold', value: facts.length, isCount: true },
        { label: 'Unique customers', value: customers.size, isCount: true },
        { label: 'Average order value', value: orders.size ? totalRevenue / orders.size : 0 },
      ],
    };
  },
  2: (facts) => ({ kind: 'trend', points: revenueByMonth(facts), money: true, valueLabel: 'Revenue' }),
  3: (facts) => {
    const byMonth = {};
    facts.forEach((f) => {
      const d = parseDateLoose(f.DATE);
      if (!d || f.ORD === null) return;
      const key = monthKeyFrom(d);
      byMonth[key] = byMonth[key] || new Set();
      byMonth[key].add(String(f.ORD));
    });
    const points = Object.keys(byMonth).sort().map((key) => ({ key, label: monthLabelFrom(key), value: byMonth[key].size }));
    return { kind: 'trend', points, money: false, valueLabel: 'Orders' };
  },
  4: (facts) => {
    const revenueValues = facts.map((f) => parseNumericLoose(f.PRICE)).filter((v) => v !== null);
    const totalRevenue = revenueValues.reduce((s, v) => s + v, 0);
    const orders = distinctValues(facts, 'ORD');
    const aov = orders.size ? totalRevenue / orders.size : 0;
    const byMonth = {};
    const ordersByMonth = {};
    facts.forEach((f) => {
      const d = parseDateLoose(f.DATE);
      const price = parseNumericLoose(f.PRICE);
      if (!d || price === null || f.ORD === null) return;
      const key = monthKeyFrom(d);
      byMonth[key] = (byMonth[key] || 0) + price;
      ordersByMonth[key] = ordersByMonth[key] || new Set();
      ordersByMonth[key].add(String(f.ORD));
    });
    const points = Object.keys(byMonth).sort()
      .map((key) => ({ key, label: monthLabelFrom(key), value: ordersByMonth[key].size ? byMonth[key] / ordersByMonth[key].size : 0 }));
    return {
      kind: 'kpi_trend',
      kpis: [{ label: 'Average order value', value: aov }],
      points,
      money: true,
      valueLabel: 'AOV',
    };
  },

  5: (facts) => ({ kind: 'bar', items: groupSum(facts, 'CAT', 'PRICE').slice(0, 15), money: true }),
  6: (facts) => {
    const revenue = groupSum(facts, 'CAT', 'PRICE');
    const counts = groupCount(facts, 'CAT');
    const countByLabel = new Map(counts.map((c) => [c.label, c.value]));
    const table = revenue.slice(0, 15).map((r) => ({ label: r.label, revenue: r.value, itemsSold: countByLabel.get(r.label) || 0 }));
    return { kind: 'ranked_table', columns: ['Category', 'Revenue', 'Items sold'], rows: table.map((r) => [r.label, r.revenue, r.itemsSold]), moneyColumns: [1] };
  },
  7: (facts) => {
    const totals = {};
    facts.forEach((f) => {
      const raw = f.PROD;
      if (raw === null || raw === undefined || raw === '') return;
      const label = String(raw).trim();
      totals[label] = totals[label] || {
        revenue: 0, qty: 0, freight: 0,
      };
      totals[label].revenue += parseNumericLoose(f.PRICE) || 0;
      totals[label].qty += 1;
      totals[label].freight += parseNumericLoose(f.FREIGHT) || 0;
    });
    const rows = Object.entries(totals)
      .map(([label, t]) => [label, t.revenue, t.qty, t.freight])
      .sort((a, b) => b[1] - a[1])
      .slice(0, 15);
    return { kind: 'ranked_table', columns: ['Product', 'Revenue', 'Quantity', 'Freight'], rows, moneyColumns: [1, 3] };
  },
  28: (facts) => {
    const values = facts.map((f) => parseNumericLoose(f.PRICE)).filter((v) => v !== null);
    const sorted = [...values].sort((a, b) => a - b);
    return {
      kind: 'describe_histogram',
      describe: {
        min: sorted[0], max: sorted[sorted.length - 1], mean: mean(values), median: quantile(sorted, 0.5), p25: quantile(sorted, 0.25), p75: quantile(sorted, 0.75),
      },
      histogram: histogramBuckets(values),
    };
  },

  8: (facts) => ({ kind: 'bar', items: groupDistinctCount(facts, 'CGEO', 'CUST').slice(0, 20), money: false, valueColumnLabel: 'Customers' }),
  9: (facts) => ({ kind: 'bar', items: groupSum(facts, 'CGEO', 'PRICE').slice(0, 20), money: true }),
  10: (facts) => {
    const customers = distinctValues(facts, 'CUST');
    const orders = distinctValues(facts, 'ORD');
    return {
      kind: 'kpis',
      kpis: [
        { label: 'Unique customers', value: customers.size, isCount: true },
        { label: 'Total orders', value: orders.size, isCount: true },
        { label: 'Orders per customer', value: customers.size ? orders.size / customers.size : 0, isPlain: true },
      ],
    };
  },
  11: (facts) => {
    const useUnique = facts.some((f) => f.CUST_UNIQUE !== null && f.CUST_UNIQUE !== undefined);
    const key = useUnique ? 'CUST_UNIQUE' : 'CUST';
    const ordersByCustomer = new Map();
    facts.forEach((f) => {
      if (f[key] === null || f[key] === undefined || f.ORD === null) return;
      const custKey = String(f[key]);
      if (!ordersByCustomer.has(custKey)) ordersByCustomer.set(custKey, new Set());
      ordersByCustomer.get(custKey).add(String(f.ORD));
    });
    const buckets = { '1 order': 0, '2 orders': 0, '3+ orders': 0 };
    ordersByCustomer.forEach((orderSet) => {
      const n = orderSet.size;
      if (n === 1) buckets['1 order'] += 1;
      else if (n === 2) buckets['2 orders'] += 1;
      else buckets['3+ orders'] += 1;
    });
    return {
      kind: 'bar',
      items: Object.entries(buckets).map(([label, value]) => ({ label, value })),
      money: false,
      valueColumnLabel: 'Customers',
      usedCustomerUniqueId: useUnique,
    };
  },

  12: (facts) => {
    const totals = {};
    facts.forEach((f) => {
      const raw = f.SELL;
      if (raw === null || raw === undefined || raw === '') return;
      const label = String(raw).trim();
      totals[label] = totals[label] || { revenue: 0, orders: new Set(), items: 0 };
      totals[label].revenue += parseNumericLoose(f.PRICE) || 0;
      if (f.ORD !== null) totals[label].orders.add(String(f.ORD));
      totals[label].items += 1;
    });
    const rows = Object.entries(totals)
      .map(([label, t]) => [label, t.revenue, t.orders.size, t.items])
      .sort((a, b) => b[1] - a[1])
      .slice(0, 15);
    return { kind: 'ranked_table', columns: ['Seller', 'Revenue', 'Orders', 'Items sold'], rows, moneyColumns: [1] };
  },
  13: (facts) => ({ kind: 'bar', items: groupDistinctCount(facts, 'SGEO', 'SELL').slice(0, 20), money: false, valueColumnLabel: 'Sellers' }),
  26: (facts) => ({ kind: 'bar', items: groupSum(facts, 'SELL', 'PRICE').slice(0, 20), money: true }),
  27: (facts) => {
    const bySeller = groupSum(facts, 'SELL', 'PRICE');
    const total = bySeller.reduce((s, r) => s + r.value, 0);
    const top5 = bySeller.slice(0, 5).reduce((s, r) => s + r.value, 0);
    const kpis = [{ label: 'Revenue from top 5 sellers', value: total ? (top5 / total) * 100 : 0, isPercent: true }];
    const byCat = groupSum(facts, 'CAT', 'PRICE');
    if (byCat.length > 0) {
      const catTotal = byCat.reduce((s, r) => s + r.value, 0);
      const catTop5 = byCat.slice(0, 5).reduce((s, r) => s + r.value, 0);
      kpis.push({ label: 'Revenue from top 5 categories', value: catTotal ? (catTop5 / catTotal) * 100 : 0, isPercent: true });
    }
    return { kind: 'kpis', kpis };
  },

  14: (facts) => ({ kind: 'bar', items: groupCount(dedupeFactsByOrder(facts), 'PTYPE'), money: false, valueColumnLabel: 'Orders' }),
  15: (facts) => ({ kind: 'bar', items: groupSum(dedupeFactsByOrder(facts), 'PTYPE', 'PVAL'), money: true }),
  16: (facts) => {
    const buckets = {};
    dedupeFactsByOrder(facts).forEach((f) => {
      const n = parseNumericLoose(f.PINST);
      if (n === null) return;
      const label = n >= 12 ? '12+' : String(Math.round(n));
      buckets[label] = (buckets[label] || 0) + 1;
    });
    const items = Object.entries(buckets)
      .map(([label, value]) => ({ label, value, sortKey: label === '12+' ? 999 : Number(label) }))
      .sort((a, b) => a.sortKey - b.sortKey)
      .map(({ label, value }) => ({ label, value }));
    return { kind: 'bar', items, money: false, valueColumnLabel: 'Orders' };
  },

  17: (facts) => ({ kind: 'bar', items: groupCount(dedupeFactsByOrder(facts), 'STAT'), money: false, valueColumnLabel: 'Orders' }),
  18: (facts) => {
    const days = [];
    dedupeFactsByOrder(facts).forEach((f) => {
      const d1 = parseDateLoose(f.DATE);
      const d2 = parseDateLoose(f.DACT);
      if (!d1 || !d2) return;
      const diff = (d2.getTime() - d1.getTime()) / 86400000;
      if (Number.isFinite(diff)) days.push(diff);
    });
    return {
      kind: 'kpi_histogram',
      kpis: [{ label: 'Average delivery time (days)', value: days.length ? mean(days) : 0, isPlain: true }],
      histogram: histogramBuckets(days),
    };
  },
  19: (facts) => {
    let onTime = 0;
    let late = 0;
    dedupeFactsByOrder(facts).forEach((f) => {
      const dAct = parseDateLoose(f.DACT);
      const dEst = parseDateLoose(f.DEST);
      if (!dAct || !dEst) return;
      if (dAct.getTime() <= dEst.getTime()) onTime += 1;
      else late += 1;
    });
    return {
      kind: 'bar',
      items: [{ label: 'On-time', value: onTime }, { label: 'Late', value: late }],
      money: false,
      valueColumnLabel: 'Orders',
    };
  },
  20: (facts) => {
    const freightValues = facts.map((f) => parseNumericLoose(f.FREIGHT)).filter((v) => v !== null);
    const revenueValues = facts.map((f) => parseNumericLoose(f.PRICE)).filter((v) => v !== null);
    const totalFreight = freightValues.reduce((s, v) => s + v, 0);
    const totalRevenue = revenueValues.reduce((s, v) => s + v, 0);
    return {
      kind: 'kpis',
      kpis: [
        { label: 'Total freight', value: totalFreight },
        { label: 'Average freight', value: freightValues.length ? mean(freightValues) : 0 },
        { label: 'Freight / revenue ratio', value: totalRevenue ? (totalFreight / totalRevenue) * 100 : 0, isPercent: true },
      ],
    };
  },
  21: (facts) => {
    const totals = {};
    const counts = {};
    facts.forEach((f) => {
      const raw = f.CGEO;
      const freight = parseNumericLoose(f.FREIGHT);
      if (raw === null || raw === undefined || raw === '' || freight === null) return;
      const label = String(raw).trim();
      totals[label] = (totals[label] || 0) + freight;
      counts[label] = (counts[label] || 0) + 1;
    });
    const items = Object.keys(totals)
      .map((label) => ({ label, value: totals[label] / counts[label] }))
      .sort((a, b) => b.value - a.value)
      .slice(0, 20);
    return { kind: 'bar', items, money: true };
  },

  22: (facts) => {
    const scores = dedupeFactsByOrder(facts).map((f) => parseNumericLoose(f.REV)).filter((v) => v !== null);
    return { kind: 'kpis', kpis: [{ label: 'Average review score', value: scores.length ? mean(scores) : 0, isPlain: true }] };
  },
  23: (facts) => {
    const buckets = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
    dedupeFactsByOrder(facts).forEach((f) => {
      const n = parseNumericLoose(f.REV);
      if (n === null) return;
      const rounded = Math.min(5, Math.max(1, Math.round(n)));
      buckets[rounded] += 1;
    });
    return {
      kind: 'bar',
      items: Object.entries(buckets).map(([label, value]) => ({ label: `${label} star`, value })),
      money: false,
      valueColumnLabel: 'Reviews',
    };
  },
  24: (facts) => {
    const totals = {};
    const counts = {};
    facts.forEach((f) => {
      const raw = f.CAT;
      const rev = parseNumericLoose(f.REV);
      if (raw === null || raw === undefined || raw === '' || rev === null) return;
      const label = String(raw).trim();
      totals[label] = (totals[label] || 0) + rev;
      counts[label] = (counts[label] || 0) + 1;
    });
    const items = Object.keys(totals)
      .map((label) => ({ label, value: totals[label] / counts[label] }))
      .sort((a, b) => b.value - a.value)
      .slice(0, 15);
    return { kind: 'bar', items, money: false, valueColumnLabel: 'Avg review score', formatValue: (v) => v.toFixed(2) };
  },
  25: (facts) => {
    const buckets = { Early: [], 'On-time': [], Late: [] };
    dedupeFactsByOrder(facts).forEach((f) => {
      const rev = parseNumericLoose(f.REV);
      const dAct = parseDateLoose(f.DACT);
      const dEst = parseDateLoose(f.DEST);
      if (rev === null || !dAct || !dEst) return;
      const diff = dAct.getTime() - dEst.getTime();
      const bucket = diff < 0 ? 'Early' : diff === 0 ? 'On-time' : 'Late';
      buckets[bucket].push(rev);
    });
    const items = Object.entries(buckets).map(([label, scores]) => ({ label, value: scores.length ? mean(scores) : 0 }));
    return { kind: 'bar', items, money: false, valueColumnLabel: 'Avg review score', formatValue: (v) => v.toFixed(2) };
  },

  29: (facts) => {
    const dates = facts.map((f) => parseDateLoose(f.DATE)).filter((d) => d !== null);
    const hasTime = dates.length > 0 && dates.some((d) => d.getUTCHours() !== 0 || d.getUTCMinutes() !== 0);
    const weekdayTotals = new Array(7).fill(0);
    const hourTotals = new Array(24).fill(0);
    facts.forEach((f) => {
      const d = parseDateLoose(f.DATE);
      const price = parseNumericLoose(f.PRICE);
      if (!d || price === null) return;
      weekdayTotals[d.getUTCDay()] += price;
      if (hasTime) hourTotals[d.getUTCHours()] += price;
    });
    return {
      kind: 'seasonality',
      byWeekday: WEEKDAY_NAMES.map((label, i) => ({ label, value: weekdayTotals[i] })),
      byHour: hasTime ? hourTotals.map((value, h) => ({ label: `${h}:00`, value })) : null,
      hasTime,
    };
  },

  30: (facts) => {
    const revenueValues = facts.map((f) => parseNumericLoose(f.PRICE)).filter((v) => v !== null);
    const totalRevenue = revenueValues.reduce((s, v) => s + v, 0);
    const orders = distinctValues(facts, 'ORD');
    const customers = distinctValues(facts, 'CUST');
    const sellers = distinctValues(facts, 'SELL');
    const orderFacts = dedupeFactsByOrder(facts);
    const deliveryDays = [];
    orderFacts.forEach((f) => {
      const d1 = parseDateLoose(f.DATE);
      const d2 = parseDateLoose(f.DACT);
      if (d1 && d2) deliveryDays.push((d2.getTime() - d1.getTime()) / 86400000);
    });
    const reviewScores = orderFacts.map((f) => parseNumericLoose(f.REV)).filter((v) => v !== null);
    return {
      kind: 'kpis',
      kpis: [
        { label: 'Total revenue', value: totalRevenue },
        { label: 'Total orders', value: orders.size, isCount: true },
        { label: 'Average order value', value: orders.size ? totalRevenue / orders.size : 0 },
        { label: 'Unique customers', value: customers.size, isCount: true },
        { label: 'Sellers', value: sellers.size, isCount: true },
        { label: 'Avg delivery time (days)', value: deliveryDays.length ? mean(deliveryDays) : 0, isPlain: true },
        { label: 'Avg review score', value: reviewScores.length ? mean(reviewScores) : 0, isPlain: true },
      ],
    };
  },
};

function computeReport(reportId, facts) {
  const fn = REPORT_COMPUTE[reportId];
  return fn ? fn(facts) : null;
}

// ------------------------------------------------------------------
// Top-level orchestrator.
// ------------------------------------------------------------------
function buildReportCatalogAnalysis(rawByFileType) {
  const fileTypes = Object.keys(rawByFileType);
  if (fileTypes.length === 0) {
    return {
      hasFiles: false, files: [], facts: [], presentRoles: new Set(), enabled: [], nearMiss: [], reportData: {},
    };
  }

  const files = classifyRawFiles(rawByFileType);
  const { facts, baseFileType } = buildEnrichedFacts(files);
  const presentRoles = computeFinalRolePresence(facts);
  const { enabled, nearMiss } = evaluateApplicability(presentRoles);

  const reportData = {};
  enabled.forEach((report) => { reportData[report.id] = computeReport(report.id, facts); });

  const fileSummaries = files.map((f) => ({
    fileType: f.fileType,
    rowCount: f.rowCount,
    rolesSupplied: Object.keys(f.detection.found).filter((rk) => f.detection.found[rk] !== '__derived_price__' || true),
    isBase: f.fileType === baseFileType,
  }));

  return {
    hasFiles: true,
    files: fileSummaries,
    factCount: facts.length,
    baseFileType,
    presentRoles,
    enabled,
    nearMiss,
    reportData,
  };
}

module.exports = {
  CANONICAL_ROLES,
  REPORT_CATALOG,
  detectFileRoles,
  classifyRawFiles,
  buildEnrichedFacts,
  evaluateApplicability,
  computeReport,
  buildReportCatalogAnalysis,
};
