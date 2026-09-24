// Full Descriptive Analytics tab — raw-row drill-down panel. A sibling of
// public/js/revenue-drilldown.js (same open/close/paginated-scroll
// mechanics, same shared .drilldown-panel/.drilldown-backdrop CSS) but
// reading a raw uploaded file's own dataset_records directly instead of
// confirmed canonical Transaction/Customer rows — so unlike that panel,
// this one's columns are never fixed ahead of time. The column list
// travels back from the server in a response header (X-Drilldown-
// Columns) rather than inline HTML, since a <thead> has to exist before
// any <tr> fragment can be validly parsed into the table — see the route
// comment on GET /descriptive-analytics/raw-drill-down.
(function () {
  var panel = document.getElementById('raw-drilldown-panel');
  if (!panel) return; // page has no raw-drilldown-enabled charts

  var backdrop = document.getElementById('raw-drilldown-backdrop');
  var closeBtn = document.getElementById('raw-drilldown-close');
  var titleEl = document.getElementById('raw-drilldown-title');
  var subEl = document.getElementById('raw-drilldown-sub');
  var thead = document.getElementById('raw-drilldown-thead');
  var tbody = document.getElementById('raw-drilldown-tbody');
  var body = document.getElementById('raw-drilldown-body');

  var state = {
    dataset: null, fileType: null, column: null, mode: 'category',
    value: null, bucketIndex: null, colMin: null, colMax: null, bins: null,
    loading: false, done: false,
  };

  function buildUrl(offset) {
    var url = '/descriptive-analytics/raw-drill-down'
      + '?dataset=' + encodeURIComponent(state.dataset)
      + '&fileType=' + encodeURIComponent(state.fileType)
      + '&column=' + encodeURIComponent(state.column)
      + '&mode=' + encodeURIComponent(state.mode)
      + '&offset=' + offset;
    if (state.mode === 'range') {
      url += '&bucketIndex=' + encodeURIComponent(state.bucketIndex)
        + '&colMin=' + encodeURIComponent(state.colMin)
        + '&colMax=' + encodeURIComponent(state.colMax)
        + '&bins=' + encodeURIComponent(state.bins);
    } else {
      url += '&value=' + encodeURIComponent(state.value);
    }
    return url;
  }

  // Builds the <thead> from the column list the server sent back — via
  // textContent, never innerHTML, since a raw uploaded file's column
  // names are untrusted SME-supplied strings.
  function renderHead(columns) {
    var tr = document.createElement('tr');
    columns.forEach(function (name) {
      var th = document.createElement('th');
      th.textContent = name;
      tr.appendChild(th);
    });
    thead.innerHTML = '';
    thead.appendChild(tr);
  }

  // atob() decodes base64 to a Latin-1 byte string, not text — a column
  // header with any non-ASCII character (accents, curly quotes, ...)
  // would come out mojibake'd without re-decoding those bytes as UTF-8.
  function decodeColumns(resp) {
    var encoded = resp.headers.get('X-Drilldown-Columns');
    if (!encoded) return null;
    try {
      var binary = atob(encoded);
      var bytes = new Uint8Array(binary.length);
      for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      return JSON.parse(new TextDecoder('utf-8').decode(bytes));
    } catch (e) {
      return null;
    }
  }

  function loadPage(offset) {
    if (state.loading || state.done || ((state.mode === 'category' || state.mode === 'month') && !state.value)) return;
    state.loading = true;

    fetch(buildUrl(offset))
      .then(function (resp) {
        if (!resp.ok) return Promise.reject(new Error('bad response'));
        var columns = decodeColumns(resp);
        return resp.text().then(function (html) { return { html: html, columns: columns }; });
      })
      .then(function (result) {
        if (offset === 0 && result.columns) renderHead(result.columns);
        var oldSentinel = tbody.querySelector('.drilldown-sentinel-row');
        if (oldSentinel) oldSentinel.remove();
        tbody.insertAdjacentHTML('beforeend', result.html);
        state.done = !tbody.querySelector('.drilldown-sentinel-row');
        state.loading = false;
      })
      .catch(function () {
        state.loading = false;
        state.done = true;
      });
  }

  function openPanel(trigger) {
    state.dataset = trigger.getAttribute('data-dataset');
    state.fileType = trigger.getAttribute('data-file-type');
    state.column = trigger.getAttribute('data-column');
    var rawMode = trigger.getAttribute('data-mode');
    state.mode = rawMode === 'range' ? 'range' : rawMode === 'month' ? 'month' : 'category';
    state.value = trigger.getAttribute('data-value');
    state.bucketIndex = trigger.getAttribute('data-bucket-index');
    state.colMin = trigger.getAttribute('data-col-min');
    state.colMax = trigger.getAttribute('data-col-max');
    state.bins = trigger.getAttribute('data-bins');
    state.done = false;

    var label = trigger.getAttribute('data-label') || '';
    var summary = trigger.getAttribute('data-summary') || '';
    titleEl.textContent = label;
    subEl.textContent = state.column + (summary ? ' · ' + summary : '');

    thead.innerHTML = '';
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

  // Trigger buttons live inside chart HTML injected via `<%- %>`, not a
  // fixed set known at page load — delegate from the document instead of
  // binding to each one individually.
  document.addEventListener('click', function (e) {
    var trigger = e.target.closest ? e.target.closest('.rawrow-drilldown-trigger') : null;
    if (trigger) openPanel(trigger);
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
