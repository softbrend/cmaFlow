// Monetization Discovery — drill-down panel behavior. The page itself
// stays fully server-rendered (this is the only client-side JS in the
// app); this file's whole job is: open/close the right-side panel, switch
// between the "by customer" and "raw transactions" views, and fetch more
// rows from GET /monetization-discovery/drill-down as the panel is
// scrolled, since a single product can carry far more rows than are
// reasonable to send on page load or hold in the DOM at once.
(function () {
  var panel = document.getElementById('drilldown-panel');
  if (!panel) return; // page has no drill-down cards (empty/no-data states)

  var backdrop = document.getElementById('drilldown-backdrop');
  var closeBtn = document.getElementById('drilldown-close');
  var titleEl = document.getElementById('drilldown-product-name');
  var subEl = document.getElementById('drilldown-product-sub');
  var thead = document.getElementById('drilldown-thead');
  var tbody = document.getElementById('drilldown-tbody');
  var body = document.getElementById('drilldown-panel-body');
  var modeButtons = Array.prototype.slice.call(document.querySelectorAll('.drilldown-mode-btn'));

  var THEAD = {
    customers: '<tr><th>Customer</th><th>Revenue</th><th>Transactions</th><th>Last purchase</th></tr>',
    transactions: '<tr><th>Date</th><th>Customer</th><th>Amount</th><th>Quantity</th></tr>',
  };

  var state = { dataset: null, product: null, mode: 'customers', loading: false, done: false };

  function loadPage(offset) {
    if (state.loading || state.done || !state.product) return;
    state.loading = true;
    var url = '/monetization-discovery/drill-down'
      + '?dataset=' + encodeURIComponent(state.dataset)
      + '&product=' + encodeURIComponent(state.product)
      + '&mode=' + encodeURIComponent(state.mode)
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
        // Fails closed — no infinite retry loop against a broken endpoint.
        state.loading = false;
        state.done = true;
      });
  }

  function setMode(m) {
    if (m !== 'customers' && m !== 'transactions') return;
    state.mode = m;
    state.done = false;
    modeButtons.forEach(function (btn) {
      btn.classList.toggle('active', btn.getAttribute('data-mode') === m);
    });
    thead.innerHTML = THEAD[m];
    tbody.innerHTML = '';
    loadPage(0);
  }

  function openPanel(trigger) {
    state.dataset = trigger.getAttribute('data-dataset');
    state.product = trigger.getAttribute('data-product');
    state.mode = 'customers';
    state.done = false;

    titleEl.textContent = state.product;
    subEl.textContent = trigger.getAttribute('data-summary') || '';
    modeButtons.forEach(function (btn) {
      btn.classList.toggle('active', btn.getAttribute('data-mode') === 'customers');
    });
    thead.innerHTML = THEAD.customers;
    tbody.innerHTML = '';

    panel.hidden = false;
    backdrop.hidden = false;
    panel.setAttribute('aria-hidden', 'false');
    document.body.classList.add('drilldown-open');
    body.scrollTop = 0;
    loadPage(0);
  }

  function closePanel() {
    panel.hidden = true;
    backdrop.hidden = true;
    panel.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('drilldown-open');
  }

  document.querySelectorAll('.drilldown-trigger').forEach(function (btn) {
    btn.addEventListener('click', function () { openPanel(btn); });
  });
  modeButtons.forEach(function (btn) {
    btn.addEventListener('click', function () { setMode(btn.getAttribute('data-mode')); });
  });
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
