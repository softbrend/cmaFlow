// Shared "what's behind this number" drill-down over Transaction rows.
// Originally built for one case (Monetization Discovery's per-product
// card — see services/monetizationDiscovery.js, which now delegates
// here) and generalized for a second: the Revenue & Growth tab's
// "Revenue by product / service" and "Revenue by customer" charts, where
// EITHER a product row or a customer row can be the thing that was
// clicked. One paginated rollup/raw-log pair, parameterized by which
// dimension is fixed (filterBy/filterValue — the thing that was clicked)
// and which dimension the rollup view groups by (always the OTHER one):
//   - drilling into a PRODUCT rolls up by customer (revenue/txn-count/
//     last-purchase per customer buying that product) — "who is this
//     product's revenue made of."
//   - drilling into a CUSTOMER rolls up by product (revenue/txn-count/
//     last-purchase per product that customer bought) — "what is this
//     customer's revenue made of."
// Both filters also expose a flat, most-recent-first transaction log.
// Paginated (DRILLDOWN_PAGE_SIZE per call): a single product or customer
// can carry far more rows than are reasonable to send or hold in the DOM
// at once — the panel that reads this loads in pages as it's scrolled.
const DRILLDOWN_PAGE_SIZE = 50;

// A $0.00/blank-amount transaction (free samples, cancelled-order rows
// left at zero, a missing amount column value — the raw data doesn't say
// which) is real data the page's own totals still count, but it's noise
// in a list someone is scanning row by row — every one of them reads the
// same "USD 0.00" and adds nothing. The drill-down panel (unlike the
// totals it's explaining) exists specifically for a human to scan, so
// every view here skips them.
function hasNonZeroAmount(t) {
  const amt = Number(t.amount);
  return Number.isFinite(amt) && amt !== 0;
}

// filterBy: 'product' | 'customer'. filterValue: the exact product_service
// string, or 'Unspecified' (the bucket revenueByProduct() in
// services/analytics.js uses for a blank/missing product_service — matched
// here the same way, so a click on that bucket shows the same rows that
// were folded into it) or a customer_id.
function matchesFilter(t, filterBy, filterValue) {
  if (filterBy === 'customer') return String(t.customer_id || '').trim() === filterValue;
  const product = String(t.product_service || '').trim();
  if (filterValue === 'Unspecified') return product === '';
  return product === filterValue;
}

function buildRevenueDrillDown(transactionRows, customerRows, {
  filterBy, filterValue, viewMode, offset = 0,
}) {
  const nameByCustomer = {};
  (customerRows || []).forEach((c) => {
    if (c && c.customer_id) nameByCustomer[c.customer_id] = c.name || null;
  });

  const filteredTxns = (transactionRows || [])
    .filter((t) => t && matchesFilter(t, filterBy, filterValue))
    .filter(hasNonZeroAmount);

  if (viewMode === 'transactions') {
    const sorted = [...filteredTxns].sort((a, b) => {
      const ta = a.timestamp ? new Date(a.timestamp).getTime() : 0;
      const tb = b.timestamp ? new Date(b.timestamp).getTime() : 0;
      return tb - ta;
    });
    const page = sorted.slice(offset, offset + DRILLDOWN_PAGE_SIZE);
    return {
      mode: 'transactions',
      rows: page.map((t) => ({
        customerId: t.customer_id || null,
        customerName: (t.customer_id && nameByCustomer[t.customer_id]) || null,
        productService: String(t.product_service || '').trim() || 'Unspecified',
        timestamp: t.timestamp || null,
        amount: Number(t.amount) || 0,
        currency: t.currency || '',
        quantity: (t.quantity !== undefined && t.quantity !== null && t.quantity !== '' && !Number.isNaN(Number(t.quantity)))
          ? Number(t.quantity) : null,
      })),
      total: sorted.length,
      hasMore: offset + DRILLDOWN_PAGE_SIZE < sorted.length,
    };
  }

  // Rollup mode — group by the dimension OPPOSITE the one that was
  // clicked.
  const rollupMode = filterBy === 'customer' ? 'products' : 'customers';
  const rollupKeyOf = (t) => (
    rollupMode === 'products' ? (String(t.product_service || '').trim() || 'Unspecified') : t.customer_id
  );

  const buckets = {};
  filteredTxns.forEach((t) => {
    const key = rollupKeyOf(t);
    if (!key) return;
    const bucket = buckets[key] || {
      key, revenue: 0, transactionCount: 0, lastTimestamp: null, currency: t.currency || '',
    };
    bucket.revenue += Number(t.amount) || 0;
    bucket.transactionCount += 1;
    const ts = t.timestamp ? new Date(t.timestamp).getTime() : null;
    if (ts !== null && !Number.isNaN(ts) && (bucket.lastTimestamp === null || ts > bucket.lastTimestamp)) bucket.lastTimestamp = ts;
    buckets[key] = bucket;
  });
  const rollup = Object.values(buckets).sort((a, b) => b.revenue - a.revenue);
  const page = rollup.slice(offset, offset + DRILLDOWN_PAGE_SIZE);

  return {
    mode: rollupMode,
    rows: page.map((b) => ({
      key: b.key,
      label: rollupMode === 'customers' ? (nameByCustomer[b.key] || b.key) : b.key,
      revenue: b.revenue,
      transactionCount: b.transactionCount,
      currency: b.currency,
      lastTimestamp: b.lastTimestamp,
    })),
    total: rollup.length,
    hasMore: offset + DRILLDOWN_PAGE_SIZE < rollup.length,
  };
}

module.exports = { DRILLDOWN_PAGE_SIZE, hasNonZeroAmount, buildRevenueDrillDown };
