// Automatic Dataset Intelligence & Analytics Engine — Analytics
// Generation Engine: the Metric Registry.
//
// Every metric below states, up front, which business-semantic column
// roles (services/businessSemantics.js) it needs to exist before it can
// be honestly computed. A metric whose required roles aren't all present
// in the dataset's identified transaction fact table is reported as NOT
// APPLICABLE, with a plain-language reason — never silently computed as
// 0. Zero means "this was computed and the real answer is zero" (e.g. a
// restaurant genuinely had no orders in a given month); a metric CMA-FLOW
// couldn't validly compute at all is a different thing and must never be
// confused with it — this is what stops a dataset with no subscription
// evidence from showing a fabricated "MRR: $0".
//
// Cross-file metrics (revenue by customer/product/merchant) resolve
// their join automatically from the relationship edge services/
// businessSemantics.js already attached to the fact table's foreign-key
// columns (itself sourced from detectRelationships()'s exact value-
// overlap measurement in services/fullDescriptiveAnalytics.js) — a
// dimension file's rows are only fetched when a real, measured
// relationship says they're the right ones to join, never guessed from
// name alone.
//
// Pure functions only — services/fullDescriptiveAnalytics.js's
// getOrBuildBusinessIntelligence() is the DB-aware layer that fetches
// the fact/dimension rows this module needs and persists the result.

const { tryParseNumber } = require('./datasetProfiler');

const TOP_N = 12;

function findRoleColumn(fileEntry, role) {
  let best = null;
  Object.entries(fileEntry.columnRoles).forEach(([name, r]) => {
    if (r.role === role && (!best || r.confidence > best.confidence)) best = { name, ...r };
  });
  return best;
}

// Finds the column to use as "revenue" for any metric that needs a
// transaction-level amount. Tries the formal 'revenue' role first; when
// the fact table has no column classified that way but DOES carry a
// 'price' column on a table that also has a date or an order id (i.e. it
// looks like a genuine order/line-item fact table, not a bare product
// catalog), the price column stands in, since a per-row listed price
// already IS the revenue for that row on a table shaped like that — e.g.
// Olist's own order_items.csv (order_id, price, freight_value, no
// separate "amount"/"total" column). This mirrors services/
// businessSemantics.js's own classifyFileRole(), which already uses this
// exact same evidence (hasPrice && (hasDate || hasOrderId)) to decide a
// FILE qualifies as a transaction fact table in the first place — this
// applies that already-trusted reasoning to the specific revenue FIGURE
// instead of only the file-level classification. A price column on a
// genuine dimension/catalog file (no date, no order id) is correctly
// still refused — that really is just a listed price, not revenue.
//
// Canonical, single-implementation home for this logic — also used by
// services/diagnosticEngine.js, which imports it from here rather than
// keeping its own copy, for the same reason every other name-pattern
// regex in this file is hoisted and shared (see ESTIMATED_DATE_NAME_RE's
// own comment below): this codebase has a documented history of the same
// piece of reasoning being fixed in one place and left stale in another.
// Returns { col, isFallback } or null when neither is available.
function findRevenueColumn(ctx) {
  const revCol = findRoleColumn(ctx.factFile, 'revenue');
  if (revCol) return { col: revCol, isFallback: false };
  const priceCol = findRoleColumn(ctx.factFile, 'price');
  if (!priceCol) return null;
  const hasDate = !!findRoleColumn(ctx.factFile, 'date');
  const hasOrderId = !!findRoleColumn(ctx.factFile, 'order_id');
  if (!hasDate && !hasOrderId) return null;
  return { col: priceCol, isFallback: true };
}

// Appends a plain-language disclosure to a provenance note whenever
// findRevenueColumn() above actually had to fall back to price — never a
// silent reinterpretation of the SME owner's data. Empty string (no-op)
// when the formal revenue role was found, so callers can always splice
// this in unconditionally.
function revenueFallbackNote(revInfo) {
  return revInfo && revInfo.isFallback
    ? ` No dedicated revenue/amount column was found, so this fact table's listed price ("${revInfo.col.name}") is used as the revenue figure.`
    : '';
}

// Builds an id -> display label lookup from a joined dimension file's raw
// rows, e.g. Users.user_id -> Users.name. Falls back to the id itself
// when the dimension file has no obvious NAME_LABEL-role column, so a
// breakdown is still readable ("Customer 40821") rather than blank.
function buildDimensionLookup(dimensionRows, idColumnName, labelColumnName) {
  const lookup = new Map();
  dimensionRows.forEach((row) => {
    const id = row[idColumnName];
    if (id === undefined || id === null || String(id).trim() === '') return;
    const key = String(id).trim();
    const label = labelColumnName && row[labelColumnName] ? String(row[labelColumnName]).trim() : null;
    if (!lookup.has(key)) lookup.set(key, label || key);
  });
  return lookup;
}

// Round 21 — the numeric sibling of buildDimensionLookup() above, for a
// joined dimension file's own MONETARY column (a catalog/listed price,
// e.g. products.csv's own "price") rather than a display label. Returns
// id -> parsed number (never a string), skipping a row whose value
// doesn't parse — a catalog price lookup is only ever read for an
// average, and an unparseable value should never silently become 0 or
// NaN inside that average.
function buildNumericDimensionLookup(dimensionRows, idColumnName, valueColumnName) {
  const lookup = new Map();
  dimensionRows.forEach((row) => {
    const id = row[idColumnName];
    if (id === undefined || id === null || String(id).trim() === '') return;
    const key = String(id).trim();
    const value = tryParseNumber(row[valueColumnName]);
    if (value === null) return;
    if (!lookup.has(key)) lookup.set(key, value);
  });
  return lookup;
}

function sumColumn(rows, colName) {
  let total = 0; let counted = 0;
  rows.forEach((row) => {
    const v = tryParseNumber(row[colName]);
    if (v !== null) { total += v; counted += 1; }
  });
  return { total, counted };
}

function groupSumTopN(rows, keyCol, valueCol, lookup, n = TOP_N) {
  const sums = new Map();
  rows.forEach((row) => {
    const key = row[keyCol];
    if (key === undefined || key === null || String(key).trim() === '') return;
    const val = tryParseNumber(row[valueCol]);
    if (val === null) return;
    const k = String(key).trim();
    sums.set(k, (sums.get(k) || 0) + val);
  });
  const ranked = [...sums.entries()].sort((a, b) => b[1] - a[1]);
  const top = ranked.slice(0, n).map(([key, value]) => ({ label: lookup && lookup.has(key) ? lookup.get(key) : key, value }));
  const otherTotal = ranked.slice(n).reduce((s, [, v]) => s + v, 0);
  if (otherTotal > 0) top.push({ label: 'Other', value: otherTotal, isOther: true });
  return top;
}

// Same top-N-with-an-"Other"-bucket shape as groupSumTopN, but resolves
// each row's grouping key THROUGH the lookup before summing, rather than
// only for display. groupSumTopN groups by the raw key (e.g. one bar per
// customer_id) and only swaps in a label at the end — right for "revenue
// by customer", wrong for "revenue by geography" resolved indirectly via
// a joined dimension file (many customer_ids share one state; grouping by
// raw customer_id would produce one bar per customer instead of one per
// state). When lookup is null (the geo column sits directly on the fact
// table itself — e.g. a GCP billing export's own Region_Zone — see
// resolveGeo() below), this reduces to grouping by the row's own value,
// which is exactly groupSumTopN's behavior with no lookup anyway.
function groupSumByLookupTopN(rows, keyCol, valueCol, lookup, n = TOP_N) {
  const sums = new Map();
  rows.forEach((row) => {
    const rawKey = row[keyCol];
    if (rawKey === undefined || rawKey === null || String(rawKey).trim() === '') return;
    const val = tryParseNumber(row[valueCol]);
    if (val === null) return;
    const rawKeyStr = String(rawKey).trim();
    const resolved = lookup && lookup.has(rawKeyStr) ? lookup.get(rawKeyStr) : rawKeyStr;
    sums.set(resolved, (sums.get(resolved) || 0) + val);
  });
  const ranked = [...sums.entries()].sort((a, b) => b[1] - a[1]);
  const top = ranked.slice(0, n).map(([label, value]) => ({ label, value }));
  const otherTotal = ranked.slice(n).reduce((s, [, v]) => s + v, 0);
  if (otherTotal > 0) top.push({ label: 'Other', value: otherTotal, isOther: true });
  return top;
}

// Finds the geography grouping key for the fact table, checking the
// DIRECT shape first (a geo_dimension-role column right on the fact table
// itself) and falling back to the INDIRECT shape (a geo_dimension column
// on an already-joined customer/merchant/product dimension file, resolved
// via the geoLookup services/fullDescriptiveAnalytics.js built alongside
// each dimension's name lookup). Returns null when neither shape is
// present anywhere in the dataset.
function resolveGeo(ctx) {
  const directCol = findRoleColumn(ctx.factFile, 'geo_dimension');
  if (directCol) return { keyCol: directCol.name, lookup: null, indirect: false };
  const roleWithGeo = ['customer_id', 'merchant_id', 'product_id']
    .find((role) => ctx.dimensions && ctx.dimensions[role] && ctx.dimensions[role].geoLookup);
  if (!roleWithGeo) return null;
  const idCol = findRoleColumn(ctx.factFile, roleWithGeo);
  if (!idCol) return null;
  return {
    keyCol: idCol.name, lookup: ctx.dimensions[roleWithGeo].geoLookup, indirect: true, viaRole: roleWithGeo, dim: ctx.dimensions[roleWithGeo],
  };
}

// Round 21 — resolves a genuine catalog/listed "current price" for
// whatever the fact table's rows are about, when a joined product (or
// merchant) dimension file carries its OWN 'price'-role column, distinct
// from the fact table's own transactional price/revenue figure. This
// matters specifically for a price what-if scenario: Olist has no such
// split (order_items.price IS the only price anywhere in the dataset),
// but a generic e-commerce export commonly does — products.csv carries
// a base/catalog price while order_items.csv carries the historical
// price actually charged per line, which can differ from the catalog
// price (discounts, price changes over time). The catalog price is the
// correct "what if we changed OUR price" decision variable; the fact
// table's own historical price is a realized OUTCOME, not a decision —
// same distinction resolveGeo()/resolveCategoryColumn() already draw
// between a fact table's own column and a joined dimension's. Always
// indirect (a dimension file's own column, by definition) — there is no
// "direct on the fact table" case to check first here, unlike geo/
// category, since the fact table's own price role already IS revenue/
// findRevenueColumn()'s fallback, not a separate catalog concept.
function resolveCatalogPrice(ctx) {
  const roleWithPrice = ['product_id', 'merchant_id']
    .find((role) => ctx.dimensions && ctx.dimensions[role] && ctx.dimensions[role].priceLookup);
  if (!roleWithPrice) return null;
  const idCol = findRoleColumn(ctx.factFile, roleWithPrice);
  if (!idCol) return null;
  const dim = ctx.dimensions[roleWithPrice];
  // sourceLabel names the DIMENSION FILE this catalog price came from
  // (e.g. "Products"), not the raw column name ("price") — a consumer-
  // facing "Current price uses price's catalog/listed price" reads like a
  // typo, where "Current price uses Products' catalog/listed price" reads
  // as the ERD-grounded sentence it's meant to be.
  return {
    keyCol: idCol.name, priceLookup: dim.priceLookup, indirect: true, viaRole: roleWithPrice, dim, sourceLabel: titleize(dim.fileType),
  };
}

function monthKeyOf(raw) {
  const t = Date.parse(String(raw || '').trim());
  if (!Number.isFinite(t)) return null;
  const d = new Date(t);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

function dayKeyOf(raw) {
  const t = Date.parse(String(raw || '').trim());
  if (!Number.isFinite(t)) return null;
  return new Date(t).toISOString().slice(0, 10);
}

// Cost/expense datasets carry secondary fields (a credit, a discount)
// that are real signal but too minor/varied in naming to deserve their
// own services/businessSemantics.js role — found here by scanning the
// fact file's FULL column list (ctx.factFileProfile, every column
// regardless of whether it won a formal semantic role), not just the
// columns findRoleColumn() already knows about.
function findLooseColumns(factFileProfile, nameRe, kinds) {
  if (!factFileProfile) return [];
  return factFileProfile.columns.filter((c) => nameRe.test(c.name) && kinds.includes(c.kind));
}

// Every entry: { id, label, kind, requires: [roles], compute(ctx) }.
// `compute` returns { value, provenance, ... } when eligible, or null
// when the required roles aren't all present — the caller (evaluate
// Metrics below) turns a null into the standard "not applicable" shape,
// so no metric definition has to write that boilerplate itself.
const METRICS = [
  {
    id: 'TOTAL_REVENUE',
    label: 'Total revenue',
    kind: 'money',
    requires: ['revenue'],
    compute(ctx) {
      const revInfo = findRevenueColumn(ctx);
      const revCol = revInfo && revInfo.col;
      const { total, counted } = sumColumn(ctx.factFile.rows, revCol.name);
      return {
        value: total,
        isFallback: revInfo.isFallback,
        provenance: this.provenanceFor(ctx, [revCol], `Summed "${revCol.name}" across ${counted.toLocaleString()} rows of ${ctx.factFile.fileType}.${revenueFallbackNote(revInfo)}`),
      };
    },
  },
  {
    id: 'TOTAL_ORDERS',
    label: 'Total orders / transactions',
    kind: 'count',
    requires: [],
    compute(ctx) {
      const orderIdCol = findRoleColumn(ctx.factFile, 'order_id');
      let value;
      let note;
      if (orderIdCol) {
        value = new Set(ctx.factFile.rows.map((r) => r[orderIdCol.name]).filter((v) => v !== null && v !== undefined && String(v).trim() !== '')).size;
        note = `Counted distinct "${orderIdCol.name}" values in ${ctx.factFile.fileType}.`;
      } else {
        value = ctx.factFile.rows.length;
        note = `Counted rows in ${ctx.factFile.fileType} (no dedicated order/transaction id column was found).`;
      }
      return { value, provenance: this.provenanceFor(ctx, orderIdCol ? [orderIdCol] : [], note) };
    },
  },
  {
    id: 'PAYING_CUSTOMERS',
    label: 'Paying customers',
    kind: 'count',
    requires: ['revenue', 'customer_id'],
    compute(ctx) {
      const revInfo = findRevenueColumn(ctx);
      const revCol = revInfo && revInfo.col;
      const custCol = findRoleColumn(ctx.factFile, 'customer_id');
      const payers = new Set();
      ctx.factFile.rows.forEach((row) => {
        const v = tryParseNumber(row[revCol.name]);
        const c = row[custCol.name];
        if (v !== null && v > 0 && c !== null && c !== undefined && String(c).trim() !== '') payers.add(String(c).trim());
      });
      return {
        value: payers.size,
        provenance: this.provenanceFor(ctx, [revCol, custCol], `Distinct "${custCol.name}" values with a positive "${revCol.name}".${revenueFallbackNote(revInfo)}`),
      };
    },
  },
  {
    id: 'ARPU',
    label: 'Average revenue per paying customer (ARPU)',
    kind: 'money',
    requires: ['revenue', 'customer_id'],
    compute(ctx) {
      const revenue = METRICS.find((m) => m.id === 'TOTAL_REVENUE').compute(ctx);
      const payers = METRICS.find((m) => m.id === 'PAYING_CUSTOMERS').compute(ctx);
      if (!payers.value) return null;
      return {
        value: revenue.value / payers.value,
        provenance: this.provenanceFor(ctx, [], 'Total revenue ÷ paying customers.'),
      };
    },
  },
  {
    id: 'AOV',
    label: 'Average order value (AOV)',
    kind: 'money',
    requires: ['revenue'],
    compute(ctx) {
      const revenue = METRICS.find((m) => m.id === 'TOTAL_REVENUE').compute(ctx);
      const orders = METRICS.find((m) => m.id === 'TOTAL_ORDERS').compute(ctx);
      if (!orders.value) return null;
      return {
        value: revenue.value / orders.value,
        provenance: this.provenanceFor(ctx, [], 'Total revenue ÷ total orders/transactions.'),
      };
    },
  },
  // --- Line-item price stats — the 'price' role (a listed/unit price on a
  // dimension row, e.g. an order-line item) is deliberately distinct from
  // 'revenue' (a transaction-level amount) — see services/businessSemantics.js.
  // Generalizes Olist's "Average/Median Item Price" to any dataset whose
  // fact table carries a price-role column, under any column name.
  {
    id: 'AVG_PRICE',
    label: 'Average item price',
    kind: 'money',
    requires: ['price'],
    compute(ctx) {
      const priceCol = findRoleColumn(ctx.factFile, 'price');
      const { total, counted } = sumColumn(ctx.factFile.rows, priceCol.name);
      if (counted === 0) return null;
      return {
        value: total / counted,
        provenance: this.provenanceFor(ctx, [priceCol], `Mean of "${priceCol.name}" across ${counted.toLocaleString()} rows of ${ctx.factFile.fileType}.`),
      };
    },
  },
  {
    id: 'MEDIAN_PRICE',
    label: 'Median item price',
    kind: 'money',
    requires: ['price'],
    compute(ctx) {
      const priceCol = findRoleColumn(ctx.factFile, 'price');
      const values = ctx.factFile.rows.map((r) => tryParseNumber(r[priceCol.name])).filter((v) => v !== null).sort((a, b) => a - b);
      if (values.length === 0) return null;
      const mid = Math.floor(values.length / 2);
      const median = values.length % 2 === 0 ? (values[mid - 1] + values[mid]) / 2 : values[mid];
      return {
        value: median,
        provenance: this.provenanceFor(ctx, [priceCol], `Median of "${priceCol.name}" across ${values.length.toLocaleString()} rows of ${ctx.factFile.fileType}.`),
      };
    },
  },
  {
    // Generalizes Olist's "Average Items per Order" without assuming a
    // dedicated quantity column exists — an order-items-style file with
    // one row per line item (no quantity column at all) counts rows
    // instead, which is exactly right for that shape (Olist's own
    // order_items.csv has no quantity column because each row already IS
    // one item).
    id: 'AVG_ITEMS_PER_ORDER',
    label: 'Average items per order',
    kind: 'number',
    requires: ['order_id'],
    compute(ctx) {
      const orderCol = findRoleColumn(ctx.factFile, 'order_id');
      const orders = new Set(ctx.factFile.rows.map((r) => r[orderCol.name]).filter((v) => v !== null && v !== undefined && String(v).trim() !== ''));
      if (orders.size === 0) return null;
      const qCol = findRoleColumn(ctx.factFile, 'quantity');
      let items;
      let note;
      if (qCol) {
        items = sumColumn(ctx.factFile.rows, qCol.name).total;
        note = `Summed "${qCol.name}" ÷ distinct "${orderCol.name}" values.`;
      } else {
        items = ctx.factFile.rows.length;
        note = `Counted rows (one row per line item) ÷ distinct "${orderCol.name}" values — no dedicated quantity column was found.`;
      }
      return {
        value: items / orders.size,
        provenance: this.provenanceFor(ctx, [orderCol, qCol].filter(Boolean), note),
      };
    },
  },
  {
    id: 'REVENUE_BY_PERIOD',
    label: 'Revenue by period',
    kind: 'trend',
    requires: ['revenue', 'date'],
    compute(ctx) {
      const revInfo = findRevenueColumn(ctx);
      const revCol = revInfo && revInfo.col;
      const dateCol = findRoleColumn(ctx.factFile, 'date');
      const sums = new Map();
      ctx.factFile.rows.forEach((row) => {
        const month = monthKeyOf(row[dateCol.name]);
        const val = tryParseNumber(row[revCol.name]);
        if (month && val !== null) sums.set(month, (sums.get(month) || 0) + val);
      });
      if (sums.size < 2) return null; // a trend needs at least two points to mean anything
      const value = [...sums.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([label, v]) => ({ label, value: v }));
      return {
        value, dateColumn: dateCol.name, provenance: this.provenanceFor(ctx, [revCol, dateCol], `"${revCol.name}" summed by month of "${dateCol.name}".${revenueFallbackNote(revInfo)}`),
      };
    },
  },
  {
    id: 'REVENUE_BY_CUSTOMER',
    label: 'Revenue by customer',
    kind: 'breakdown',
    requires: ['revenue', 'customer_id'],
    compute(ctx) {
      const revInfo = findRevenueColumn(ctx);
      const revCol = revInfo && revInfo.col;
      const custCol = findRoleColumn(ctx.factFile, 'customer_id');
      const dim = ctx.dimensions.customer_id;
      const value = groupSumTopN(ctx.factFile.rows, custCol.name, revCol.name, dim ? dim.lookup : null);
      const note = (dim
        ? `"${revCol.name}" summed by "${custCol.name}", joined to ${dim.fileType}.${dim.labelColumn} for customer names (${dim.overlapPct.toFixed(1)}% id overlap).`
        : `"${revCol.name}" summed by "${custCol.name}" — no matching customer file was found to resolve names, so raw ids are shown.`) + revenueFallbackNote(revInfo);
      return { value, provenance: this.provenanceFor(ctx, [revCol, custCol], note, dim ? dim.joinPath : []) };
    },
  },
  {
    id: 'REVENUE_BY_MERCHANT',
    label: 'Revenue by restaurant / merchant',
    kind: 'breakdown',
    requires: ['revenue', 'merchant_id'],
    compute(ctx) {
      const revInfo = findRevenueColumn(ctx);
      const revCol = revInfo && revInfo.col;
      const mCol = findRoleColumn(ctx.factFile, 'merchant_id');
      const dim = ctx.dimensions.merchant_id;
      const value = groupSumTopN(ctx.factFile.rows, mCol.name, revCol.name, dim ? dim.lookup : null);
      const note = (dim
        ? `"${revCol.name}" summed by "${mCol.name}", joined to ${dim.fileType}.${dim.labelColumn} for names (${dim.overlapPct.toFixed(1)}% id overlap).`
        : `"${revCol.name}" summed by "${mCol.name}" — no matching merchant file was found to resolve names.`) + revenueFallbackNote(revInfo);
      return { value, provenance: this.provenanceFor(ctx, [revCol, mCol], note, dim ? dim.joinPath : []) };
    },
  },
  {
    id: 'REVENUE_BY_PRODUCT',
    label: 'Revenue by product',
    kind: 'breakdown',
    requires: ['revenue', 'product_id'],
    compute(ctx) {
      const revInfo = findRevenueColumn(ctx);
      const revCol = revInfo && revInfo.col;
      const pCol = findRoleColumn(ctx.factFile, 'product_id');
      const dim = ctx.dimensions.product_id;
      const value = groupSumTopN(ctx.factFile.rows, pCol.name, revCol.name, dim ? dim.lookup : null);
      const note = (dim
        ? `"${revCol.name}" summed by "${pCol.name}", joined to ${dim.fileType}.${dim.labelColumn} for names (${dim.overlapPct.toFixed(1)}% id overlap).`
        : `"${revCol.name}" summed by "${pCol.name}" — no matching product file was found to resolve names.`) + revenueFallbackNote(revInfo);
      return { value, provenance: this.provenanceFor(ctx, [revCol, pCol], note, dim ? dim.joinPath : []) };
    },
  },
  {
    // requires: [] rather than ['revenue', 'geo_dimension'] — a geo
    // column is never required to sit ON the fact table (see resolveGeo()
    // above), so evaluateMetrics()'s generic missing-role check would
    // wrongly report this "not applicable" whenever geography only lives
    // on a joined dimension file (Olist's customer_state, on customers.csv,
    // not orders.csv). This checks its own applicability instead — it still
    // needs a real revenue column, just not a geo column on THIS file.
    id: 'REVENUE_BY_GEOGRAPHY',
    label: 'Revenue by geography',
    kind: 'breakdown',
    requires: [],
    compute(ctx) {
      const revInfo = findRevenueColumn(ctx);
      const revCol = revInfo && revInfo.col;
      if (!revCol) return null;
      const geo = resolveGeo(ctx);
      if (!geo) return null;
      const value = groupSumByLookupTopN(ctx.factFile.rows, geo.keyCol, revCol.name, geo.lookup);
      if (!value.length) return null;
      const note = (geo.indirect
        ? `"${revCol.name}" summed by "${geo.dim.geoColumn}", resolved via ${geo.dim.fileType}.${geo.keyCol} (${geo.dim.overlapPct.toFixed(1)}% id overlap).`
        : `"${revCol.name}" summed by "${geo.keyCol}".`) + revenueFallbackNote(revInfo);
      return { value, provenance: this.provenanceFor(ctx, [revCol], note, geo.indirect ? geo.dim.joinPath : []) };
    },
  },
  {
    // Same requires: [] reasoning as REVENUE_BY_GEOGRAPHY just above — a
    // category label is never required to sit ON the fact table either
    // (see resolveCategoryColumn()'s direct/indirect split, the same shape
    // as resolveGeo()), so this checks its own applicability instead of
    // naming a role evaluateMetrics()'s generic missing-role check would
    // wrongly gate on. This is the ranked "Sales by Category" breakdown —
    // distinct from the business-descriptive-statistics layer's "Top
    // Category by revenue" (a single scalar winner), the same split
    // REVENUE_BY_CUSTOMER/MERCHANT/PRODUCT already have from their own
    // "Total X" business-statistics counterparts.
    id: 'REVENUE_BY_CATEGORY',
    label: 'Revenue by category',
    kind: 'breakdown',
    requires: [],
    compute(ctx) {
      const revInfo = findRevenueColumn(ctx);
      const revCol = revInfo && revInfo.col;
      if (!revCol) return null;
      const category = resolveCategoryColumn(ctx);
      if (!category) return null;
      const value = groupSumByLookupTopN(ctx.factFile.rows, category.keyCol, revCol.name, category.lookup);
      if (!value.length) return null;
      const note = (category.indirect
        ? `"${revCol.name}" summed by "${category.sourceLabel}", resolved via ${category.dim.fileType}.${category.keyCol} (${category.dim.overlapPct.toFixed(1)}% id overlap).`
        : `"${revCol.name}" summed by "${category.keyCol}".`) + revenueFallbackNote(revInfo);
      return { value, provenance: this.provenanceFor(ctx, [revCol], note, category.indirect ? category.dim.joinPath : []) };
    },
  },
  {
    id: 'USAGE',
    label: 'Total usage (quantity)',
    kind: 'count',
    requires: ['quantity'],
    compute(ctx) {
      const qCol = findRoleColumn(ctx.factFile, 'quantity');
      const { total } = sumColumn(ctx.factFile.rows, qCol.name);
      return { value: total, provenance: this.provenanceFor(ctx, [qCol], `Summed "${qCol.name}" across ${ctx.factFile.fileType}.`) };
    },
  },
  {
    id: 'USAGE_BY_PERIOD',
    label: 'Usage over time',
    kind: 'trend',
    requires: ['quantity', 'date'],
    compute(ctx) {
      const qCol = findRoleColumn(ctx.factFile, 'quantity');
      const dateCol = findRoleColumn(ctx.factFile, 'date');
      const sums = new Map();
      ctx.factFile.rows.forEach((row) => {
        const month = monthKeyOf(row[dateCol.name]);
        const val = tryParseNumber(row[qCol.name]);
        if (month && val !== null) sums.set(month, (sums.get(month) || 0) + val);
      });
      if (sums.size < 2) return null;
      const value = [...sums.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([label, v]) => ({ label, value: v }));
      return {
        value, dateColumn: dateCol.name, provenance: this.provenanceFor(ctx, [qCol, dateCol], `"${qCol.name}" summed by month of "${dateCol.name}".`),
      };
    },
  },
  // --- Cost/expense metrics — for a dataset whose fact table's monetary
  // measure reads as COST (services/businessSemantics.js's 'cost' role),
  // not REVENUE. A cloud billing export is the motivating case, but
  // nothing here is GCP-specific: any dated expense/billing export with a
  // 'cost' column produces these the same way REVENUE metrics above are
  // produced for a sales dataset — see claude/monetization-discovery-
  // engine.md's cost-vs-revenue section.
  {
    id: 'TOTAL_COST',
    label: 'Total cost / expenditure',
    kind: 'money',
    requires: ['cost'],
    compute(ctx) {
      const costCol = findRoleColumn(ctx.factFile, 'cost');
      const { total, counted } = sumColumn(ctx.factFile.rows, costCol.name);
      return {
        value: total,
        provenance: this.provenanceFor(ctx, [costCol], `Summed "${costCol.name}" across ${counted.toLocaleString()} rows of ${ctx.factFile.fileType} — an expenditure/cost figure, not customer revenue.`),
      };
    },
  },
  {
    id: 'COST_BY_PERIOD',
    label: 'Cost over time',
    kind: 'trend',
    requires: ['cost', 'date'],
    compute(ctx) {
      const costCol = findRoleColumn(ctx.factFile, 'cost');
      const dateCol = findRoleColumn(ctx.factFile, 'date');
      const sums = new Map();
      ctx.factFile.rows.forEach((row) => {
        const month = monthKeyOf(row[dateCol.name]);
        const val = tryParseNumber(row[costCol.name]);
        if (month && val !== null) sums.set(month, (sums.get(month) || 0) + val);
      });
      if (sums.size < 2) return null;
      const value = [...sums.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([label, v]) => ({ label, value: v }));
      return {
        value, dateColumn: dateCol.name, provenance: this.provenanceFor(ctx, [costCol, dateCol], `"${costCol.name}" summed by month of "${dateCol.name}".`),
      };
    },
  },
  {
    id: 'AVG_DAILY_COST',
    label: 'Average daily cost',
    kind: 'money',
    requires: ['cost', 'date'],
    compute(ctx) {
      const costCol = findRoleColumn(ctx.factFile, 'cost');
      const dateCol = findRoleColumn(ctx.factFile, 'date');
      const byDay = new Map();
      ctx.factFile.rows.forEach((row) => {
        const day = dayKeyOf(row[dateCol.name]);
        const val = tryParseNumber(row[costCol.name]);
        if (day && val !== null) byDay.set(day, (byDay.get(day) || 0) + val);
      });
      if (byDay.size === 0) return null;
      const total = [...byDay.values()].reduce((s, v) => s + v, 0);
      return {
        value: total / byDay.size,
        sublabel: `across ${byDay.size.toLocaleString()} day(s) with recorded activity`,
        provenance: this.provenanceFor(ctx, [costCol, dateCol], `Total "${costCol.name}" ÷ number of distinct calendar days present in "${dateCol.name}".`),
      };
    },
  },
  {
    id: 'AVG_MONTHLY_COST',
    label: 'Average monthly cost',
    kind: 'money',
    requires: ['cost', 'date'],
    compute(ctx) {
      const costCol = findRoleColumn(ctx.factFile, 'cost');
      const dateCol = findRoleColumn(ctx.factFile, 'date');
      const byMonth = new Map();
      ctx.factFile.rows.forEach((row) => {
        const month = monthKeyOf(row[dateCol.name]);
        const val = tryParseNumber(row[costCol.name]);
        if (month && val !== null) byMonth.set(month, (byMonth.get(month) || 0) + val);
      });
      if (byMonth.size === 0) return null;
      const total = [...byMonth.values()].reduce((s, v) => s + v, 0);
      return {
        value: total / byMonth.size,
        sublabel: `across ${byMonth.size} month(s)`,
        provenance: this.provenanceFor(ctx, [costCol, dateCol], `Total "${costCol.name}" ÷ number of distinct calendar months present in "${dateCol.name}".`),
      };
    },
  },
  {
    id: 'COST_BY_CATEGORY',
    label: 'Cost by service (highest-cost first)',
    kind: 'breakdown',
    requires: ['cost', 'cost_category'],
    compute(ctx) {
      const costCol = findRoleColumn(ctx.factFile, 'cost');
      const catCol = findRoleColumn(ctx.factFile, 'cost_category');
      const value = groupSumTopN(ctx.factFile.rows, catCol.name, costCol.name, null);
      return {
        value,
        provenance: this.provenanceFor(ctx, [costCol, catCol], `"${costCol.name}" summed by "${catCol.name}", highest first.`),
      };
    },
  },
  {
    // See REVENUE_BY_GEOGRAPHY above for why requires is [] rather than
    // naming 'geo_dimension' directly — the same direct/indirect join
    // logic applies here (e.g. a GCP export's own Region_Zone column vs.
    // an Olist-shaped dataset's cost living on a file joined to a geo
    // dimension elsewhere).
    id: 'COST_BY_GEOGRAPHY',
    label: 'Cost by geography',
    kind: 'breakdown',
    requires: [],
    compute(ctx) {
      const costCol = findRoleColumn(ctx.factFile, 'cost');
      if (!costCol) return null;
      const geo = resolveGeo(ctx);
      if (!geo) return null;
      const value = groupSumByLookupTopN(ctx.factFile.rows, geo.keyCol, costCol.name, geo.lookup);
      if (!value.length) return null;
      const note = geo.indirect
        ? `"${costCol.name}" summed by "${geo.dim.geoColumn}", resolved via ${geo.dim.fileType}.${geo.keyCol} (${geo.dim.overlapPct.toFixed(1)}% id overlap).`
        : `"${costCol.name}" summed by "${geo.keyCol}".`;
      return { value, provenance: this.provenanceFor(ctx, [costCol], note, geo.indirect ? geo.dim.joinPath : []) };
    },
  },
  {
    id: 'CREDITS_AND_DISCOUNTS',
    label: 'Credits & discounts',
    kind: 'money',
    requires: [],
    compute(ctx) {
      const matches = findLooseColumns(ctx.factFileProfile, /credit|discount/i, ['currency', 'numeric']);
      if (matches.length === 0) return null;
      let total = 0;
      matches.forEach((col) => {
        total += sumColumn(ctx.factFile.rows, col.name).total;
      });
      return {
        value: total,
        provenance: this.provenanceFor(ctx, [], `Summed ${matches.map((c) => `"${c.name}"`).join(', ')} across ${ctx.factFile.fileType} — the only column(s) whose name suggests a credit or discount.`),
      };
    },
  },
  {
    id: 'COST_ANOMALIES',
    label: 'Cost anomalies (unusually high/low days)',
    kind: 'breakdown',
    requires: ['cost', 'date'],
    compute(ctx) {
      const costCol = findRoleColumn(ctx.factFile, 'cost');
      const dateCol = findRoleColumn(ctx.factFile, 'date');
      const byDay = new Map();
      ctx.factFile.rows.forEach((row) => {
        const day = dayKeyOf(row[dateCol.name]);
        const val = tryParseNumber(row[costCol.name]);
        if (day && val !== null) byDay.set(day, (byDay.get(day) || 0) + val);
      });
      if (byDay.size < 5) return null; // not enough days to establish a baseline
      const values = [...byDay.values()];
      const m = values.reduce((s, v) => s + v, 0) / values.length;
      const variance = values.reduce((s, v) => s + (v - m) ** 2, 0) / values.length;
      const sd = Math.sqrt(variance);
      if (sd === 0) return null; // perfectly flat cost — nothing to flag as anomalous
      const anomalies = [...byDay.entries()]
        .map(([day, v]) => ({ day, value: v, z: (v - m) / sd }))
        .filter((d) => Math.abs(d.z) >= 2)
        .sort((a, b) => Math.abs(b.z) - Math.abs(a.z))
        .slice(0, TOP_N)
        .map((d) => ({ label: `${d.day} (${d.z >= 0 ? '+' : ''}${d.z.toFixed(1)}σ)`, value: d.value }));
      if (anomalies.length === 0) return null;
      return {
        value: anomalies,
        provenance: this.provenanceFor(ctx, [costCol, dateCol], `Daily "${costCol.name}" totals more than 2 standard deviations from the ${byDay.size}-day average (μ=${m.toFixed(2)}, σ=${sd.toFixed(2)}).`),
      };
    },
  },
  {
    id: 'MRR',
    label: 'Monthly recurring revenue (MRR)',
    kind: 'money',
    requires: ['revenue', 'date', 'subscription_plan'],
    compute(ctx) {
      const revCol = findRoleColumn(ctx.factFile, 'revenue');
      const dateCol = findRoleColumn(ctx.factFile, 'date');
      const planCol = findRoleColumn(ctx.factFile, 'subscription_plan');
      const byMonth = new Map();
      ctx.factFile.rows.forEach((row) => {
        const month = monthKeyOf(row[dateCol.name]);
        const val = tryParseNumber(row[revCol.name]);
        if (month && val !== null) byMonth.set(month, (byMonth.get(month) || 0) + val);
      });
      if (byMonth.size === 0) return null;
      const months = [...byMonth.keys()].sort();
      const lastMonth = months[months.length - 1];
      return {
        value: byMonth.get(lastMonth),
        sublabel: lastMonth,
        provenance: this.provenanceFor(ctx, [revCol, dateCol, planCol], `Revenue recognized in ${lastMonth} among rows carrying a "${planCol.name}" value — a plan/tier column is the minimum evidence for recurring billing; this is not confirmed subscription-cadence revenue.`),
      };
    },
  },
  {
    id: 'FREEMIUM_CONVERSION',
    label: 'Freemium conversion rate',
    kind: 'percent',
    requires: ['customer_id', 'subscription_plan'],
    compute(ctx) {
      const custCol = findRoleColumn(ctx.factFile, 'customer_id');
      const planCol = findRoleColumn(ctx.factFile, 'subscription_plan');
      const FREE_RE = /free|trial/i;
      const byCustomer = new Map();
      ctx.factFile.rows.forEach((row) => {
        const c = row[custCol.name];
        const plan = row[planCol.name];
        if (c === null || c === undefined || String(c).trim() === '' || !plan) return;
        const key = String(c).trim();
        if (!byCustomer.has(key)) byCustomer.set(key, { free: false, paid: false });
        const rec = byCustomer.get(key);
        if (FREE_RE.test(String(plan))) rec.free = true; else rec.paid = true;
      });
      const freeCohort = [...byCustomer.values()].filter((r) => r.free);
      if (freeCohort.length === 0) return null; // no free/trial cohort detected at all
      const converted = freeCohort.filter((r) => r.paid).length;
      return {
        value: (converted / freeCohort.length) * 100,
        sublabel: `${converted.toLocaleString()} of ${freeCohort.length.toLocaleString()} free/trial customers`,
        provenance: this.provenanceFor(ctx, [custCol, planCol], `Customers whose "${planCol.name}" value ever matched free/trial, and whether that same customer also had a non-free plan value.`),
      };
    },
  },
  {
    id: 'CHURN',
    label: 'Customer inactivity — descriptive proxy',
    kind: 'percent',
    requires: ['customer_id', 'date'],
    compute(ctx) {
      const custCol = findRoleColumn(ctx.factFile, 'customer_id');
      const dateCol = findRoleColumn(ctx.factFile, 'date');
      const monthsByCustomer = new Map();
      ctx.factFile.rows.forEach((row) => {
        const c = row[custCol.name];
        const month = monthKeyOf(row[dateCol.name]);
        if (!month || c === null || c === undefined || String(c).trim() === '') return;
        const key = String(c).trim();
        if (!monthsByCustomer.has(key)) monthsByCustomer.set(key, new Set());
        monthsByCustomer.get(key).add(month);
      });
      const allMonths = [...new Set(ctx.factFile.rows.map((r) => monthKeyOf(r[dateCol.name])).filter(Boolean))].sort();
      if (allMonths.length < 3) return null; // not enough calendar history to speak of a "prior" and "latest" period at all
      const repeatCustomers = [...monthsByCustomer.values()].filter((s) => s.size > 1).length;
      if (repeatCustomers < 5 || repeatCustomers / monthsByCustomer.size < 0.1) return null; // insufficient longitudinal (repeat-activity) evidence — most customers here look one-and-done, not a churn-measurable cohort
      const priorMonth = allMonths[allMonths.length - 2];
      const lastMonth = allMonths[allMonths.length - 1];
      const activeInPrior = [...monthsByCustomer.entries()].filter(([, s]) => s.has(priorMonth)).map(([k]) => k);
      if (activeInPrior.length === 0) return null;
      const stillActive = activeInPrior.filter((k) => monthsByCustomer.get(k).has(lastMonth)).length;
      const churned = activeInPrior.length - stillActive;
      return {
        value: (churned / activeInPrior.length) * 100,
        sublabel: `${priorMonth} → ${lastMonth}`,
        provenance: this.provenanceFor(ctx, [custCol, dateCol], `Of customers active in ${priorMonth}, the share with no activity recorded in ${lastMonth} — a simple month-over-month descriptive proxy, not a predictive churn model (see Predictive Analytics for that).`),
      };
    },
  },
];

// Shared provenance builder — every metric's compute() calls this so the
// shape (and the confidence-band rollup) never drifts between metrics.
function provenanceFor(ctx, roleColumns, note, joinPath = []) {
  const confidences = roleColumns.filter(Boolean).map((c) => c.confidence);
  const confidence = confidences.length ? Math.min(...confidences) : 1;
  return {
    sourceFile: ctx.factFile.fileType,
    sourceColumns: roleColumns.filter(Boolean).map((c) => c.name),
    joinPath,
    confidence,
    band: confidence >= 0.7 ? 'High' : confidence >= 0.4 ? 'Medium' : 'Low',
    note,
  };
}
METRICS.forEach((m) => { m.provenanceFor = provenanceFor; });

const ROLE_LABELS = {
  revenue: 'a revenue/amount column (or a listed price on a dated/order-keyed row)',
  cost: 'a cost/expenditure column',
  cost_category: 'a service/vendor/category column to break cost down by',
  geo_dimension: 'a region/state/country/city column',
  customer_id: 'a customer identifier',
  merchant_id: 'a restaurant/merchant identifier',
  product_id: 'a product identifier',
  order_id: 'an order/transaction identifier',
  date: 'a date column',
  quantity: 'a quantity/usage measure',
  price: 'a listed/unit price column',
  subscription_plan: 'a subscription/plan column',
};

// A role is "present" for gating purposes the same way it's actually
// resolved when a metric computes — in particular 'revenue' counts as
// present when findRevenueColumn()'s price fallback would apply, not only
// when a formally-roled revenue column exists, so a metric never gets
// stuck reporting "not applicable" for a figure it's actually about to
// compute successfully.
function roleIsPresent(ctx, role) {
  if (role === 'revenue') return !!findRevenueColumn(ctx);
  return !!findRoleColumn(ctx.factFile, role);
}

function missingRolesReason(ctx, requires) {
  const names = requires.filter((r) => !roleIsPresent(ctx, r)).map((r) => ROLE_LABELS[r] || r);
  return `Not applicable — ${names.join(' and ')} could not be identified in ${ctx.factFile.fileType}, so there isn't enough evidence to compute this.`;
}

// Evaluates the whole registry against one dataset's business context,
// returning every metric with either a real computed value or an
// explicit "not applicable" — never a mix of the two under one shape, so
// the view layer never has to guess which it got.
// ---------------------------------------------------------------------
// Dynamic metric generators — the "generalized engine" half of this
// dataset-agnostic build. Every METRICS entry above is a fixed, named
// definition (TOTAL_REVENUE, COST_BY_CATEGORY, ...); these four instead
// SCAN whatever the fact table actually contains and produce however many
// metric RESULTS that scan turns up — zero for a narrow dataset, a dozen+
// for a wide one — rather than one static id per possible column. Each
// returns already-resolved result objects (the {id, label, kind,
// applicable: true, value, provenance} shape evaluateMetrics() below
// gives every STATIC metric), because there's no fixed id to report
// "not applicable" against: a column that doesn't qualify simply
// contributes nothing, the same way a dimension file that was never
// uploaded contributes no metric today.
//
// This is deliberately the generalized-engine reading of "descriptive
// analytics based on the dataset's ERD" a GCP Cloud Billing export and an
// Olist-shaped e-commerce export both asked for: "Top Costliest
// Resources"/"Most-Used Resources" and "Top Products"/"Top Sellers" are
// the SAME shape (an unclaimed id-kind column broken down by whichever
// measure the dataset actually has), not two hardcoded metrics — see
// buildEntityBreakdownMetrics(). Likewise "CPU/Memory Utilization" and
// "Freight Analysis" are the same shape (a currency/numeric column no
// semantic role claimed) — see buildLeftoverMeasureMetrics(). "Delivery
// Delay"/"On-Time Delivery Rate" and any other date-pair dataset reduce
// to one generator — see buildDatePairMetrics().
const CLAIMED_MEASURE_ROLES = new Set(['revenue', 'cost', 'price', 'quantity']);
const DYNAMIC_METRIC_CAP = 14;

function pluralize(word) {
  if (/[sxz]$|[cs]h$/i.test(word)) return `${word}es`;
  if (/[^aeiou]y$/i.test(word)) return `${word.slice(0, -1)}ies`;
  return `${word}s`;
}

// "Total_Cost_INR" -> "Total Cost INR", "CPU_Utilization" -> "CPU
// Utilization", "review_score" -> "Review Score". Short (<=3 char)
// all-caps runs are kept as-is (acronyms like INR/CPU/ID) rather than
// title-cased into "Inr"/"Cpu".
function titleize(name) {
  const spaced = String(name)
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_\-]+/g, ' ')
    .trim();
  if (!spaced) return String(name);
  return spaced.split(/\s+/).map((w) => {
    if (w.length <= 3 && w === w.toUpperCase() && /[A-Z]/.test(w)) return w;
    return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
  }).join(' ');
}

// "Resource_ID" -> "Resource", "seller_id" -> "Seller" — the entity name
// implied by an id-kind column's own name, for a generic "Top <entity>"
// breakdown title when no dedicated customer/merchant/product role fits.
// Also strips a leading "__bridged_" prefix first — services/
// fullDescriptiveAnalytics.js's two-hop bridge (Round 15) names its
// materialized column after the role's own natural name whenever
// possible, but falls back to that prefixed form on a rare name
// collision; this keeps the label clean even in that fallback case.
function entityLabelFromIdColumn(name) {
  const unprefixed = String(name).replace(/^__bridged_/, '');
  const stripped = unprefixed.replace(/[_ ]?id$/i, '').trim();
  return titleize(stripped || name);
}

// A leftover column whose name reads as a ratio/rate/score (CPU/memory
// "utilization", a "rate", a "score", an "index") is a bounded, already-
// averaged-per-row measure — SUMMING it across rows ("Total CPU
// Utilization: 9,969%") is meaningless, where its AVERAGE ("Average CPU
// Utilization: 49.6%") is the number an SME/engineer actually wants (the
// per-column histogram that would normally sit beside it is already
// produced elsewhere, by the per-file numeric-column charts in
// buildFullDescriptiveCards() — this generator only owns the single KPI).
// A genuine currency column is never ambiguous this way (a cost/fee is
// additive by nature), so this only ever reclassifies a 'numeric'-kind
// leftover, never a 'currency' one.
const AVERAGE_STYLE_RE = /utili[sz]ation|\bpercent\b|\brate\b|\bscore\b|\bratio\b|\bindex\b|\bavg\b|average|installments?/i;

// Any currency/numeric fact-table column NOT already claimed by a
// revenue/cost/price/quantity role gets its own KPI — a Total for an
// additive measure (a freight/shipping fee, a tip amount), an Average for
// a ratio-shaped one (CPU/memory utilization) — plus a trend of that same
// KPI if the fact table has a primary date column. Column order in
// ctx.factFileProfile.columns (the file's original column order) decides
// which ones surface first once DYNAMIC_METRIC_CAP trims the combined
// dynamic list.
function buildLeftoverMeasureMetrics(ctx) {
  if (!ctx.factFileProfile) return [];
  const claimedNames = new Set(
    Object.entries(ctx.factFile.columnRoles || {})
      .filter(([, r]) => CLAIMED_MEASURE_ROLES.has(r.role))
      .map(([name]) => name)
  );
  const dateCol = findRoleColumn(ctx.factFile, 'date');
  const results = [];

  // A freight/shipping-fee-named column gets its own dedicated FREIGHT_TOTAL
  // headline metric (see buildFreightTotalMetrics() below) — skip it here so
  // it doesn't ALSO surface a second time as a generic "Total <Column
  // Name>" leftover tile.

  // 'rating'-kind columns are included here too (e.g. an unclaimed
  // review_score on the fact table itself) — always averaged, never
  // summed, since a rating scale's total is never a meaningful number
  // regardless of what its column name happens to say. This is what
  // generalizes "Average Review Score" beyond a name-pattern match: ANY
  // unclaimed rating-kind column on the fact table gets it automatically.
  ctx.factFileProfile.columns
    .filter((c) => ['currency', 'numeric', 'rating'].includes(c.kind) && !claimedNames.has(c.name) && c.mean !== null && !FREIGHT_NAME_RE.test(c.name))
    .forEach((col) => {
      const label = titleize(col.name);
      const isCurrency = col.kind === 'currency';
      const isRating = col.kind === 'rating';
      const preferAverage = isRating || (!isCurrency && AVERAGE_STYLE_RE.test(col.name));
      // A rating (e.g. a 1-5 review score) or an installment COUNT can
      // easily fall inside a plain 0-100 numeric range without being a
      // percentage at all — bounds alone aren't enough evidence. Excluding
      // both here fixes a real mislabeling this generator would otherwise
      // produce (e.g. "Average Review Score: 3.83%" for a score that is
      // actually 3.83 out of 5, not 3.83 percent).
      const looksLikePercentRange = !isRating && !/install/i.test(col.name)
        && col.min !== null && col.min >= 0 && col.max !== null && col.max <= 100;
      const kpiKind = isCurrency ? 'money' : 'number';

      if (preferAverage) {
        const vals = [];
        ctx.factFile.rows.forEach((row) => {
          const v = tryParseNumber(row[col.name]);
          if (v !== null) vals.push(v);
        });
        if (vals.length === 0) return;
        const avg = vals.reduce((s, v) => s + v, 0) / vals.length;
        results.push({
          id: `LEFTOVER_AVG::${col.name}`,
          label: `Average ${label}`,
          kind: 'number',
          unitSuffix: looksLikePercentRange ? '%' : '',
          applicable: true,
          value: Math.round(avg * 100) / 100,
          provenance: provenanceFor(ctx, [], `Averaged "${col.name}" across ${vals.length.toLocaleString()} rows of ${ctx.factFile.fileType} — a ratio/rate-shaped measure, not summed, since a total wouldn't be a meaningful number for it.`),
        });
        return; // a ratio's "trend of its sum" would be equally meaningless — skip
      }

      const { total, counted } = sumColumn(ctx.factFile.rows, col.name);
      if (counted === 0) return;
      results.push({
        id: `LEFTOVER_TOTAL::${col.name}`,
        label: `Total ${label}`,
        kind: kpiKind,
        applicable: true,
        value: total,
        provenance: provenanceFor(ctx, [], `Summed "${col.name}" across ${counted.toLocaleString()} rows of ${ctx.factFile.fileType} — a numeric measure not claimed by any known revenue/cost/price/quantity role, surfaced on its own.`),
      });

      if (dateCol) {
        const sums = new Map();
        ctx.factFile.rows.forEach((row) => {
          const month = monthKeyOf(row[dateCol.name]);
          const val = tryParseNumber(row[col.name]);
          if (month && val !== null) sums.set(month, (sums.get(month) || 0) + val);
        });
        if (sums.size >= 2) {
          const value = [...sums.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([lbl, v]) => ({ label: lbl, value: v }));
          results.push({
            id: `LEFTOVER_TREND::${col.name}`,
            label: `${label} over time`,
            kind: 'trend',
            applicable: true,
            value,
            dateColumn: dateCol.name,
            provenance: provenanceFor(ctx, [], `"${col.name}" summed by month of "${dateCol.name}".`),
          });
        }
      }
    });

  return results;
}

// customer_id/merchant_id/product_id already get their own static
// REVENUE_BY_CUSTOMER/REVENUE_BY_MERCHANT/REVENUE_BY_PRODUCT breakdown
// whenever revenue is present — regardless of whether a dimension file
// was ever resolved for them (those metrics fall back to raw ids with no
// lookup) — so a column holding one of those three roles would be pure
// duplication here. 'order_id' is different: nothing else in the
// registry ever breaks it down (TOTAL_ORDERS only counts it), and an
// id-kind column can legitimately win the 'order_id' role at fairly low
// confidence purely as a generic id-shaped fallback when nothing else on
// the file fits better (e.g. a GCP export's own "Resource_ID", which
// repeats ~65x per resource and is nothing like an order id) — excluding
// every order_id-roled column here would silently drop exactly the
// "Top Costliest Resources"/"Most-Used Resources" breakdowns this
// generator exists for. So an order_id-roled column is only excluded
// when it actually LOOKS like a one-row-per-event id (near-unique) —
// otherwise it's treated as unclaimed and gets the same generic
// breakdown treatment as any other repeating id-kind column.
const DIMENSION_COVERED_ROLES = new Set(['customer_id', 'merchant_id', 'product_id']);
const NEAR_UNIQUE_RATIO = 0.5;

function isClaimedForEntityBreakdown(ctx, col) {
  const roleInfo = ctx.factFile.columnRoles && ctx.factFile.columnRoles[col.name];
  if (!roleInfo) return false;
  if (DIMENSION_COVERED_ROLES.has(roleInfo.role)) return true;
  if (roleInfo.role === 'order_id') {
    const rowCount = ctx.factFile.rows.length || 1;
    return (col.uniqueCount / rowCount) > NEAR_UNIQUE_RATIO;
  }
  return true; // any other assigned role (geo_dimension, cost_category, name_label, ...) is claimed for a different purpose
}

function unclaimedEntityIdColumns(ctx) {
  return ctx.factFileProfile.columns.filter((c) => (
    c.kind === 'id'
    && !isClaimedForEntityBreakdown(ctx, c)
    && c.uniqueCount > 1
    && c.uniqueCount <= 2000
  ));
}

// Any moderate-cardinality id-kind column not already covered by a
// customer/merchant/product breakdown (see isClaimedForEntityBreakdown()
// above) gets top-N breakdowns of the fact table's primary measure
// (revenue, or cost when there's no revenue) and of quantity when
// present — generalizing "Top Costliest Resources"/"Most-Used Resources"
// (a GCP export's Resource_ID) and "Top Sellers" (an Olist-shaped
// export's seller_id, when it wasn't already resolved to merchant_id)
// without naming either domain. Bounded to columns with real repetition
// (uniqueCount > 1) and a sane cardinality ceiling, so a column that's
// really just another primary-key-shaped id (near-100% unique) is left
// alone — a "top N" of all-distinct values is not a useful breakdown.
function buildEntityBreakdownMetrics(ctx) {
  if (!ctx.factFileProfile) return [];
  const results = [];
  const revInfo = findRevenueColumn(ctx);
  const revCol = revInfo && revInfo.col;
  const costCol = findRoleColumn(ctx.factFile, 'cost');
  const qCol = findRoleColumn(ctx.factFile, 'quantity');
  const primaryCol = revCol || costCol;
  const primaryLabel = primaryCol ? titleize(primaryCol.name) : null;

  const candidates = unclaimedEntityIdColumns(ctx);

  candidates.forEach((col) => {
    const entityLabel = entityLabelFromIdColumn(col.name);
    if (primaryCol) {
      const value = groupSumTopN(ctx.factFile.rows, col.name, primaryCol.name, null);
      if (value.length) {
        results.push({
          id: `ENTITY_BY_MEASURE::${col.name}`,
          label: `Top ${entityLabel} by ${primaryLabel}`,
          kind: 'breakdown',
          applicable: true,
          value,
          provenance: provenanceFor(ctx, [primaryCol], `"${primaryCol.name}" summed by "${col.name}", highest first — "${col.name}" doesn't resolve to a known customer/merchant/product identifier, so its own raw values are shown.`),
        });
      }
    }
    if (qCol) {
      const value = groupSumTopN(ctx.factFile.rows, col.name, qCol.name, null);
      if (value.length) {
        results.push({
          id: `ENTITY_BY_USAGE::${col.name}`,
          label: `Most-used ${entityLabel} (by ${titleize(qCol.name)})`,
          kind: 'breakdown',
          applicable: true,
          value,
          provenance: provenanceFor(ctx, [qCol], `"${qCol.name}" summed by "${col.name}", highest first.`),
        });
      }
    }
  });

  return results;
}

// "Number of distinct X" — for the same leftover id-kind columns
// buildEntityBreakdownMetrics() breaks down (e.g. "Number of distinct
// Resources"), plus the cost_category/geo_dimension roled columns when
// present (e.g. "Number of distinct Service Name", "Number of distinct
// Region Zone") — the simple count-of-classes companion to those
// breakdowns.
function distinctCountResult(ctx, col, label) {
  const values = new Set();
  ctx.factFile.rows.forEach((row) => {
    const v = row[col.name];
    if (v !== null && v !== undefined && String(v).trim() !== '') values.add(String(v).trim());
  });
  if (values.size === 0) return null;
  return {
    id: `DISTINCT_COUNT::${col.name}`,
    label: `Number of distinct ${label}`,
    kind: 'count',
    applicable: true,
    value: values.size,
    provenance: provenanceFor(ctx, [], `Counted distinct non-blank values of "${col.name}" in ${ctx.factFile.fileType}.`),
  };
}

function buildDistinctCountMetrics(ctx) {
  if (!ctx.factFileProfile) return [];
  const results = [];

  const idCandidates = unclaimedEntityIdColumns(ctx);
  idCandidates.forEach((col) => {
    const r = distinctCountResult(ctx, col, pluralize(entityLabelFromIdColumn(col.name)));
    if (r) results.push(r);
  });

  ['cost_category', 'geo_dimension'].forEach((role) => {
    const roleCol = findRoleColumn(ctx.factFile, role);
    if (!roleCol) return;
    const fpCol = ctx.factFileProfile.columns.find((c) => c.name === roleCol.name);
    if (!fpCol) return;
    const r = distinctCountResult(ctx, fpCol, titleize(fpCol.name));
    if (r) results.push(r);
  });

  return results;
}

// Average duration (in days) between the fact table's primary date
// column and any OTHER date column it carries — e.g. order date vs.
// delivery date — plus an on-time-rate percentage when an
// "estimated/expected/scheduled" date column and an "actual/delivered/
// completed" one are both present, detected by name rather than hardcoded
// to any one dataset's exact column names.
// Hoisted to module scope (not just local to buildDatePairMetrics) so
// services/diagnosticEngine.js's per-ROW delay computation (Delivery is
// late / Review scores are low diagnostics) can detect the same
// "estimated/expected vs. actual/delivered" date-pair shape without a
// second, independently-maintained copy of this regex — this codebase has
// a documented history of the same name-pattern regex being fixed in one
// place and left stale in another (see STATUS_NAME_RE's own comment
// below), so sharing the one definition is deliberate.
const ESTIMATED_DATE_NAME_RE = /estimat|expect|scheduled|promised|\bdue\b/i;
const ACTUAL_DATE_NAME_RE = /actual|delivered|completed|fulfilled|arrived/i;

function buildDatePairMetrics(ctx) {
  if (!ctx.factFileProfile) return [];
  const primaryDateCol = findRoleColumn(ctx.factFile, 'date');
  if (!primaryDateCol) return [];
  const MS_PER_DAY = 86400000;
  const results = [];

  const otherDateCols = ctx.factFileProfile.columns.filter((c) => c.kind === 'date' && c.name !== primaryDateCol.name);
  otherDateCols.forEach((col) => {
    const diffs = [];
    ctx.factFile.rows.forEach((row) => {
      const t1 = Date.parse(String(row[primaryDateCol.name] || '').trim());
      const t2 = Date.parse(String(row[col.name] || '').trim());
      if (Number.isFinite(t1) && Number.isFinite(t2)) diffs.push((t2 - t1) / MS_PER_DAY);
    });
    if (diffs.length < 5) return; // too few paired dates to mean anything
    const avg = diffs.reduce((s, d) => s + d, 0) / diffs.length;
    results.push({
      id: `DATE_PAIR_DURATION::${col.name}`,
      label: `Average days from ${titleize(primaryDateCol.name)} to ${titleize(col.name)}`,
      kind: 'number',
      unitSuffix: ' days',
      applicable: true,
      value: Math.round(avg * 10) / 10,
      provenance: provenanceFor(ctx, [primaryDateCol], `Average of ("${col.name}" − "${primaryDateCol.name}") in days across ${diffs.length.toLocaleString()} rows with both dates present.`),
    });
  });

  const estCol = ctx.factFileProfile.columns.find((c) => c.kind === 'date' && ESTIMATED_DATE_NAME_RE.test(c.name));
  const actCol = ctx.factFileProfile.columns.find((c) => c.kind === 'date' && ACTUAL_DATE_NAME_RE.test(c.name));
  if (estCol && actCol) {
    let onTime = 0;
    let total = 0;
    ctx.factFile.rows.forEach((row) => {
      const est = Date.parse(String(row[estCol.name] || '').trim());
      const act = Date.parse(String(row[actCol.name] || '').trim());
      if (Number.isFinite(est) && Number.isFinite(act)) {
        total += 1;
        if (act <= est) onTime += 1;
      }
    });
    if (total >= 5) {
      results.push({
        id: `ON_TIME_RATE::${estCol.name}__${actCol.name}`,
        label: `On-time rate (${titleize(actCol.name)} vs. ${titleize(estCol.name)})`,
        kind: 'percent',
        applicable: true,
        value: (onTime / total) * 100,
        provenance: provenanceFor(ctx, [], `Share of ${total.toLocaleString()} rows where "${actCol.name}" fell on or before "${estCol.name}".`),
      });
    }
  }

  return results;
}

// ---------------------------------------------------------------------
// Business Descriptive Statistics — a second layer on top of the metrics
// above, generalizing the specific ~20-KPI executive summary an SME
// owner would expect from a dataset like Olist's (Total Orders/Customers/
// Products/Sellers, Top Category, Top Customer/Seller State, Most-used
// Payment Type, Cancellation Rate, ...). Every one of those reads, at
// face value, like it names Olist's own columns — but each is really an
// instance of a role-general shape already established by the generators
// above, so these are written the same way: scan whatever roles/columns
// the fact table actually has and produce however many results that scan
// turns up, never hardcoded to any one dataset's column names. These are
// intentionally NOT subject to DYNAMIC_METRIC_CAP (see evaluateMetrics()
// below) — that cap exists to stop a wide dataset's leftover columns from
// flooding the tab with one KPI per column; these are a small, fixed-size
// set of headline business figures, not a per-column scan.

// "Total Customers"/"Total Products"/"Total Sellers" — a plain distinct
// count of whichever customer/merchant/product id role the fact table
// carries. Deliberately excludes 'order_id' (TOTAL_ORDERS already covers
// it as a static metric) and 'revenue'-gated PAYING_CUSTOMERS (a
// different question — every customer vs. only ones with a positive
// amount recorded).
const COUNTABLE_ENTITY_ROLES = ['customer_id', 'merchant_id', 'product_id'];

function buildEntityTotalCountMetrics(ctx) {
  const results = [];
  COUNTABLE_ENTITY_ROLES.forEach((role) => {
    const col = findRoleColumn(ctx.factFile, role);
    if (!col) return;
    const distinct = new Set(
      ctx.factFile.rows.map((r) => r[col.name]).filter((v) => v !== null && v !== undefined && String(v).trim() !== '')
    );
    if (distinct.size === 0) return;
    const entityLabel = pluralize(entityLabelFromIdColumn(col.name));
    results.push({
      id: `TOTAL_ENTITY::${role}`,
      label: `Total ${entityLabel}`,
      kind: 'count',
      applicable: true,
      value: distinct.size,
      provenance: provenanceFor(ctx, [col], `Counted distinct "${col.name}" values in ${ctx.factFile.fileType}.`),
    });
  });
  return results;
}

// "Top Category" and "Most-used Payment Type" are the same shape: the
// single most frequent value of a categorical column, by ROW COUNT (not
// revenue-weighted — a plain frequency mode, matching how the rest of the
// descriptive-statistics layer defines "Mode" for a categorical column).
// The category column is either the formal cost_category role (built for
// exactly this — a service/vendor/category breakdown) or, when that role
// wasn't assigned, any unclaimed category-kind column whose name reads as
// a classification (categor.../type/segment/class) — this is what lets
// Olist's own "product_category_name" surface as "Top Category" even
// though nothing about it matches cost_category's own (deliberately
// narrower, cost/billing-oriented) naming pattern. The payment/mechanism
// column is found the same way, by name.
// Anchored on `[_ ]` rather than `\b` for the same reason as STATUS_NAME_RE
// above — "customer_segment"/"risk_class"/"sales_channel" all have an
// underscore immediately before the word of interest, where `\b` never
// matches. "categor" itself needs no anchoring — it's a plain substring
// match by design, so it already catches "product_category_name" fine.
const GENERIC_CATEGORY_NAME_RE = /categor|(?:^|[_ ])segment(?:$|[_ ])|(?:^|[_ ])class(?:ification)?(?:$|[_ ])/i;
const PAYMENT_MECHANISM_NAME_RE = /payment[_ ]?(?:type|method|mode)|(?:^|[_ ])mechanism(?:$|[_ ])|(?:^|[_ ])channel(?:$|[_ ])/i;

function modeOfCategoryColumn(ctx, colName) {
  return modeOfResolvedColumn(ctx, colName, null);
}

// Generalized version of modeOfCategoryColumn() — resolves each row's key
// THROUGH an optional lookup before counting, the same direct/indirect
// split groupSumByLookupTopN() already uses for revenue breakdowns. When
// lookup is null this is identical to modeOfCategoryColumn()'s old direct-
// only behavior; when a lookup is given, a row whose id doesn't resolve to
// anything in it is skipped rather than counted under the raw id — a
// deliberately stricter rule than groupSumByLookupTopN()'s (which falls
// back to the raw key) because a "top" MODE should never crown a raw,
// un-resolved id as if it were a real category/geography value.
function modeOfResolvedColumn(ctx, keyCol, lookup) {
  const counts = new Map();
  let total = 0;
  ctx.factFile.rows.forEach((row) => {
    const raw = row[keyCol];
    if (raw === null || raw === undefined || String(raw).trim() === '') return;
    const rawKeyStr = String(raw).trim();
    const resolved = lookup ? lookup.get(rawKeyStr) : rawKeyStr;
    if (!resolved) return;
    counts.set(resolved, (counts.get(resolved) || 0) + 1);
    total += 1;
  });
  if (total === 0) return null;
  let best = null;
  counts.forEach((count, label) => { if (!best || count > best.count) best = { label, count }; });
  return { label: best.label, count: best.count, percentage: (best.count / total) * 100, total };
}

// Shared by buildTopCategoryMetrics() (frequency mode), buildTopCategoryBy
// RevenueMetrics() (revenue-weighted mode), and the REVENUE_BY_CATEGORY
// metric below, so every category-shaped output is always asking about
// the exact same column — never several independently-drifting category
// detection rules disagreeing with each other. Checks the DIRECT shape
// first (a category-role column right on the fact table itself — the
// cost_category role, or any unclaimed generically-category-named
// column), then falls back to the INDIRECT shape (a category-like column
// on an already-joined product/merchant dimension file, e.g. Olist's
// product_category_name on products.csv, resolved via product_id) — the
// exact same direct/indirect split resolveGeo() already uses for
// geography. Returns { keyCol, lookup, indirect, sourceLabel, dim } or
// null when neither shape is present anywhere in the dataset.
function resolveCategoryColumn(ctx) {
  const claimedNames = new Set(Object.keys(ctx.factFile.columnRoles || {}));
  const costCategoryCol = findRoleColumn(ctx.factFile, 'cost_category');
  if (costCategoryCol) return { keyCol: costCategoryCol.name, lookup: null, indirect: false, sourceLabel: costCategoryCol.name };
  const genericCategoryCol = ctx.factFileProfile && ctx.factFileProfile.columns.find((c) => c.kind === 'category' && !claimedNames.has(c.name) && GENERIC_CATEGORY_NAME_RE.test(c.name));
  if (genericCategoryCol) return { keyCol: genericCategoryCol.name, lookup: null, indirect: false, sourceLabel: genericCategoryCol.name };
  const roleWithCategory = ['product_id', 'merchant_id', 'customer_id']
    .find((role) => ctx.dimensions && ctx.dimensions[role] && ctx.dimensions[role].categoryLookup);
  if (!roleWithCategory) return null;
  const idCol = findRoleColumn(ctx.factFile, roleWithCategory);
  if (!idCol) return null;
  const dim = ctx.dimensions[roleWithCategory];
  return {
    keyCol: idCol.name, lookup: dim.categoryLookup, indirect: true, viaRole: roleWithCategory, dim, sourceLabel: dim.categoryColumn,
  };
}

function buildTopCategoryMetrics(ctx) {
  if (!ctx.factFileProfile) return [];
  const results = [];
  const claimedNames = new Set(Object.keys(ctx.factFile.columnRoles || {}));

  const category = resolveCategoryColumn(ctx);
  if (category) {
    const top = modeOfResolvedColumn(ctx, category.keyCol, category.lookup);
    if (top) {
      const label = titleize(category.sourceLabel);
      const note = category.indirect
        ? `Most frequent "${category.sourceLabel}" among ${top.total.toLocaleString()} rows, resolved via ${category.dim.fileType}.${category.keyCol} (${category.dim.overlapPct.toFixed(1)}% id overlap) — ${top.count.toLocaleString()} rows (${top.percentage.toFixed(1)}%). This is a FREQUENCY leader (most order-line items), not necessarily the same category that leads by revenue — see "Top ${label} by revenue" for that.`
        : `Most frequent value of "${category.keyCol}" — ${top.count.toLocaleString()} of ${top.total.toLocaleString()} rows (${top.percentage.toFixed(1)}%). This is a FREQUENCY leader (most order-line items), not necessarily the same category that leads by revenue — see "Top ${label} by revenue" for that.`;
      results.push({
        id: `TOP_CATEGORY::${category.keyCol}`,
        label: `Top ${label} by sales volume`,
        kind: 'mode',
        applicable: true,
        value: top,
        provenance: provenanceFor(ctx, [], note, category.indirect ? category.dim.joinPath : []),
      });
    }
  }

  const paymentCol = ctx.factFileProfile.columns.find((c) => c.kind === 'category' && !claimedNames.has(c.name) && PAYMENT_MECHANISM_NAME_RE.test(c.name));
  if (paymentCol) {
    const top = modeOfCategoryColumn(ctx, paymentCol.name);
    if (top) {
      results.push({
        id: `TOP_PAYMENT_MECHANISM::${paymentCol.name}`,
        label: `Most-used ${titleize(paymentCol.name)}`,
        kind: 'mode',
        applicable: true,
        value: top,
        provenance: provenanceFor(ctx, [], `Most frequent value of "${paymentCol.name}" — ${top.count.toLocaleString()} of ${top.total.toLocaleString()} rows (${top.percentage.toFixed(1)}%).`),
      });
    }
  }

  return results;
}

// "Top Category by Revenue" — deliberately a SEPARATE metric from
// TOP_CATEGORY above, not a reinterpretation of it. A category's
// popularity by item count and its popularity by revenue can honestly
// disagree (Olist's own data: bed_bath_table leads by item frequency,
// health_beauty leads by revenue) — collapsing them into one "Top
// Category" figure would silently pick a winner between two different
// questions. Uses the exact same category column resolveCategoryColumn()
// found for the frequency version, so the two metrics are always talking
// about the same column, and the same findRevenueColumn() fallback every
// other revenue-shaped metric in this file uses, so it works on a plain
// order-line-item fact table (a 'price' column, no formal 'revenue' role)
// exactly like TOTAL_REVENUE does.
function buildTopCategoryByRevenueMetrics(ctx) {
  if (!ctx.factFileProfile) return [];
  const category = resolveCategoryColumn(ctx);
  if (!category) return [];
  const revInfo = findRevenueColumn(ctx);
  if (!revInfo) return [];
  const ranked = groupSumByLookupTopN(ctx.factFile.rows, category.keyCol, revInfo.col.name, category.lookup);
  const real = ranked.filter((r) => !r.isOther);
  if (!real.length) return [];
  const top = real[0];
  const totalRevenue = ranked.reduce((s, r) => s + r.value, 0);
  const label = titleize(category.sourceLabel);
  const note = (category.indirect
    ? `"${revInfo.col.name}" summed by "${category.sourceLabel}", resolved via ${category.dim.fileType}.${category.keyCol} (${category.dim.overlapPct.toFixed(1)}% id overlap), highest first.`
    : `"${revInfo.col.name}" summed by "${category.keyCol}", highest first.`) + revenueFallbackNote(revInfo);
  return [{
    id: `TOP_CATEGORY_REVENUE::${category.keyCol}`,
    label: `Top ${label} by revenue`,
    kind: 'mode',
    applicable: true,
    value: {
      label: top.label,
      amount: top.value,
      percentage: totalRevenue > 0 ? (top.value / totalRevenue) * 100 : null,
      totalRevenue,
    },
    isFallback: revInfo.isFallback,
    provenance: provenanceFor(ctx, [revInfo.col], note, category.indirect ? category.dim.joinPath : []),
  }];
}

// "Top Customer State"/"Top Seller State" — a FREQUENCY mode (most common
// state a customer/seller/product falls in), not the revenue-weighted
// REVENUE_BY_GEOGRAPHY breakdown. Deliberately loops over every one of
// customer_id/merchant_id/product_id independently (rather than
// resolveGeo()'s single "first match wins" answer used by the revenue/
// cost breakdowns) — Olist's own dataset needs BOTH "Top Customer State"
// and "Top Seller State" from the SAME fact table at once, which a single
// resolved geo dimension structurally can't give. Also covers the DIRECT
// shape (a geo_dimension column right on the fact table itself).
function buildTopGeographyFrequencyMetrics(ctx) {
  const results = [];

  const directCol = findRoleColumn(ctx.factFile, 'geo_dimension');
  if (directCol) {
    const top = modeOfCategoryColumn(ctx, directCol.name);
    if (top) {
      results.push({
        id: `TOP_GEOGRAPHY::direct::${directCol.name}`,
        label: `Top ${titleize(directCol.name)}`,
        kind: 'mode',
        applicable: true,
        value: top,
        provenance: provenanceFor(ctx, [directCol], `Most frequent value of "${directCol.name}" — ${top.count.toLocaleString()} of ${top.total.toLocaleString()} rows (${top.percentage.toFixed(1)}%).`),
      });
    }
  }

  COUNTABLE_ENTITY_ROLES.forEach((role) => {
    const dim = ctx.dimensions && ctx.dimensions[role];
    if (!dim || !dim.geoLookup) return;
    const idCol = findRoleColumn(ctx.factFile, role);
    if (!idCol) return;
    const counts = new Map();
    let total = 0;
    ctx.factFile.rows.forEach((row) => {
      const rawKey = row[idCol.name];
      if (rawKey === null || rawKey === undefined || String(rawKey).trim() === '') return;
      const resolved = dim.geoLookup.get(String(rawKey).trim());
      if (!resolved) return;
      counts.set(resolved, (counts.get(resolved) || 0) + 1);
      total += 1;
    });
    if (total === 0) return;
    let best = null;
    counts.forEach((count, label) => { if (!best || count > best.count) best = { label, count }; });
    const entityLabel = entityLabelFromIdColumn(idCol.name);
    const geoLabel = titleize(dim.geoColumn);
    // Avoid a redundant label like "Top Customer Customer State" when the
    // geo column's own name already starts with the entity's word (as in
    // "customer_state") — say "Top Customer State" instead.
    const combinedLabel = geoLabel.toLowerCase().startsWith(entityLabel.toLowerCase())
      ? `Top ${geoLabel}`
      : `Top ${entityLabel} ${geoLabel}`;
    results.push({
      id: `TOP_GEOGRAPHY::${role}::${dim.geoColumn}`,
      label: combinedLabel,
      kind: 'mode',
      applicable: true,
      value: { label: best.label, count: best.count, percentage: (best.count / total) * 100, total },
      provenance: provenanceFor(ctx, [idCol], `Most frequent "${dim.geoColumn}" among ${total.toLocaleString()} rows, resolved via ${dim.fileType}.${idCol.name} (${dim.overlapPct.toFixed(1)}% id overlap) — ${best.count.toLocaleString()} rows (${((best.count / total) * 100).toFixed(1)}%).`, dim.joinPath),
    });
  });

  return results;
}

// "Cancellation Rate" — generalized to any category-kind column whose
// NAME reads as a status field (order status, shipment status, payment
// status, ...) that actually contains a "canceled"/"cancelled" value
// somewhere in the real data, not assumed from the column name alone. The
// label names the actual column used, since "status" doesn't always mean
// "order status" specifically (a payment-status or shipment-status column
// would compute the same shape of number, just about a different stage).
// Anchored on `[_ ]` rather than `\b` — `\b` never matches next to an
// underscore (it's itself a \w character), so a plain `\bstatus\b` would
// silently fail to match "order_status"/"payment_status", the single most
// common real-world spelling of this column. Same recurring bug already
// fixed repeatedly elsewhere in services/businessSemantics.js.
const STATUS_NAME_RE = /(?:^|[_ ])status(?:$|[_ ])/i;
const CANCEL_VALUE_RE = /cancel/i;

function buildCancellationRateMetrics(ctx) {
  if (!ctx.factFileProfile) return [];
  const statusCol = ctx.factFileProfile.columns.find((c) => c.kind === 'category' && STATUS_NAME_RE.test(c.name));
  if (!statusCol) return [];
  let total = 0;
  let canceled = 0;
  ctx.factFile.rows.forEach((row) => {
    const v = row[statusCol.name];
    if (v === null || v === undefined || String(v).trim() === '') return;
    total += 1;
    if (CANCEL_VALUE_RE.test(String(v))) canceled += 1;
  });
  if (total === 0 || canceled === 0) return []; // no cancellation-like value ever appeared — nothing honest to report
  return [{
    id: `CANCELLATION_RATE::${statusCol.name}`,
    label: `Cancellation rate (${titleize(statusCol.name)})`,
    kind: 'percent',
    applicable: true,
    value: (canceled / total) * 100,
    provenance: provenanceFor(ctx, [], `Share of ${total.toLocaleString()} rows in "${statusCol.name}" whose value contains "cancel".`),
  }];
}

// "Total Freight/Shipping Cost" — a headline figure a shipping-heavy SME
// owner (Olist's own order_items.csv: price + freight_value side by side)
// would expect right alongside Total Revenue, but freight has no formal
// businessSemantics.js role of its own (it's a shipping fee, not the
// revenue/cost/price/quantity roles that role vocabulary covers). Found by
// name rather than role, the same way Top Category/Cancellation Rate are —
// an unclaimed currency/numeric column whose name reads as a freight or
// shipping charge. Given a stable, predictable id (unlike the generic
// LEFTOVER_TOTAL::<column name> scan, whose id varies with the source
// file's own column naming), so the business-descriptive-summary narrative
// generator (routes/dashboard.js's buildBusinessSummaryCard()) can find it
// reliably by id rather than pattern-matching a label.
const FREIGHT_NAME_RE = /freight|shipping[_ ]?(?:cost|charge|fee)|postage/i;

function buildFreightTotalMetrics(ctx) {
  if (!ctx.factFileProfile) return [];
  const claimedNames = new Set(Object.keys(ctx.factFile.columnRoles || {}));
  const freightCol = ctx.factFileProfile.columns.find((c) => ['currency', 'numeric'].includes(c.kind) && !claimedNames.has(c.name) && FREIGHT_NAME_RE.test(c.name));
  if (!freightCol) return [];
  const { total, counted } = sumColumn(ctx.factFile.rows, freightCol.name);
  if (counted === 0) return [];
  return [{
    id: 'FREIGHT_TOTAL',
    label: 'Total freight / shipping cost',
    kind: 'money',
    applicable: true,
    value: total,
    provenance: provenanceFor(ctx, [], `Summed "${freightCol.name}" across ${counted.toLocaleString()} rows of ${ctx.factFile.fileType}.`),
  }];
}

// Delivered/Cancelled order counts and delivery-time KPIs (Round 15) — the
// same STATUS_NAME_RE/CANCEL_VALUE_RE/ESTIMATED_DATE_NAME_RE/
// ACTUAL_DATE_NAME_RE detection buildCancellationRateMetrics() and
// buildDatePairMetrics() already use against the fact table, applied here
// to ctx.linkedOrderFile instead — the "orders"-shaped file services/
// fullDescriptiveAnalytics.js's findFulfillmentBridge() resolves one hop
// away from the fact table, for a dataset whose transaction fact table is
// itself a line-item file (Olist's order_items.csv) with no order-status
// or delivery-date columns of its own. Deliberately only ever reads
// ctx.linkedOrderFile — never re-derives it — and only ever runs when
// services/fullDescriptiveAnalytics.js already determined the fact table
// itself doesn't have what's needed, so there's no risk of this ever
// duplicating buildCancellationRateMetrics()/buildDatePairMetrics()'s own
// fact-table-direct results.
function buildLinkedOrderFileMetrics(ctx) {
  const linked = ctx.linkedOrderFile;
  if (!linked || !linked.profile) return [];
  const results = [];
  const entityLabel = titleize(linked.fileType);
  const sourceNote = ` (computed from the joined "${linked.fileType}" file, ${linked.joinNote}, not ${ctx.factFile.fileType} directly)`;
  const MS_PER_DAY = 86400000;

  const statusCol = linked.profile.columns.find((c) => c.kind === 'category' && STATUS_NAME_RE.test(c.name));
  if (statusCol) {
    const counts = new Map();
    let total = 0;
    linked.rows.forEach((row) => {
      const v = row[statusCol.name];
      if (v === null || v === undefined || String(v).trim() === '') return;
      total += 1;
      const key = String(v).trim().toLowerCase();
      counts.set(key, (counts.get(key) || 0) + 1);
    });
    if (total > 0) {
      const deliveredCount = [...counts.entries()].filter(([k]) => /deliver/i.test(k)).reduce((s, [, c]) => s + c, 0);
      const cancelledCount = [...counts.entries()].filter(([k]) => CANCEL_VALUE_RE.test(k)).reduce((s, [, c]) => s + c, 0);
      if (deliveredCount > 0) {
        results.push({
          id: 'LINKED_DELIVERED_COUNT',
          label: `Delivered ${entityLabel}`,
          kind: 'count',
          applicable: true,
          value: deliveredCount,
          provenance: provenanceFor(ctx, [], `Count of "${statusCol.name}" values containing "deliver" in the joined ${linked.fileType} file, out of ${total.toLocaleString()} rows.${sourceNote}`),
        });
      }
      if (cancelledCount > 0) {
        results.push({
          id: 'LINKED_CANCELLED_COUNT',
          label: `Cancelled ${entityLabel}`,
          kind: 'count',
          applicable: true,
          value: cancelledCount,
          provenance: provenanceFor(ctx, [], `Count of "${statusCol.name}" values containing "cancel" in the joined ${linked.fileType} file, out of ${total.toLocaleString()} rows.${sourceNote}`),
        });
        results.push({
          id: 'LINKED_CANCELLATION_RATE',
          label: `Cancellation rate (${titleize(statusCol.name)})`,
          kind: 'percent',
          applicable: true,
          value: (cancelledCount / total) * 100,
          provenance: provenanceFor(ctx, [], `Share of ${total.toLocaleString()} rows in "${statusCol.name}" (joined ${linked.fileType} file) whose value contains "cancel".${sourceNote}`),
        });
      }
    }
  }

  // "Actual/delivered" date column — when more than one column matches
  // (Olist's own order_delivered_carrier_date AND order_delivered_
  // customer_date both contain "delivered"), a "customer"-qualified name
  // is preferred: the date the CUSTOMER actually received the order, not
  // a mid-journey carrier handoff.
  const actCandidates = linked.profile.columns.filter((c) => c.kind === 'date' && ACTUAL_DATE_NAME_RE.test(c.name));
  const actCol = actCandidates.find((c) => /customer/i.test(c.name)) || actCandidates[0] || null;
  const estCol = linked.profile.columns.find((c) => c.kind === 'date' && ESTIMATED_DATE_NAME_RE.test(c.name));
  const primaryDateColName = linked.profile.dateColumnName;

  if (primaryDateColName && actCol && actCol.name !== primaryDateColName) {
    const diffs = [];
    linked.rows.forEach((row) => {
      const t1 = Date.parse(String(row[primaryDateColName] || '').trim());
      const t2 = Date.parse(String(row[actCol.name] || '').trim());
      if (Number.isFinite(t1) && Number.isFinite(t2) && t2 >= t1) diffs.push((t2 - t1) / MS_PER_DAY);
    });
    if (diffs.length >= 5) {
      const avg = diffs.reduce((s, d) => s + d, 0) / diffs.length;
      results.push({
        id: 'LINKED_AVG_DELIVERY_TIME',
        label: 'Average delivery time',
        kind: 'number',
        unitSuffix: ' days',
        applicable: true,
        value: Math.round(avg * 10) / 10,
        provenance: provenanceFor(ctx, [], `Average of ("${actCol.name}" − "${primaryDateColName}") in days across ${diffs.length.toLocaleString()} rows of the joined ${linked.fileType} file with both dates present.${sourceNote}`),
      });
    }
  }

  if (actCol && estCol && actCol.name !== estCol.name) {
    let late = 0;
    let total = 0;
    linked.rows.forEach((row) => {
      const act = Date.parse(String(row[actCol.name] || '').trim());
      const est = Date.parse(String(row[estCol.name] || '').trim());
      if (Number.isFinite(act) && Number.isFinite(est)) {
        total += 1;
        if (act > est) late += 1;
      }
    });
    if (total >= 5) {
      results.push({
        id: 'LINKED_LATE_DELIVERY_RATE',
        label: `Late-delivery rate (${titleize(actCol.name)} vs. ${titleize(estCol.name)})`,
        kind: 'percent',
        applicable: true,
        value: (late / total) * 100,
        provenance: provenanceFor(ctx, [], `Share of ${total.toLocaleString()} rows in the joined ${linked.fileType} file where "${actCol.name}" fell after "${estCol.name}".${sourceNote}`),
      });
    }
  }

  return results;
}

function evaluateMetrics(ctx) {
  const staticResults = METRICS.map((m) => {
    const missing = m.requires.filter((r) => !roleIsPresent(ctx, r));
    if (missing.length > 0) {
      return {
        id: m.id, label: m.label, kind: m.kind, applicable: false, reason: missingRolesReason(ctx, m.requires),
      };
    }
    let result;
    try {
      result = m.compute(ctx);
    } catch (err) {
      result = null;
    }
    if (!result) {
      return {
        id: m.id, label: m.label, kind: m.kind, applicable: false, reason: 'Not applicable — the required columns were found, but there was not enough qualifying data to compute a real value (e.g. too few dated rows, or no matching cohort).',
      };
    }
    return {
      id: m.id, label: m.label, kind: m.kind, applicable: true, ...result,
    };
  });

  // Dynamic generators only ever return already-applicable results (see
  // the block comment above them), so no missing-role/no-result stub
  // handling is needed here — just gather, cap, and append. The cap
  // keeps a very wide dataset (dozens of unclaimed columns) from turning
  // this tab into a wall of cards; whatever gets cut is arbitrary only in
  // the sense that column order decides it, not that it's hidden forever
  // — the same generator runs again, in the same order, every time.
  let dynamicResults = [];
  try {
    dynamicResults = [
      ...buildLeftoverMeasureMetrics(ctx),
      ...buildEntityBreakdownMetrics(ctx),
      ...buildDatePairMetrics(ctx),
      ...buildDistinctCountMetrics(ctx),
    ].slice(0, DYNAMIC_METRIC_CAP);
  } catch (err) {
    dynamicResults = [];
  }

  // Business Descriptive Statistics — deliberately NOT part of the capped
  // list above. DYNAMIC_METRIC_CAP exists to stop a wide dataset's
  // leftover columns from flooding the tab with one KPI per column; these
  // generators instead each produce a small, fixed-size handful of
  // headline business figures (at most 3 entity-total counts, 2
  // category-mode stats, 4 geography-mode stats, 1 cancellation rate),
  // so there's nothing here that scales with dataset width the way the
  // capped generators do.
  let businessResults = [];
  try {
    businessResults = [
      ...buildEntityTotalCountMetrics(ctx),
      ...buildTopCategoryMetrics(ctx),
      ...buildTopCategoryByRevenueMetrics(ctx),
      ...buildTopGeographyFrequencyMetrics(ctx),
      ...buildCancellationRateMetrics(ctx),
      ...buildFreightTotalMetrics(ctx),
      ...buildLinkedOrderFileMetrics(ctx),
    ];
  } catch (err) {
    businessResults = [];
  }

  return [...staticResults, ...dynamicResults, ...businessResults];
}

module.exports = {
  METRICS,
  findRoleColumn,
  buildDimensionLookup,
  evaluateMetrics,
  // Exported for services/diagnosticEngine.js — the same cross-file
  // business context (ctx) this module already consumes, and every one of
  // these is a small, generically-named helper this codebase has a
  // documented history of accidentally re-implementing (and re-breaking)
  // in more than one place. Additive-only: no existing consumer's behavior
  // changes by these becoming visible.
  resolveGeo,
  sumColumn,
  provenanceFor,
  missingRolesReason,
  titleize,
  entityLabelFromIdColumn,
  pluralize,
  STATUS_NAME_RE,
  CANCEL_VALUE_RE,
  GENERIC_CATEGORY_NAME_RE,
  PAYMENT_MECHANISM_NAME_RE,
  ESTIMATED_DATE_NAME_RE,
  ACTUAL_DATE_NAME_RE,
  // Canonical revenue resolution (formal 'revenue' role, falling back to
  // 'price' on a dated/order-keyed fact table) — services/diagnosticEngine.js
  // imports these from here rather than keeping its own copy, so the two
  // engines can never drift on what counts as "revenue" for a dataset.
  findRevenueColumn,
  revenueFallbackNote,
  FREIGHT_NAME_RE,
  resolveCategoryColumn,
  // Exported for services/predictiveAnalyticsDynamic.js — the same robust
  // (Date.parse-based, UTC-normalized) month-bucketing every other fact-
  // table-native engine in this codebase already uses, so a revenue trend
  // built for the predictive forecast can never disagree with the one
  // Business Metrics/Dynamic Diagnostics show for the same dataset.
  monthKeyOf,
  // Round 21 — ERD-driven price-field resolution for the What-if scenario
  // / Pricing recommendation engines: a joined dimension's own catalog
  // price, numeric-typed, separate from buildDimensionLookup()'s
  // string-label lookup.
  buildNumericDimensionLookup,
  resolveCatalogPrice,
};
