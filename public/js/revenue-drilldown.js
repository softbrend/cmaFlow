// Descriptive Analytics — Revenue & Growth tab's drill-down panel. A
// sibling of public/js/monetization-discovery.js (same panel mechanics:
// open/close, paginated fetch-on-scroll) but two-directional: a 🔍 on a
// "Revenue by product / service" row drills into that product (rolled up
// by customer); a 🔍 on a "Revenue by customer" row drills into that
// customer (rolled up by product). The toggle's own label swaps to match
// whichever direction is active, since "By customer" doesn't make sense
// once you're already looking at one customer.
(function () {
  var panel = document.getElementById('revenue-drilldown-panel');
  if (!panel) return; // page has no drilldown-enabled charts (e.g. raw-upload source)

  var backdrop = document.getElementById('revenue-drilldown-backdrop');
  var closeBtn = document.getElementById('revenue-drilldown-close');
  var titleEl = document.getElementById('revenue-drilldown-title');
  var subEl = document.getElementById('revenue-drilldown-sub');
  var thead = document.getElementById('revenue-drilldown-thead');
  var tbody = document.getElementById('revenue-drilldown-tbody');
  var body = document.getElementById('revenue-drilldown-body');
  var rollupBtn = document.getElementById('revenue-drilldown-rollup-btn');
  var txnBtn = document.getElementById('revenue-drilldown-txn-btn');

  // Rollup mode is always the dimension OPPOSITE what was clicked — drill
  // into a product, roll up by customer, and vice versa.
  var ROLLUP_OF = { product: 'customers', customer: 'products' };
  var ROLLUP_LABEL = { customers: 'By customer', products: 'By product' };
  var THEAD = {
    customers: '<tr><th>Customer</th><th>Revenue</th><th>Transactions</th><th>Last purchase</th></tr>',
    products: '<tr><th>Product / service</th><th>Revenue</th><th>Transactions</th><th>Last purchase</th></tr>',
    transactions: '<tr><th>Date</th><th>Customer</th><th>Product / service</th><th>Amount</th><th>Quantity</th></tr>',
  };

  var state = { dataset: null, by: null, value: null, viewMode: 'rollup', loading: false, done: false };

  function loadPage(offset) {
    if (state.loading || state.done || !state.value) return;
    state.loading = true;
    var url = '/descriptive-analytics/revenue-drill-down'
      + '?dataset=' + encodeURIComponent(state.dataset)
      + '&by=' + encodeURIComponent(state.by)
      + '&value=' + encodeURIComponent(state.value)
      + '&mode=' + encodeURIComponent(state.viewMode === 'transactions' ? 'transactions' : 'rollup')
      + '&offset=' + offset;

    fetch(url)
      .then(function (resp) { return resp.ok ? resp.text() : Promise.reject(new Error('bad response')); })
      .then(function (html) {
        var oldSentinel = tbody.querySelector('.drilldown-sentinel-row');
        if (oldSentinel) oldSentinel.remove();
        tbody.insertAdjacentHTML('beforeend', html);
        state.done = !tbody.querySelector('.drilldown-sentinel-row');
        state.loading = false;
      })
      .catch(function () {
        state.loading = false;
        state.done = true;
      });
  }

  function setViewMode(vm) {
    state.viewMode = vm;
    state.done = false;
    var rollupKey = ROLLUP_OF[state.by];
    rollupBtn.textContent = ROLLUP_LABEL[rollupKey];
    rollupBtn.classList.toggle('active', vm === 'rollup');
    txnBtn.classList.toggle('active', vm === 'transactions');
    thead.innerHTML = THEAD[vm === 'transactions' ? 'transactions' : rollupKey];
    tbody.innerHTML = '';
    loadPage(0);
  }

  function openPanel(trigger) {
    state.dataset = trigger.getAttribute('data-dataset');
    state.by = trigger.getAttribute('data-filter-by') === 'customer' ? 'customer' : 'product';
    state.value = trigger.getAttribute('data-filter-value');
    state.viewMode = 'rollup';
    state.done = false;

    titleEl.textContent = state.value;
    subEl.textContent = (state.by === 'customer' ? 'Customer' : 'Product') + ' · ' + (trigger.getAttribute('data-summary') || '');

    panel.hidden = false;
    backdrop.hidden = false;
    panel.setAttribute('aria-hidden', 'false');
    document.body.classList.add('drilldown-open');
    body.scrollTop = 0;
    setViewMode('rollup');
  }

  function closePanel() {
    panel.hidden = true;
    backdrop.hidden = true;
    panel.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('drilldown-open');
  }

  // Trigger buttons live inside chart HTML injected via `<%- %>`, not a
  // fixed set known at page load — delegate from the document instead of
  // binding to each one individually.
  document.addEventListener('click', function (e) {
    var trigger = e.target.closest ? e.target.closest('.drilldown-row-trigger') : null;
    if (trigger) openPanel(trigger);
  });

  rollupBtn.addEventListener('click', function () { setViewMode('rollup'); });
  txnBtn.addEventListener('click', function () { setViewMode('transactions'); });
  closeBtn.addEventListener('click', closePanel);
  backdrop.addEventListener('click', closePanel);
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && !panel.hidden) closePanel();
  });

  body.addEventListener('scroll', function () {
    if (state.loading || state.done) return;
    if (body.scrollTop + body.clientHeight >= body.scrollHeight - 120) {
      var sentinel = tbody.querySelector('.drilldown-sentinel-row');
      var nextOffset = sentinel ? parseInt(sentinel.getAttribute('data-next-offset'), 10) : 0;
      loadPage(nextOffset);
    }
  });
})();
