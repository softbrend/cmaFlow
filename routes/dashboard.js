const express = require('express');
const path = require('path');
const fs = require('fs');
const { body, validationResult } = require('express-validator');
const pool = require('../db/pool');
const { requireAuth } = require('../middleware/auth');
const {
  uploadDatasetFiles, sanitizeDatasetId, pairFilesWithLabels, finalizeDatasetUpload, discardDatasetUpload,
  DATASETS_ROOT,
} = require('../middleware/upload');
const { humanizeFileType, parseCsvFile, buildColumnMeta, applyFilters } = require('../middleware/browse');
const { insertDatasetRecords } = require('../db/ingest');
const { CANONICAL_ENTITIES } = require('../db/canonicalSchema');
const { suggestMapping, guessEntity, guessConfigModelType } = require('../services/mapping');
const { runTransformPipeline } = require('../services/transform');
const {
  MODEL_TYPE_LABELS, revenueTrend, mode,
  buildRawRevenueGrowthAnalytics, getRawRecordsByFileType, pickRawEntityRows,
  getDatasetDomainRollupRaw, buildDatasetDomainAnalysis,
} = require('../services/analytics');
const {
  MODEL_TYPES, discoverMechanisms, getConfirmedClassifications, saveConfirmedClassifications,
  buildProductDrillDown,
} = require('../services/monetizationDiscovery');
const { buildRawDrillDown } = require('../services/rawDrillDown');
const { HISTOGRAM_BINS } = require('../services/datasetProfiler');
const {
  revenueBridge, revenueByTransactionType, cancellationReasonsRanked, combinedPriceChangeImpact, diagnosticCoverage,
} = require('../services/diagnosticAnalytics');
const {
  buildCustomerFeatures, churnRiskDistribution, lifecycleStageDistribution, revenueForecast,
  listWhatIfProducts, buildPriceWhatIfScenario,
} = require('../services/predictiveAnalytics');
const { elasticitySummary, rankConfigurationRecommendations } = require('../services/prescriptiveAnalytics');
const { buildDynamicPrescriptiveRecommendations } = require('../services/prescriptiveEngine');
const {
  renderStatTile, renderBarChart, renderTrendChart, renderScatterChart, renderCatalogTable,
} = require('../services/charts');
const {
  formatCompactMoney, formatMoney, formatCount, formatPercent, escapeHtml,
} = require('../services/format');
const { buildEvaluationReport } = require('../services/evaluationReport');
const { buildEvaluationReportWorkbook } = require('../services/evaluationReportExport');
const { CANONICAL_ROLES, REPORT_CATALOG, buildReportCatalogAnalysis } = require('../services/reportCatalog');
const {
  upsertFileProfile, getOrBuildFullProfile, getOrBuildBusinessIntelligence, getCorrelationSample,
  buildBusinessContext, getOrBuildBusinessContext,
} = require('../services/fullDescriptiveAnalytics');
const { buildErdDefinition } = require('../services/erdDiagram');
const { ensureDefaultDataset, setDefaultDataset } = require('../services/accountDatasets');
const { getOrCompute: getOrComputeAnalyticsCache, getOrComputeInProcess: getOrComputeAnalyticsCacheInProcess } = require('../services/analyticsCache');
const { ROLE_ONTOLOGY } = require('../services/semanticFieldOntology'); // Round 22 — role dropdown options for GET/POST /dataset/:id/review-fields
// Only ACTUAL_DATE_NAME_RE is needed here (to pick the "delivered/actual"
// date-pair duration out of buildBusinessSummaryCard()'s KPI resolution
// below) — imported from services/metricRegistry.js rather than redefined,
// same reasoning as every other shared name-pattern regex in this codebase.
const { ACTUAL_DATE_NAME_RE, titleize } = require('../services/metricRegistry');
// Fact-table-native Predictive Analytics (Dynamic source) — see that
// file's header for why Customer risk / Lifecycle / Revenue forecast /
// What-if scenario each need their own honest-degradation path here,
// distinct from the CMA Canonical Schema engine below.
const {
  buildDynamicCustomerFeatures, buildDynamicRevenueTrend, inferPriceElasticityFromFactTable,
  listDynamicWhatIfGroups, buildDynamicPriceWhatIfScenario,
  buildDeliveryDelayRisk, buildReviewScoreOutlook,
} = require('../services/predictiveAnalyticsDynamic');

const router = express.Router();
router.use(requireAuth);

const ENTITY_NAMES = Object.keys(CANONICAL_ENTITIES);

// Nav sections shown in the sidebar under the six-step CMA-Flow conceptual
// framework (Upload New Dataset / Browse Dataset live outside this list,
// registered as their own routes below). Every entry here is a real,
// implemented section — see IMPLEMENTED_SLUGS just below, which now
// covers the whole list. (A "Decision & simulation" placeholder used to
// sit here too; it was removed as redundant once its intended purpose —
// dataset-grounded what-if scenario analysis, one of the Prescriptive
// Evidence outputs in the conceptual-framework diagram — turned out to
// already be fully implemented by the What-if scenario tab under
// Predictive Analytics. See claude/cma-flow-app-conceptual-framework-audit.md
// in the project docs for the verification that led to this cleanup.
// Monetization discovery also used to sit first in this list — it's now a
// separate hardcoded <li> in views/partials/sidebar.ejs, positioned after
// Browse Dataset instead, per the user's requested nav order; see the same
// project doc for why.)
const STUB_SECTIONS = [
  { slug: 'descriptive-analytics', label: 'Descriptive analytics', icon: '📊',
    blurb: 'Historical and current-state views of how each SME account is earning revenue today.' },
  { slug: 'diagnostic-insights', label: 'Diagnostic insights', icon: '🔍',
    blurb: 'Root-cause analysis of monetization performance shifts.' },
  { slug: 'predictive-analytics', label: 'Predictive analytics', icon: '📈',
    blurb: 'Forecasts of how the current monetization setup will perform going forward, including a dataset-grounded what-if scenario tool.' },
  { slug: 'prescriptive-recommendations', label: 'Prescriptive recommendations', icon: '💡',
    blurb: 'Recommended next revenue-model configuration for the assigned dataset.' },
];

// Row counts ingested into dataset_records per dataset, keyed by dataset row id
// then file_type: { [datasetRowId]: { [fileType]: count } }. file_type here is
// whatever free-form label each file was uploaded under — there's no fixed
// list, so every uploaded file type shows up here regardless of its name.
async function getRecordCounts(accountId) {
  const { rows } = await pool.query(
    `SELECT dataset_id, file_type, COUNT(*)::int AS cnt
       FROM dataset_records
      WHERE account_id = $1
      GROUP BY dataset_id, file_type`,
    [accountId]
  );
  const map = {};
  rows.forEach((r) => {
    map[r.dataset_id] = map[r.dataset_id] || {};
    map[r.dataset_id][r.file_type] = r.cnt;
  });
  return map;
}

// Field (column) listings for the Browse Dataset picker, keyed the same
// shape as getRecordCounts: { [datasetRowId]: { [fileType]: [{ name, kind }, ...] } }.
// Reuses the datasetProfiler.js profile already cached at upload time
// (services/fullDescriptiveAnalytics.js, see claude/
// full-descriptive-analytics.md) — kind is that column's inferred type
// (numeric, category, date, id, ...), so the picker can show not just
// that a "price" field exists but what CMA-FLOW understood it to be.
// A dataset uploaded before that feature shipped (or whose profile
// hasn't been backfilled yet) falls back to a cheap one-row peek at the
// raw JSONB keys — field names only, kind: null — rather than forcing a
// full profile computation on every visit to this page.
async function getDatasetFieldSummaries(accountId) {
  const [{ rows: profiled }, { rows: peeked }] = await Promise.all([
    pool.query(
      `SELECT dataset_id, file_type, profile FROM dataset_profiles WHERE account_id = $1`,
      [accountId]
    ),
    pool.query(
      `SELECT DISTINCT ON (dataset_id, file_type) dataset_id, file_type, data
         FROM dataset_records
        WHERE account_id = $1
        ORDER BY dataset_id, file_type, row_index`,
      [accountId]
    ),
  ]);

  const map = {};
  peeked.forEach((r) => {
    map[r.dataset_id] = map[r.dataset_id] || {};
    const fields = Object.keys(r.data || {})
      .filter((name) => name.trim() !== '')
      .map((name) => ({ name, kind: null }));
    map[r.dataset_id][r.file_type] = fields;
  });
  profiled.forEach((r) => {
    map[r.dataset_id] = map[r.dataset_id] || {};
    const cols = (r.profile && r.profile.columns) || [];
    if (cols.length > 0) {
      map[r.dataset_id][r.file_type] = cols.map((c) => ({ name: c.name, kind: c.kind }));
    }
  });
  return map;
}

// Which physical files make up each dataset+file_type, keyed the same
// shape as getRecordCounts: { [datasetRowId]: { [fileType]: [{ original_name,
// row_count, uploaded_at }, ...] } }. A dataset can have any number of
// files per type, so this is a list rather than a single path.
async function getFileManifest(accountId) {
  const { rows } = await pool.query(
    `SELECT dataset_id, file_type, original_name, row_count, uploaded_at
       FROM dataset_files
      WHERE account_id = $1
      ORDER BY dataset_id, file_type, uploaded_at`,
    [accountId]
  );
  const map = {};
  rows.forEach((r) => {
    map[r.dataset_id] = map[r.dataset_id] || {};
    map[r.dataset_id][r.file_type] = map[r.dataset_id][r.file_type] || [];
    map[r.dataset_id][r.file_type].push(r);
  });
  return map;
}

// Latest canonical-transform status per dataset+file_type, keyed the same
// shape as getRecordCounts: { [datasetRowId]: { [fileType]: { valid,
// invalid, mappingVersion, entity } } }. Keyed on file_type (not entity —
// several differently-labeled files can share an entity), using the new
// canonical_records.file_type column. Only the newest mapping_version per
// dataset+file_type is summarized here — older versions stay in the
// database for lineage/audit but aren't surfaced as "current" in the UI.
async function getCanonicalStatus(accountId) {
  const { rows } = await pool.query(
    `SELECT dataset_id, file_type, entity, mapping_version,
            COUNT(*) FILTER (WHERE status = 'valid')::int   AS valid_count,
            COUNT(*) FILTER (WHERE status = 'invalid')::int AS invalid_count
       FROM canonical_records
      WHERE account_id = $1
        AND mapping_version = (
              SELECT MAX(cr2.mapping_version) FROM canonical_records cr2
               WHERE cr2.dataset_id = canonical_records.dataset_id
                 AND cr2.file_type = canonical_records.file_type
                 AND cr2.account_id = $1
            )
      GROUP BY dataset_id, file_type, entity, mapping_version`,
    [accountId]
  );
  const map = {};
  rows.forEach((r) => {
    map[r.dataset_id] = map[r.dataset_id] || {};
    map[r.dataset_id][r.file_type] = {
      valid: r.valid_count, invalid: r.invalid_count, mappingVersion: r.mapping_version, entity: r.entity,
    };
  });
  return map;
}

// Expose nav data to every view under this router.
router.use((req, res, next) => {
  res.locals.navSections = STUB_SECTIONS;
  next();
});

// ------------------------------------------------------------------
// Admin read-only oversight of the four analytics pages — routes/admin.js
// (GET /admin/datasets/:id/view) sets session.adminViewAccountId when an
// Admin picks "View analytics" for another account's dataset from Manage
// Datasets, and GET /admin/exit-view clears it. resolveAccountId() is the
// only thing that changes: it swaps in that account's id in place of the
// Admin's own — deliberately called from ONLY the five routes below
// (descriptive-analytics + its raw-drill-down, diagnostic-insights,
// predictive-analytics, prescriptive-recommendations), not wired in as
// blanket middleware, so every OTHER route in this SME-owner-facing
// router (upload, monetization config, map/transform, review-fields, ...)
// still resolves strictly to req.session.userId — an Admin who manually
// visits one of those write routes while "viewing" another account only
// ever affects their own (dataset-less) Admin account, never the
// SME owner's data. Those four pages have no POST forms of their own
// (confirmed before building this), so read-only oversight is exactly
// what this does and nothing more.
function resolveAccountId(req) {
  if (req.session.user && req.session.user.role === 'Admin' && req.session.adminViewAccountId) {
    return req.session.adminViewAccountId;
  }
  return req.session.userId;
}

// Attaches res.locals.adminViewingAccount (owner_name/business_name, or
// null) so the four analytics templates can show a small "Viewing X as
// admin" banner without every res.render() call in those routes needing
// to remember to pass it — res.render() merges res.locals automatically.
// Also attaches res.locals.adminDatasetSwitcherOptions — every dataset
// across every account (id/dataset_id/dataset_name/business_name), for both the
// banner's "switch dataset" dropdown AND the empty-state dataset picker
// these four pages show an Admin who hasn't selected anything yet (an
// Admin account has no datasets of its own, so it never sees the
// SME-owner "Upload a dataset" prompt — see views/dashboard/
// {descriptive-analytics,diagnostic-insights,predictive-analytics,
// prescriptive-recommendations}.ejs's `datasets.length === 0` branch).
// Queried for ANY signed-in Admin, not only while already impersonating
// (adminViewAccountId set) — the empty-state picker needs the full list
// before an Admin has picked anything at all.
async function attachAdminViewingBanner(req, res, next) {
  res.locals.adminViewingAccount = null;
  res.locals.adminDatasetSwitcherOptions = null;
  if (req.session.user && req.session.user.role === 'Admin') {
    try {
      const { rows: switcherRows } = await pool.query(
        `SELECT ud.id, ud.dataset_id, ud.dataset_name, a.business_name
           FROM uploaded_datasets ud
           JOIN sme_accounts a ON a.id = ud.account_id
          ORDER BY a.business_name, ud.dataset_id`
      );
      res.locals.adminDatasetSwitcherOptions = switcherRows;

      if (req.session.adminViewAccountId) {
        const { rows } = await pool.query(
          `SELECT owner_name, business_name FROM sme_accounts WHERE id = $1`,
          [req.session.adminViewAccountId]
        );
        res.locals.adminViewingAccount = rows[0] || null;
      }
    } catch (e) {
      // Non-fatal — worst case the banner/picker just doesn't show this request.
      res.locals.adminViewingAccount = null;
      res.locals.adminDatasetSwitcherOptions = null;
    }
  }
  next();
}

// ------------------------------------------------------------------
// GET /  — SME Owner Portal landing page (browser-tab title matches the
// page's own "SME Owner Portal" heading — see views/dashboard/index.ejs).
// ------------------------------------------------------------------
router.get('/', async (req, res, next) => {
  try {
    const accountId = req.session.userId;

    // An Admin account has no datasets/analytics of its own — this whole
    // portal home page (and everything else this router serves) is
    // SME-owner-facing, so send an Admin straight to its own section. Same
    // redirect already happens right after login (routes/auth.js); this
    // catches an Admin navigating back to "/" directly (bookmark, browser
    // back button, typed URL).
    if (req.session.user && req.session.user.role === 'Admin') {
      return res.redirect('/admin');
    }

    // Self-healing net alongside the assignment that already happened at
    // login (routes/auth.js): covers a session that predates the
    // account's first dataset upload, or whose previous default was
    // deleted since. See services/accountDatasets.js.
    const { datasets, defaultDatasetId } = await ensureDefaultDataset(accountId);
    const defaultDataset = datasets.find((d) => d.id === defaultDatasetId) || null;

    const { rows: configs } = await pool.query(
      `SELECT id, config_name, model_type, details, is_active, created_at
         FROM monetization_configs
        WHERE account_id = $1 AND is_active = true
        ORDER BY created_at DESC`,
      [accountId]
    );

    res.render('dashboard/index', {
      title: 'SME Owner Portal',
      active: 'monetization-intelligence',
      datasets,
      defaultDataset,
      configs,
    });
  } catch (err) {
    next(err);
  }
});

// POST /default-dataset — the SME owner's own explicit choice of which of
// their uploaded datasets this account treats as its default (shown on
// the SME Owner Portal home page, and what ensureDefaultDataset() falls
// back to re-assigning if this one is ever deleted). Reachable from both
// the home page and the Upload New Dataset page's dataset table, hence
// the redirect_to switch — kept to a fixed allow-list of in-app paths
// rather than trusting an arbitrary redirect target from the form.
router.post('/default-dataset', async (req, res, next) => {
  try {
    const accountId = req.session.userId;
    const datasetRowId = parseInt(req.body.dataset_id, 10);
    if (datasetRowId) {
      await setDefaultDataset(accountId, datasetRowId);
    }
    const redirectTo = req.body.redirect_to === '/upload-dataset' ? '/upload-dataset' : '/';
    res.redirect(redirectTo);
  } catch (err) {
    next(err);
  }
});

// ------------------------------------------------------------------
// Stub pages for the remaining nav sections
// ------------------------------------------------------------------
const IMPLEMENTED_SLUGS = ['monetization-discovery', 'descriptive-analytics', 'diagnostic-insights', 'predictive-analytics', 'prescriptive-recommendations'];
STUB_SECTIONS.forEach((section) => {
  if (IMPLEMENTED_SLUGS.includes(section.slug)) return; // real implementation below
  router.get(`/${section.slug}`, (req, res) => {
    res.render('dashboard/placeholder', {
      title: section.label,
      active: section.slug,
      section,
    });
  });
});

// ------------------------------------------------------------------
// Monetization Discovery Engine — sits between Map & Transform and every
// analytics page, exactly where the CMA architecture diagram places it.
// CMA-Flow does not ask the SME owner which mechanism they use, and (the
// mistake this replaces) it does not just read whatever text happens to
// be in a MonetizationConfig row's model_type field either — both of
// those are "asking," one asks a person, the other asks the data's own
// label. Instead, services/monetizationDiscovery.js infers each
// product's mechanism from how customers are actually behaving
// (recurring/consistent charges -> Subscription, usage-scaled charges ->
// Pay-per-use, a free/paid customer split -> Freemium, dataset/API/report
// access -> Data-as-a-Service), and this screen is where the SME owner
// reviews that inference — with its evidence spelled out — and confirms
// or corrects it per product. A confirmed choice is what every other
// analytics page (Descriptive's Mechanisms tab, the Pricing Catalog,
// Prescriptive's recommendation ranking) actually reads from
// (services/analytics.js's buildDescriptiveAnalytics) — the live
// inference is used in the meantime for anything not yet confirmed, so
// nothing is blocked waiting on this screen, but it's always shown
// honestly as "inferred, not yet confirmed" until the SME owner acts.
// ------------------------------------------------------------------
router.get('/monetization-discovery', async (req, res, next) => {
  const accountId = req.session.userId;
  try {
    const { rows: datasets } = await pool.query(
      `SELECT id, dataset_id, dataset_name, domain, created_at
         FROM uploaded_datasets
        WHERE account_id = $1
        ORDER BY created_at DESC`,
      [accountId]
    );

    if (datasets.length === 0) {
      return res.render('dashboard/monetization-discovery', {
        title: 'Monetization discovery',
        active: 'monetization-discovery',
        datasets: [],
        selectedDataset: null,
        discoveries: [],
        financialProfile: null,
        rawInfo: null,
        modelTypes: MODEL_TYPES,
        modelTypeLabels: MODEL_TYPE_LABELS,
      });
    }

    const requestedId = parseInt(req.query.dataset, 10);
    const selectedDataset = datasets.find((d) => d.id === requestedId) || datasets[0];

    // Content-aware, raw-native by design: Monetization Discovery reads
    // directly off this dataset's own uploaded files — no Map & Transform,
    // no CMA Canonical Schema dependency. pickRawEntityRows() (services/
    // analytics.js) reuses the same guessEntity()/suggestMapping()
    // heuristic Map & Transform itself starts from to find whichever raw
    // file looks like Transaction/Entitlement/Monetization Config data —
    // i.e. it looks for fields related to revenue/income (amount,
    // customer, product, date) rather than requiring a reviewed schema —
    // and discoverMechanisms() below is fed those rows exactly as it was
    // always fed canonical ones (it only ever takes plain row arrays, so
    // switching source changes nothing about how a mechanism is inferred).
    // See claude/cma-flow-app-conceptual-framework-audit.md in the project
    // docs — the canonical schema is a future-dissertation extension, not
    // part of this study's reported pathway.
    const rawByFileType = await getRawRecordsByFileType(accountId, selectedDataset.id);
    const txnPick = pickRawEntityRows(rawByFileType, 'Transaction');
    const entPick = pickRawEntityRows(rawByFileType, 'Entitlement');
    const monPick = pickRawEntityRows(rawByFileType, 'MonetizationConfig');
    const cleanTxns = txnPick.rows.filter((t) => t.amount !== null && !Number.isNaN(Number(t.amount)) && t.customer_id);
    const transactionRows = cleanTxns;
    const entitlementRows = entPick.rows;
    const monetizationRows = monPick.rows;
    const hasAnyData = cleanTxns.length > 0 || entitlementRows.length > 0 || monetizationRows.length > 0;
    const rawInfo = {
      hasTransactionSignal: cleanTxns.length > 0,
      sourceFileLabel: txnPick.fileType ? humanizeFileType(txnPick.fileType) : null,
      skippedRows: txnPick.rows.length - cleanTxns.length,
    };

    // Dataset-level business-domain / financial-measure classification —
    // computed from this dataset's RAW uploaded files (services/
    // businessSemantics.js + services/datasetClassifier.js), so a GCP
    // Cloud Billing export (or any other cost/expense dataset) reads as
    // "cost, not revenue" here. Threaded into discoverMechanisms() below
    // so a usage-based billing pattern it infers from Transaction data is
    // labeled honestly as vendor billing, never as this organization's own
    // revenue.
    const bi = await getOrBuildBusinessIntelligence(accountId, selectedDataset.id);
    const financialProfile = bi.financialProfile || { applicable: false, reason: 'Not yet computed for this dataset.' };

    const discoveries = hasAnyData ? discoverMechanisms(transactionRows, entitlementRows, monetizationRows, financialProfile) : [];
    const confirmedMap = hasAnyData ? await getConfirmedClassifications(accountId, selectedDataset.id) : {};

    res.render('dashboard/monetization-discovery', {
      title: 'Monetization discovery',
      active: 'monetization-discovery',
      datasets,
      selectedDataset,
      hasAnyData,
      financialProfile,
      rawInfo,
      discoveries: discoveries.map((d, i) => ({
        ...d,
        index: i,
        confirmedModelType: confirmedMap[d.productService] || '',
      })),
      modelTypes: MODEL_TYPES,
      modelTypeLabels: MODEL_TYPE_LABELS,
      errors: [],
    });
  } catch (err) {
    next(err);
  }
});

// POST /monetization-discovery — confirms/corrects the mechanism for one
// or more products at once. The inference itself is ALWAYS recomputed
// server-side from this dataset's current raw uploaded files (never
// trusted from hidden form fields) — only the SME owner's actual
// selected model_type per product is taken from the submission, and only
// for a product name that still exists in the fresh discovery pass, so a
// stale form (raw files re-uploaded since the page loaded) can't
// silently confirm a classification that no longer applies to anything.
router.post('/monetization-discovery', async (req, res, next) => {
  const accountId = req.session.userId;
  try {
    const datasetRowId = parseInt(req.body.dataset_id, 10);
    const { rows: datasetCheck } = await pool.query(
      `SELECT id FROM uploaded_datasets WHERE id = $1 AND account_id = $2`,
      [datasetRowId, accountId]
    );
    if (!datasetCheck[0]) {
      res.status(404).render('errors/404', { title: 'Not found', layout: false });
      return;
    }

    // Re-derive the same raw-native rows the GET route showed — the
    // confirmation is always checked against a fresh discovery pass, never
    // trusted from hidden form fields (see the comment above this route).
    const [rawByFileType, bi] = await Promise.all([
      getRawRecordsByFileType(accountId, datasetRowId),
      getOrBuildBusinessIntelligence(accountId, datasetRowId),
    ]);
    const txnPick = pickRawEntityRows(rawByFileType, 'Transaction');
    const entPick = pickRawEntityRows(rawByFileType, 'Entitlement');
    const monPick = pickRawEntityRows(rawByFileType, 'MonetizationConfig');
    const transactionRows = txnPick.rows.filter((t) => t.amount !== null && !Number.isNaN(Number(t.amount)) && t.customer_id);
    const entitlementRows = entPick.rows;
    const monetizationRows = monPick.rows;
    const financialProfile = bi.financialProfile || { applicable: false };
    const freshDiscoveries = discoverMechanisms(transactionRows, entitlementRows, monetizationRows, financialProfile);

    const entries = [];
    freshDiscoveries.forEach((d, i) => {
      const submittedProduct = req.body[`product_${i}`];
      if (submittedProduct !== d.productService) return; // page/data drifted — skip rather than misattribute
      const selected = (req.body[`confirm_${i}`] || '').trim();
      if (!MODEL_TYPES.includes(selected)) return; // "— use inferred —" or blank: nothing to confirm yet
      entries.push({
        productService: d.productService,
        confirmedModelType: selected,
        inferredModelType: d.inferredModelType,
        confidence: d.confidence,
        evidence: d.evidence,
      });
    });

    if (entries.length > 0) {
      await saveConfirmedClassifications(accountId, datasetRowId, entries);
    }

    res.redirect(`/monetization-discovery?dataset=${datasetRowId}`);
  } catch (err) {
    next(err);
  }
});

// GET /monetization-discovery/drill-down — fetched by the discovery
// card's drill-down panel (public/js/monetization-discovery.js), one page
// at a time, so the SME owner can see exactly which customers/
// transactions a card's KPI tiles and inference are reading before
// deciding whether to confirm or correct it. Renders a bare row-fragment
// (layout: false, no <table>/<thead> — the panel shell already has
// those) so the client can just append it to the table body on load and
// on "load more" scroll, matching the plain server-rendered-HTML style
// the rest of the app uses (JSON was deliberately avoided here so this
// stays one templating system, not two).
router.get('/monetization-discovery/drill-down', async (req, res, next) => {
  const accountId = req.session.userId;
  try {
    const datasetRowId = parseInt(req.query.dataset, 10);
    const { rows: datasetCheck } = await pool.query(
      `SELECT id FROM uploaded_datasets WHERE id = $1 AND account_id = $2`,
      [datasetRowId, accountId]
    );
    if (!datasetCheck[0]) {
      res.status(404).render('errors/404', { title: 'Not found', layout: false });
      return;
    }

    const product = String(req.query.product || '').trim();
    const viewMode = req.query.mode === 'transactions' ? 'transactions' : 'customers';
    const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
    if (!product) {
      res.status(400).render('errors/404', { title: 'Not found', layout: false });
      return;
    }

    // Raw-native, matching the GET/POST routes above: the same auto-
    // detected Transaction rows discoverMechanisms() was fed, plus a
    // best-effort raw Customer pick purely for a friendlier name in the
    // "By customer" view — buildProductDrillDown() already tolerates an
    // empty customerRows array and falls back to the customer_id itself.
    const rawByFileType = await getRawRecordsByFileType(accountId, datasetRowId);
    const transactionRows = pickRawEntityRows(rawByFileType, 'Transaction').rows
      .filter((t) => t.amount !== null && !Number.isNaN(Number(t.amount)) && t.customer_id);
    const customerRows = pickRawEntityRows(rawByFileType, 'Customer').rows;
    const currency = mode(transactionRows.map((t) => t.currency)) || '';
    const drillDown = buildProductDrillDown(transactionRows, customerRows, product, viewMode, offset);

    res.render('dashboard/_drilldown-rows', {
      layout: false,
      mode: drillDown.mode,
      rows: drillDown.rows,
      hasMore: drillDown.hasMore,
      nextOffset: offset + drillDown.rows.length,
      currency,
      formatMoney,
      formatCount,
    });
  } catch (err) {
    next(err);
  }
});

// ------------------------------------------------------------------
// GET /descriptive-analytics — historical/current-state monetization
// view, computed from the CMA Canonical Schema (post Map & Transform)
// for one Dataset ID at a time (?dataset=), split into eight selectable
// views (?view=) matching the CMA descriptive-analytics matrix:
// Customers, Transactions, Mechanisms, Entitlements, Configuration,
// Switching, Reconciliation, and Dataset analysis. Every view's chart
// cards are built up front (the underlying numbers are cheap, in-memory
// aggregation over an already-fetched dataset) so switching tabs is an
// instant server-rendered navigation, not a second round of queries.
// ------------------------------------------------------------------
const ANALYTICS_VIEWS = [
  { slug: 'full-descriptive', label: 'Full descriptive analytics', icon: '🧬' },
  { slug: 'revenue-growth', label: 'Revenue & growth', icon: '💹' },
  { slug: 'dataset-analysis', label: 'Dataset analysis', icon: '🗂️' },
];

function modelLabel(rawModelType) {
  return MODEL_TYPE_LABELS[rawModelType] || (rawModelType ? rawModelType.replace(/_/g, ' ') : 'Unspecified');
}

// Revenue & Growth tab — builds the same set of chart-card HTML regardless
// of which data source produced `metrics` (services/analytics.js's
// revenueGrowthMetrics(), called identically from the CMA Canonical
// Schema path in buildDescriptiveAnalytics() and the raw-upload path in
// buildRawRevenueGrowthAnalytics()) — the two sources only ever differ in
// how reviewed the input is, never in how a card is rendered.
//
// `drilldownDatasetId`, when passed (the CMA Canonical Schema call site
// only — see below), wires the "Revenue by product / service" and
// "Revenue by customer" charts' rows to the drill-down panel
// (GET /descriptive-analytics/revenue-drill-down). Left off for the raw-
// upload call site: that panel always reads confirmed CANONICAL
// Transaction/Customer data (the same source every other drill-down in
// this app reads), which an unmapped raw upload's product/customer values
// won't reliably line up with.
function buildRevenueGrowthCards(metrics, currency, drilldownDatasetId = null) {
  const cards = {};
  cards.kpiRow = [
    renderStatTile({ label: 'Total revenue', value: formatCompactMoney(metrics.totalRevenue, currency) }),
    renderStatTile({ label: 'Paying customers', value: formatCount(metrics.payingCustomerCount) }),
    renderStatTile({ label: 'ARPU', value: metrics.arpu === null ? '—' : formatMoney(metrics.arpu, currency) }),
    renderStatTile({
      label: 'MRR',
      value: metrics.mrr === null ? '—' : formatCompactMoney(metrics.mrr, currency),
      sublabel: metrics.mrrMonthLabel || null,
    }),
  ];
  cards.arrValue = metrics.arr === null ? null : formatCompactMoney(metrics.arr, currency);

  cards.byMechanism = renderBarChart({
    title: 'Revenue by mechanism',
    items: metrics.byMechanism,
    currency,
    emptyMessage: 'No transaction revenue could be matched to a product/service yet.',
  });
  cards.byCustomer = renderBarChart({
    title: 'Revenue by customer',
    items: metrics.byCustomer,
    currency,
    drilldown: drilldownDatasetId ? { by: 'customer', datasetId: drilldownDatasetId } : null,
  });
  cards.byProduct = renderBarChart({
    title: 'Revenue by product / service',
    items: metrics.byProduct,
    currency,
    drilldown: drilldownDatasetId ? { by: 'product', datasetId: drilldownDatasetId } : null,
  });
  cards.byPeriod = renderTrendChart({ title: 'Revenue by period', points: metrics.byPeriod, currency });

  cards.mechanismContribution = renderBarChart({
    title: 'Mechanism contribution',
    subtitle: 'Each mechanism\'s share of total revenue',
    items: metrics.mechanismTable.map((m) => ({ label: m.label, value: m.pctOfTotal, isOther: m.isOther })),
    money: false,
    formatValue: (v) => `${v.toFixed(1)}%`,
    emptyMessage: 'No mechanism-attributed revenue yet.',
  });

  cards.usageAvailable = !!metrics.usage;
  if (metrics.usage) {
    cards.usageKpiRow = [
      renderStatTile({ label: 'Total usage (quantity)', value: formatCount(metrics.usage.totalUsage) }),
      renderStatTile({ label: 'Transactions with usage data', value: formatCount(metrics.usage.coveredTransactions) }),
    ];
    cards.usageByProduct = renderBarChart({
      title: 'Usage by product / service', items: metrics.usage.byProduct, money: false, valueColumnLabel: 'Quantity',
    });
  }

  cards.customerGrowthActive = renderTrendChart({
    title: 'Active customers by month',
    points: metrics.customerGrowth.activeTrend,
    money: false,
    valueLabel: 'Active customers',
    emptyMessage: 'Not enough transaction history yet to show customer growth.',
  });
  cards.customerGrowthNew = renderTrendChart({
    title: 'New customers by month',
    points: metrics.customerGrowth.newTrend,
    money: false,
    valueLabel: 'New customers',
    emptyMessage: 'Not enough transaction history yet to show new-customer growth.',
  });

  cards.conversionAvailable = !!metrics.conversion;
  if (metrics.conversion) {
    cards.conversionKpiRow = [
      renderStatTile({ label: 'Free / trial cohort', value: formatCount(metrics.conversion.freeCohortSize) }),
      renderStatTile({ label: 'Converted to paying', value: formatCount(metrics.conversion.convertedCount) }),
      renderStatTile({ label: 'Conversion rate', value: `${metrics.conversion.rate.toFixed(1)}%` }),
    ];
  }

  cards.churnAvailable = !!metrics.churn;
  if (metrics.churn) {
    cards.churnKpiRow = [
      renderStatTile({ label: 'Active entitlements', value: formatCount(metrics.churn.activeCount) }),
      renderStatTile({ label: 'Expired entitlements', value: formatCount(metrics.churn.expiredCount) }),
      renderStatTile({ label: 'Churn rate', value: `${metrics.churn.rate.toFixed(1)}%` }),
    ];
  }

  return cards;
}

// Full Descriptive Analytics tab — turns one services/fullDescriptive
// Analytics.js bundle (per-file column profiles + cross-file
// relationships) into chart-card HTML, reusing the exact same render
// functions every other tab uses (renderStatTile/renderBarChart/
// renderTrendChart) so a histogram or a category breakdown here looks
// identical in style to "Revenue by product" — nothing about this tab
// gets its own bespoke visual language. Every section is built from
// whatever profileFile() actually found in THIS dataset's columns, so a
// restaurant-order export and a short-term-rental export produce entirely
// different sections without any per-domain branching here.
const MEASURE_LABEL_RE = /_/g;
function humanizeColumnName(name) {
  const s = String(name || '').replace(MEASURE_LABEL_RE, ' ').trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function fmtNum(v, digits = 2) {
  return v === null || v === undefined ? '—' : Number(v).toLocaleString(undefined, { maximumFractionDigits: digits });
}
function fmtPct(v, digits = 1) {
  return v === null || v === undefined ? '—' : `${Number(v).toFixed(digits)}%`;
}

// The column-level descriptive-statistics menu, one field list per
// semantic type — Numeric / Currency / Categorical / Rating / Date-Time /
// Identifier, matching services/datasetProfiler.js's per-kind stat object
// one-for-one. Geographic isn't a separate case here: a geo_dimension
// column is still a plain 'category' kind at the per-file profiling level
// (the geo semantic is a cross-file BUSINESS role, layered on top — see
// services/businessSemantics.js), so it already gets the Categorical
// treatment below, which is exactly "Unique locations" (uniqueCount) plus
// "frequency and percentage by location" (the top[] entries) either way.
// Returns [] for kinds with no dedicated stat menu in the spec (boolean,
// url, text, empty) — those keep the plain name+kind pill in the view.
function buildColumnStatLines(col, currency) {
  const lines = [];
  const push = (label, value) => lines.push({ label, value });

  if (['numeric', 'percentage', 'geo_lat', 'geo_lng'].includes(col.kind)) {
    push('Count', formatCount(col.count));
    push('Missing', formatCount(col.missing));
    push('Mean', fmtNum(col.mean));
    push('Median', fmtNum(col.median));
    push('Mode', fmtNum(col.mode));
    push('SD', fmtNum(col.stdev));
    push('Variance', fmtNum(col.variance));
    push('Min', fmtNum(col.min));
    push('Q1', fmtNum(col.q1));
    push('Q3', fmtNum(col.q3));
    push('Max', fmtNum(col.max));
    push('IQR', fmtNum(col.iqr));
    push('CV', fmtPct(col.cv));
  } else if (col.kind === 'currency') {
    push('Count', formatCount(col.count));
    push('Total', formatMoney(col.sum, currency));
    push('Mean', formatMoney(col.mean, currency));
    push('Median', formatMoney(col.median, currency));
    push('SD', formatMoney(col.stdev, currency));
    push('Min', formatMoney(col.min, currency));
    push('Q1', formatMoney(col.q1, currency));
    push('Q3', formatMoney(col.q3, currency));
    push('Max', formatMoney(col.max, currency));
  } else if (col.kind === 'rating') {
    push('Count', formatCount(col.count));
    push('Mean', fmtNum(col.mean));
    push('Median', fmtNum(col.median));
    push('Mode', fmtNum(col.mode));
    push('SD', fmtNum(col.stdev));
    push('Min', fmtNum(col.min));
    push('Max', fmtNum(col.max));
    if (col.frequencyDistribution && col.frequencyDistribution.length > 0) {
      push('Frequency distribution', col.frequencyDistribution
        .map((f) => `${fmtNum(f.value, 1)}: ${fmtPct(f.percentage)}`).join(' · '));
    }
  } else if (col.kind === 'category') {
    push('Count', formatCount(col.count));
    push('Unique', formatCount(col.uniqueCount));
    push('Mode', col.mode || '—');
    if (col.top && col.top.length > 0) {
      push('Frequency & percentage', col.top
        .slice(0, 5)
        .map((t) => `${t.label} (${formatCount(t.count)}, ${fmtPct(t.percentage)})`).join(' · '));
    }
  } else if (col.kind === 'date') {
    push('Count', formatCount(col.count));
    push('Earliest', col.minDate || '—');
    push('Latest', col.maxDate || '—');
    push('Range', col.rangeDays !== null ? `${formatCount(col.rangeDays)} day(s)` : '—');
    const peak = (arr, keyName) => (arr && arr.length ? arr.reduce((b, x) => (x.count > b.count ? x : b), arr[0]) : null);
    const peakDow = peak(col.byDayOfWeek);
    const peakMoy = peak(col.byMonthOfYear);
    const peakYear = peak(col.byYear);
    if (peakDow && peakDow.count > 0) push('Busiest day of week', `${peakDow.label} (${formatCount(peakDow.count)})`);
    if (peakMoy && peakMoy.count > 0) push('Busiest month', `${peakMoy.label} (${formatCount(peakMoy.count)})`);
    if (peakYear && peakYear.count > 0) push('Busiest year', `${peakYear.year} (${formatCount(peakYear.count)})`);
  } else if (col.kind === 'id') {
    push('Count', formatCount(col.count));
    push('Unique count', formatCount(col.uniqueCount));
    push('Duplicate count', formatCount(col.duplicateCount));
    push('Uniqueness ratio', fmtPct(col.uniquenessRatio !== null ? col.uniquenessRatio * 100 : null));
  }

  return lines;
}

function buildFullDescriptiveCards(bundle, currency, datasetRowId) {
  const { files, relationships } = bundle;

  // --- Executive KPI row: one tile per file (row count), capped. This
  // used to also guess at a "headline measure" by grabbing the first
  // currency/rating column found in ANY file, regardless of whether that
  // file had anything to do with revenue — which is exactly the bug a
  // multi-file food-delivery upload exposed (a `food.csv` with no
  // revenue or customer field at all was being read as if it were
  // representative of the dataset's money). Real, cross-file revenue
  // KPIs now come from buildBusinessMetricsCards() below, computed by
  // the Automatic Dataset Intelligence & Analytics Engine — only for a
  // file it has actually identified as the transaction fact table, not
  // an arbitrary currency-shaped column anywhere in the dataset. -------
  const executiveKpiRow = [];
  files.slice(0, 6).forEach((fp) => {
    executiveKpiRow.push(renderStatTile({
      label: humanizeFileType(fp.fileType), value: formatCount(fp.rowCount), sublabel: null,
    }));
  });

  // --- Per-file sections -----------------------------------------------
  const fileSections = files.map((fp) => {
    const totalCells = fp.columns.length * fp.rowCount;
    const totalMissing = fp.columns.reduce((s, c) => s + (c.missing || 0), 0);
    const completeness = totalCells > 0 ? 100 - ((totalMissing / totalCells) * 100) : 100;

    const kpiRow = [
      renderStatTile({ label: 'Rows', value: formatCount(fp.rowCount) }),
      renderStatTile({ label: 'Columns detected', value: formatCount(fp.columns.length) }),
      renderStatTile({ label: 'Data completeness', value: `${completeness.toFixed(1)}%` }),
    ];
    if (fp.dateColumnName) {
      const dc = fp.columns.find((c) => c.name === fp.dateColumnName);
      if (dc && dc.minDate) {
        kpiRow.push(renderStatTile({ label: humanizeColumnName(dc.name), value: `${dc.minDate} → ${dc.maxDate}` }));
      }
    }

    // Every category/numeric breakdown chart below gets a per-row 🔍
    // drill-down straight into that column's actual raw rows (see
    // services/rawDrillDown.js + public/js/raw-row-drilldown.js) —
    // "Category: Supreme, 9 rows" opens exactly those 9 rows, no Map &
    // Transform required, since this whole tab already works directly
    // off dataset_records. Only meaningful when a datasetRowId was
    // supplied (it always is from the real route below; omitted only if
    // this were ever called without one).
    const categoryCharts = fp.columns
      .filter((c) => c.kind === 'category' && c.top.length > 0)
      .slice(0, 4)
      .map((c) => {
        const items = c.top.map((t) => ({ label: t.label, value: t.count }));
        if (c.otherCount > 0) items.push({ label: 'Other', value: c.otherCount, isOther: true });
        return renderBarChart({
          title: humanizeColumnName(c.name),
          items,
          money: false,
          valueColumnLabel: 'Rows',
          drilldown: datasetRowId ? {
            kind: 'raw-category', datasetId: datasetRowId, fileType: fp.fileType, column: c.name,
          } : null,
        });
      });

    const numericCharts = fp.columns
      .filter((c) => ['numeric', 'currency', 'rating', 'percentage'].includes(c.kind) && c.histogram && c.histogram.length > 0)
      .slice(0, 4)
      .map((c) => {
        const items = c.histogram.map((b, i) => ({ label: b.label, value: b.count, bucketIndex: i }));
        const subtitleBits = [`mean ${c.mean.toFixed(2)}`, `median ${c.median.toFixed(2)}`];
        if (c.zeroCount > 0) subtitleBits.push(`${formatCount(c.zeroCount)} zero`);
        if (c.negativeCount > 0) subtitleBits.push(`${formatCount(c.negativeCount)} negative`);
        return renderBarChart({
          title: humanizeColumnName(c.name),
          subtitle: subtitleBits.join(' · '),
          items,
          money: false,
          valueColumnLabel: 'Rows',
          drilldown: datasetRowId ? {
            kind: 'raw-range', datasetId: datasetRowId, fileType: fp.fileType, column: c.name,
            colMin: c.min, colMax: c.max, bins: HISTOGRAM_BINS,
          } : null,
        });
      });

    let trendChart = null;
    if (fp.trendByMonth.length > 1) {
      const primaryMeasure = fp.measureColumns[0];
      const usesSum = primaryMeasure && fp.trendByMonth.some((t) => t.sum !== null);
      trendChart = renderTrendChart({
        title: usesSum ? `${humanizeColumnName(primaryMeasure)} by month` : `${humanizeColumnName(fp.dateColumnName)}: rows by month`,
        points: fp.trendByMonth.map((t) => ({
          label: t.month, value: usesSum ? t.sum : t.count,
        })),
        money: false,
        valueLabel: usesSum ? humanizeColumnName(primaryMeasure) : 'Rows',
        // Same per-row 🔍 drill-down as this file's own category/numeric
        // breakdown charts above (raw-category/raw-range) — a month point
        // opens exactly the rows of THIS file whose own date column falls
        // in that month, via the new 'raw-month' kind (services/
        // rawDrillDown.js + public/js/raw-row-drilldown.js).
        drilldown: datasetRowId ? {
          kind: 'raw-month', datasetId: datasetRowId, fileType: fp.fileType, column: fp.dateColumnName,
        } : null,
      });
    }

    const dataQuality = fp.columns
      .filter((c) => c.missing > 0 || c.duplicateCount > 0 || c.negativeCount > 0 || c.zeroCount > 0)
      .map((c) => ({
        name: humanizeColumnName(c.name),
        missingPct: fp.rowCount > 0 ? `${((c.missing / fp.rowCount) * 100).toFixed(1)}%` : '—',
        duplicateCount: c.duplicateCount || 0,
        zeroCount: c.zeroCount || 0,
        negativeCount: c.negativeCount || 0,
      }));

    return {
      fileType: fp.fileType,
      fileLabel: humanizeFileType(fp.fileType),
      rowCount: formatCount(fp.rowCount),
      kpiRow,
      categoryCharts,
      numericCharts,
      trendChart,
      correlations: fp.correlations.map((c) => ({
        a: humanizeColumnName(c.a), b: humanizeColumnName(c.b), r: c.r.toFixed(2), sampleSize: formatCount(c.sampleSize),
      })),
      // Raw (un-humanized, un-formatted) column names + numeric r/sampleSize
      // — attachScatterCharts() below needs the ACTUAL column names to
      // query dataset_records, and the numeric r/sampleSize to decide
      // which pairs clear the scatter-worthy threshold. Stripped back off
      // before this reaches the view (see attachScatterCharts).
      rawCorrelations: fp.correlations,
      scatterCharts: [],
      dataQuality,
      columns: fp.columns.map((c) => ({
        name: humanizeColumnName(c.name), kind: c.kind, statLines: buildColumnStatLines(c, currency),
      })),
    };
  });

  const relationshipRows = relationships.map((r) => ({
    from: `${humanizeFileType(r.fromFile)}.${r.fromColumn}`,
    to: `${humanizeFileType(r.toFile)}.${r.toColumn}`,
    overlapPct: `${r.overlapPct.toFixed(1)}%`,
    matched: formatCount(r.matched),
    fromDistinct: formatCount(r.fromDistinct),
  }));

  return { executiveKpiRow, fileSections, relationshipRows };
}

// Scatter charts for the Full Descriptive Analytics tab — a deliberately
// separate, ASYNC step from buildFullDescriptiveCards() above (which stays
// a pure, synchronous render over an already-fetched bundle). Unlike every
// other chart on that tab, a scatter plot needs raw (x, y) sample POINTS
// that the cached per-file profile never retains (see getCorrelationSample()
// in services/fullDescriptiveAnalytics.js) — so this runs one small,
// targeted query per pair actually worth plotting, never for every
// correlation computed. "Worth plotting" mirrors what a human analyst
// would bother looking at: a moderate-or-stronger relationship (|r| ≥ 0.3)
// with enough paired rows to mean something (≥ 10), capped to the top 2
// strongest pairs per file so a wide dataset with many measure columns
// doesn't turn into a wall of scatter plots.
const SCATTER_MIN_ABS_R = 0.3;
const SCATTER_MIN_SAMPLE_SIZE = 10;
const SCATTER_MAX_PER_FILE = 2;

async function attachScatterCharts(fileSections, datasetRowId) {
  await Promise.all(fileSections.map(async (section) => {
    const candidates = (section.rawCorrelations || [])
      .filter((c) => Math.abs(c.r) >= SCATTER_MIN_ABS_R && c.sampleSize >= SCATTER_MIN_SAMPLE_SIZE)
      .slice(0, SCATTER_MAX_PER_FILE);

    section.scatterCharts = await Promise.all(candidates.map(async (c) => {
      const points = await getCorrelationSample(datasetRowId, section.fileType, c.a, c.b, 300);
      return renderScatterChart({
        title: `${humanizeColumnName(c.a)} vs. ${humanizeColumnName(c.b)}`,
        xLabel: humanizeColumnName(c.a),
        yLabel: humanizeColumnName(c.b),
        points,
        r: c.r,
        sampleSize: c.sampleSize,
      });
    }));
    // Raw column names/numbers were only ever needed to decide which
    // pairs to sample above — never meant to reach the view.
    delete section.rawCorrelations;
  }));
}

// Business Metrics section — the Automatic Dataset Intelligence &
// Analytics Engine's output (services/businessSemantics.js +
// services/metricRegistry.js, orchestrated by getOrBuildBusinessIntelligence()
// in services/fullDescriptiveAnalytics.js). Unlike buildFullDescriptiveCards()
// above, which profiles every file on its own, everything rendered here
// is computed by reasoning ACROSS files: which one is the transaction
// fact table, which of its columns are revenue/customer/product/merchant
// identifiers, and which other uploaded files those identifiers actually
// join to (confirmed by measured value overlap, not just name matching).
// A metric this engine couldn't validly compute renders as an honest
// "Not applicable" card with its reason, never a manufactured 0 — see
// claude/business-semantic-metric-engine.md.
const FILE_ROLE_LABELS = {
  transaction_fact: 'Transaction fact table',
  customer_dimension: 'Customer dimension',
  merchant_dimension: 'Merchant / restaurant dimension',
  product_dimension: 'Product dimension',
  subscription_dimension: 'Subscription dimension',
  usage_log: 'Usage log',
  generic_dimension: 'Related dimension (unnamed)',
  unclassified: 'Unclassified',
};

function formatMetricValue(metric, currency) {
  if (metric.kind === 'money') return formatCompactMoney(metric.value, currency);
  if (metric.kind === 'count') return formatCount(metric.value);
  if (metric.kind === 'percent') return `${metric.value.toFixed(1)}%`;
  // A plain numeric measure that isn't money/a count/a percentage — e.g.
  // buildDatePairMetrics()'s "average days between two dates" — with an
  // optional unit suffix the metric itself supplies (" days").
  if (metric.kind === 'number') return `${metric.value.toLocaleString(undefined, { maximumFractionDigits: 1 })}${metric.unitSuffix || ''}`;
  // The most-frequent-value shape — buildTopCategoryMetrics() /
  // buildTopGeographyFrequencyMetrics()'s "Top Category"/"Top Customer
  // State"/"Most-used Payment Type" business stats: { label, count,
  // percentage, total }.
  if (metric.kind === 'mode') return `${metric.value.label} (${metric.value.percentage.toFixed(1)}%)`;
  return String(metric.value);
}

// Generic "concentration" insight for any breakdown-kind metric — e.g.
// "Top 3 of 12 services account for 91.2% of total cost". This is the
// skill-compliant stand-in for a literal Pareto chart (bars + a
// cumulative-% line): the dataviz skill's "One axis — never a dual-axis
// chart (two y-scales)" rule rules out the classic bars+line-overlay
// Pareto chart outright, since that needs a second y-scale for the
// cumulative percentage. The same insight — "a small number of
// categories account for most of the total" — is fully carried by this
// one-line subtitle on the EXISTING single-axis breakdown bar chart, with
// no new chart type and no second axis. Applies to any breakdown metric
// generically (cost by service, revenue by geography, top resources by
// usage, ...) rather than being wired to one specific metric id.
function concentrationSubtitle(items) {
  if (!items || items.length < 2) return null;
  const real = items.filter((i) => !i.isOther);
  const total = items.reduce((s, i) => s + Math.abs(i.value), 0);
  if (total <= 0 || real.length < 2) return null;
  const topN = Math.min(3, real.length);
  const sorted = [...real].sort((a, b) => Math.abs(b.value) - Math.abs(a.value));
  const topSum = sorted.slice(0, topN).reduce((s, i) => s + Math.abs(i.value), 0);
  const pct = (topSum / total) * 100;
  if (pct < 40) return null; // not a meaningfully concentrated distribution — a generic subtitle would just be noise
  return `Top ${topN} of ${real.length} account for ${pct.toFixed(1)}% of the total.`;
}

function buildBusinessMetricsCards(bi, currency, datasetRowId = null) {
  if (!bi || !bi.semanticModel) {
    return { applicable: false, reason: bi ? bi.reason : null, fileRoles: [] };
  }

  const fileRoles = bi.semanticModel.files.map((f) => ({
    fileType: f.fileType,
    fileLabel: humanizeFileType(f.fileType),
    role: f.role,
    roleLabel: FILE_ROLE_LABELS[f.role] || f.role,
    confidencePct: `${Math.round(f.confidence * 100)}%`,
    band: f.band,
    evidence: f.evidence,
    isFact: f.fileType === bi.factFileType,
  }));

  if (!bi.applicable) {
    return {
      applicable: false, reason: bi.reason, fileRoles, financialProfile: bi.financialProfile || null,
    };
  }

  const factLabel = humanizeFileType(bi.factFileType);
  const simpleMetrics = [];
  // A dataset can now legitimately carry more than one trend metric at
  // once (e.g. REVENUE_BY_PERIOD and COST_BY_PERIOD both applicable, or
  // COST_BY_PERIOD alongside USAGE_BY_PERIOD) — an array, not a single
  // slot that the last trend metric silently overwrote.
  const trendCharts = [];
  const breakdownCharts = [];

  bi.metrics.forEach((m) => {
    if (!m.applicable) {
      simpleMetrics.push({
        id: m.id, label: m.label, applicable: false, reason: m.reason,
      });
      return;
    }
    if (m.kind === 'trend') {
      trendCharts.push(renderTrendChart({
        title: m.label,
        points: m.value,
        currency,
        valueLabel: m.label,
        // Same raw-row drill-down as every other chart on this tab (see
        // public/js/raw-row-drilldown.js) — a new 'raw-month' bucket kind
        // alongside the existing 'raw-category'/'raw-range' ones, filtering
        // the fact table's own dataset_records to the rows whose date
        // column falls in that point's month. Only wired when the metric
        // told us which date column it bucketed by (m.dateColumn) and a
        // dataset id was supplied — both always true from the real route.
        drilldown: (datasetRowId && m.dateColumn) ? {
          kind: 'raw-month', datasetId: datasetRowId, fileType: bi.factFileType, column: m.dateColumn,
        } : null,
      }));
      return;
    }
    if (m.kind === 'breakdown') {
      breakdownCharts.push(renderBarChart({
        title: m.label, items: m.value, currency, subtitle: concentrationSubtitle(m.value),
      }));
      return;
    }
    simpleMetrics.push({
      id: m.id,
      label: m.label,
      applicable: true,
      value: formatMetricValue(m, currency),
      sublabel: m.sublabel || null,
      confidenceBand: m.provenance.band,
      provenanceNote: m.provenance.note,
      sourceFile: m.provenance.sourceFile,
      sourceColumns: m.provenance.sourceColumns.join(', '),
    });
  });

  return {
    applicable: true,
    factFileLabel: factLabel,
    fileRoles,
    financialProfile: bi.financialProfile || null,
    dimensionsUsed: bi.dimensionsUsed.map((d) => ({
      role: d.role, fileLabel: humanizeFileType(d.fileType), overlapPct: `${d.overlapPct.toFixed(1)}%`,
    })),
    simpleMetrics,
    trendCharts,
    breakdownCharts,
  };
}

router.get('/descriptive-analytics', attachAdminViewingBanner, async (req, res, next) => {
  const accountId = resolveAccountId(req);
  try {
    const { rows: datasets } = await pool.query(
      `SELECT id, dataset_id, dataset_name, domain, created_at
         FROM uploaded_datasets
        WHERE account_id = $1
        ORDER BY created_at DESC`,
      [accountId]
    );

    if (datasets.length === 0) {
      return res.render('dashboard/descriptive-analytics', {
        title: 'Descriptive analytics',
        active: 'descriptive-analytics',
        datasets: [],
        selectedDataset: null,
        cards: null,
        views: ANALYTICS_VIEWS,
        activeView: null,
        dataSource: 'raw',
        rawRevenueGrowth: null,
        fullDescriptive: null,
        fullDescriptiveHasData: false,
        businessMetrics: null,
        currency: '',
      });
    }

    const requestedId = parseInt(req.query.dataset, 10);
    const selectedDataset = datasets.find((d) => d.id === requestedId) || datasets[0];
    const activeView = ANALYTICS_VIEWS.some((v) => v.slug === req.query.view)
      ? req.query.view
      : 'full-descriptive';
    // The CMA Canonical Schema (and its Map & Transform step) is reserved
    // for a future dissertation extension and is not part of this study's
    // reported pathway — see claude/cma-flow-app-conceptual-framework-audit.md
    // in the project docs. Descriptive Analytics only exposes raw-native
    // views as a result: Full descriptive analytics, Revenue & Growth, and
    // (as of Round 7) Dataset analysis all read directly from this
    // account's own uploaded files, with no Map & Transform required and
    // no canonical-schema opt-in anywhere on this page (the Customers /
    // Transactions / Mechanisms / Entitlements / Configuration / Switching
    // / Reconciliation tabs, which only ever read the canonical schema,
    // were removed from this page entirely in Round 5 — per-dataset
    // Mechanisms/Entitlements/Configuration detail specific to the
    // monetization mechanisms themselves still belongs to that future
    // extension; see Diagnostic/Predictive/Prescriptive for the analytics
    // this study does report on).
    const dataSource = 'raw';

    // Currency for this whole page is read from the SELECTED dataset's own
    // raw Transaction/MonetizationConfig columns (pickRawEntityRows() —
    // the same content-aware detection every raw-native tab in this app
    // already uses), so every tab — including the account-wide Dataset
    // analysis table below — formats money consistently without ever
    // touching canonical_records.
    const selectedRawByFileType = await getRawRecordsByFileType(accountId, selectedDataset.id);
    const currency = mode(pickRawEntityRows(selectedRawByFileType, 'Transaction').rows.map((t) => t.currency))
      || mode(pickRawEntityRows(selectedRawByFileType, 'MonetizationConfig').rows.map((m) => m.currency))
      || '';

    const cards = {};

    // Raw-upload source — the only source Revenue & Growth reads on this
    // page now. Only computed when this tab is actually open — it needs
    // its own dataset_records query, so it isn't worth paying for on every
    // other tab's request.
    let rawRevenueGrowth = null;
    if (activeView === 'revenue-growth') {
      rawRevenueGrowth = await buildRawRevenueGrowthAnalytics(accountId, selectedDataset.id);
      if (rawRevenueGrowth.hasTransactionSignal) {
        rawRevenueGrowth.sourceFileLabel = humanizeFileType(rawRevenueGrowth.sourceFileType);
        cards.revenueGrowthRaw = buildRevenueGrowthCards(rawRevenueGrowth, rawRevenueGrowth.currency);
      }
    }

    // --- Full Descriptive Analytics tab — works directly off this
    // dataset's RAW uploaded files (services/fullDescriptiveAnalytics.js),
    // with no dependency on Map & Transform, so it's the one tab that
    // shows something real even for a dataset that hasn't been (or never
    // will be) mapped onto the CMA Canonical Schema. Only computed when
    // this tab is actually open — getOrBuildFullProfile() is cheap when
    // every file's profile is already cached (the common case, since
    // profiling now runs at upload time — see POST /upload-dataset), but
    // still does real work the first time an older dataset is opened here.
    let fullDescriptive = null;
    let fullDescriptiveHasData = false;
    let businessMetrics = null;
    if (activeView === 'full-descriptive') {
      const bundle = await getOrBuildFullProfile(accountId, selectedDataset.id);
      fullDescriptiveHasData = bundle.files.length > 0;
      if (fullDescriptiveHasData) {
        fullDescriptive = buildFullDescriptiveCards(bundle, currency, selectedDataset.id);
        await attachScatterCharts(fullDescriptive.fileSections, selectedDataset.id);
        // Automatic Dataset Intelligence & Analytics Engine — reasons
        // ACROSS this dataset's files (which one is the transaction fact
        // table, which columns are revenue/customer/product/merchant
        // identifiers, which other files they actually join to) to
        // compute real cross-file business metrics. See
        // services/businessSemantics.js and services/metricRegistry.js.
        const bi = await getOrBuildBusinessIntelligence(accountId, selectedDataset.id);
        businessMetrics = buildBusinessMetricsCards(bi, currency, selectedDataset.id);
      }
    }

    // --- Dataset analysis tab (account-wide, by domain) — Round 7: reads
    // every dataset this account has uploaded straight off ITS OWN raw
    // files (getDatasetDomainRollupRaw(), one pickRawEntityRows('Transaction')
    // read per dataset), not the frozen canonical_records table Map &
    // Transform produces. Only computed when this tab is actually open —
    // it's one raw-records fetch per dataset on the account, not worth
    // paying for on every other tab's request.
    if (activeView === 'dataset-analysis') {
      const domainRollup = await getDatasetDomainRollupRaw(accountId, datasets);
      const da = buildDatasetDomainAnalysis(domainRollup, selectedDataset.id);
      cards.datasetAnalysisKpiRow = [
        renderStatTile({ label: 'This dataset\u2019s domain', value: selectedDataset.domain || 'Unspecified' }),
        renderStatTile({ label: 'Domains on this account', value: formatCount(da.domains.length) }),
        renderStatTile({ label: 'Datasets on this account', value: formatCount(datasets.length) }),
      ];
      cards.domainChart = renderBarChart({
        title: 'Revenue by dataset domain',
        subtitle: 'Rolled up across every dataset this account has uploaded — not just the selected one, each read from its own raw uploaded columns',
        items: da.domainChart,
        currency,
      });
      cards.datasetsTable = da.datasets.map((d) => ({
        datasetCode: d.datasetCode,
        datasetName: d.datasetName,
        domain: d.domain,
        revenue: formatMoney(d.revenue, currency),
        transactions: formatCount(d.transactionCount),
        customers: formatCount(d.customerCount),
        isCurrent: d.datasetRowId === selectedDataset.id,
      }));
    }

    res.render('dashboard/descriptive-analytics', {
      title: 'Descriptive analytics',
      active: 'descriptive-analytics',
      datasets,
      selectedDataset,
      cards,
      views: ANALYTICS_VIEWS,
      activeView,
      dataSource,
      rawRevenueGrowth,
      fullDescriptive,
      fullDescriptiveHasData,
      businessMetrics,
      currency,
    });
  } catch (err) {
    next(err);
  }
});

// NOTE (Round 7): GET /descriptive-analytics/revenue-drill-down — the
// canonical-only Revenue & Growth drill-down this comment used to
// document — was removed here. It read Transaction/Customer straight off
// canonical_records, and it had already gone unreachable back in Round 5
// once the canonical Revenue & Growth branch (and its
// public/js/revenue-drilldown.js <script> tag) was removed from
// descriptive-analytics.ejs — no view has linked to this route since.
// The raw-native Revenue & Growth tab's own drill-down needs are covered
// by GET /descriptive-analytics/raw-drill-down below and by GET
// /monetization-discovery/drill-down, both already raw-native.

// GET /descriptive-analytics/raw-drill-down — fetched by the Full
// Descriptive Analytics tab's per-column 🔍 row buttons (public/js/
// raw-row-drilldown.js), one page at a time. Unlike the revenue
// drill-down above, this reads a raw uploaded file's own dataset_records
// directly — no Map & Transform required, any column of any file, not a
// fixed canonical shape — via services/rawDrillDown.js. Because a raw
// file's columns are never a fixed schema, the response carries the
// column list in a response header (X-Drilldown-Columns, a base64'd JSON
// array) rather than inline HTML: a <tr> fragment is only valid HTML
// inside a <table>/<tbody> once already in the DOM (see raw-row-
// drilldown.js), so the column list — needed once, to build the
// <thead>, before any row exists — has to travel some other way. The
// rows themselves stay plain server-rendered HTML (_raw-drilldown-
// rows.ejs), matching every other drill-down fragment in this app.
router.get('/descriptive-analytics/raw-drill-down', async (req, res, next) => {
  const accountId = resolveAccountId(req);
  try {
    const datasetRowId = parseInt(req.query.dataset, 10);
    const { rows: datasetCheck } = await pool.query(
      `SELECT id FROM uploaded_datasets WHERE id = $1 AND account_id = $2`,
      [datasetRowId, accountId]
    );
    if (!datasetCheck[0]) {
      res.status(404).render('errors/404', { title: 'Not found', layout: false });
      return;
    }

    const fileType = String(req.query.fileType || '').trim();
    const column = String(req.query.column || '').trim();
    const drillMode = req.query.mode === 'range' ? 'range' : req.query.mode === 'month' ? 'month' : 'category';
    const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
    if (!fileType || !column) {
      res.status(400).render('errors/404', { title: 'Not found', layout: false });
      return;
    }

    const params = { datasetRowId, fileType, column, mode: drillMode, offset };
    if (drillMode === 'range') {
      params.bucketIndex = parseInt(req.query.bucketIndex, 10);
      params.colMin = Number(req.query.colMin);
      params.colMax = Number(req.query.colMax);
      params.bins = parseInt(req.query.bins, 10) || HISTOGRAM_BINS;
      if (!Number.isFinite(params.bucketIndex) || !Number.isFinite(params.colMin) || !Number.isFinite(params.colMax)) {
        res.status(400).render('errors/404', { title: 'Not found', layout: false });
        return;
      }
    } else {
      // 'category' and 'month' both reduce to the same shape — an exact
      // string match against `value` (a raw category label, or a
      // "YYYY-MM" month key) — see matchesCategory()/matchesMonth() in
      // services/rawDrillDown.js.
      params.value = String(req.query.value || '').trim();
      if (!params.value) {
        res.status(400).render('errors/404', { title: 'Not found', layout: false });
        return;
      }
    }

    const drillDown = await buildRawDrillDown(accountId, params);

    res.set('X-Drilldown-Columns', Buffer.from(JSON.stringify(drillDown.columns), 'utf8').toString('base64'));
    res.set('X-Drilldown-Total', String(drillDown.total));
    res.render('dashboard/_raw-drilldown-rows', {
      layout: false,
      columns: drillDown.columns,
      rows: drillDown.rows,
      hasMore: drillDown.hasMore,
      nextOffset: offset + drillDown.rows.length,
    });
  } catch (err) {
    next(err);
  }
});

// ------------------------------------------------------------------
// Dynamic Diagnostic Analytics tab — services/diagnosticEngine.js's 12
// finding generators, turned into generic {title, columns, rows} tables
// so this one function (not 12 hand-written table blocks in the .ejs)
// covers every finding shape. Every cell is already formatted into a
// display string here — the view just iterates columns/rows generically,
// the same "route formats, view renders" split as every other tab.
// Unlike buildBusinessMetricsCards() above, this tab works directly off
// the fact-table business-intelligence ctx (services/
// fullDescriptiveAnalytics.js's getOrBuildBusinessIntelligence()) rather
// than the CMA Canonical Schema, so it renders regardless of whether this
// dataset has ever been through Map & Transform — see the "Add alongside"
// decision in claude/ (this feature's design doc).
function fmtNum(v, digits = 1) {
  if (v === null || v === undefined || Number.isNaN(v)) return '—';
  return Number(v).toLocaleString('en-US', { maximumFractionDigits: digits });
}
function fmtPctPoint(v) {
  if (v === null || v === undefined || Number.isNaN(v)) return '—';
  return `${v >= 0 ? '+' : ''}${v.toFixed(1)}%`;
}
function fmtMoneyCell(v, currency) {
  if (v === null || v === undefined || Number.isNaN(v)) return '—';
  return formatMoney(v, currency);
}

function factorTables(result, currency) {
  const tables = [];
  if (result.numericResults.length) {
    tables.push({
      title: 'Numeric factors (Pearson correlation + best split)',
      columns: ['Factor', 'Correlation', 'Best-separating split'],
      rows: result.numericResults.map((r) => [
        escapeHtml(r.label),
        fmtNum(r.correlation, 2),
        r.split ? `≤ ${fmtNum(r.split.threshold, 1)} → avg ${fmtNum(r.split.leftMean, 1)}, above → avg ${fmtNum(r.split.rightMean, 1)} (explains ${fmtNum(r.split.reductionPct, 0)}% of variance)` : '—',
      ]),
    });
  }
  if (result.categoricalResults.length) {
    tables.push({
      title: 'Categorical factors (group comparison, effect size η)',
      columns: ['Factor', 'Effect size (η)', 'Most different group'],
      rows: result.categoricalResults.map((r) => [
        escapeHtml(r.label),
        fmtNum(r.eta, 2),
        r.bestGroup ? `${escapeHtml(r.bestGroup.label)}: avg ${fmtNum(r.bestGroup.mean, 2)} vs overall ${fmtNum(r.overallMean, 2)}` : '—',
      ]),
    });
  }
  return tables;
}

function binaryFactorTables(result) {
  const tables = [];
  if (result.numericResults.length) {
    tables.push({
      title: "Numeric factors (standardized group difference — Cohen's d)",
      columns: ['Factor', "Cohen's d", 'Group means'],
      rows: result.numericResults.map((r) => [
        escapeHtml(r.label),
        fmtNum(r.cohensD, 2),
        `${fmtNum(r.trueMean, 2)} vs ${fmtNum(r.falseMean, 2)} (n=${r.trueCount}/${r.falseCount})`,
      ]),
    });
  }
  if (result.categoricalResults.length) {
    tables.push({
      title: 'Categorical factors (chi-square test of association)',
      columns: ['Factor', 'χ²', 'df', 'Significant at 5%?'],
      rows: result.categoricalResults.map((r) => [
        escapeHtml(r.label),
        fmtNum(r.test.chiSquare, 2),
        String(r.test.df),
        r.test.significant ? 'Yes' : 'No',
      ]),
    });
  }
  return tables;
}

function contributionTable(title, rows, currency, valueLabel = 'Value') {
  if (!rows || rows.length === 0) return null;
  return {
    title,
    columns: [title.includes('geograph') ? 'Geography' : 'Value', `Prev. ${valueLabel}`, `Curr. ${valueLabel}`, 'Δ', '% of total change'],
    rows: rows.map((r) => [
      escapeHtml(r.label),
      fmtNum(r.prevValue, 1),
      fmtNum(r.currValue, 1),
      fmtNum(r.delta, 1),
      r.pctOfChange === null ? '—' : fmtPctPoint(r.pctOfChange),
    ]),
  };
}

function segmentationTables(seg, currency) {
  const cols = ['Group', ...seg.measures.map((m) => m.label)];
  const rowOf = (g) => [escapeHtml(g.label), ...seg.measures.map((m) => (m.key === 'revenue' ? fmtMoneyCell(g[m.key], currency) : fmtNum(g[m.key], 1)))];
  return [
    { title: 'Top performers', columns: cols, rows: seg.top.map(rowOf) },
    { title: 'Bottom performers', columns: cols, rows: seg.bottom.map(rowOf) },
  ];
}

function crosstabTable(crosstab) {
  if (!crosstab) return null;
  return {
    title: 'Crosstab',
    columns: ['', ...crosstab.colLabels],
    rows: crosstab.rowLabels.map((r) => [escapeHtml(r), ...crosstab.colLabels.map((c) => formatCount((crosstab.counts[r] || {})[c] || 0))]),
  };
}

// ---------------------------------------------------------------------
// Business Descriptive Summary — an auto-generated, template-based
// narrative plus a compact stat table, built from whichever business KPIs
// (services/metricRegistry.js's evaluateMetrics(), already computed as
// part of `bi`) actually resolved for this dataset. Rendered as a
// pseudo-finding at the TOP of the Dynamic diagnostics tab in Diagnostic
// Insights — "here's the business at a glance" before the 12 diagnostic
// questions answer "why". Deliberately not itself a diagnostic finding
// (it describes WHAT the numbers are, not WHY they moved); it lives on
// this tab rather than a tab of its own because it's built from the exact
// same business-intelligence bundle this route already computes for the
// Dynamic diagnostics tab, so adding it here costs no extra computation
// and guarantees the summary can never disagree with the 12 findings
// rendered right below it.
//
// This is the "generate business FINDINGS, not just statistics" layer
// the person commissioning this specifically asked for: each qualifying
// phrase below is a small, honest, rule-based classifier (a plain
// threshold table, not an opaque model) that turns a number into
// plain-language wording — every threshold is stated here, once, so it
// can be audited: review score >=4.2 "excellent", >=3.6 "generally
// favorable", >=3.0 "mixed", else "an area needing attention"; on-time
// rate >=90% "strong", >=75% "adequate", else "inconsistent" (used only
// when no review score is available to lead with).
//
// Explicit design point requested alongside this feature: "Top Category"
// is reported TWICE — by sales volume (frequency) and by revenue — since
// the two can honestly disagree (a cheap, frequently-bought category vs.
// an expensive, rarely-bought one, e.g. Olist's own bed_bath_table vs.
// health_beauty). Collapsing them into one number would silently pick a
// winner between two different questions; see
// services/metricRegistry.js's TOP_CATEGORY / TOP_CATEGORY_REVENUE.
// Each qualifier carries a severity (0 = best, 3 = worst) alongside its
// label so that, when BOTH a review score and an on-time rate are
// available, the narrative leads with whichever signal is actually more
// concerning — never lets a decent review score paper over a genuinely
// poor on-time rate (or vice versa). See the combined lead-in logic
// below, in the customer-experience paragraph.
function reviewScoreQualifier(v) {
  if (v >= 4.2) return { label: 'excellent', severity: 0 };
  if (v >= 3.6) return { label: 'generally favorable', severity: 1 };
  if (v >= 3.0) return { label: 'mixed', severity: 2 };
  return { label: 'an area needing attention', severity: 3 };
}
function onTimeQualifier(v) {
  if (v >= 90) return { label: 'strong', severity: 0 };
  if (v >= 75) return { label: 'adequate', severity: 1 };
  if (v >= 50) return { label: 'mixed', severity: 2 };
  return { label: 'inconsistent', severity: 3 };
}

function findFirstApplicable(metrics, predicate) {
  return metrics.find((m) => m.applicable && predicate(m)) || null;
}

// Resolves the small, fixed set of business KPIs this summary narrates,
// by id (for the stable, name-independent metrics) or by a label/id
// pattern match (for the dynamic, column-name-dependent ones) — never by
// recomputing anything from raw rows, so this can never disagree with the
// KPI tiles the rest of the app already shows for the same metric ids.
function resolveBusinessKpis(metrics) {
  const idIs = (id) => (m) => m.id === id;
  const idStarts = (prefix) => (m) => typeof m.id === 'string' && m.id.startsWith(prefix);
  return {
    totalOrders: findFirstApplicable(metrics, idIs('TOTAL_ORDERS')),
    totalCustomers: findFirstApplicable(metrics, idIs('TOTAL_ENTITY::customer_id')),
    totalProducts: findFirstApplicable(metrics, idIs('TOTAL_ENTITY::product_id')),
    totalSellers: findFirstApplicable(metrics, idIs('TOTAL_ENTITY::merchant_id')),
    totalRevenue: findFirstApplicable(metrics, idIs('TOTAL_REVENUE')),
    totalFreight: findFirstApplicable(metrics, idIs('FREIGHT_TOTAL')),
    avgPrice: findFirstApplicable(metrics, idIs('AVG_PRICE')),
    medianPrice: findFirstApplicable(metrics, idIs('MEDIAN_PRICE')),
    aov: findFirstApplicable(metrics, idIs('AOV')),
    avgItemsPerOrder: findFirstApplicable(metrics, idIs('AVG_ITEMS_PER_ORDER')),
    avgPaymentValue: findFirstApplicable(metrics, (m) => idStarts('LEFTOVER_AVG::')(m) && /payment.*(value|amount)/i.test(m.label)),
    avgInstallments: findFirstApplicable(metrics, (m) => idStarts('LEFTOVER_AVG::')(m) && /install/i.test(m.label)),
    avgReviewScore: findFirstApplicable(metrics, (m) => idStarts('LEFTOVER_AVG::')(m) && /(review|rating|score)/i.test(m.label)),
    avgDeliveryDays: findFirstApplicable(metrics, (m) => idStarts('DATE_PAIR_DURATION::')(m) && ACTUAL_DATE_NAME_RE.test(m.id.slice('DATE_PAIR_DURATION::'.length))),
    onTimeRate: findFirstApplicable(metrics, idStarts('ON_TIME_RATE::')),
    cancellationRate: findFirstApplicable(metrics, idStarts('CANCELLATION_RATE::')),
    topCategoryVolume: findFirstApplicable(metrics, idStarts('TOP_CATEGORY::')),
    topCategoryRevenue: findFirstApplicable(metrics, idStarts('TOP_CATEGORY_REVENUE::')),
    topPaymentType: findFirstApplicable(metrics, idStarts('TOP_PAYMENT_MECHANISM::')),
    topCustomerState: findFirstApplicable(metrics, idStarts('TOP_GEOGRAPHY::customer_id::')),
    topSellerState: findFirstApplicable(metrics, idStarts('TOP_GEOGRAPHY::merchant_id::')),
  };
}

const BUSINESS_KPI_INTERPRETATIONS = {
  totalOrders: 'Unique orders in the dataset',
  totalCustomers: 'Unique customers',
  totalProducts: 'Unique products represented',
  totalSellers: 'Unique sellers',
  totalRevenue: 'Sum of all revenue/item amounts',
  totalFreight: 'Total shipping/freight charges',
  avgPrice: 'Mean price per line item',
  medianPrice: 'Half of items cost below/above this amount',
  aov: 'Average merchandise value per order',
  avgItemsPerOrder: 'Average number of items purchased per order',
  avgPaymentValue: 'Mean value of payment records',
  avgInstallments: 'Average installments per payment',
  avgReviewScore: 'Overall mean customer rating',
  avgDeliveryDays: 'Mean time from purchase to customer delivery',
  onTimeRate: 'Delivered by or before the estimated delivery date',
  cancellationRate: 'Percentage of orders canceled',
  topCategoryVolume: 'Most frequently purchased category, by item count',
  topCategoryRevenue: 'Category generating the most revenue (can differ from the volume leader)',
  topPaymentType: 'Most common payment method',
  topCustomerState: 'Where the most customers are located',
  topSellerState: 'Where the most sellers are located',
};

function formatBusinessKpiResult(key, metric, currency) {
  if (key === 'topCategoryRevenue') {
    return `${escapeHtml(metric.value.label)} (${fmtMoneyCell(metric.value.amount, currency)}${metric.value.percentage !== null ? `, ${fmtNum(metric.value.percentage, 1)}%` : ''})`;
  }
  if (metric.kind === 'mode') return `${escapeHtml(metric.value.label)} (${fmtNum(metric.value.percentage, 1)}%)`;
  if (metric.kind === 'money') return fmtMoneyCell(metric.value, currency);
  if (metric.kind === 'count') return formatCount(metric.value);
  if (metric.kind === 'percent') return `${fmtNum(metric.value, 2)}%`;
  if (metric.kind === 'number') return `${fmtNum(metric.value, 2)}${metric.unitSuffix || ''}`;
  return escapeHtml(String(metric.value));
}

function buildBusinessSummaryCard(bi, currency) {
  if (!bi || !bi.applicable) return null;
  const metrics = bi.metrics || [];
  const k = resolveBusinessKpis(metrics);
  const resolvedKeys = Object.keys(k).filter((key) => k[key]);

  if (resolvedKeys.length === 0) {
    return {
      id: 'BUSINESS_SUMMARY',
      label: '📊 Business descriptive summary',
      question: 'What does this dataset show at a glance, before diagnosing why?',
      method: 'Automatic Business Descriptive Summary — template-based narrative generation from already-computed business metrics',
      applicable: false,
      reason: "None of this dataset's columns resolved to a recognized business KPI yet (no revenue/price, order, customer, or date column was confidently identified on the transaction fact table).",
    };
  }

  const revenueFallbackSuffix = (metric) => (metric && metric.isFallback
    ? ' No dedicated revenue/amount column was found for this dataset, so a listed price is used as the revenue figure.'
    : '');

  // --- Paragraph 1: scale & commercial value ---------------------------
  const scaleParts = [];
  if (k.totalOrders) scaleParts.push(`${formatCount(k.totalOrders.value)} orders`);
  if (k.totalCustomers) scaleParts.push(`${formatCount(k.totalCustomers.value)} unique customers`);
  let scaleSentence = null;
  if (scaleParts.length) {
    scaleSentence = `The dataset contains ${scaleParts.join(' from ')}`;
    const involving = [];
    if (k.totalProducts) involving.push(`${formatCount(k.totalProducts.value)} products`);
    if (k.totalSellers) involving.push(`${formatCount(k.totalSellers.value)} sellers`);
    if (involving.length) scaleSentence += `, involving ${involving.join(' and ')}`;
    scaleSentence += '.';
  }

  let revenueSentence = null;
  if (k.totalRevenue && k.aov) {
    revenueSentence = `Total merchandise sales reached approximately ${fmtMoneyCell(k.totalRevenue.value, currency)}, with an average order value of ${fmtMoneyCell(k.aov.value, currency)}.${revenueFallbackSuffix(k.totalRevenue)}`;
  } else if (k.totalRevenue) {
    revenueSentence = `Total merchandise sales reached approximately ${fmtMoneyCell(k.totalRevenue.value, currency)}.${revenueFallbackSuffix(k.totalRevenue)}`;
  } else if (k.aov) {
    revenueSentence = `The average order value was approximately ${fmtMoneyCell(k.aov.value, currency)}.`;
  }

  const itemsSentence = k.avgItemsPerOrder ? `Customers purchased an average of ${fmtNum(k.avgItemsPerOrder.value, 2)} items per order.` : null;

  const freightPaymentParts = [];
  if (k.totalFreight) freightPaymentParts.push(`total freight/shipping charges of approximately ${fmtMoneyCell(k.totalFreight.value, currency)}`);
  if (k.avgPaymentValue) freightPaymentParts.push(`an average payment value of ${fmtMoneyCell(k.avgPaymentValue.value, currency)}`);
  if (k.avgInstallments) freightPaymentParts.push(`payments typically split across ${fmtNum(k.avgInstallments.value, 1)} installments`);
  const freightPaymentSentence = freightPaymentParts.length ? `${freightPaymentParts[0].charAt(0).toUpperCase()}${freightPaymentParts[0].slice(1)}${freightPaymentParts.length > 1 ? `, with ${freightPaymentParts.slice(1).join(' and ')}` : ''}.` : null;

  const paragraph1 = [scaleSentence, revenueSentence, itemsSentence, freightPaymentSentence].filter(Boolean).join(' ');

  // --- Paragraph 2: customer experience / service quality --------------
  let serviceSentence = null;
  if (k.avgReviewScore || k.onTimeRate) {
    let qualifier;
    if (k.avgReviewScore && k.onTimeRate) {
      const rq = reviewScoreQualifier(k.avgReviewScore.value);
      const tq = onTimeQualifier(k.onTimeRate.value);
      qualifier = (tq.severity > rq.severity ? tq : rq).label;
    } else if (k.avgReviewScore) {
      qualifier = reviewScoreQualifier(k.avgReviewScore.value).label;
    } else {
      qualifier = onTimeQualifier(k.onTimeRate.value).label;
    }
    const clauses = [];
    if (k.avgReviewScore) clauses.push(`an average review score of ${fmtNum(k.avgReviewScore.value, 2)} out of 5`);
    if (k.onTimeRate) clauses.push(`approximately ${fmtNum(k.onTimeRate.value, 2)}% of delivered orders arriving on or before their estimated delivery date`);
    serviceSentence = `Customer service performance was ${qualifier}, with ${clauses.join(' and ')}.`;
  }
  let deliveryCancelSentence = null;
  if (k.avgDeliveryDays || k.cancellationRate) {
    const clauses = [];
    if (k.avgDeliveryDays) clauses.push(`average purchase-to-delivery time was ${fmtNum(k.avgDeliveryDays.value, 2)} days`);
    if (k.cancellationRate) clauses.push(`the cancellation rate was approximately ${fmtNum(k.cancellationRate.value, 2)}%`);
    deliveryCancelSentence = `${clauses.map((c, i) => (i === 0 ? c.charAt(0).toUpperCase() + c.slice(1) : c)).join(', while ')}.`;
  }
  const paragraph2 = [serviceSentence, deliveryCancelSentence].filter(Boolean).join(' ');

  // --- Paragraph 3: composition / segmentation --------------------------
  let categorySentence = null;
  if (k.topCategoryVolume && k.topCategoryRevenue) {
    categorySentence = (k.topCategoryVolume.value.label === k.topCategoryRevenue.value.label)
      ? `${escapeHtml(k.topCategoryVolume.value.label)} was both the most frequently purchased category and the top revenue generator, at approximately ${fmtMoneyCell(k.topCategoryRevenue.value.amount, currency)}.`
      : `The most frequently purchased product category was ${escapeHtml(k.topCategoryVolume.value.label)}, whereas ${escapeHtml(k.topCategoryRevenue.value.label)} generated the highest sales value at approximately ${fmtMoneyCell(k.topCategoryRevenue.value.amount, currency)}.`;
  } else if (k.topCategoryVolume) {
    categorySentence = `The most frequently purchased product category was ${escapeHtml(k.topCategoryVolume.value.label)}.`;
  } else if (k.topCategoryRevenue) {
    categorySentence = `${escapeHtml(k.topCategoryRevenue.value.label)} generated the highest sales value, at approximately ${fmtMoneyCell(k.topCategoryRevenue.value.amount, currency)}.`;
  }

  let geoSentence = null;
  if (k.topCustomerState && k.topSellerState) {
    geoSentence = (k.topCustomerState.value.label === k.topSellerState.value.label)
      ? `${escapeHtml(k.topCustomerState.value.label)} had the largest concentration of both customers and sellers.`
      : `${escapeHtml(k.topCustomerState.value.label)} had the largest concentration of customers, while ${escapeHtml(k.topSellerState.value.label)} had the largest concentration of sellers.`;
  } else if (k.topCustomerState) {
    geoSentence = `${escapeHtml(k.topCustomerState.value.label)} had the largest concentration of customers.`;
  } else if (k.topSellerState) {
    geoSentence = `${escapeHtml(k.topSellerState.value.label)} had the largest concentration of sellers.`;
  }

  const paymentSentence = k.topPaymentType
    ? `${escapeHtml(k.topPaymentType.value.label)} was the dominant payment method, used in ${fmtNum(k.topPaymentType.value.percentage, 1)}% of payment records.`
    : null;

  const paragraph3 = [categorySentence, geoSentence, paymentSentence].filter(Boolean).join(' ');

  const narrativeParagraphs = [paragraph1, paragraph2, paragraph3].filter((p) => p && p.trim().length);

  const rows = resolvedKeys.map((key) => [
    escapeHtml(k[key].label),
    formatBusinessKpiResult(key, k[key], currency),
    escapeHtml(BUSINESS_KPI_INTERPRETATIONS[key] || ''),
  ]);
  const tables = rows.length ? [{
    title: 'Business statistics at a glance', columns: ['Business statistic', 'Result', 'Interpretation'], rows,
  }] : [];

  const omittedCount = Object.keys(k).length - resolvedKeys.length;

  return {
    id: 'BUSINESS_SUMMARY',
    label: '📊 Business descriptive summary',
    question: 'What does this dataset show at a glance, before diagnosing why?',
    method: 'Automatic Business Descriptive Summary — template-based narrative generation from already-computed business metrics, never a separate recomputation',
    applicable: true,
    narrativeParagraphs,
    stats: [],
    tables,
    omittedCount,
  };
}

function buildDiagnosticEngineCards(bi, currency) {
  if (!bi || !bi.applicable) {
    return { applicable: false, reason: bi ? bi.reason : null, findings: [] };
  }

  const findings = (bi.diagnostics || []).map((f) => {
    if (!f.applicable) return f; // { id, label, question, method, applicable: false, reason }

    const tables = [];
    const stats = [];
    switch (f.id) {
      case 'REVENUE_DRIVERS':
        if (f.overall.pct !== null) stats.push(renderStatTile({ label: 'Revenue change', value: fmtPctPoint(f.overall.pct), sublabel: `${f.overall.prevMonth} → ${f.overall.currMonth}` }));
        if (f.decomposition) {
          tables.push({
            title: 'Price/volume decomposition',
            columns: ['Effect', 'Amount'],
            rows: [
              ['Volume effect (orders changing)', fmtMoneyCell(f.decomposition.volumeEffect, currency)],
              ['Price effect (AOV changing)', fmtMoneyCell(f.decomposition.priceEffect, currency)],
            ],
          });
        }
        (f.contributions || []).forEach((c) => {
          const t = contributionTable(`Contribution by ${c.dimensionLabel}`, c.rows, currency, 'revenue');
          if (t) tables.push(t);
        });
        break;
      case 'ORDERS_DRIVERS':
        if (f.overall.pct !== null) stats.push(renderStatTile({ label: 'Order count change', value: fmtPctPoint(f.overall.pct), sublabel: `${f.overall.prevMonth} → ${f.overall.currMonth}` }));
        (f.contributions || []).forEach((c) => {
          const t = contributionTable(`Contribution by ${c.dimensionLabel}`, c.rows, currency, 'orders');
          if (t) tables.push(t);
        });
        break;
      case 'AOV_DRIVERS':
        tables.push({
          title: 'Mix vs. rate decomposition',
          columns: ['Effect', 'Amount'],
          rows: [
            ['Mix effect (product mix shift)', fmtMoneyCell(f.decomposition.mixEffect, currency)],
            ['Rate effect (price moving within categories)', fmtMoneyCell(f.decomposition.rateEffect, currency)],
          ],
        });
        tables.push({
          title: 'By category',
          columns: ['Category', 'Prev. share', 'Curr. share', 'Prev. AOV', 'Curr. AOV'],
          rows: f.decomposition.perCategory.map((c) => [escapeHtml(c.label), `${fmtNum(c.prevShare, 1)}%`, `${fmtNum(c.currShare, 1)}%`, fmtMoneyCell(c.prevAOV, currency), fmtMoneyCell(c.currAOV, currency)]),
        });
        break;
      case 'FREIGHT_DRIVERS':
      case 'DELIVERY_DELAY_DRIVERS':
      case 'REVIEW_SCORE_DRIVERS':
        tables.push(...factorTables(f, currency));
        break;
      case 'CATEGORY_REVENUE_PARETO':
        tables.push({
          title: 'Declining categories (Pareto)',
          columns: ['Category', 'Prev. revenue', 'Curr. revenue', 'Δ', 'Cumulative % of decline'],
          rows: f.pareto.map((r) => [escapeHtml(r.label), fmtMoneyCell(r.prevValue, currency), fmtMoneyCell(r.currValue, currency), fmtMoneyCell(r.delta, currency), `${fmtNum(r.cumulativePct, 1)}%`]),
        });
        (f.secondary || []).forEach((s) => {
          const t = contributionTable(`Also declining by ${s.dimensionLabel}`, s.rows, currency, 'revenue');
          if (t) tables.push(t);
        });
        break;
      case 'SELLER_PERFORMANCE_SEGMENTATION':
      case 'GEO_SALES_SEGMENTATION':
        tables.push(...segmentationTables(f, currency));
        break;
      case 'CANCELLATION_DRIVERS':
        if (f.trend) stats.push(renderStatTile({ label: 'Cancellation rate', value: `${fmtNum(f.trend.currRatePct, 1)}%`, delta: f.trend.currRatePct - f.trend.prevRatePct, sublabel: f.trend.prevMonth }));
        tables.push(...binaryFactorTables(f));
        break;
      case 'PAYMENT_BEHAVIOR_CROSSTAB': {
        const ct = crosstabTable(f.crosstab);
        if (ct) tables.push({ ...ct, title: `Payment type × ${f.otherColumnLabel || 'status/category'}` });
        const geoCt = crosstabTable(f.geoCrosstab);
        if (geoCt) tables.push({ ...geoCt, title: 'Payment type × geography' });
        if (f.installmentsByPayment) {
          tables.push({
            title: 'Average installments by payment type',
            columns: ['Payment type', 'Avg. installments', 'Rows'],
            rows: f.installmentsByPayment.groups.map((g) => [escapeHtml(g.label), fmtNum(g.avgInstallments, 1), formatCount(g.count)]),
          });
        }
        if (f.orderValueByPayment) {
          tables.push({
            title: `Average ${f.orderValueByPayment.columnLabel} by payment type`,
            columns: ['Payment type', `Avg. ${f.orderValueByPayment.columnLabel}`, 'Rows'],
            rows: f.orderValueByPayment.groups.map((g) => [escapeHtml(g.label), fmtMoneyCell(g.avgValue, currency), formatCount(g.count)]),
          });
        }
        break;
      }
      case 'REPEAT_PURCHASE_DRIVERS':
        stats.push(renderStatTile({ label: 'Repeat customers', value: formatCount(f.repeatCount), sublabel: `of ${formatCount(f.repeatCount + f.oneTimeCount)} total` }));
        tables.push(...binaryFactorTables(f));
        break;
      case 'LOW_REVIEW_DRILLDOWN':
        stats.push(renderStatTile({ label: 'Low-rated rows analyzed', value: formatCount(f.lowReviewCount) }));
        tables.push({
          title: 'Drill-down path',
          columns: ['Question', 'Finding', 'Narrowed?'],
          rows: f.steps.map((s) => [escapeHtml(s.question), escapeHtml(s.finding), s.narrowed === null ? '—' : (s.narrowed ? 'Yes' : 'No')]),
        });
        f.steps.filter((s) => s.table).forEach((s) => {
          tables.push({
            title: `Breakdown — ${s.question}`,
            columns: ['Group', 'Rows (this subset)', 'Share of subset', 'Share of all rated orders', 'Lift'],
            rows: s.table.map((r) => [
              escapeHtml(r.label),
              formatCount(r.count),
              `${fmtNum(r.subsetShare, 1)}%`,
              r.baseShare === null ? '—' : `${fmtNum(r.baseShare, 1)}%`,
              r.lift === null ? '—' : `${fmtNum(r.lift, 1)}x`,
            ]),
          });
        });
        if (f.specifics && f.specifics.length) {
          tables.push({
            title: 'Specific orders/products to inspect',
            columns: ['Order ID', 'Product', 'Rating'],
            rows: f.specifics.map((s) => [escapeHtml(s.orderId ? String(s.orderId) : '—'), escapeHtml(s.product ? String(s.product) : '—'), fmtNum(s.rating, 1)]),
          });
        }
        break;
      case 'GEO_MARKET_DECOMPOSITION':
        stats.push(renderStatTile({ label: 'Top geography', value: escapeHtml(f.top.label), sublabel: fmtMoneyCell(f.top.revenue, currency) }));
        if (f.dominant) stats.push(renderStatTile({ label: 'Dominant factor', value: escapeHtml(f.dominant.factor), sublabel: `${fmtNum(f.dominant.ratio, 2)}x average` }));
        tables.push({
          title: 'Revenue by geography — customers × orders/customer × AOV',
          columns: ['Geography', 'Revenue', 'Orders', 'Customers', 'Orders/customer', 'AOV'],
          rows: f.rows.map((r) => [escapeHtml(r.label), fmtMoneyCell(r.revenue, currency), formatCount(r.orders), r.customers === null ? '—' : formatCount(r.customers), fmtNum(r.ordersPerCustomer, 2), fmtMoneyCell(r.aov, currency)]),
        });
        break;
      case 'PARETO_CONCENTRATION':
        f.panels.forEach((p) => {
          tables.push({
            title: `Pareto by ${p.dimensionLabel} (${p.pareto.vitalFewCount} of ${p.pareto.totalGroups} account for 80%)`,
            columns: [titleize(p.dimensionLabel), 'Revenue', '% of total', 'Cumulative %'],
            rows: p.pareto.rows.map((r) => [escapeHtml(r.label), fmtMoneyCell(r.value, currency), `${fmtNum(r.pctOfTotal, 1)}%`, `${fmtNum(r.cumulativePct, 1)}%`]),
          });
        });
        break;
      case 'FREIGHT_IMPACT_ANALYSIS':
        stats.push(renderStatTile({ label: 'Avg. freight-to-value ratio', value: `${fmtNum(f.overallRatio, 1)}%` }));
        if (f.reviewCorrelation !== null) stats.push(renderStatTile({ label: 'Correlation with review score', value: fmtNum(f.reviewCorrelation, 2) }));
        f.segments.forEach((s) => {
          tables.push(...segmentationTables(s.seg, currency).map((t) => ({ ...t, title: `${t.title} by ${s.dimensionLabel} (freight-to-value ratio)` })));
        });
        break;
      case 'CATEGORY_PERFORMANCE_MATRIX':
        tables.push({
          title: 'Category performance matrix',
          columns: ['Category', 'Revenue', 'Avg. review score', 'Quadrant'],
          rows: f.rows.map((r) => [escapeHtml(r.label), fmtMoneyCell(r.revenue, currency), fmtNum(r.avgRating, 2), escapeHtml(r.quadrant)]),
        });
        break;
      default:
        break;
    }

    return {
      id: f.id,
      label: f.label,
      question: f.question,
      method: f.method,
      applicable: true,
      narrative: f.narrative,
      stats,
      tables,
      // CAAGA Stage 6 (Priority + Confidence Engine, services/
      // priorityEngine.js via services/diagnosticEngine.js's
      // scoreDiagnosticFinding()) — carried through to the view so the
      // ranking that already reordered `bi.diagnostics` is visible to the
      // SME as a badge, not just an invisible sort key.
      priorityScore: f.priorityScore,
      priorityBand: f.priorityBand,
      confidence: f.confidence,
      confidenceBand: f.confidenceBand,
    };
  });

  return { applicable: true, findings };
}

// ------------------------------------------------------------------
// GET /diagnostic-insights — root-cause views over this dataset's own
// raw uploaded columns (pickRawEntityRows() — no Map & Transform
// required, no CMA Canonical Schema dependency; see
// claude/cma-flow-app-conceptual-framework-audit.md in the project
// docs), one Dataset ID at a time. Revenue bridge needs only ordinary
// Transaction data (two months of it); price-change impact and the
// cancellation ranking need the optional Phase 1 fields (effective_from,
// cancellation_reason) and degrade to an explicit empty state without
// them — never a guess. The fourth tab, Dynamic diagnostics, is
// different — see buildDiagnosticEngineCards() above — it works off the
// fact-table business-intelligence ctx instead of pickRawEntityRows().
// ------------------------------------------------------------------
const DIAGNOSTIC_VIEWS = [
  { slug: 'revenue-bridge', label: 'Revenue bridge', icon: '🌉' },
  { slug: 'price-impact', label: 'Price-change impact', icon: '💲' },
  { slug: 'cancellations', label: 'Cancellation reasons', icon: '🚪' },
  { slug: 'dynamic-diagnostics', label: 'Dynamic diagnostics', icon: '🧭' },
];

router.get('/diagnostic-insights', attachAdminViewingBanner, async (req, res, next) => {
  const accountId = resolveAccountId(req);
  try {
    const { rows: datasets } = await pool.query(
      `SELECT id, dataset_id, dataset_name, domain, created_at
         FROM uploaded_datasets
        WHERE account_id = $1
        ORDER BY created_at DESC`,
      [accountId]
    );

    if (datasets.length === 0) {
      return res.render('dashboard/diagnostic-insights', {
        title: 'Diagnostic insights',
        active: 'diagnostic-insights',
        datasets: [],
        selectedDataset: null,
        cards: null,
        views: DIAGNOSTIC_VIEWS,
        activeView: null,
        hasAnyData: false,
        dataSource: 'raw',
        rawInfo: null,
      });
    }

    const requestedId = parseInt(req.query.dataset, 10);
    const selectedDataset = datasets.find((d) => d.id === requestedId) || datasets[0];
    const activeView = DIAGNOSTIC_VIEWS.some((v) => v.slug === req.query.view) ? req.query.view : 'revenue-bridge';
    // Round 7: the CMA Canonical Schema opt-in this page used to offer
    // (?source=canonical) is gone — every process in this app now reads
    // directly off the SME owner's own raw uploaded files, auto-detecting
    // Transaction/Entitlement/MonetizationConfig columns (pickRawEntityRows()
    // in services/analytics.js — the same guessEntity()/suggestMapping()
    // heuristic Map & Transform itself starts from). The canonical schema
    // stays reserved as a future-dissertation extension — see
    // claude/cma-flow-app-conceptual-framework-audit.md in the project docs.
    const dataSource = 'raw';

    // Routed through the analytics result cache (services/
    // analyticsCache.js) — the 4 non-dynamic tabs on this page (revenue
    // bridge, revenue-by-type, price-change impact, cancellations) used
    // to re-fetch EVERY row of this dataset's uploaded files from
    // Postgres and re-run the full computation on every single page
    // load, regardless of which tab was open — real cost on a large
    // upload, paid again on every click between tabs. A cache hit here
    // costs two small indexed queries instead; a miss costs exactly what
    // this route always did, plus one upsert to save the result for next
    // time. Invalidates itself automatically the moment a new file lands
    // on this dataset (see getOrCompute()'s freshness check).
    const diagRaw = await getOrComputeAnalyticsCache(selectedDataset.id, accountId, 'diagnostic-raw', async () => {
      const rawByFileType = await getRawRecordsByFileType(accountId, selectedDataset.id);
      const txnPick = pickRawEntityRows(rawByFileType, 'Transaction');
      const entPick = pickRawEntityRows(rawByFileType, 'Entitlement');
      const monPick = pickRawEntityRows(rawByFileType, 'MonetizationConfig');
      const cleanTxns = txnPick.rows.filter((t) => t.amount !== null && !Number.isNaN(Number(t.amount)) && t.customer_id);
      const transactionRows = cleanTxns;
      const entitlementRows = entPick.rows;
      const monetizationRows = monPick.rows;
      const computedHasAnyData = cleanTxns.length > 0 || entPick.rows.length > 0 || monPick.rows.length > 0;
      const computedRawInfo = {
        hasTransactionSignal: cleanTxns.length > 0,
        sourceFileLabel: txnPick.fileType ? humanizeFileType(txnPick.fileType) : null,
        skippedRows: txnPick.rows.length - cleanTxns.length,
      };

      if (!computedHasAnyData) {
        return { hasAnyData: false, rawInfo: computedRawInfo, currency: '', bridge: null, byType: null, priceImpacts: [], cancellations: null, coverage: null };
      }

      const computedCurrency = mode(transactionRows.map((t) => t.currency)) || mode(monetizationRows.map((m) => m.currency)) || '';
      return {
        hasAnyData: true,
        rawInfo: computedRawInfo,
        currency: computedCurrency,
        bridge: revenueBridge(transactionRows),
        byType: revenueByTransactionType(transactionRows),
        priceImpacts: combinedPriceChangeImpact(transactionRows, monetizationRows),
        cancellations: cancellationReasonsRanked(entitlementRows),
        coverage: diagnosticCoverage(transactionRows, entitlementRows, monetizationRows),
      };
    });

    let hasAnyData = diagRaw.hasAnyData;
    const rawInfo = diagRaw.rawInfo;

    // The Dynamic diagnostics tab reads the fact-table business-
    // intelligence ctx (services/fullDescriptiveAnalytics.js), not the
    // pickRawEntityRows() picks the other 3 tabs need — so a dataset with
    // no readable Transaction/Entitlement/MonetizationConfig columns
    // (hasAnyData false above) can still have something to show here.
    // Its own "nothing to show" case is handled inline, per-finding, via
    // buildDiagnosticEngineCards()'s honest "Not applicable" shape —
    // matching the Business Metrics tab's own established convention —
    // rather than by this page-level empty-state gate.
    if (activeView === 'dynamic-diagnostics') hasAnyData = true;

    if (!hasAnyData) {
      return res.render('dashboard/diagnostic-insights', {
        title: 'Diagnostic insights',
        active: 'diagnostic-insights',
        datasets,
        selectedDataset,
        cards: null,
        views: DIAGNOSTIC_VIEWS,
        activeView,
        hasAnyData: false,
        dataSource,
        rawInfo,
      });
    }

    const { currency, bridge, byType, priceImpacts, cancellations, coverage } = diagRaw;

    const cards = {};
    cards.coverageKpiRow = [
      renderStatTile({ label: 'Txns with a transaction type', value: `${coverage.txnTypePct.toFixed(1)}%` }),
      renderStatTile({ label: 'Config rows with an effective date', value: `${coverage.effectiveDatePct.toFixed(1)}%` }),
      renderStatTile({ label: 'Entitlements with a cancellation reason', value: `${coverage.cancelReasonPct.toFixed(1)}%` }),
    ];

    if (bridge) {
      cards.bridgeKpiRow = [
        renderStatTile({
          label: 'Net new revenue',
          value: formatCompactMoney(bridge.netNew, currency),
          delta: bridge.netNewPct,
          sublabel: bridge.prevLabel,
        }),
        renderStatTile({
          label: `${bridge.prevLabel} → ${bridge.currLabel}`,
          value: `${formatCompactMoney(bridge.prevTotal, currency)} → ${formatCompactMoney(bridge.currTotal, currency)}`,
        }),
      ];
      cards.bridgeTable = bridge.rows.map((r) => ({
        category: r.category,
        amount: formatMoney(r.amount, currency),
        count: formatCount(r.count),
        isPositive: r.sign > 0,
        isNegative: r.sign < 0,
      }));
    }

    cards.byTypeChart = renderBarChart({
      title: 'Revenue by transaction type',
      subtitle: `Requires the optional transaction_type field — populated for ${coverage.txnTypePct.toFixed(1)}% of this dataset's transactions`,
      items: byType.items,
      currency,
      emptyMessage: 'No transactions in this dataset carry a recognizable transaction-type column yet (e.g. "Type", "Billing Type") — add one to unlock this breakdown.',
    });

    cards.priceImpactTable = priceImpacts.map((i) => ({
      product: i.product,
      effectiveDate: new Date(i.effectiveDate).toLocaleDateString(),
      oldPrice: formatMoney(i.oldPrice, currency),
      newPrice: formatMoney(i.newPrice, currency),
      pricePctChange: i.pricePctChange === null ? '—' : formatPercent(i.pricePctChange),
      revenuePctChange: i.revenuePctChange === null ? '—' : formatPercent(i.revenuePctChange),
      volumePctChange: i.volumePctChange === null ? '—' : formatPercent(i.volumePctChange),
      elasticity: i.elasticity === null ? '—' : i.elasticity.toFixed(2),
      isRevenueUp: i.revenuePctChange !== null && i.revenuePctChange > 0,
      isRevenueDown: i.revenuePctChange !== null && i.revenuePctChange < 0,
      inferred: !!i.inferred,
    }));

    cards.cancellationsChart = renderBarChart({
      title: 'Entitlement cancellations by reason',
      subtitle: `Requires the optional cancellation_reason field — populated for ${coverage.cancelReasonPct.toFixed(1)}% of this dataset's entitlements`,
      items: cancellations.items,
      money: false,
      emptyMessage: 'No entitlements in this dataset carry a recognizable cancellation-reason column yet — add one to unlock this ranking.',
    });

    // Dynamic diagnostics tab — only computed when actually open, same
    // "don't pay for it on every other tab" discipline as the Full
    // Descriptive Analytics tab's own business-intelligence call.
    if (activeView === 'dynamic-diagnostics') {
      const bi = await getOrBuildBusinessIntelligence(accountId, selectedDataset.id);
      cards.diagnostics = buildDiagnosticEngineCards(bi, currency);
      // Business Descriptive Summary — prepended as a pseudo-finding so it
      // renders first, above the 12 diagnostic questions, using the exact
      // same card markup (no separate template branch needed). Only when
      // the tab itself is applicable at all — if bi isn't applicable, the
      // page-level "Not applicable" info-box above the findings list
      // already covers that case for everything on this tab, summary
      // included.
      if (cards.diagnostics.applicable) {
        const summaryCard = buildBusinessSummaryCard(bi, currency);
        if (summaryCard) cards.diagnostics.findings.unshift(summaryCard);
      }
    }

    res.render('dashboard/diagnostic-insights', {
      title: 'Diagnostic insights',
      active: 'diagnostic-insights',
      datasets,
      selectedDataset,
      cards,
      views: DIAGNOSTIC_VIEWS,
      activeView,
      hasAnyData: true,
      bridge,
      dataSource,
      rawInfo,
    });
  } catch (err) {
    next(err);
  }
});

// ------------------------------------------------------------------
// GET /predictive-analytics — Phase 3 of the roadmap: a per-customer
// feature layer (tenure, recency, frequency, monetary) feeding a
// rules-based churn-risk score and lifecycle stage, plus a simple
// linear-trend revenue projection — deliberately explainable, not a
// trained model, so every number traces back to a named rule.
// ------------------------------------------------------------------
const PREDICTIVE_VIEWS = [
  { slug: 'customer-risk', label: 'Customer risk', icon: '🧮' },
  { slug: 'lifecycle', label: 'Lifecycle stages', icon: '🔁' },
  { slug: 'forecast', label: 'Revenue forecast', icon: '📉' },
  { slug: 'what-if', label: 'What-if scenario', icon: '🎛️' },
];

router.get('/predictive-analytics', attachAdminViewingBanner, async (req, res, next) => {
  const accountId = resolveAccountId(req);
  try {
    const { rows: datasets } = await pool.query(
      `SELECT id, dataset_id, dataset_name, domain, created_at
         FROM uploaded_datasets
        WHERE account_id = $1
        ORDER BY created_at DESC`,
      [accountId]
    );

    if (datasets.length === 0) {
      return res.render('dashboard/predictive-analytics', {
        title: 'Predictive analytics',
        active: 'predictive-analytics',
        datasets: [],
        selectedDataset: null,
        cards: null,
        views: PREDICTIVE_VIEWS,
        activeView: null,
        hasAnyData: false,
        dataSource: 'dynamic',
        rawInfo: null,
      });
    }

    const requestedId = parseInt(req.query.dataset, 10);
    const selectedDataset = datasets.find((d) => d.id === requestedId) || datasets[0];
    const activeView = PREDICTIVE_VIEWS.some((v) => v.slug === req.query.view) ? req.query.view : 'customer-risk';
    // Round 7: the CMA Canonical Schema opt-in this page used to offer
    // (?source=canonical) is gone — the two remaining data sources are
    // both raw-native. 'raw' reads Customer/Transaction/Entitlement/
    // MonetizationConfig picked directly off this dataset's own uploaded
    // files (pickRawEntityRows() below); 'dynamic' reads the SAME
    // fact-table business context (services/fullDescriptiveAnalytics.js's
    // buildBusinessContext) Dynamic Diagnostics and the Business Summary
    // already use, so it works even on a dataset with no Customer-shaped
    // file of its own — see services/predictiveAnalyticsDynamic.js's
    // header. 'dynamic' is the default: it's this study's reported
    // pathway (dataset-native, no canonical schema required at all),
    // consistent with the manuscript and with claude/cma-flow-app-
    // conceptual-framework-audit.md in the project docs.
    const dataSource = req.query.source === 'raw' ? 'raw' : 'dynamic';

    let hasAnyData;
    let rawInfo = null;
    let currency = '';
    let features;
    let riskDist;
    let lifecycleDist;
    let trend;
    let forecast;
    let dynBi = null; // { ctx, ... } from buildBusinessContext — only built for dataSource === 'dynamic'
    let dynRiskApplicable = true;
    let dynRiskReason = null;
    let dynForecastApplicable = true;
    let dynForecastReason = null;
    // Only populated for 'raw' — the What-if scenario block below still
    // needs these two arrays for that path.
    let rawWhatIfTransactionRows = [];
    let rawWhatIfMonetizationRows = [];

    if (dataSource === 'dynamic') {
      // Round 19: routed through the in-process ctx cache
      // (getOrBuildBusinessContext) instead of calling buildBusinessContext()
      // directly — this page used to pay the full fact-table/bridge-file
      // row-fetch cost on EVERY load with no caching at all, even though
      // Descriptive/Diagnostic's own business-intelligence cache had
      // already computed the exact same ctx moments earlier on the same
      // dataset. See services/fullDescriptiveAnalytics.js's header comment
      // on getOrBuildBusinessContext for the full reasoning.
      dynBi = await getOrBuildBusinessContext(accountId, selectedDataset.id);
      // Own per-view "Not applicable" handling below (matching Dynamic
      // Diagnostics' established convention) rather than one page-level
      // gate — Revenue forecast and What-if can both still work from a
      // fact table that Customer risk/Lifecycle honestly can't (no
      // customer_id column on it), so a single hasAnyData=false would be
      // wrong here.
      hasAnyData = true;

      if (!dynBi.applicable) {
        dynRiskApplicable = false;
        dynRiskReason = dynBi.reason;
        dynForecastApplicable = false;
        dynForecastReason = dynBi.reason;
        features = [];
        riskDist = [];
        lifecycleDist = [];
        trend = [];
        forecast = null;
      } else {
        const riskResult = buildDynamicCustomerFeatures(dynBi.ctx);
        dynRiskApplicable = riskResult.applicable;
        dynRiskReason = riskResult.reason || null;
        features = riskResult.applicable ? riskResult.features : [];
        riskDist = churnRiskDistribution(features);
        lifecycleDist = lifecycleStageDistribution(features);

        const trendResult = buildDynamicRevenueTrend(dynBi.ctx);
        dynForecastApplicable = trendResult.applicable;
        dynForecastReason = trendResult.reason || null;
        trend = trendResult.trend;
        forecast = trendResult.applicable ? revenueForecast(trend) : null;
      }
    } else {
      // Routed through the analytics result cache's in-process variant —
      // this branch used to re-fetch every row of the dataset's uploaded
      // files and rebuild customer features (an O(rows) aggregation) on
      // EVERY load of this page, for ANY tab, even lifecycle/forecast
      // which don't need the raw rows themselves, just these derived
      // results. The in-process variant (not the Postgres-backed one
      // Diagnostic/Prescriptive use just below/above) because this
      // bundle is one object per CUSTOMER — on a large customer base
      // that can run several MB, and round-tripping that much JSON
      // through Postgres on every "hit" would undercut the point; see
      // services/analyticsCache.js's header on getOrComputeInProcess.
      const predRaw = await getOrComputeAnalyticsCacheInProcess(selectedDataset.id, accountId, 'predictive-raw', async () => {
        const rawByFileType = await getRawRecordsByFileType(accountId, selectedDataset.id);
        const custPick = pickRawEntityRows(rawByFileType, 'Customer');
        const txnPick = pickRawEntityRows(rawByFileType, 'Transaction');
        const entPick = pickRawEntityRows(rawByFileType, 'Entitlement');
        const cleanCust = custPick.rows.filter((c) => c.customer_id);
        const cleanTxns = txnPick.rows.filter((t) => t.amount !== null && !Number.isNaN(Number(t.amount)) && t.customer_id);
        const customerRows = cleanCust;
        const transactionRows = cleanTxns;
        const entitlementRows = entPick.rows;
        const computedHasAnyData = cleanCust.length > 0;
        const computedRawInfo = {
          hasTransactionSignal: cleanCust.length > 0,
          sourceFileLabel: custPick.fileType ? humanizeFileType(custPick.fileType) : null,
          skippedRows: custPick.rows.length - cleanCust.length,
        };

        if (!computedHasAnyData) {
          return { hasAnyData: false, rawInfo: computedRawInfo, currency: '', features: [], riskDist: [], lifecycleDist: [], trend: [], forecast: null };
        }

        const computedCurrency = mode(transactionRows.map((t) => t.currency)) || '';
        const computedFeatures = buildCustomerFeatures(customerRows, transactionRows, entitlementRows);
        const computedTrend = revenueTrend(transactionRows);
        return {
          hasAnyData: true,
          rawInfo: computedRawInfo,
          currency: computedCurrency,
          features: computedFeatures,
          riskDist: churnRiskDistribution(computedFeatures),
          lifecycleDist: lifecycleStageDistribution(computedFeatures),
          trend: computedTrend,
          forecast: revenueForecast(computedTrend),
        };
      });

      hasAnyData = predRaw.hasAnyData;
      rawInfo = predRaw.rawInfo;

      if (!hasAnyData) {
        return res.render('dashboard/predictive-analytics', {
          title: 'Predictive analytics',
          active: 'predictive-analytics',
          datasets,
          selectedDataset,
          cards: null,
          views: PREDICTIVE_VIEWS,
          activeView,
          hasAnyData: false,
          dataSource,
          rawInfo,
        });
      }

      currency = predRaw.currency;
      features = predRaw.features;
      riskDist = predRaw.riskDist;
      lifecycleDist = predRaw.lifecycleDist;
      trend = predRaw.trend;
      forecast = predRaw.forecast;

      // What-if scenario needs the actual raw transaction/monetization-
      // config rows, not the cached aggregates above — fetched on its
      // own, only when that tab is actually open (same "pay for it only
      // when open" discipline as delivery-delay-risk/review-score-
      // outlook below), rather than unconditionally on every load of
      // this page the way the pre-cache version of this route did.
      if (activeView === 'what-if') {
        const whatIfByFileType = await getRawRecordsByFileType(accountId, selectedDataset.id);
        rawWhatIfTransactionRows = pickRawEntityRows(whatIfByFileType, 'Transaction').rows
          .filter((t) => t.amount !== null && !Number.isNaN(Number(t.amount)) && t.customer_id);
        rawWhatIfMonetizationRows = pickRawEntityRows(whatIfByFileType, 'MonetizationConfig').rows;
      }
    }

    const cards = {};
    cards.dynRiskApplicable = dynRiskApplicable;
    cards.dynRiskReason = dynRiskReason;
    cards.dynForecastApplicable = dynForecastApplicable;
    cards.dynForecastReason = dynForecastReason;

    // Round 20 — delivery-delay risk (folded into the Customer risk tab)
    // and review-score outlook (folded into the Lifecycle tab), both
    // Dynamic-source-only (see services/predictiveAnalyticsDynamic.js's
    // header on each) and only computed when their own tab is open,
    // matching the What-if scenario's existing "only computed when this
    // tab is open" convention below.
    cards.deliveryDelayRisk = null;
    cards.deliveryDelayRiskKpiRow = [];
    cards.reviewScoreOutlook = null;
    cards.reviewScoreOutlookKpiRow = [];
    if (dataSource === 'dynamic' && dynBi && dynBi.applicable) {
      if (activeView === 'customer-risk') {
        cards.deliveryDelayRisk = buildDeliveryDelayRisk(dynBi.ctx);
        if (cards.deliveryDelayRisk.applicable) {
          cards.deliveryDelayRiskKpiRow = [
            renderStatTile({ label: 'Overall late rate', value: cards.deliveryDelayRisk.overallRatePct === null ? '—' : `${cards.deliveryDelayRisk.overallRatePct.toFixed(1)}%` }),
            renderStatTile({ label: 'Rows assessed', value: formatCount(cards.deliveryDelayRisk.sampleSize) }),
          ];
        }
      } else if (activeView === 'lifecycle') {
        cards.reviewScoreOutlook = buildReviewScoreOutlook(dynBi.ctx);
        if (cards.reviewScoreOutlook.applicable) {
          cards.reviewScoreOutlookKpiRow = [
            renderStatTile({ label: 'Overall avg. review score', value: cards.reviewScoreOutlook.overallAvg.toFixed(2) }),
            renderStatTile({ label: 'Rated rows', value: formatCount(cards.reviewScoreOutlook.sampleSize) }),
          ];
        }
      }
    }
    cards.riskKpiRow = [
      renderStatTile({ label: 'High risk', value: formatCount(features.filter((f) => f.churnRiskBand === 'High').length) }),
      renderStatTile({ label: 'Medium risk', value: formatCount(features.filter((f) => f.churnRiskBand === 'Medium').length) }),
      renderStatTile({ label: 'Low risk', value: formatCount(features.filter((f) => f.churnRiskBand === 'Low').length) }),
      renderStatTile({ label: 'Already churned', value: formatCount(features.filter((f) => f.churnRiskBand === 'Churned').length) }),
    ];
    // Recency cutoffs are dataset-relative (see predictiveAnalytics.js) —
    // every scored customer carries the same thresholds object, so read it
    // off the first one to label the chart with what "quiet too long"
    // actually means for THIS account rather than implying a universal rule.
    const thresholdInfo = features.length ? features[0].recencyThresholds : null;
    const thresholdLabel = thresholdInfo
      ? (thresholdInfo.adaptive
        ? `this account's own recency pattern (quiet > ${formatCount(thresholdInfo.medium)}d / > ${formatCount(thresholdInfo.high)}d)`
        : `${formatCount(thresholdInfo.medium)}/${formatCount(thresholdInfo.high)}-day defaults — too few customers yet to fit account-specific cutoffs`)
      : '90/180-day defaults';
    cards.riskChart = renderBarChart({
      title: 'Customers by churn-risk band',
      subtitle: dataSource === 'dynamic'
        ? `Rules-based, computed directly from this fact table's own customer/date${features.length && features[0].monetary !== null ? '/revenue' : ''} columns: recency (against ${thresholdLabel}) and transaction frequency, plus an early-warning point for stretching past a customer's own usual purchase gap — this fact table has no entitlement/auto_renew concept of its own, so "Churned" here always means a customer going silent for 2x+ their own normal purchase gap, never a confirmed cancellation date`
        : `Rules-based: recency (against ${thresholdLabel}), entitlement status, auto_renew, transaction frequency, and an early-warning point for stretching past a customer's own usual purchase gap — plus a churn date read straight from the data, or, when there is none, a customer going silent for 2x+ their own normal purchase gap`,
      items: riskDist,
      money: false,
      emptyMessage: dataSource === 'dynamic' && !dynRiskApplicable
        ? dynRiskReason
        : 'Not enough entitlement/transaction history yet to score churn risk.',
    });
    cards.riskTable = features
      .filter((f) => f.churnRiskBand !== 'Insufficient data')
      // Ties in risk score are broken by revenue at stake — a high-value
      // customer at the same risk level as a low-value one is the one
      // worth calling first.
      .sort((a, b) => (b.churnRiskScore || 0) - (a.churnRiskScore || 0) || b.monetary - a.monetary)
      .slice(0, 25)
      .map((f) => {
        let basis = 'Risk score';
        if (f.churnRiskBand === 'Churned') {
          basis = f.churnInferred
            ? `Inferred — silent ${formatCount(f.recencyDays)}d vs ~${formatCount(f.cadenceIntervalDays)}d usual gap`
            : 'Churn date on record';
        } else if (f.cadenceStretch) {
          basis = 'Risk score — incl. stretching past usual purchase gap';
        }
        return {
          name: f.name,
          tenureDays: f.tenureDays === null ? '—' : formatCount(f.tenureDays),
          recencyDays: f.recencyDays === null ? '—' : formatCount(f.recencyDays),
          frequency: formatCount(f.frequency),
          monetary: formatMoney(f.monetary, currency),
          band: f.churnRiskBand,
          basis,
          basisInferred: !!f.churnInferred,
          highValue: !!f.highValue,
        };
      });

    cards.lifecycleChart = renderBarChart({
      title: 'Customers by lifecycle stage',
      items: lifecycleDist,
      money: false,
      emptyMessage: dataSource === 'dynamic' && !dynRiskApplicable
        ? dynRiskReason
        : 'No Entitlement/Transaction data yet to classify lifecycle stage.',
    });

    cards.trend = renderTrendChart({ title: 'Revenue trend (history used for the forecast)', points: trend, currency });
    cards.forecastAvailable = !!forecast;
    cards.forecastNotApplicableReason = dataSource === 'dynamic' && !dynForecastApplicable ? dynForecastReason : null;
    if (forecast) {
      cards.forecastKpiRow = [
        renderStatTile({ label: 'Basis', value: `${forecast.historyMonths} months of history` }),
        renderStatTile({ label: 'Avg monthly growth', value: formatPercent(forecast.growthRatePct) }),
        renderStatTile({ label: `Projected ${forecast.projections[0].label}`, value: formatCompactMoney(forecast.projections[0].value, currency) }),
        renderStatTile({ label: 'Trend fit (R²)', value: forecast.r2 === null ? '—' : forecast.r2.toFixed(2) }),
      ];
      // Cross-check columns: Holt's-linear-smoothing (needs one more month
      // than the OLS line) and, since Round 20, Holt-Winters/ETS (needs
      // >=24 months — see services/predictiveAnalytics.js's header) each
      // show alongside the primary OLS projection when they have enough
      // history to run, plus an 80% prediction-interval range on the
      // primary method — see reliabilityNote for the plain-language read
      // of how much the methods agree and what the backtest found.
      cards.forecastTable = forecast.projections.map((p, i) => ({
        label: p.label,
        value: formatMoney(p.value, currency),
        interval: (p.intervalLow !== null && p.intervalHigh !== null) ? `${formatMoney(p.intervalLow, currency)} – ${formatMoney(p.intervalHigh, currency)}` : null,
        crossCheck: forecast.crossCheck ? formatMoney(forecast.crossCheck.projections[i].value, currency) : null,
        holtWinters: forecast.holtWinters ? formatMoney(forecast.holtWinters.projections[i].value, currency) : null,
      }));
      cards.forecastHasCrossCheck = !!forecast.crossCheck;
      cards.forecastHasHoltWinters = !!forecast.holtWinters;
      cards.forecastReliabilityNote = forecast.reliabilityNote;
      // Backtested MAE/RMSE/MAPE — a real out-of-sample accuracy table,
      // one row per method that had enough training history to backtest.
      if (forecast.validation && forecast.validation.holdoutSize > 0) {
        const v = forecast.validation;
        const rows = [];
        if (v.ols) rows.push({ method: 'Linear trend (OLS)', ...v.ols });
        if (v.holt) rows.push({ method: "Holt's linear", ...v.holt });
        if (v.holtWinters) rows.push({ method: 'Holt-Winters/ETS', ...v.holtWinters });
        cards.forecastValidationTable = rows;
        cards.forecastValidationHoldout = v.holdoutSize;
        // MAPE excludes any held-out month whose actual value is too
        // small (near-zero) relative to this dataset's own training-
        // window scale — see accuracyMetrics()'s own comment on why
        // (MAPE is a textbook-unstable statistic near zero). Disclosed
        // here rather than silently showing a missing/odd-looking number.
        cards.forecastValidationExcludedNote = rows.some((r) => r.excludedFromMape > 0)
          ? "MAPE excludes month(s) with a near-zero actual revenue value in this dataset's held-out window (dividing by a near-zero number produces a meaningless percentage) — MAE/RMSE above still cover every held-out month."
          : null;
      } else {
        cards.forecastValidationTable = null;
      }
    }

    // --- What-if scenario (price change) — only computed when this tab is
    // open, same "don't pay for it on other tabs" discipline as raw-mode
    // revenue growth. Canonical/raw reuses combinedPriceChangeImpact()'s
    // own elasticity read via services/predictiveAnalytics.js; dynamic
    // reuses services/predictiveAnalyticsDynamic.js's fact-table-native
    // equivalent — same "confirmed > inferred > assumed-flat" ladder,
    // minus the "confirmed" rung a raw fact table has no MonetizationConfig
    // to confirm against. Either way this is grounded in the SAME numbers
    // the rest of the page already shows for this dataset, never a
    // re-derived one.
    let whatIfProduct = null;
    let whatIfPricePct = null;
    cards.whatIfIsDynamic = dataSource === 'dynamic';
    if (activeView === 'what-if') {
      whatIfPricePct = req.query.pricePct !== undefined && req.query.pricePct !== '' ? req.query.pricePct : '10';

      if (dataSource === 'dynamic') {
        if (!dynBi.applicable) {
          cards.whatIfProducts = [];
          cards.whatIfNotApplicableReason = dynBi.reason;
        } else {
          const groups = listDynamicWhatIfGroups(dynBi.ctx);
          whatIfProduct = groups.includes(req.query.product) ? req.query.product : (groups[0] || null);
          cards.whatIfProducts = groups;
          cards.whatIfSelectedProduct = whatIfProduct;
          cards.whatIfPricePctInput = whatIfPricePct;
          cards.whatIfGroupLabel = 'Category';

          const impacts = inferPriceElasticityFromFactTable(dynBi.ctx);
          if (impacts.applicable && impacts.groupLabel) cards.whatIfGroupLabel = impacts.groupLabel;
          if (!impacts.applicable) {
            cards.whatIfNotApplicableReason = impacts.reason;
          } else if (whatIfProduct) {
            const scenario = buildDynamicPriceWhatIfScenario(dynBi.ctx, impacts.results, {
              group: whatIfProduct, pricePctChange: whatIfPricePct,
            });
            cards.whatIfAvailable = scenario.available;
            if (scenario.available) {
              cards.whatIfGroupLabel = scenario.groupLabel;
              const groupNoun = scenario.groupLabel === 'All products/services' ? 'this dataset' : `this ${scenario.groupLabel.toLowerCase()}`;
              const otherGroupsNoun = scenario.groupLabel === 'All products/services' ? 'group' : scenario.groupLabel.toLowerCase();
              const elasticityLabel = {
                'group-inferred': `${groupNoun === 'this dataset' ? 'This dataset\'s' : `${groupNoun}'s`} own price shift, inferred directly from this dataset's transaction history (elasticity ${scenario.elasticity.toFixed(2)}).`,
                'dataset-average': `No detected price change for ${groupNoun} yet — using this dataset's average elasticity across ${scenario.elasticitySampleSize} other ${otherGroupsNoun}${scenario.elasticitySampleSize === 1 ? '' : 's'} (${scenario.elasticity.toFixed(2)}).`,
                'assumed-flat': 'No price-change evidence exists anywhere in this dataset yet — assuming volume holds flat (price change flows straight through to revenue).',
              }[scenario.elasticitySource];

              const notes = [];
              if (scenario.revenueIsEstimatedOccupancy) {
                notes.push(`Estimated Revenue: this dataset has no dedicated revenue field — figures reflect ${scenario.availabilityColumnName ? `booked nights/slots per "${scenario.availabilityColumnName}"` : 'booked rows only'} priced at the listed rate, not observed transaction amounts.`);
              } else if (scenario.revenueIsFallback) {
                notes.push('No dedicated revenue/amount column was found, so this fact table\'s listed price is used as the revenue figure.');
              }

              cards.whatIf = {
                baselineMonthLabel: scenario.baselineMonthLabel,
                pricePctChange: scenario.pricePctChange,
                elasticityLabel: [elasticityLabel, ...notes].join(' '),
                elasticityAssumed: scenario.elasticitySource === 'assumed-flat',
                revenueIsEstimatedOccupancy: scenario.revenueIsEstimatedOccupancy,
                catalogPrice: scenario.catalogPrice ? {
                  price: formatMoney(scenario.catalogPrice.avgPrice, currency),
                  sourceLabel: scenario.catalogPrice.sourceLabel,
                  scopedToGroup: scenario.catalogPrice.scopedToGroup,
                  empiricalPrice: scenario.baseline.empiricalUnitPrice === null ? '—' : formatMoney(scenario.baseline.empiricalUnitPrice, currency),
                } : null,
                kpiRow: [
                  renderStatTile({ label: 'Baseline revenue', value: formatCompactMoney(scenario.baseline.revenue, currency) }),
                  renderStatTile({ label: 'Scenario revenue', value: formatCompactMoney(scenario.scenario.revenue, currency), delta: scenario.revenueDeltaPct, sublabel: 'baseline' }),
                  renderStatTile({ label: 'Revenue impact', value: `${scenario.revenueDelta >= 0 ? '+' : ''}${formatCompactMoney(scenario.revenueDelta, currency)}` }),
                ],
                table: [
                  {
                    metric: scenario.catalogPrice ? 'Price (catalog/listed)' : 'Price',
                    baseline: scenario.baseline.unitPrice === null ? '—' : formatMoney(scenario.baseline.unitPrice, currency),
                    scenario: scenario.scenario.unitPrice === null ? '—' : formatMoney(scenario.scenario.unitPrice, currency),
                    change: formatPercent(scenario.pricePctChange),
                  },
                  {
                    metric: 'Volume (units)',
                    baseline: formatCount(scenario.baseline.volume),
                    scenario: formatCount(Math.round(scenario.scenario.volume)),
                    change: formatPercent(scenario.volumePctChange),
                  },
                  {
                    metric: scenario.revenueIsEstimatedOccupancy ? 'Estimated Revenue' : 'Revenue',
                    baseline: formatMoney(scenario.baseline.revenue, currency),
                    scenario: formatMoney(scenario.scenario.revenue, currency),
                    change: scenario.revenueDeltaPct === null ? '—' : formatPercent(scenario.revenueDeltaPct),
                  },
                ],
              };
            } else {
              cards.whatIfReason = scenario.reason;
            }
          }
        }
      } else {
        const products = listWhatIfProducts(rawWhatIfTransactionRows);
        whatIfProduct = products.includes(req.query.product) ? req.query.product : (products[0] || null);

        cards.whatIfProducts = products;
        cards.whatIfSelectedProduct = whatIfProduct;
        cards.whatIfPricePctInput = whatIfPricePct;
        cards.whatIfGroupLabel = 'Product';

        if (whatIfProduct) {
          const scenario = buildPriceWhatIfScenario(rawWhatIfTransactionRows, rawWhatIfMonetizationRows, {
            product: whatIfProduct, pricePctChange: whatIfPricePct,
          });
          cards.whatIfAvailable = scenario.available;
          if (scenario.available) {
            const elasticityLabel = {
              'product-configured': `This product's own detected price-change elasticity (${scenario.elasticity.toFixed(2)}).`,
              'product-inferred': `This product's own price shift, inferred from its transaction history (elasticity ${scenario.elasticity.toFixed(2)}).`,
              'dataset-average': `No price-change history for this product yet — using this dataset's average elasticity across ${scenario.elasticitySampleSize} other product(s) (${scenario.elasticity.toFixed(2)}).`,
              'assumed-flat': 'No price-change evidence exists anywhere in this dataset yet — assuming volume holds flat (price change flows straight through to revenue).',
            }[scenario.elasticitySource];

            cards.whatIf = {
              baselineMonthLabel: scenario.baselineMonthLabel,
              pricePctChange: scenario.pricePctChange,
              elasticityLabel,
              elasticityAssumed: scenario.elasticitySource === 'assumed-flat',
              kpiRow: [
                renderStatTile({ label: 'Baseline revenue', value: formatCompactMoney(scenario.baseline.revenue, currency) }),
                renderStatTile({ label: 'Scenario revenue', value: formatCompactMoney(scenario.scenario.revenue, currency), delta: scenario.revenueDeltaPct, sublabel: 'baseline' }),
                renderStatTile({ label: 'Revenue impact', value: `${scenario.revenueDelta >= 0 ? '+' : ''}${formatCompactMoney(scenario.revenueDelta, currency)}` }),
              ],
              table: [
                {
                  metric: 'Price',
                  baseline: scenario.baseline.unitPrice === null ? '—' : formatMoney(scenario.baseline.unitPrice, currency),
                  scenario: scenario.scenario.unitPrice === null ? '—' : formatMoney(scenario.scenario.unitPrice, currency),
                  change: formatPercent(scenario.pricePctChange),
                },
                {
                  metric: 'Volume (units)',
                  baseline: formatCount(scenario.baseline.volume),
                  scenario: formatCount(Math.round(scenario.scenario.volume)),
                  change: formatPercent(scenario.volumePctChange),
                },
                {
                  metric: 'Revenue',
                  baseline: formatMoney(scenario.baseline.revenue, currency),
                  scenario: formatMoney(scenario.scenario.revenue, currency),
                  change: scenario.revenueDeltaPct === null ? '—' : formatPercent(scenario.revenueDeltaPct),
                },
              ],
            };
          } else {
            cards.whatIfReason = scenario.reason;
          }
        }
      }
    }

    res.render('dashboard/predictive-analytics', {
      title: 'Predictive analytics',
      active: 'predictive-analytics',
      datasets,
      selectedDataset,
      cards,
      views: PREDICTIVE_VIEWS,
      activeView,
      hasAnyData: true,
      dataSource,
      rawInfo,
      whatIfProduct,
      whatIfPricePct,
    });
  } catch (err) {
    next(err);
  }
});

// ------------------------------------------------------------------
// GET /prescriptive-recommendations — Phase 4 of the roadmap: reuses
// Descriptive Analytics' own Mechanisms/Reconciliation/Catalog baseline
// plus Diagnostic's price-change read, ranking the four CMA revenue
// models with full reasoning shown for every candidate.
// ------------------------------------------------------------------
const PRESCRIPTIVE_VIEWS = [
  { slug: 'baseline', label: 'Current performance', icon: '📐' },
  { slug: 'elasticity', label: 'Price elasticity', icon: '⚖️' },
  { slug: 'recommendation', label: 'Recommendation', icon: '🧭' },
];

router.get('/prescriptive-recommendations', attachAdminViewingBanner, async (req, res, next) => {
  const accountId = resolveAccountId(req);
  try {
    const { rows: datasets } = await pool.query(
      `SELECT id, dataset_id, dataset_name, domain, created_at
         FROM uploaded_datasets
        WHERE account_id = $1
        ORDER BY created_at DESC`,
      [accountId]
    );

    if (datasets.length === 0) {
      return res.render('dashboard/prescriptive-recommendations', {
        title: 'Prescriptive recommendations',
        active: 'prescriptive-recommendations',
        datasets: [],
        selectedDataset: null,
        cards: null,
        views: PRESCRIPTIVE_VIEWS,
        activeView: null,
        hasAnyData: false,
        dataSource: 'dynamic',
        rawInfo: null,
      });
    }

    const requestedId = parseInt(req.query.dataset, 10);
    const selectedDataset = datasets.find((d) => d.id === requestedId) || datasets[0];
    const activeView = PRESCRIPTIVE_VIEWS.some((v) => v.slug === req.query.view) ? req.query.view : 'baseline';
    // Round 14: ported to the newer dataset-native engine generation — see
    // services/prescriptiveEngine.js, built for the user-supplied
    // "Analytics Pipelines" reference document's explicit ask for every
    // recommendation to carry an Evidence -> Recommendation -> Expected
    // KPI -> Confidence structure. 'dynamic' (the default, same reasoning
    // as /predictive-analytics) reads the SAME fact-table business-
    // intelligence bundle Dynamic Diagnostics and Dynamic Predictive
    // already use (services/fullDescriptiveAnalytics.js's
    // getOrBuildBusinessIntelligence / buildBusinessContext), so it works
    // even on a dataset with no Customer-shaped file of its own. 'raw'
    // keeps the ORIGINAL Phase-4-roadmap engine (services/
    // prescriptiveAnalytics.js, below) exactly as it behaved before this
    // round — see claude/cma-flow-app-conceptual-framework-audit.md.
    const dataSource = req.query.source === 'raw' ? 'raw' : 'dynamic';

    if (dataSource === 'dynamic') {
      // Round 19: this used to call buildBusinessContext() directly here,
      // completely redundant with the getOrBuildBusinessIntelligence() call
      // right above it — both need the same ctx, so this page paid the
      // full fact-table/bridge-file row-fetch cost TWICE on every single
      // load. Routed through the in-process ctx cache instead
      // (getOrBuildBusinessContext): getOrBuildBusinessIntelligence()
      // already populates that cache internally when it has to do a real
      // rebuild, so this second call is now a cache hit in the common case,
      // and the two together do the expensive work at most once per
      // request instead of twice.
      const bi = await getOrBuildBusinessIntelligence(accountId, selectedDataset.id);
      const built = await getOrBuildBusinessContext(accountId, selectedDataset.id);
      const presc = buildDynamicPrescriptiveRecommendations({ bi, ctx: built.applicable ? built.ctx : null });

      const cards = {};
      cards.dynamicApplicable = presc.applicable;
      cards.dynamicReason = presc.applicable ? null : presc.reason;
      cards.recommendations = presc.applicable ? presc.recommendations.map((r) => ({
        decisionArea: r.decisionArea,
        evidence: r.evidence,
        recommendation: r.recommendation,
        expectedKpi: r.expectedKpi,
        confidencePct: Math.round(r.confidence * 100),
        confidenceBand: r.confidenceBand,
        sourceLabel: r.sourceLabel,
      })) : [];
      cards.dataReadiness = presc.applicable ? presc.dataReadiness : [];

      return res.render('dashboard/prescriptive-recommendations', {
        title: 'Prescriptive recommendations',
        active: 'prescriptive-recommendations',
        datasets,
        selectedDataset,
        cards,
        views: PRESCRIPTIVE_VIEWS,
        activeView,
        hasAnyData: true,
        dataSource,
        rawInfo: null,
      });
    }

    // ---- dataSource === 'raw': original Phase 4 roadmap engine, unchanged
    // behavior from before this round (services/prescriptiveAnalytics.js).
    // Routed through the analytics result cache — this branch used to do
    // TWO separate full row-fetches of the dataset's uploaded files
    // (buildRawRevenueGrowthAnalytics's own internal fetch, plus a second
    // explicit getRawRecordsByFileType call right after it) and rebuild
    // the elasticity/ranking analysis, on every single page load. See
    // services/analyticsCache.js and the matching comment on Diagnostic
    // Insights' raw pathway above.
    const prescRaw = await getOrComputeAnalyticsCache(selectedDataset.id, accountId, 'prescriptive-raw', async () => {
      const rawGrowth = await buildRawRevenueGrowthAnalytics(accountId, selectedDataset.id);
      const computedHasAnyData = !!rawGrowth.hasTransactionSignal;
      const computedRawInfo = {
        hasTransactionSignal: computedHasAnyData,
        sourceFileLabel: rawGrowth.sourceFileType ? humanizeFileType(rawGrowth.sourceFileType) : null,
        skippedRows: computedHasAnyData ? rawGrowth.rowCounts.skippedRows : 0,
      };

      if (!computedHasAnyData) {
        return { hasAnyData: false, rawInfo: computedRawInfo, mechanismTable: [], totalRevenue: 0, currency: '', candidates: [], reconciliationNote: null, elasticityAvailable: false, elasticity: null };
      }

      const rawByFileType = await getRawRecordsByFileType(accountId, selectedDataset.id);
      const transactionRows = pickRawEntityRows(rawByFileType, 'Transaction').rows
        .filter((t) => t.amount !== null && !Number.isNaN(Number(t.amount)) && t.customer_id);
      const monetizationRows = pickRawEntityRows(rawByFileType, 'MonetizationConfig').rows;

      const elasticity = elasticitySummary(transactionRows, monetizationRows);
      const { candidates, reconciliationNote } = rankConfigurationRecommendations({
        mechanismTable: rawGrowth.mechanismTable, reconciliation: null, elasticity, catalog: null,
      });

      return {
        hasAnyData: true,
        rawInfo: computedRawInfo,
        mechanismTable: rawGrowth.mechanismTable,
        totalRevenue: rawGrowth.totalRevenue,
        currency: rawGrowth.currency,
        candidates,
        reconciliationNote,
        elasticity,
      };
    });

    const hasAnyData = prescRaw.hasAnyData;
    const rawInfo = prescRaw.rawInfo;

    if (!hasAnyData) {
      return res.render('dashboard/prescriptive-recommendations', {
        title: 'Prescriptive recommendations',
        active: 'prescriptive-recommendations',
        datasets,
        selectedDataset,
        cards: null,
        views: PRESCRIPTIVE_VIEWS,
        activeView,
        hasAnyData: false,
        dataSource,
        rawInfo,
      });
    }

    const {
      mechanismTable, totalRevenue, currency, candidates, reconciliationNote, elasticity,
    } = prescRaw;
    const reconciliation = null;

    const cards = {};
    cards.baselineKpiRow = [
      renderStatTile({ label: 'Total revenue (this dataset)', value: formatCompactMoney(totalRevenue, currency) }),
      renderStatTile({ label: 'Leading mechanism', value: mechanismTable[0] ? mechanismTable[0].label : 'None yet' }),
    ];
    cards.mechanismTable = mechanismTable.map((m) => ({
      label: m.label, revenue: formatMoney(m.revenue, currency), count: formatCount(m.count), pctOfTotal: `${m.pctOfTotal.toFixed(1)}%`,
    }));
    cards.reconciliationNote = reconciliationNote;
    if (reconciliation) {
      cards.reconciliationKpiRow = [
        renderStatTile({ label: 'Expected revenue', value: formatCompactMoney(reconciliation.expectedRevenue, currency) }),
        renderStatTile({ label: 'Actual revenue', value: formatCompactMoney(reconciliation.actualRevenue, currency) }),
        renderStatTile({
          label: 'Variance', value: formatCompactMoney(reconciliation.variance, currency), delta: reconciliation.variancePct, sublabel: 'expected',
        }),
      ];
    }

    cards.elasticityAvailable = elasticity.available;
    if (elasticity.available) {
      cards.elasticityKpiRow = [
        renderStatTile({ label: 'Average elasticity', value: elasticity.avgElasticity.toFixed(2) }),
        renderStatTile({ label: 'Demand looks', value: elasticity.isElastic ? 'Elastic (volume-sensitive)' : 'Inelastic (price-insensitive)' }),
      ];
    }
    cards.elasticityTable = elasticity.impacts.map((i) => ({
      product: i.product,
      effectiveDate: new Date(i.effectiveDate).toLocaleDateString(),
      oldPrice: formatMoney(i.oldPrice, currency),
      newPrice: formatMoney(i.newPrice, currency),
      volumePctChange: i.volumePctChange === null ? '—' : formatPercent(i.volumePctChange),
      elasticity: i.elasticity === null ? '—' : i.elasticity.toFixed(2),
      inferred: !!i.inferred,
    }));

    cards.candidates = candidates.map((c, idx) => ({
      rank: idx + 1, label: c.label, score: c.score.toFixed(1), reasoning: c.reasoning,
    }));

    res.render('dashboard/prescriptive-recommendations', {
      title: 'Prescriptive recommendations',
      active: 'prescriptive-recommendations',
      datasets,
      selectedDataset,
      cards,
      views: PRESCRIPTIVE_VIEWS,
      activeView,
      hasAnyData: true,
      dataSource,
      rawInfo,
    });
  } catch (err) {
    next(err);
  }
});

// MODEL_TYPES imported from services/monetizationDiscovery.js above —
// the same four-value enum used everywhere in the app.

// ------------------------------------------------------------------
// Import from raw uploaded datasets (Round 7) — aggregates every raw
// file across this account's datasets that content-aware detection
// (pickRawEntityRows('MonetizationConfig') — the same guessEntity()/
// suggestMapping() heuristic Map & Transform itself starts from) picks
// out as pricing-catalog data, into reviewable configuration candidates,
// one per distinct product_service. This never writes anything: it is
// read on the GET /setup-configuration screen so the SME owner can see
// what their raw uploads are offering, and it is recomputed (never
// trusted from the submitted form) inside POST /setup-configuration/
// import so an import always reflects the current raw data, not a stale
// or tampered request. Reads canonical_records nowhere — see
// claude/cma-flow-app-conceptual-framework-audit.md in the project docs.
// ------------------------------------------------------------------
function slugifyGroupKey(label) {
  const slug = String(label || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'unlabeled';
}

async function getMonetizationConfigCandidates(accountId) {
  const { rows: datasets } = await pool.query(
    `SELECT id, dataset_id FROM uploaded_datasets WHERE account_id = $1`,
    [accountId]
  );

  const byProduct = new Map();
  await Promise.all(datasets.map(async (d) => {
    const rawByFileType = await getRawRecordsByFileType(accountId, d.id);
    const pick = pickRawEntityRows(rawByFileType, 'MonetizationConfig');
    if (pick.rows.length === 0) return;
    pick.rows.forEach((row) => {
      const label = String((row || {}).product_service || '').trim() || 'Unlabeled';
      if (!byProduct.has(label)) {
        byProduct.set(label, {
          rowCount: 0, rawModelTypes: new Set(), tiers: new Set(), prices: [], currencies: new Map(), datasetIds: new Set(), fileTypes: new Set(),
        });
      }
      const agg = byProduct.get(label);
      agg.rowCount += 1;
      const modelType = String((row || {}).model_type || '').trim();
      if (modelType) agg.rawModelTypes.add(modelType);
      const tier = String((row || {}).tier || '').trim();
      if (tier) agg.tiers.add(tier);
      if (typeof row.price === 'number' && Number.isFinite(row.price)) agg.prices.push(row.price);
      const currency = String((row || {}).currency || '').trim();
      if (currency) agg.currencies.set(currency, (agg.currencies.get(currency) || 0) + 1);
      agg.datasetIds.add(d.dataset_id);
      if (pick.fileType) agg.fileTypes.add(pick.fileType);
    });
  }));

  const seenKeys = new Map();
  return [...byProduct.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([label, agg]) => {
      const baseKey = slugifyGroupKey(label);
      let key = baseKey;
      if (seenKeys.has(baseKey)) {
        const n = seenKeys.get(baseKey) + 1;
        seenKeys.set(baseKey, n);
        key = `${baseKey}-${n}`;
      } else {
        seenKeys.set(baseKey, 1);
      }

      const rawModelTypes = [...agg.rawModelTypes];
      const suggestedModelType = rawModelTypes.length === 1
        ? guessConfigModelType(rawModelTypes[0])
        : null;
      const prices = agg.prices;
      // Most-frequent currency across this product's picked rows — mirrors
      // SQL MODE() WITHIN GROUP from the canonical version this replaces.
      let bestCurrency = null;
      let bestCount = 0;
      agg.currencies.forEach((count, cur) => {
        if (count > bestCount) { bestCount = count; bestCurrency = cur; }
      });

      return {
        key,
        productService: label,
        rowCount: agg.rowCount,
        rawModelTypes,
        suggestedModelType,
        tierCount: agg.tiers.size,
        minPrice: prices.length ? Math.min(...prices) : null,
        maxPrice: prices.length ? Math.max(...prices) : null,
        avgPrice: prices.length ? prices.reduce((sum, p) => sum + p, 0) / prices.length : null,
        currency: bestCurrency,
        datasetIds: [...agg.datasetIds],
        fileTypes: [...agg.fileTypes],
      };
    });
}

async function getSavedConfigs(accountId) {
  const { rows } = await pool.query(
    `SELECT id, config_name, model_type, details, is_active, created_at
       FROM monetization_configs
      WHERE account_id = $1
      ORDER BY created_at DESC`,
    [accountId]
  );
  return rows;
}

// ------------------------------------------------------------------
// GET /setup-configuration — list + manual-entry form + Import from
// Canonical Schema
// ------------------------------------------------------------------
router.get('/setup-configuration', async (req, res, next) => {
  try {
    const [configs, candidates] = await Promise.all([
      getSavedConfigs(req.session.userId),
      getMonetizationConfigCandidates(req.session.userId),
    ]);
    res.render('dashboard/setup-configuration', {
      title: 'Set-up monetization configuration',
      active: 'setup-monetization-configuration',
      configs,
      candidates,
      modelTypes: MODEL_TYPES,
      errors: [],
      old: {},
    });
  } catch (err) {
    next(err);
  }
});

// ------------------------------------------------------------------
// POST /setup-configuration — create a new monetization configuration
// (manual entry — always available, and the only path for SME owners
// with no raw pricing/catalog data to import from yet)
// ------------------------------------------------------------------
const configValidators = [
  body('config_name').trim().notEmpty().withMessage('Configuration name is required.'),
  body('model_type').isIn(MODEL_TYPES).withMessage('Please choose a valid revenue model.'),
];

router.post('/setup-configuration', configValidators, async (req, res, next) => {
  const result = validationResult(req);
  const accountId = req.session.userId;

  if (!result.isEmpty()) {
    const [configs, candidates] = await Promise.all([
      getSavedConfigs(accountId),
      getMonetizationConfigCandidates(accountId),
    ]);
    return res.status(400).render('dashboard/setup-configuration', {
      title: 'Set-up monetization configuration',
      active: 'setup-monetization-configuration',
      configs,
      candidates,
      modelTypes: MODEL_TYPES,
      errors: result.array(),
      old: req.body,
    });
  }

  const { config_name, model_type } = req.body;
  try {
    await pool.query(
      `INSERT INTO monetization_configs (account_id, config_name, model_type)
       VALUES ($1, $2, $3)`,
      [accountId, config_name, model_type]
    );
    res.redirect('/setup-configuration');
  } catch (err) {
    next(err);
  }
});

// ------------------------------------------------------------------
// POST /setup-configuration/import — confirm selected candidates from
// "Import from raw uploaded datasets" as active monetization configs.
// Candidates are always recomputed server-side from the account's
// current raw uploaded files (never trusted from the submitted form), so
// what gets written is exactly what the SME owner reviewed on screen, and the
// whole batch is rejected atomically if any selected row is invalid —
// no partial import. Nothing here is auto-applied: this route only
// ever runs on an explicit SME-owner submit.
// ------------------------------------------------------------------
router.post('/setup-configuration/import', async (req, res, next) => {
  const accountId = req.session.userId;
  try {
    const candidates = await getMonetizationConfigCandidates(accountId);
    const byKey = new Map(candidates.map((c) => [c.key, c]));

    const selectedKeys = Object.keys(req.body)
      .filter((k) => k.startsWith('select_') && req.body[k] === 'on')
      .map((k) => k.slice('select_'.length));

    const errors = [];
    const toImport = [];

    if (selectedKeys.length === 0) {
      errors.push({ msg: 'Select at least one candidate to import.' });
    }

    selectedKeys.forEach((key) => {
      const candidate = byKey.get(key);
      if (!candidate) {
        errors.push({ msg: 'One of the selected candidates is no longer available — the underlying data may have changed. Please refresh and try again.' });
        return;
      }
      const name = String(req.body[`name_${key}`] || '').trim() || candidate.productService;
      const modelType = req.body[`model_type_${key}`];
      if (!MODEL_TYPES.includes(modelType)) {
        errors.push({ msg: `Choose a valid revenue model for "${name}".` });
        return;
      }
      toImport.push({ candidate, name, modelType });
    });

    if (errors.length > 0) {
      const configs = await getSavedConfigs(accountId);
      return res.status(400).render('dashboard/setup-configuration', {
        title: 'Set-up monetization configuration',
        active: 'setup-monetization-configuration',
        configs,
        candidates,
        modelTypes: MODEL_TYPES,
        errors,
        old: {},
      });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const { candidate, name, modelType } of toImport) {
        const details = {
          // Round 7: candidates are aggregated from raw uploaded files
          // (getMonetizationConfigCandidates() above), never canonical_records.
          // 'canonical_import' is kept recognized by the views below for
          // configs imported by earlier rounds of this app, purely for
          // backward-compatible display of already-saved rows.
          source: 'raw_import',
          product_service: candidate.productService,
          price: { min: candidate.minPrice, max: candidate.maxPrice, avg: candidate.avgPrice },
          currency: candidate.currency,
          tier_count: candidate.tierCount,
          row_count: candidate.rowCount,
          raw_model_types: candidate.rawModelTypes,
          dataset_ids: candidate.datasetIds,
          file_types: candidate.fileTypes,
          imported_at: new Date().toISOString(),
        };
        // eslint-disable-next-line no-await-in-loop
        await client.query(
          `INSERT INTO monetization_configs (account_id, config_name, model_type, details)
           VALUES ($1, $2, $3, $4::jsonb)`,
          [accountId, name, modelType, JSON.stringify(details)]
        );
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    res.redirect('/setup-configuration');
  } catch (err) {
    next(err);
  }
});

// ------------------------------------------------------------------
// POST /setup-configuration/:id/deactivate
// ------------------------------------------------------------------
router.post('/setup-configuration/:id/deactivate', async (req, res, next) => {
  try {
    await pool.query(
      `UPDATE monetization_configs SET is_active = false WHERE id = $1 AND account_id = $2`,
      [req.params.id, req.session.userId]
    );
    res.redirect('/setup-configuration');
  } catch (err) {
    next(err);
  }
});

// ------------------------------------------------------------------
// Upload New Dataset — form + list
// ------------------------------------------------------------------
async function renderUploadForm(req, res, next, { status = 200, errors = [], success = null } = {}) {
  try {
    const accountId = req.session.userId;
    // Also doubles as the self-healing check for the default dataset: a
    // dataset uploaded moments ago on this very page (success path below)
    // becomes the account's default immediately if it didn't have one
    // yet, and a just-deleted default (delete route redirects here) gets
    // re-assigned right away rather than waiting for the next login.
    const { datasets, defaultDatasetId } = await ensureDefaultDataset(accountId);
    const recordCounts = await getRecordCounts(accountId);
    const canonicalStatus = await getCanonicalStatus(accountId);
    const fileManifest = await getFileManifest(accountId);
    res.status(status).render('dashboard/upload-dataset', {
      title: 'Upload New Dataset',
      active: 'upload-new-dataset',
      datasets,
      defaultDatasetId,
      recordCounts,
      canonicalStatus,
      fileManifest,
      humanizeFileType,
      errors,
      success,
    });
  } catch (err) {
    next(err);
  }
}

router.get('/upload-dataset', (req, res, next) => {
  renderUploadForm(req, res, next);
});

const DATASET_ID_RE = /^[A-Za-z0-9_-]{3,50}$/;

// POST /upload-dataset — one Dataset ID per submission, but any number of
// CSV files, each given its own SME-chosen label (see pairFilesWithLabels()
// in middleware/upload.js) — there's no fixed set of "the" file types a
// dataset must have. Files sharing the same label merge into one
// continuous, browsable set (row_index keeps counting up across them). All
// of it ingests inside a single transaction: either the whole dataset
// (every file) commits together, or none of it does.
router.post('/upload-dataset', (req, res, next) => {
  uploadDatasetFiles(req, res, async (uploadErr) => {
    if (uploadErr) {
      discardDatasetUpload(req); // clean up any files staged before the error
      const msg = uploadErr.code === 'LIMIT_FILE_SIZE'
        ? 'One of the files is larger than the 500MB limit per file.'
        : uploadErr.code === 'LIMIT_UNEXPECTED_FILE'
        ? 'Too many files were attached to this dataset at once.'
        : uploadErr.message || 'The files could not be uploaded.';
      return renderUploadForm(req, res, next, { status: 400, errors: [{ msg }] });
    }

    const datasetId = (req.body.dataset_id || '').trim();
    const datasetName = (req.body.dataset_name || '').trim();
    const domain = (req.body.domain || '').trim();
    const accountId = req.session.userId;
    const pairedFiles = pairFilesWithLabels(req);

    const fieldErrors = [];
    if (!DATASET_ID_RE.test(datasetId)) {
      fieldErrors.push('Dataset ID must be 3-50 characters (letters, numbers, - or _ only), e.g. SME_Retail_07.');
    }
    if (!datasetName) fieldErrors.push('Dataset name is required.');
    if (pairedFiles.length === 0) fieldErrors.push('Attach at least one CSV file.');

    if (fieldErrors.length > 0) {
      discardDatasetUpload(req);
      return renderUploadForm(req, res, next, { status: 400, errors: fieldErrors.map((msg) => ({ msg })) });
    }

    // Group the flat paired-file list by the file_type each row resolved
    // to, so several files sharing one label (e.g. several months of
    // "transactions") merge into one continuous, browsable set with
    // row_index counting up across them — the same behavior as before,
    // just keyed by whatever free-form labels the SME owner actually
    // typed instead of a fixed list of four.
    const byType = {};
    pairedFiles.forEach((pf) => {
      byType[pf.fileType] = byType[pf.fileType] || [];
      byType[pf.fileType].push(pf);
    });

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const { rows: inserted } = await client.query(
        `INSERT INTO uploaded_datasets (account_id, dataset_id, dataset_name, domain)
         VALUES ($1, $2, $3, $4) RETURNING id`,
        [accountId, datasetId, datasetName, domain || null]
      );
      const datasetRowId = inserted[0].id;
      const rowSummary = {};

      for (const [fileType, group] of Object.entries(byType)) {
        let runningRowCount = 0;
        // Accumulated across every physical file sharing this label (see
        // the merge behavior described above insertDatasetRecords calls)
        // so profiling below runs once over the FULL merged set, not once
        // per physical file — a profile is meant to describe the whole
        // "Transactions" file type, not just whichever CSV happened to be
        // picked last. Built with concat(), not push(...rows) — spreading
        // a 200,000-element array into push()'s arguments blows V8's
        // call-stack argument limit long before that (see the same
        // reasoning behind arrMin/arrMax in services/datasetProfiler.js).
        let allRowsForType = [];

        for (const { file, label } of group) {
          let parsedRows;
          try {
            parsedRows = parseCsvFile(file.path);
          } catch (parseErr) {
            throw Object.assign(
              new Error(`${file.originalname} (${label}) could not be read as a CSV file (${parseErr.message}).`),
              { isParseError: true }
            );
          }

          const storedPath = path.join(
            'uploads', 'datasets', String(accountId), sanitizeDatasetId(datasetId), fileType, file.filename
          );
          const { rows: fileRows } = await client.query(
            `INSERT INTO dataset_files (dataset_id, account_id, file_type, original_name, stored_path, row_count)
             VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
            [datasetRowId, accountId, fileType, file.originalname, storedPath, parsedRows.length]
          );
          const sourceFileId = fileRows[0].id;

          if (parsedRows.length > 0) {
            await insertDatasetRecords(client, {
              datasetRowId, accountId, fileType, rows: parsedRows,
              sourceFileId, startRowIndex: runningRowCount,
            });
            allRowsForType = allRowsForType.concat(parsedRows);
          }
          runningRowCount += parsedRows.length;
        }

        rowSummary[fileType] = { files: group.length, rows: runningRowCount };

        // Profile -> Validate -> ... -> Generate Descriptive Analytics:
        // run the Full Descriptive Analytics profiler (services/
        // datasetProfiler.js) right here, on the rows already in memory,
        // rather than waiting for the tab to be opened — see claude/
        // full-descriptive-analytics.md. Never allowed to fail the
        // upload itself: if profiling throws for any reason, the raw
        // ingest above (the part the SME owner actually asked for) has
        // already succeeded, so this is logged and swallowed rather than
        // rolling back a perfectly good upload over an analytics bug —
        // getOrBuildFullProfile() will simply compute it lazily (from
        // dataset_records) the first time the tab is opened instead.
        if (allRowsForType.length > 0) {
          try {
            await upsertFileProfile(client, {
              datasetRowId, accountId, fileType, rows: allRowsForType,
            });
          } catch (profileErr) {
            console.error(`Full Descriptive Analytics profiling failed for dataset ${datasetId} / ${fileType}:`, profileErr);
          }
        }
      }

      await client.query('COMMIT');
      // Only now — after the database write is confirmed durable — do the
      // raw files move out of the temp folder and into their permanent home.
      finalizeDatasetUpload(req, accountId, datasetId, pairedFiles);

      const summaryParts = Object.entries(rowSummary).map(([fileType, s]) => (
        `${humanizeFileType(fileType)} (${s.files} file${s.files === 1 ? '' : 's'}, ${s.rows.toLocaleString()} rows)`
      ));
      return renderUploadForm(req, res, next, {
        success: `"${datasetName}" (${datasetId}) uploaded: ${summaryParts.join(', ')}.`,
      });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      discardDatasetUpload(req); // temp files only — never touches another dataset's files

      if (err.code === '23505') {
        return renderUploadForm(req, res, next, {
          status: 400,
          errors: [{ msg: `Dataset ID "${datasetId}" is already used for this account — choose another.` }],
        });
      }
      if (err.isParseError) {
        return renderUploadForm(req, res, next, { status: 400, errors: [{ msg: err.message }] });
      }
      next(err);
    } finally {
      client.release();
    }
  });
});

// POST /upload-dataset/:id/delete — permanently removes one uploaded
// dataset. The DB row is the source of truth: deleting it cascades (see
// ON DELETE CASCADE in db/schema.sql) to dataset_files, dataset_records,
// dataset_mappings, canonical_records, and monetization_classifications,
// so nothing derived from this dataset is left orphaned. The raw CSVs on
// disk (uploads/datasets/<accountId>/<sanitized dataset id>/...) are a
// separate, best-effort cleanup afterward — a leftover folder there is
// harmless, so a filesystem error never blocks or rolls back the delete.
router.post('/upload-dataset/:id/delete', async (req, res, next) => {
  try {
    const accountId = req.session.userId;
    const { rows } = await pool.query(
      `SELECT id, dataset_id FROM uploaded_datasets WHERE id = $1 AND account_id = $2`,
      [req.params.id, accountId]
    );
    const dataset = rows[0];
    if (!dataset) return res.status(404).render('errors/404', { title: 'Not found', layout: false });

    await pool.query(`DELETE FROM uploaded_datasets WHERE id = $1 AND account_id = $2`, [dataset.id, accountId]);

    const datasetDir = path.join(DATASETS_ROOT, String(accountId), sanitizeDatasetId(dataset.dataset_id));
    fs.rm(datasetDir, { recursive: true, force: true }, () => {});

    res.redirect('/upload-dataset');
  } catch (err) {
    next(err);
  }
});

// ------------------------------------------------------------------
// Browse Dataset — pick a dataset + file, then filter/page its rows.
// Every uploaded file is browsable here regardless of how many there are
// or what label the SME owner gave it — there's no fixed list of "the"
// file types to check against, only whatever actually has ingested rows.
// ------------------------------------------------------------------
router.get('/browse-dataset', async (req, res, next) => {
  try {
    const { rows: datasets } = await pool.query(
      `SELECT id, dataset_id, dataset_name, domain
         FROM uploaded_datasets
        WHERE account_id = $1
        ORDER BY created_at DESC`,
      [req.session.userId]
    );
    const [recordCounts, fieldSummaries] = await Promise.all([
      getRecordCounts(req.session.userId),
      getDatasetFieldSummaries(req.session.userId),
    ]);
    res.render('dashboard/browse-dataset-picker', {
      title: 'Browse Dataset',
      active: 'browse-dataset',
      datasets,
      recordCounts,
      fieldSummaries,
      humanizeFileType,
    });
  } catch (err) {
    next(err);
  }
});

// Registered BEFORE the generic /browse-dataset/:id/:fileType route just
// below — both are two-segment paths, and Express matches by
// registration order, not specificity, so this dataset-level route would
// otherwise never be reached (":fileType" would greedily capture the
// literal "report-catalog" segment first, and 404 since no file has that
// type). The Evaluation Report routes don't have this problem: they're
// three-segment paths that :id/:fileType's two-segment pattern can never
// match in the first place.
router.get('/browse-dataset/:id/report-catalog', async (req, res, next) => {
  try {
    const { id } = req.params;
    const { rows } = await pool.query(
      `SELECT id, dataset_id, dataset_name, domain
         FROM uploaded_datasets
        WHERE id = $1 AND account_id = $2`,
      [id, req.session.userId]
    );
    const dataset = rows[0];
    if (!dataset) {
      return res.status(404).render('errors/404', { title: 'Not found', layout: false });
    }

    const rawByFileType = await getRawRecordsByFileType(req.session.userId, id);
    const analysis = buildReportCatalogAnalysis(rawByFileType);
    const currency = null; // raw, pre-Map-&-Transform data has no confirmed currency yet
    const { categorized, categoryOrder } = buildReportCatalogCards(analysis, currency);
    const summaryKpiRow = [
      renderStatTile({ label: 'Reports unlocked', value: `${analysis.enabled.length} of 30` }),
      renderStatTile({ label: 'One field away', value: `${analysis.nearMiss.length} report${analysis.nearMiss.length === 1 ? '' : 's'}` }),
    ].join('');

    res.render('dashboard/report-catalog', {
      title: `Report Catalog — ${dataset.dataset_name}`,
      active: 'browse-dataset',
      dataset,
      analysis,
      categorized,
      categoryOrder,
      summaryKpiRow,
      CANONICAL_ROLES,
      humanizeFileType,
    });
  } catch (err) {
    next(err);
  }
});

// GET /browse-dataset/:id/erd — Entity-Relationship Diagram for one
// dataset, dynamic per :id the same way report-catalog above is:
// selecting a different dataset from Browse Dataset just visits a
// different :id, no extra state to track. Reuses the exact same cached
// profile + relationships every other Full Descriptive Analytics view
// reads (getOrBuildFullProfile() — cheap on a cache hit, computes once
// lazily on a miss) and hands it straight to the pure, deterministic
// services/erdDiagram.js algorithm — see claude/erd-diagram.md.
// Registered here, before the generic :id/:fileType route, for the same
// reason report-catalog is: Express matches by registration order, and
// "erd" would otherwise be swallowed as a literal file type.
router.get('/browse-dataset/:id/erd', async (req, res, next) => {
  try {
    const { id } = req.params;
    const { rows } = await pool.query(
      `SELECT id, dataset_id, dataset_name, domain
         FROM uploaded_datasets
        WHERE id = $1 AND account_id = $2`,
      [id, req.session.userId]
    );
    const dataset = rows[0];
    if (!dataset) {
      return res.status(404).render('errors/404', { title: 'Not found', layout: false });
    }

    const bundle = await getOrBuildFullProfile(req.session.userId, dataset.id);
    const erd = buildErdDefinition(bundle.files, bundle.relationships);

    res.render('dashboard/erd', {
      title: `Entity-Relationship Diagram — ${dataset.dataset_name}`,
      active: 'browse-dataset',
      dataset,
      erd,
      humanizeFileType,
    });
  } catch (err) {
    next(err);
  }
});

router.get('/browse-dataset/:id/:fileType', async (req, res, next) => {
  try {
    const { id, fileType } = req.params;

    const { rows } = await pool.query(
      `SELECT id, dataset_id, dataset_name, domain
         FROM uploaded_datasets
        WHERE id = $1 AND account_id = $2`,
      [id, req.session.userId]
    );
    const dataset = rows[0];

    // A dataset can have any number of physical files under any number of
    // free-form labels — "has this file_type at all" is answered by
    // whether any rows were ever ingested for it, not by checking against
    // a fixed list of allowed names (that fixed-list check was the actual
    // cause of newly uploaded, non-standard-named files 404ing here).
    const { rows: presenceRows } = dataset ? await pool.query(
      `SELECT 1 FROM dataset_records WHERE dataset_id = $1 AND account_id = $2 AND file_type = $3 LIMIT 1`,
      [id, req.session.userId, fileType]
    ) : { rows: [] };

    if (!dataset || presenceRows.length === 0) {
      return res.status(404).render('errors/404', { title: 'Not found', layout: false });
    }

    // Records come from cmaDB (dataset_records), not the raw CSV on disk —
    // that's what was actually ingested at upload time, and it's what lets
    // this page work the same way regardless of each dataset's own column layout.
    const { rows: recordRows } = await pool.query(
      `SELECT data FROM dataset_records
        WHERE dataset_id = $1 AND account_id = $2 AND file_type = $3
        ORDER BY row_index`,
      [id, req.session.userId, fileType]
    );
    const allRows = recordRows.map((r) => r.data);
    const columns = allRows.length > 0 ? Object.keys(allRows[0]) : [];
    const columnMeta = buildColumnMeta(allRows, columns);
    const filtered = applyFilters(allRows, columnMeta, req.query);

    const pageSize = Math.min(Math.max(parseInt(req.query.pageSize, 10) || 25, 10), 200);
    const requestedPage = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const totalPages = Math.max(Math.ceil(filtered.length / pageSize), 1);
    const page = Math.min(requestedPage, totalPages);
    const pageRows = filtered.slice((page - 1) * pageSize, page * pageSize);

    const label = humanizeFileType(fileType);
    res.render('dashboard/browse-dataset', {
      title: `Browse — ${label}`,
      active: 'browse-dataset',
      dataset,
      fileType,
      label,
      columns,
      columnMeta,
      pageRows,
      totalRows: allRows.length,
      filteredCount: filtered.length,
      page,
      totalPages,
      pageSize,
      query: req.query,
    });
  } catch (err) {
    next(err);
  }
});

// Shared by both Evaluation Report routes below — the same ownership
// check and raw-row fetch the row browser above uses (dataset_records,
// BEFORE Map & Transform), so the report always reflects exactly what
// Browse Dataset is showing for this file.
async function loadDatasetAndRawRows(accountId, id, fileType) {
  const { rows } = await pool.query(
    `SELECT id, dataset_id, dataset_name, domain
       FROM uploaded_datasets
      WHERE id = $1 AND account_id = $2`,
    [id, accountId]
  );
  const dataset = rows[0];

  const { rows: presenceRows } = dataset ? await pool.query(
    `SELECT 1 FROM dataset_records WHERE dataset_id = $1 AND account_id = $2 AND file_type = $3 LIMIT 1`,
    [id, accountId, fileType]
  ) : { rows: [] };
  if (!dataset || presenceRows.length === 0) return { dataset: null, columns: [], rawRows: [] };

  const { rows: recordRows } = await pool.query(
    `SELECT data FROM dataset_records
      WHERE dataset_id = $1 AND account_id = $2 AND file_type = $3
      ORDER BY row_index`,
    [id, accountId, fileType]
  );
  const rawRows = recordRows.map((r) => r.data);
  const columns = rawRows.length > 0 ? Object.keys(rawRows[0]) : [];
  return { dataset, columns, rawRows };
}

// Pre-renders the Evaluation Report's chart/tile HTML the same way
// buildRevenueGrowthCards() does above, so views/dashboard/evaluation-report.ejs
// stays a thin shell for the chart-shaped sections; the plain tabular
// sections (profiling, numeric stats, monetization findings, correlation)
// are simple enough that the view renders them directly.
function buildEvaluationReportCards(report) {
  const cards = {};
  const k = report.kpis;

  cards.kpiRow = [
    renderStatTile({ label: 'Records', value: formatCount(k.records) }),
    renderStatTile({ label: 'Unique customers', value: k.uniqueCustomers === undefined ? '—' : formatCount(k.uniqueCustomers) }),
    renderStatTile({ label: 'Total revenue', value: k.totalRevenue === undefined ? '—' : formatMoney(k.totalRevenue, null) }),
    renderStatTile({ label: 'Average revenue / record', value: k.averageRevenue === undefined ? '—' : formatMoney(k.averageRevenue, null) }),
    renderStatTile({ label: 'Median revenue / record', value: k.medianRevenue === undefined ? '—' : formatMoney(k.medianRevenue, null) }),
    renderStatTile({ label: 'ARPU', value: k.arpu === undefined ? '—' : formatMoney(k.arpu, null) }),
  ];

  cards.mrrArrRow = report.mrrArr ? [
    renderStatTile({ label: 'MRR', value: report.mrrArr.mrr === null ? '—' : formatMoney(report.mrrArr.mrr, null), sublabel: report.mrrArr.source }),
    renderStatTile({ label: 'ARR', value: formatMoney(report.mrrArr.arr, null), sublabel: report.mrrArr.source }),
  ] : null;

  cards.churnRow = report.churn ? [
    renderStatTile({ label: 'Churn rate', value: `${report.churn.rate.toFixed(1)}%`, sublabel: `from "${report.churn.column}"` }),
  ] : null;

  cards.byCustomer = report.revenueByCustomer
    ? renderBarChart({ title: 'Revenue by customer', items: report.revenueByCustomer.slice(0, 15), currency: null, emptyMessage: 'No revenue data by customer.' })
    : null;
  cards.byProduct = report.revenueByProduct
    ? renderBarChart({ title: 'Revenue by product / service', items: report.revenueByProduct.slice(0, 15), currency: null, emptyMessage: 'No revenue data by product.' })
    : null;
  cards.byMechanism = report.revenueByMechanism
    ? renderBarChart({ title: 'Revenue by mechanism', items: report.revenueByMechanism, currency: null, emptyMessage: 'No revenue data by mechanism.' })
    : null;
  cards.byPeriod = report.byPeriod
    ? renderTrendChart({ title: 'Revenue by period', points: report.byPeriod, currency: null })
    : null;
  cards.growth = report.growth
    ? renderTrendChart({
      title: 'New customers by month', points: report.growth.trend, money: false, valueLabel: 'New customers',
      subtitle: `From "${report.growth.column}"`,
    })
    : null;
  cards.histogram = (report.histogram && report.histogram.length > 0)
    ? renderBarChart({
      title: 'Revenue distribution', subtitle: `By "${report.primary.revenueCol}" (${report.histogram.length} buckets)`,
      items: report.histogram, money: false, valueColumnLabel: 'Records',
    })
    : null;

  return cards;
}

// ------------------------------------------------------------------
// Evaluation Report — a per-file data-quality + monetization-readiness
// pass over one raw uploaded file, reachable from Browse Dataset. Runs
// entirely on dataset_records (before Map & Transform) via
// services/evaluationReport.js — see that file's header comment for why
// its "Monetization field evidence" section is deliberately distinct
// from the app's real (behavioral) Monetization Discovery Engine.
// ------------------------------------------------------------------
router.get('/browse-dataset/:id/:fileType/evaluation', async (req, res, next) => {
  try {
    const { id, fileType } = req.params;
    const { dataset, columns, rawRows } = await loadDatasetAndRawRows(req.session.userId, id, fileType);
    if (!dataset) {
      return res.status(404).render('errors/404', { title: 'Not found', layout: false });
    }

    const label = humanizeFileType(fileType);
    const report = buildEvaluationReport(columns, rawRows);
    const cards = buildEvaluationReportCards(report);

    res.render('dashboard/evaluation-report', {
      title: `Evaluation Report — ${label}`,
      active: 'browse-dataset',
      dataset,
      fileType,
      label,
      report,
      cards,
      formatMoney,
      formatCount,
    });
  } catch (err) {
    next(err);
  }
});

router.get('/browse-dataset/:id/:fileType/evaluation/export.xlsx', async (req, res, next) => {
  try {
    const { id, fileType } = req.params;
    const { dataset, columns, rawRows } = await loadDatasetAndRawRows(req.session.userId, id, fileType);
    if (!dataset) {
      return res.status(404).render('errors/404', { title: 'Not found', layout: false });
    }

    const report = buildEvaluationReport(columns, rawRows);
    const workbook = await buildEvaluationReportWorkbook(report, {
      datasetName: dataset.dataset_name,
      fileType,
      label: humanizeFileType(fileType),
    });

    const safeName = `${dataset.dataset_name}-${fileType}-evaluation-report`.replace(/[^a-z0-9-]+/gi, '_');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${safeName}.xlsx"`);
    await workbook.xlsx.write(res);
    res.end();
  } catch (err) {
    next(err);
  }
});

// ------------------------------------------------------------------
// Report Catalog — the "Descriptive Analytics Decision Framework" for
// arbitrary multi-file raw dataset uploads (e.g. Olist's eight linked
// CSVs). Unlike the Evaluation Report above (one raw file at a time),
// this runs across EVERY raw file in a dataset together, joined on
// shared key columns — see services/reportCatalog.js's header comment
// for how this differs from both the Evaluation Report and the app's
// own (raw-native, behavioral) Monetization Discovery Engine.
// ------------------------------------------------------------------
function formatReportKpiValue(k, currency) {
  if (k.isCount) return formatCount(k.value);
  if (k.isPercent) return `${k.value.toFixed(1)}%`;
  if (k.isPlain) return k.value.toFixed(2);
  return formatMoney(k.value, currency);
}

function renderReportKpiRow(kpis, currency) {
  return `<div class="kpi-row">${kpis.map((k) => renderStatTile({ label: k.label, value: formatReportKpiValue(k, currency) })).join('')}</div>`;
}

function renderRankedTable(title, columns, rows, moneyColumns, currency) {
  if (!rows || rows.length === 0) {
    return `<div class="chart-card"><div class="chart-title">${escapeHtml(title)}</div><p class="chart-empty">No data yet for this report.</p></div>`;
  }
  const thead = columns.map((c) => `<th>${escapeHtml(c)}</th>`).join('');
  const tbody = rows.map((r) => `<tr>${r.map((cell, i) => {
    if (i === 0) return `<td>${escapeHtml(cell)}</td>`;
    const isMoney = moneyColumns && moneyColumns.includes(i);
    return `<td>${escapeHtml(isMoney ? formatMoney(cell, currency) : formatCount(cell))}</td>`;
  }).join('')}</tr>`).join('');
  return `<div class="chart-card"><div class="chart-title">${escapeHtml(title)}</div><div class="table-scroll"><table class="table-simple"><thead><tr>${thead}</tr></thead><tbody>${tbody}</tbody></table></div></div>`;
}

function buildReportCatalogCardHtml(report, data, currency) {
  const { title } = report;
  switch (data.kind) {
    case 'kpis':
      return `<div class="chart-card"><div class="chart-title">${escapeHtml(title)}</div>${renderReportKpiRow(data.kpis, currency)}</div>`;
    case 'kpi_trend':
      return renderReportKpiRow(data.kpis, currency) + renderTrendChart({
        title, points: data.points, money: data.money, valueLabel: data.valueLabel,
      });
    case 'trend':
      return renderTrendChart({
        title, points: data.points, money: data.money, valueLabel: data.valueLabel,
      });
    case 'bar':
      return renderBarChart({
        title, items: data.items, currency, money: data.money, valueColumnLabel: data.valueColumnLabel, formatValue: data.formatValue,
      });
    case 'ranked_table':
      return renderRankedTable(title, data.columns, data.rows, data.moneyColumns, currency);
    case 'describe_histogram': {
      const d = data.describe;
      const kpis = [
        { label: 'Min', value: d.min }, { label: 'Mean', value: d.mean }, { label: 'Median', value: d.median }, { label: 'Max', value: d.max },
      ];
      return renderReportKpiRow(kpis, currency) + renderBarChart({
        title: 'Price distribution', items: data.histogram, money: false, valueColumnLabel: 'Records',
      });
    }
    case 'kpi_histogram':
      return renderReportKpiRow(data.kpis, currency) + renderBarChart({
        title: `${title} — distribution (days)`, items: data.histogram, money: false, valueColumnLabel: 'Orders',
      });
    case 'seasonality': {
      let html = renderBarChart({
        title: `${title} — by weekday`, items: data.byWeekday, currency, money: true,
      });
      if (data.hasTime) {
        html += renderBarChart({
          title: `${title} — by hour`, items: data.byHour, currency, money: true,
        });
      } else {
        html += '<div class="chart-card"><p class="chart-empty">Hour-level revenue isn\'t shown — this dataset\'s date field has no time component, only a calendar date.</p></div>';
      }
      return html;
    }
    default:
      return '';
  }
}

function buildReportCatalogCards(analysis, currency) {
  const categorized = {};
  analysis.enabled.forEach((report) => {
    const data = analysis.reportData[report.id];
    if (!data) return;
    const html = buildReportCatalogCardHtml(report, data, currency);
    categorized[report.category] = categorized[report.category] || [];
    categorized[report.category].push({ report, html });
  });
  const categoryOrder = [...new Set(REPORT_CATALOG.map((r) => r.category))];
  return { categorized, categoryOrder };
}

// ------------------------------------------------------------------
// Data Mapping & Transformation — the CMA pipeline
// (Clean -> Normalize -> Transform -> Tag -> Enrich -> Validate -> Freeze)
// ------------------------------------------------------------------

// Shared ownership lookup used by the mapping and canonical routes below.
// Unlike before, this does NOT also resolve a canonical entity — a file's
// entity is no longer derivable from its file_type/label, so it's
// resolved separately (see resolveEntity()) from an explicit request
// parameter instead.
async function loadDataset(req, res) {
  const { id } = req.params;
  const { rows } = await pool.query(
    `SELECT id, dataset_id, dataset_name, domain FROM uploaded_datasets
      WHERE id = $1 AND account_id = $2`,
    [id, req.session.userId]
  );
  const dataset = rows[0];
  if (!dataset) {
    res.status(404).render('errors/404', { title: 'Not found', layout: false });
    return null;
  }
  return dataset;
}

// Resolves which of the four canonical entities a file should map into:
// an explicit choice from the request (?entity= on GET, entity field on
// POST) when it's one of the four valid names, otherwise a heuristic
// default from guessEntity(). Entity is never derived from the file_type
// name alone — this is always either the SME owner's own confirmed choice
// or a non-authoritative starting suggestion they're free to change.
//
// `columns`, when supplied, is the file's ACTUAL column headers (fetched
// from its already-ingested rows) — this is what lets guessEntity() read
// what the data really looks like (e.g. an AWS/GCP rate-card export with
// no customer/account column anywhere) instead of only pattern-matching
// the file's name, which could never tell a Transaction-shaped file from
// a MonetizationConfig-shaped one when both happen to be named "usage" or
// "billing". Callers must fetch columns BEFORE calling this.
function resolveEntity(requested, fileType, columns) {
  if (ENTITY_NAMES.includes(requested)) return requested;
  return guessEntity(fileType, columns);
}

// Every file_type that actually has ingested rows for this dataset —
// the fixed set Map & Transform operates on for the whole batch in one
// go, queried fresh (never trusted from form input) so the batch always
// matches what's really been uploaded under this Dataset ID.
async function getDatasetFileTypes(datasetRowId, accountId) {
  const { rows } = await pool.query(
    `SELECT DISTINCT file_type FROM dataset_records
      WHERE dataset_id = $1 AND account_id = $2
      ORDER BY file_type`,
    [datasetRowId, accountId]
  );
  return rows.map((r) => r.file_type);
}

// GET /upload-dataset/:id/map — review/edit the column mapping for EVERY
// file uploaded under this Dataset ID at once, as one batch — not one
// file at a time. Each file gets its own block (entity switcher + column
// mapping table, pre-filled from its own most recently confirmed mapping
// for the same entity if one exists, otherwise auto-suggested fresh), but
// there is exactly one "Confirm & Run Transform" action for the whole
// dataset below all of them.
router.get('/upload-dataset/:id/map', async (req, res, next) => {
  try {
    const dataset = await loadDataset(req, res);
    if (!dataset) return;
    const accountId = req.session.userId;

    const fileTypes = await getDatasetFileTypes(dataset.id, accountId);
    if (fileTypes.length === 0) {
      return renderUploadForm(req, res, next, {
        status: 400,
        errors: [{ msg: `"${dataset.dataset_id}" has no uploaded files yet — upload files before mapping.` }],
      });
    }

    const blocks = [];
    for (const fileType of fileTypes) {
      const label = humanizeFileType(fileType);

      // Columns are fetched BEFORE resolveEntity() so a fresh (non-remap)
      // suggestion can read what this file's data actually looks like —
      // see the comment on resolveEntity() for why that matters.
      const { rows: sampleRows } = await pool.query(
        `SELECT data FROM dataset_records
          WHERE dataset_id = $1 AND account_id = $2 AND file_type = $3
          ORDER BY row_index LIMIT 1`,
        [dataset.id, accountId, fileType]
      );
      const { count: rowCount } = (await pool.query(
        `SELECT COUNT(*)::int AS count FROM dataset_records
          WHERE dataset_id = $1 AND account_id = $2 AND file_type = $3`,
        [dataset.id, accountId, fileType]
      )).rows[0];
      const columns = sampleRows.length ? Object.keys(sampleRows[0].data) : [];

      const entity = resolveEntity(req.query[`entity_${fileType}`], fileType, columns);
      const entitySpec = CANONICAL_ENTITIES[entity];

      const { rows: existingRows } = await pool.query(
        `SELECT field_map, mapping_version, entity FROM dataset_mappings
          WHERE dataset_id = $1 AND account_id = $2 AND file_type = $3
          ORDER BY mapping_version DESC LIMIT 1`,
        [dataset.id, accountId, fileType]
      );

      const suggested = suggestMapping(columns, entity);
      let fieldMap = suggested;
      let isRemap = false;
      // Only pre-fill from a previous confirmed mapping when it was for
      // the SAME entity this block is currently showing — a file
      // previously confirmed as Customer shouldn't silently reuse those
      // column choices if the entity switcher is set to Transaction.
      if (existingRows.length > 0 && existingRows[0].entity === entity) {
        isRemap = true;
        const confirmed = existingRows[0].field_map;
        fieldMap = {};
        Object.keys(entitySpec.fields).forEach((key) => {
          fieldMap[key] = {
            ...suggested[key],
            source: confirmed[key] ? confirmed[key].source : null,
            confidence: 1, // previously confirmed by a human, not just suggested
          };
        });
      }

      // Required fields the SUGGESTION could not match to any column at
      // all (not "the SME hasn't picked one yet" — no candidate scored
      // above 0 against this file's actual headers). This is what turns
      // "0 valid rows" from a silent, confusing outcome into something the
      // SME owner sees and understands before they even confirm: e.g. an
      // AWS/GCP rate-card or cost export that has no customer/account
      // column anywhere can never freeze a valid Transaction row no matter
      // how it's mapped, because the source data itself doesn't carry
      // that dimension. Based on the fresh suggestion, not the possibly
      // remapped fieldMap, so a human's earlier explicit "— none —"
      // choice doesn't get relabeled as "impossible to find".
      const unmappableRequired = Object.keys(entitySpec.fields)
        .filter((key) => entitySpec.fields[key].required && !suggested[key].source);

      blocks.push({
        fileType, label, entity, entitySpec, columns, fieldMap, isRemap, rowCount, unmappableRequired,
      });
    }

    // Switching one file's entity reloads the page — this keeps every
    // OTHER file's currently selected entity in the URL so their blocks
    // don't silently reset back to their default guess.
    function entityLink(targetFileType, entityName) {
      const params = new URLSearchParams();
      fileTypes.forEach((ft) => {
        if (ft === targetFileType) return;
        const current = req.query[`entity_${ft}`];
        if (ENTITY_NAMES.includes(current)) params.set(`entity_${ft}`, current);
      });
      params.set(`entity_${targetFileType}`, entityName);
      return `/upload-dataset/${dataset.id}/map?${params.toString()}#file-${targetFileType}`;
    }

    res.render('dashboard/map-dataset', {
      title: `Map & Transform — ${dataset.dataset_name}`,
      active: 'upload-new-dataset',
      dataset,
      blocks,
      entityNames: ENTITY_NAMES,
      entityLink,
      errors: [],
    });
  } catch (err) {
    next(err);
  }
});

// POST /upload-dataset/:id/map — confirm every file's mapping (and entity
// choice) at once and run the full Clean->Normalize->Transform->Tag->
// Enrich->Validate->Freeze pipeline for the WHOLE dataset batch inside a
// single transaction: either every file in this Dataset ID freezes
// together, or none of them do. Each file still gets its own
// mapping_version (dataset_mappings stays keyed per dataset_id+file_type,
// so per-file audit history is unaffected), but there is exactly one
// confirm action and one combined reconciliation for the batch.
router.post('/upload-dataset/:id/map', async (req, res, next) => {
  try {
    const dataset = await loadDataset(req, res);
    if (!dataset) return;
    const accountId = req.session.userId;

    const fileTypes = await getDatasetFileTypes(dataset.id, accountId);
    if (fileTypes.length === 0) {
      return renderUploadForm(req, res, next, {
        status: 400,
        errors: [{ msg: `"${dataset.dataset_id}" has no uploaded files to map.` }],
      });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const perFileResults = [];
      for (const fileType of fileTypes) {
        // Columns are fetched BEFORE resolveEntity() — see the comment on
        // resolveEntity() for why a fresh (non-explicit) entity choice
        // needs to see this file's actual data shape, not just its name.
        const { rows: sampleRows } = await client.query(
          `SELECT data FROM dataset_records
            WHERE dataset_id = $1 AND account_id = $2 AND file_type = $3
            ORDER BY row_index LIMIT 1`,
          [dataset.id, accountId, fileType]
        );
        const validColumns = new Set(sampleRows.length ? Object.keys(sampleRows[0].data) : []);

        const entity = resolveEntity(req.body[`entity_${fileType}`], fileType, Array.from(validColumns));
        const entitySpec = CANONICAL_ENTITIES[entity];

        const fieldMap = {};
        Object.keys(entitySpec.fields).forEach((key) => {
          const selected = (req.body[`map_${fileType}_${key}`] || '').trim();
          fieldMap[key] = { source: selected && validColumns.has(selected) ? selected : null };
        });

        const { rows: versionRows } = await client.query(
          `SELECT COALESCE(MAX(mapping_version), 0) + 1 AS next_version
             FROM dataset_mappings WHERE dataset_id = $1 AND file_type = $2`,
          [dataset.id, fileType]
        );
        const mappingVersion = versionRows[0].next_version;

        await client.query(
          `INSERT INTO dataset_mappings (dataset_id, account_id, file_type, entity, mapping_version, field_map)
           VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
          [dataset.id, accountId, fileType, entity, mappingVersion, JSON.stringify(fieldMap)]
        );

        const summary = await runTransformPipeline(client, {
          datasetRowId: dataset.id, accountId, fileType, entity, fieldMap, mappingVersion,
        });

        perFileResults.push({ fileType, label: humanizeFileType(fileType), entity, mappingVersion, summary });
      }

      await client.query('COMMIT');

      const totals = perFileResults.reduce((acc, r) => ({
        total: acc.total + r.summary.total,
        valid: acc.valid + r.summary.valid,
        invalid: acc.invalid + r.summary.invalid,
      }), { total: 0, valid: 0, invalid: 0 });

      res.render('dashboard/transform-results', {
        title: `Transform results — ${dataset.dataset_name}`,
        active: 'upload-new-dataset',
        dataset,
        perFileResults,
        totals,
      });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      next(err);
    } finally {
      client.release();
    }
  } catch (err) {
    next(err);
  }
});

// Round 22 — Semantic Field Detection Engine's confidence-gated SME
// confirmation screen. GET lists every column the hybrid engine
// (services/semanticFieldEngine.js) left in the Medium
// ("flag-for-confirmation") or Low ("ask-sme") confidence band — or
// flagged as a possible brand-new semantic role — that hasn't already
// been confirmed; POST records the SME owner's answer to
// field_role_feedback (db/schema.sql), which scripts/
// retrainSemanticClassifier.js later folds into the classifier's next
// training run. Deliberately its own screen, not folded into Map &
// Transform (GET/POST /upload-dataset/:id/map above) — that screen
// belongs to the separate CMA Canonical Schema / entity-mapping system
// (services/mapping.js), a different pipeline from the dynamic/
// content-aware semantic-role model this confirms fields for; conflating
// the two risks regressing a proven, independently-tested screen for no
// real benefit.
router.get('/dataset/:id/review-fields', async (req, res, next) => {
  try {
    const dataset = await loadDataset(req, res);
    if (!dataset) return;
    const accountId = req.session.userId;

    const bi = await getOrBuildBusinessIntelligence(accountId, dataset.id);
    const pendingReview = (bi.semanticModel && bi.semanticModel.pendingReview) || [];

    const { rows: alreadyConfirmed } = await pool.query(
      `SELECT file_type, column_name FROM field_role_feedback
        WHERE dataset_id = $1 AND account_id = $2`,
      [dataset.id, accountId]
    );
    const confirmedKeys = new Set(alreadyConfirmed.map((r) => `${r.file_type}\u0000${r.column_name}`));
    const items = pendingReview.filter((p) => !confirmedKeys.has(`${p.fileType}\u0000${p.columnName}`));

    const roleOptions = [
      { value: 'none', label: "— No business role (doesn't fit any of these) —" },
      ...Object.entries(ROLE_ONTOLOGY).map(([role, entry]) => ({ value: role, label: entry.uiLabel })),
    ];

    res.render('dashboard/review-fields', {
      title: `Review field roles — ${dataset.dataset_name}`,
      active: 'upload-new-dataset',
      dataset,
      items: items.map((it) => ({ ...it, fileLabel: humanizeFileType(it.fileType) })),
      roleOptions,
      confirmedCount: alreadyConfirmed.length,
      errors: [],
    });
  } catch (err) {
    next(err);
  }
});

router.post('/dataset/:id/review-fields', async (req, res, next) => {
  try {
    const dataset = await loadDataset(req, res);
    if (!dataset) return;
    const accountId = req.session.userId;

    const items = Array.isArray(req.body.items) ? req.body.items : Object.values(req.body.items || {});
    const rows = items.filter((it) => it && it.fileType && it.columnName && it.confirmedRole);

    if (rows.length > 0) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        for (const it of rows) {
          const suggestedConfidence = it.suggestedConfidence !== '' && it.suggestedConfidence !== undefined
            ? Number(it.suggestedConfidence) : null;
          await client.query(
            `INSERT INTO field_role_feedback
               (dataset_id, account_id, file_type, column_name, suggested_role, suggested_confidence, confirmed_role, was_correction)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
             ON CONFLICT (dataset_id, file_type, column_name) DO UPDATE SET
               suggested_role = EXCLUDED.suggested_role,
               suggested_confidence = EXCLUDED.suggested_confidence,
               confirmed_role = EXCLUDED.confirmed_role,
               was_correction = EXCLUDED.was_correction,
               confirmed_at = now()`,
            [
              dataset.id, accountId, it.fileType, it.columnName,
              it.suggestedRole || null, suggestedConfidence, it.confirmedRole,
              it.confirmedRole !== (it.suggestedRole || 'none'),
            ]
          );
        }
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    }

    res.redirect(`/dataset/${dataset.id}/review-fields`);
  } catch (err) {
    next(err);
  }
});

// GET /canonical-dataset/:id/:fileType — browse the frozen CMA Canonical
// Schema output for one dataset+file: fixed canonical columns (not the
// raw file's own columns), a valid/invalid view toggle, and each invalid
// row's recorded reasons — nothing here is ever silently missing, only
// explicitly flagged. The latest entity + mapping_version for this file
// are read directly off canonical_records.file_type, so there's no need
// to guess or reverse-derive the entity.
router.get('/canonical-dataset/:id/:fileType', async (req, res, next) => {
  try {
    const dataset = await loadDataset(req, res);
    if (!dataset) return;
    const { fileType } = req.params;
    const accountId = req.session.userId;
    const label = humanizeFileType(fileType);

    const { rows: latestRows } = await pool.query(
      `SELECT entity, mapping_version FROM canonical_records
        WHERE dataset_id = $1 AND account_id = $2 AND file_type = $3
        ORDER BY mapping_version DESC, id DESC LIMIT 1`,
      [dataset.id, accountId, fileType]
    );
    if (latestRows.length === 0) {
      return res.render('dashboard/canonical-dataset', {
        title: `Canonical — ${label}`,
        active: 'upload-new-dataset',
        dataset, fileType, label, entity: null, entitySpec: null,
        mappingVersion: null, rows: [], counts: { valid: 0, invalid: 0 }, view: 'all',
      });
    }
    const { entity, mapping_version: mappingVersion } = latestRows[0];
    const entitySpec = CANONICAL_ENTITIES[entity];

    const view = ['valid', 'invalid', 'all'].includes(req.query.view) ? req.query.view : 'all';
    const baseParams = [dataset.id, accountId, fileType, mappingVersion];
    const statusClause = view === 'all' ? '' : `AND status = $${baseParams.length + 1}`;
    const params = view === 'all' ? baseParams : [...baseParams, view];

    const { rows } = await pool.query(
      `SELECT id, data, status, validation_errors FROM canonical_records
        WHERE dataset_id = $1 AND account_id = $2 AND file_type = $3 AND mapping_version = $4 ${statusClause}
        ORDER BY id`,
      params
    );

    const { rows: countRows } = await pool.query(
      `SELECT COUNT(*) FILTER (WHERE status = 'valid')::int AS valid,
              COUNT(*) FILTER (WHERE status = 'invalid')::int AS invalid
         FROM canonical_records
        WHERE dataset_id = $1 AND account_id = $2 AND file_type = $3 AND mapping_version = $4`,
      [dataset.id, accountId, fileType, mappingVersion]
    );

    res.render('dashboard/canonical-dataset', {
      title: `Canonical — ${label}`,
      active: 'upload-new-dataset',
      dataset,
      fileType,
      label,
      entity,
      entitySpec,
      mappingVersion,
      rows,
      counts: countRows[0],
      view,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
