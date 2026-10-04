// SME business-category CSV templates — added 30 September 2026 for the
// Template Evaluator field-generalization round, extended 2 October 2026
// to also cover the new Business Owner Evaluator role (see
// usesTemplateSystem() below). Either role picks an SME business category
// here, downloads its CSV template (the exact column set CMA-Flow expects
// for that category — see data/sme-templates/
// 00_CMAFlow_SME_Template_Manifest.csv), fills it with a realistic (not
// necessarily their own live) dataset, and uploads it as Task 1 of their
// own walkthrough. Static reference data checked into the repo (not
// anything a user uploads), so it lives under data/, not uploads/ (which
// is gitignored and per-account).
//
// Reachable by any signed-in account (requireAuth only) — the SME
// business categories and field names here carry no participant data of
// any kind, so there is no reason to restrict them by role. It's only
// ever linked from the Template Evaluator and Business Owner Evaluator's
// own sidebar branches (see views/partials/sidebar.ejs), and
// middleware/evaluationGate.js always allows /sme-templates regardless of
// lock state, the same as /evaluation itself, since either role needs a
// template before Task 1.
const express = require('express');
const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');
const { requireAuth } = require('../middleware/auth');
const pool = require('../db/pool');
const { logEvent } = require('../services/smeTamActivity');
const {
  ingestTemplateForEvaluation, EVAL_FILE_TYPE,
  findEvaluationCopyByCategory, listEvaluationDatasetCopies, getEvaluationDatasetById,
  // Blank-track (added 3 October 2026, per Brenda's "blank template...
  // real datasets" request) — see services/templateEvaluationIngest.js's
  // own module-header comment on that track for the full picture.
  ingestBlankTemplateForEvaluation, findBlankCopyByCategory, isBlankDatasetId,
} = require('../services/templateEvaluationIngest');
// Only for the "switch without re-ingesting" path inside POST
// /sme-templates/set-evaluation-default below — see its own comment.
const { setDefaultDataset } = require('../services/accountDatasets');
// For GET /user-manual below — reads the live six-task walkthrough
// definitions and the ISO/IEC 25010 domain labels/item counts straight
// from the single source of truth, so the manual can never drift out of
// sync with the actual instrument if either is ever revised.
const {
  WALKTHROUGH_TASKS, ISO_DOMAIN_LABELS, ISO25010_ITEMS,
  // SME Owner-TAM Evaluator (added 4 October 2026) — same portal features
  // as Business Owner Evaluator, direct flow, reworded 17-item TAM.
  SME_TAM_ROLE, SME_TAM_ITEMS, DOMAIN_LABELS, isDirectFlow: isDirectFlowFor,
} = require('../services/tamEvaluation');

const router = express.Router();
const TEMPLATES_ROOT = path.join(__dirname, '..', 'data', 'sme-templates');
const MANIFEST_PATH = path.join(TEMPLATES_ROOT, '00_CMAFlow_SME_Template_Manifest.csv');
const EXPERT_ROLE = 'Template Evaluator';
// Business Owner Evaluator (added 2 October 2026) gets the exact same
// business-category/template system a Template Evaluator does — picks a
// category at signup (routes/auth.js's /businessOwner-signup/register,
// mirroring /expert-signup/register), can download any category's CSV,
// and can set/switch its own "default CSV for evaluation" here — the
// ISO/IEC 25010 questionnaire this role answers (not TAM) is the only
// thing that's different about it, handled entirely in
// services/tamEvaluation.js, never here.
const BUSINESS_ROLE = 'Business Owner Evaluator';

// SME Owner-TAM Evaluator (added 4 October 2026) gets the same template
// system and the same editable-copy (blank/prefilled, CRUD) experience as
// Business Owner Evaluator — see hasEditableCopies() below.
function usesTemplateSystem(role) {
  return role === EXPERT_ROLE || role === BUSINESS_ROLE || role === SME_TAM_ROLE;
}

// The two roles that hold their OWN editable evaluation-dataset copies
// (blank track + prefilled track, Excel-style CRUD). Template Evaluator is
// deliberately excluded — see requireBusinessOwner()'s comment.
function hasEditableCopies(role) {
  return role === BUSINESS_ROLE || role === SME_TAM_ROLE;
}

// Same shape as requireAdmin in middleware/auth.js — a signed-in account
// that isn't eligible for the template system gets a plain 403, not a
// bounce to /login, since they ARE authenticated, just not a role this
// section (choosing/browsing the "default CSV for evaluation") is for.
// Kept local to this router since nothing outside routes/templates.js
// needs it yet.
function requireTemplateEligible(req, res, next) {
  if (!(req.session && req.session.userId)) {
    req.session.flashError = 'Please sign in to continue.';
    return res.redirect('/login');
  }
  if (req.session.user && usesTemplateSystem(req.session.user.role)) {
    return next();
  }
  return res.status(403).render('errors/403', { title: 'Not authorized', layout: false });
}

// Gates the editable-dataset CRUD routes below (added 2 October 2026, per
// Brenda's explicit request) to Business Owner Evaluator ONLY — Template
// Evaluator keeps the exact read-only "Browse Evaluation CSV" experience
// (GET /sme-templates/evaluation-data above) it's always had, since the
// 15 Template Evaluator responses already collected were evaluated
// against that fixed, uneditable dataset and must stay comparable to any
// later Template Evaluator respondent. Deliberately its own, narrower
// check rather than reusing requireTemplateEligible()/usesTemplateSystem()
// above, which both roles satisfy.
function requireBusinessOwner(req, res, next) {
  if (!(req.session && req.session.userId)) {
    req.session.flashError = 'Please sign in to continue.';
    return res.redirect('/login');
  }
  // Name kept (it gates every editable-copy route below) even though, as of
  // 4 October 2026, it also admits SME Owner-TAM Evaluator via
  // hasEditableCopies() — still never Template Evaluator.
  if (req.session.user && hasEditableCopies(req.session.user.role)) {
    return next();
  }
  return res.status(403).render('errors/403', { title: 'Not authorized', layout: false });
}

// Shared by all four /sme-templates/evaluation-dataset/:datasetRowId*
// routes below — resolves ONE specific copy (by its uploaded_datasets.id,
// not a fixed slug: a Business Owner Evaluator can hold several at once,
// one per category it has picked — see services/templateEvaluationIngest.js's
// module header) to its row id, category label, and every dataset_records
// row currently under it. getEvaluationDatasetById() does the actual
// ownership + "is this really one of this account's template copies, not
// a manually uploaded dataset" check, so this can never read or touch
// another account's rows, or a dataset this route isn't meant for.
// Returns null when datasetRowId doesn't resolve to such a row at all.
async function loadEvaluationDataset(accountId, datasetRowId) {
  const datasetRow = await getEvaluationDatasetById(accountId, datasetRowId);
  if (!datasetRow) return null;
  const { rows: records } = await pool.query(
    `SELECT id, data FROM dataset_records
      WHERE dataset_id = $1 AND account_id = $2 AND file_type = $3
      ORDER BY row_index, id`,
    [datasetRow.id, accountId, EVAL_FILE_TYPE]
  );
  return {
    datasetRowId: datasetRow.id,
    categoryLabel: datasetRow.domain,
    records,
    // Added 3 October 2026, alongside the blank-template feature — true
    // only for a copy started blank (dataset_id prefixed EVALBLANK_, see
    // services/templateEvaluationIngest.js). The PATCH/DELETE routes
    // below check this before touching a single row: a prefilled
    // (EVALCOPY_/EVALUATION_DEFAULT) copy's existing rows stay locked,
    // per the still-standing 3 October decision for that dataset type —
    // only a blank-origin copy, made entirely of the account's own
    // CRUD-entered rows, gets full edit/delete.
    isBlankOrigin: isBlankDatasetId(datasetRow.dataset_id),
  };
}

// Shared by the editor GET route and the Create/Update routes below —
// resolves the column list for ONE dataset copy. For a copy that already
// has rows, that's just this copy's own data shape (unchanged from
// before). For a copy with ZERO rows — which, before the blank-template
// feature, only ever meant "nothing to show yet" — this now also covers
// a freshly-started blank copy, so its columns are read from its own
// category's template CSV header instead (the exact same file
// resolveTemplateFile()/ingestBlankTemplateForEvaluation() already read
// to build it), never from an actual data row it doesn't have. Returns
// [] only if even that lookup fails (e.g. a manifest edited out from
// under an existing copy), which the callers treat as "no columns to
// show or add against."
function resolveColumnsForDataset(evalData) {
  if (evalData.records.length > 0) return Object.keys(evalData.records[0].data);
  if (!evalData.categoryLabel) return [];
  try {
    const manifest = loadManifest();
    const manifestRow = manifest.find((r) => r.sme_business_category === evalData.categoryLabel);
    if (!manifestRow) return [];
    const raw = fs.readFileSync(path.join(TEMPLATES_ROOT, manifestRow.template_file), 'utf-8');
    const sample = parse(raw, { columns: true, skip_empty_lines: true });
    return sample.length ? Object.keys(sample[0]) : [];
  } catch (err) {
    return [];
  }
}

// Re-counts this account's evaluation dataset's rows straight from
// dataset_records (never trusted from an in-memory count that could be
// stale under a second concurrent edit) and bumps dataset_files'
// row_count + uploaded_at to match. That uploaded_at bump is the ENTIRE
// mechanism that makes an edit here show up in the four analytics
// modules: services/fullDescriptiveAnalytics.js's getOrBuildFullProfile()
// and getOrBuildBusinessIntelligence() both treat
// "MAX(dataset_files.uploaded_at) newer than the cached profile's/bundle's
// computed_at" as "stale, recompute" — the exact same check that already
// makes a real re-upload refresh Descriptive/Diagnostic/Predictive/
// Prescriptive. Reusing it here means a Create/Update/Delete below needs
// no analytics-specific code of its own: the next time the account opens
// any of those four modules, they recompute from the edited rows exactly
// as if the account had re-uploaded the file.
async function touchEvaluationDataset(datasetRowId, accountId) {
  const { rows: countRows } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM dataset_records
      WHERE dataset_id = $1 AND account_id = $2 AND file_type = $3`,
    [datasetRowId, accountId, EVAL_FILE_TYPE]
  );
  await pool.query(
    `UPDATE dataset_files SET row_count = $1, uploaded_at = now()
      WHERE dataset_id = $2 AND account_id = $3 AND file_type = $4`,
    [countRows[0].n, datasetRowId, accountId, EVAL_FILE_TYPE]
  );
  return countRows[0].n;
}

// Figures out which of the "Add new row" modal's fields should be a
// dropdown of already-used values instead of a free-text box (added
// 3 October 2026, per Brenda's follow-up on the modal). A column counts
// as "choice-like" when its non-empty values across the account's own
// copy repeat a lot — at least 2 distinct values seen, no more than
// COLUMN_CHOICE_MAX of them, and strictly fewer distinct values than
// there are rows (so an effectively-unique column like SKU, RECORD ID or
// CUSTOMER ID — one distinct value per row — never turns into an
// unusable dropdown of 50 options). Bails out of scanning a column early
// once it's already seen more than the cap, so one free-text/ID-like
// column with many rows doesn't cost a full table scan for nothing.
// Returns only the columns worth offering as a dropdown, each as its
// sorted list of existing values — evaluation-dataset-editor.ejs treats
// any column missing from this object as plain free text.
const COLUMN_CHOICE_MAX = 15;
function computeColumnChoices(columns, records) {
  const result = {};
  columns.forEach((col) => {
    const seen = new Set();
    for (let i = 0; i < records.length; i += 1) {
      const raw = records[i].data[col];
      const v = raw === undefined || raw === null ? '' : String(raw).trim();
      if (v === '') continue;
      seen.add(v);
      if (seen.size > COLUMN_CHOICE_MAX) break;
    }
    if (seen.size >= 2 && seen.size <= COLUMN_CHOICE_MAX && seen.size < records.length) {
      result[col] = Array.from(seen).sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
    }
  });
  return result;
}

function loadManifest() {
  const raw = fs.readFileSync(MANIFEST_PATH, 'utf-8');
  return parse(raw, { columns: true, skip_empty_lines: true });
}

// Only a template_file name that's actually listed in the manifest can
// ever be read off disk — req.params.file never reaches fs directly, so
// there's no path-traversal surface here regardless of what's typed into
// the URL.
function resolveTemplateFile(fileName) {
  const manifest = loadManifest();
  const row = manifest.find((r) => r.template_file === fileName);
  if (!row) return null;
  return { row, fullPath: path.join(TEMPLATES_ROOT, row.template_file) };
}

router.get('/sme-templates', requireAuth, async (req, res, next) => {
  try {
    const manifest = loadManifest();
    const user = req.session.user;
    // A Template Evaluator or Business Owner Evaluator declares their
    // business category at signup (routes/auth.js's business_category
    // field, stored in sme_accounts.business_sector) — surfaced here so
    // the row matching that choice is easy to find rather than making
    // them re-scan all 20. null for an SME owner (whose business_sector
    // is their own actual sector, not one of these 20 categories
    // necessarily) and for anyone without a declared category yet.
    const assignedCategory = (user && usesTemplateSystem(user.role) && user.business_sector) || null;
    // Each of the 20 templates now ships with 50 synthetic rows (see
    // data/sme-templates/*_template.csv) built so they drive real output
    // across all four analytics modules. Either template-system role can
    // mark one as their "default CSV for evaluation" below and then
    // browse/filter its exact rows (GET /sme-templates/evaluation-data)
    // to cross-check report numbers against known source values — an SME
    // owner has no equivalent concept, since their reports are built from
    // their own uploaded data. Kept as the name isExpertEvaluator for the
    // view/local variable (views/dashboard/sme-templates.ejs reads it
    // unchanged) even though it now also covers Business Owner Evaluator —
    // see usesTemplateSystem() above.
    const isExpertEvaluator = !!(user && usesTemplateSystem(user.role));
    // Only ever true for a Template Evaluator — Business Owner Evaluator
    // has no direct-flow variant (always walkthrough-gated, see
    // middleware/evaluationGate.js), so evaluation_flow is never 'direct'
    // for that role and this stays false there regardless.
    const isDirectFlow = !!(user && isDirectFlowFor(user.role, user.evaluation_flow));
    const evaluationTemplateFile = (isExpertEvaluator && user.evaluation_template_file) || null;
    // Decides which of the two "view your records" destinations this
    // view links to below — added 2 October 2026 alongside the
    // Business-Owner-Evaluator-only CRUD grid. Template Evaluator keeps
    // linking to the existing read-only evaluation-data-browser; Business
    // Owner Evaluator links to the new editable evaluation-dataset-editor
    // instead. See requireBusinessOwner() above for why this is scoped
    // more narrowly than isExpertEvaluator.
    const isBusinessOwner = !!(user && hasEditableCopies(user.role));
    // One row per category this Business Owner Evaluator already holds a
    // copy of (added 3 October 2026, alongside the multi-copy model —
    // see services/templateEvaluationIngest.js's module header), keyed by
    // category name so the manifest loop below can look up, per row,
    // whether "Edit records" has somewhere to link to yet. null for
    // anyone else — Template Evaluator still has exactly one copy total,
    // already fully described by evaluationTemplateFile/isEvalDefault
    // alone, so it needs no such map.
    let categoryToDatasetRowId = null;
    // Blank-track counterpart to categoryToDatasetRowId just below —
    // added 3 October 2026 alongside the blank-template feature. Built
    // from the SAME listEvaluationDatasetCopies() call, split by
    // isBlankDatasetId() rather than two separate queries, since an
    // account can hold both a prefilled AND a blank copy of the same
    // category at once (two different dataset_ids) and the "Download SME
    // Templates" table needs to show the right action for each track
    // independently per row.
    let categoryToBlankDatasetRowId = null;
    if (isBusinessOwner) {
      const copies = await listEvaluationDatasetCopies(user.id);
      categoryToDatasetRowId = {};
      categoryToBlankDatasetRowId = {};
      copies.forEach((c) => {
        if (isBlankDatasetId(c.dataset_id)) {
          categoryToBlankDatasetRowId[c.domain] = c.id;
        } else {
          categoryToDatasetRowId[c.domain] = c.id;
        }
      });
    }
    res.render('dashboard/sme-templates', {
      title: 'Download SME Templates',
      active: 'sme-templates',
      manifest,
      assignedCategory,
      isExpertEvaluator,
      isDirectFlow,
      isBusinessOwner,
      evaluationTemplateFile,
      categoryToDatasetRowId,
      categoryToBlankDatasetRowId,
    });
  } catch (err) {
    next(err);
  }
});

router.get('/sme-templates/download/:file', requireAuth, (req, res) => {
  const resolved = resolveTemplateFile(req.params.file);
  if (!resolved) {
    return res.status(404).render('errors/404', { title: 'Not found', layout: false });
  }
  // SME Owner-TAM Evaluator only: count (consent-gated, counts only) that
  // the 50-row sample template was downloaded. No-op for every other role.
  logEvent(req.session.user, 'sample_template_downloaded', { category: resolved.row.sme_business_category });
  res.download(resolved.fullPath, resolved.row.template_file);
});

// GET /sme-templates/download-blank/:file — a headers-only copy of the same
// template (added 4 October 2026): the exact column set CMA-Flow expects
// for that category, zero data rows, for an owner to fill in with their own
// records offline and upload back at Upload Dataset. Built from the first
// line of the manifest-listed template file only (same path-traversal
// protection as /download), so it can never drift from the real template.
router.get('/sme-templates/download-blank/:file', requireAuth, (req, res) => {
  const resolved = resolveTemplateFile(req.params.file);
  if (!resolved) {
    return res.status(404).render('errors/404', { title: 'Not found', layout: false });
  }
  const raw = fs.readFileSync(resolved.fullPath, 'utf-8').replace(/^\uFEFF/, '');
  const headerLine = raw.split(/\r?\n/)[0];
  logEvent(req.session.user, 'blank_template_downloaded', { category: resolved.row.sme_business_category });
  const outName = resolved.row.template_file.replace(/_template\.csv$/i, '') + '_blank_template.csv';
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${outName}"`);
  res.send(headerLine + '\r\n');
});

// POST /sme-templates/set-evaluation-default — a Template Evaluator's or
// Business Owner Evaluator's own explicit choice of which template they
// want to use for the evaluation. This does two things, not just one: it
// records the choice (sme_accounts.evaluation_template_file, for the
// "browse these exact rows" page below), AND it makes that category's
// copy the account's default dataset (sme_accounts.default_dataset_id) —
// that second part is what makes "default" mean what it says: the
// Descriptive/Diagnostic/Predictive/Prescriptive pages (and Task 1's
// "Upload New Dataset" step) read an account's default dataset with no
// manual upload needed, so picking a template here is enough to drive all
// four analytics modules from it.
//
// Added 3 October 2026: checks for an existing copy of this category
// FIRST (findEvaluationCopyByCategory()) and, when one already exists,
// only switches which copy is current (setDefaultDataset()) — it does
// NOT re-ingest. Only a category this account has never picked before
// goes through the full ingestTemplateForEvaluation() (fresh copy from
// the static template CSV). This matters most for a Business Owner
// Evaluator switching back to a category it already has an EDITED copy
// of (routes/templates.js's own CRUD routes below): without this check,
// clicking "Use" to return to it would silently discard those edits by
// deleting and recreating that row from the pristine template every
// time. Safe for Template Evaluator too — it never edits its one
// dataset's rows (no CRUD UI for that role), so finding vs. re-ingesting
// the exact same category is observably identical either way for it.
router.post('/sme-templates/set-evaluation-default', requireTemplateEligible, async (req, res, next) => {
  try {
    const resolved = resolveTemplateFile(req.body.template_file);
    if (!resolved) {
      return res.redirect('/sme-templates');
    }

    const accountId = req.session.userId;
    const category = resolved.row.sme_business_category;

    let datasetRowId = await findEvaluationCopyByCategory(accountId, category);
    const reusedCopy = !!datasetRowId;
    if (datasetRowId) {
      await setDefaultDataset(accountId, datasetRowId);
    } else {
      const raw = fs.readFileSync(resolved.fullPath, 'utf-8');
      const records = parse(raw, { columns: true, skip_empty_lines: true });
      ({ datasetRowId } = await ingestTemplateForEvaluation(accountId, resolved, records));
    }
    await logEvent(req.session.user, 'prefilled_template_used', {
      category, datasetOrigin: 'prefilled', detail: { action: reusedCopy ? 'switched' : 'started' },
    });

    await pool.query(
      'UPDATE sme_accounts SET evaluation_template_file = $1 WHERE id = $2',
      [resolved.row.template_file, accountId],
    );
    req.session.user.evaluation_template_file = resolved.row.template_file;
    req.session.user.default_dataset_id = datasetRowId;

    res.redirect('/sme-templates');
  } catch (err) {
    next(err);
  }
});

// POST /sme-templates/start-blank — Business Owner Evaluator only (added
// 3 October 2026, per Brenda: "there is a button to select that the
// business owner will use the blank template, and can do all the CRUD
// operations, so their datasets will be treated as evaluation but real
// datasets"). This is the BLANK track's own counterpart to POST
// /sme-templates/set-evaluation-default just above: same category input
// (a manifest template_file, resolved the same way), but it ingests a
// zero-row copy (ingestBlankTemplateForEvaluation()) instead of the
// prefilled 50-row one, and the two tracks' existing-copy checks are
// deliberately separate (findBlankCopyByCategory() vs
// findEvaluationCopyByCategory()) so neither one's "already have one?
// switch, don't re-ingest" safety ever matches the other's row — a
// second "start blank" click for a category the account is already
// filling in with real rows must switch to that same copy, never
// silently wipe it by re-ingesting. requireBusinessOwner (not
// requireTemplateEligible), since full CRUD on a blank copy is a
// Business Owner Evaluator concept only — Template Evaluator keeps no UI
// path to this route at all (see views/dashboard/sme-templates.ejs).
router.post('/sme-templates/start-blank', requireBusinessOwner, async (req, res, next) => {
  try {
    const resolved = resolveTemplateFile(req.body.template_file);
    if (!resolved) {
      return res.redirect('/sme-templates');
    }

    const accountId = req.session.userId;
    const category = resolved.row.sme_business_category;

    let datasetRowId = await findBlankCopyByCategory(accountId, category);
    const reusedBlank = !!datasetRowId;
    if (datasetRowId) {
      await setDefaultDataset(accountId, datasetRowId);
    } else {
      ({ datasetRowId } = await ingestBlankTemplateForEvaluation(accountId, resolved));
    }
    await logEvent(req.session.user, 'blank_started', {
      category, datasetOrigin: 'blank', detail: { action: reusedBlank ? 'switched' : 'started' },
    });

    await pool.query(
      'UPDATE sme_accounts SET evaluation_template_file = $1 WHERE id = $2',
      [resolved.row.template_file, accountId],
    );
    req.session.user.evaluation_template_file = resolved.row.template_file;
    req.session.user.default_dataset_id = datasetRowId;

    // Straight to the editor for this copy — unlike picking a prefilled
    // template (which has 50 rows already to browse from /sme-templates
    // itself), a fresh blank copy's whole point is to start typing rows
    // in immediately.
    res.redirect(`/sme-templates/evaluation-dataset/${datasetRowId}`);
  } catch (err) {
    next(err);
  }
});

// GET /sme-templates/evaluation-data — browse/filter the exact rows of
// whichever template the Template Evaluator picked above. Reads the CSV
// straight off disk (it's the same static file /sme-templates/download
// serves) and hands every row + column name to the view; filtering itself
// happens client-side in the browser (see views/dashboard/
// evaluation-data-browser.ejs) since 50 rows is trivial to filter in the
// page without a round trip per filter change.
router.get('/sme-templates/evaluation-data', requireTemplateEligible, (req, res, next) => {
  try {
    const fileName = req.session.user.evaluation_template_file;
    const resolved = fileName && resolveTemplateFile(fileName);
    if (!resolved) {
      req.session.flashError = 'Choose a default CSV for evaluation first.';
      return res.redirect('/sme-templates');
    }
    const raw = fs.readFileSync(resolved.fullPath, 'utf-8');
    const records = parse(raw, { columns: true, skip_empty_lines: true });
    const columns = records.length ? Object.keys(records[0]) : [];
    res.render('dashboard/evaluation-data-browser', {
      title: 'Browse Evaluation CSV',
      // Its own active value (not 'sme-templates') so public/css/style.css
      // can give this page a wider layout and bigger, Excel-style table
      // without touching the Download SME Templates listing page, which
      // shares that route's 'sme-templates' value and must stay narrow —
      // see the body.stage-evaluation-data-browser rules there, and the
      // matching lookup in views/partials/sidebar.ejs that still treats
      // this value as "on the Download SME Templates page" for nav
      // highlighting (same pattern already used for 'evaluation-questionnaire'
      // next to 'evaluation').
      active: 'evaluation-data-browser',
      categoryLabel: resolved.row.sme_business_category,
      templateFile: resolved.row.template_file,
      columns,
      records,
    });
  } catch (err) {
    next(err);
  }
});

// Two reference documents alongside the per-category templates: the full
// field data dictionary (every field, every category, suggested type and
// analytics role) and the short analytics-readiness guidance README —
// both of Brenda's own source materials, offered as-is rather than
// reformatted into the app.
router.get('/sme-templates/reference/:file', requireAuth, (req, res) => {
  const allowed = {
    'field-data-dictionary': '00_CMAFlow_Field_Data_Dictionary.csv',
    'analytics-guidance': '00_README_CMAFlow_Analytics_Guidance.csv',
  };
  const fileName = allowed[req.params.file];
  if (!fileName) {
    return res.status(404).render('errors/404', { title: 'Not found', layout: false });
  }
  res.download(path.join(TEMPLATES_ROOT, fileName), fileName);
});

// GET /user-manual — added 3 October 2026, per Brenda's explicit
// request: a step-by-step guide to every process a Business Owner
// Evaluator goes through, reachable from the sidebar directly below
// their "Business Owner Evaluator Evaluation" link (views/partials/
// sidebar.ejs). Reachable by any signed-in account (requireAuth only,
// same discipline as /sme-templates above — the content below carries
// no participant data, so there's no reason to restrict it by role),
// but the sidebar only ever links to it for Business Owner Evaluator,
// since that's the one role the content is actually written for.
// middleware/evaluationGate.js allows this route at every lock state
// (added to ALWAYS_ALLOWED_PREFIXES, same as /evaluation and
// /sme-templates) — a brand-new, still-locked account is exactly who
// most needs it.
//
// WALKTHROUGH_TASKS/ISO_DOMAIN_LABELS/ISO25010_ITEMS are passed straight
// from services/tamEvaluation.js rather than re-typed into the view, so
// the manual's six-task table and questionnaire-domain summary can never
// silently drift out of sync with the actual instrument if either is
// revised later.
router.get('/user-manual', requireAuth, (req, res) => {
  // SME Owner-TAM Evaluator (added 4 October 2026) gets the same manual
  // with two sections swapped for its own direct-flow/TAM process — see
  // views/dashboard/user-manual.ejs's isSmeTam branches. Its questionnaire
  // summary reads the live SME_TAM_ITEMS/DOMAIN_LABELS the same way the
  // Business Owner branch reads ISO25010_ITEMS/ISO_DOMAIN_LABELS, so
  // neither can drift from its real instrument.
  const isSmeTam = !!(req.session.user && req.session.user.role === SME_TAM_ROLE);
  const items = isSmeTam ? SME_TAM_ITEMS : ISO25010_ITEMS;
  const isoDomainCounts = {};
  items.forEach((item) => {
    isoDomainCounts[item.domain] = (isoDomainCounts[item.domain] || 0) + 1;
  });
  res.render('dashboard/user-manual', {
    title: 'User Manual',
    active: 'user-manual',
    isSmeTam,
    tasks: WALKTHROUGH_TASKS,
    isoDomainLabels: isSmeTam ? DOMAIN_LABELS : ISO_DOMAIN_LABELS,
    isoDomainCounts,
    isoItemCount: items.length,
  });
});

// ------------------------------------------------------------------
// Business Owner Evaluator's own editable copies of the evaluation
// dataset — added 2 October 2026, per Brenda's explicit request: "allow
// the business owner to do CRUD operation on the dataset selected like
// in excel template", specifically so a Business Owner Evaluator can
// validate for themselves whether adding a row or changing a value
// actually changes what the four analytics modules compute. Extended 3
// October 2026, again per Brenda's explicit request, to a MULTI-copy
// model: picking a business category no longer replaces whatever copy
// the account already had — each category gets its own unique
// dataset_id (services/templateEvaluationIngest.js's datasetIdForCategory())
// and its own row in uploaded_datasets, so an account can hold several
// categories' worth of copies at once, each independently add/edit/
// delete-able, while the shared, read-only source template CSV under
// data/sme-templates/ is never written to by any of this — every route
// below reads and writes only this account's OWN already-ingested
// dataset_records rows (the exact rows Descriptive/Diagnostic/Predictive/
// Prescriptive compute from for whichever copy is currently "default"),
// never the static file. requireBusinessOwner (not requireTemplateEligible)
// gates all five: see that function's comment for why Template Evaluator
// is deliberately excluded.
// ------------------------------------------------------------------

// GET /sme-templates/evaluation-dataset — lists every copy this account
// currently holds (one per category it has picked), each linking to its
// own editor below. The account's own default_dataset_id (read fresh,
// not from session, so a switch made from another device/tab is never
// shown as stale) marks which one is "★ Current" — i.e. which copy Task
// 1 and the four analytics modules fall back to with no explicit
// ?dataset= chosen.
router.get('/sme-templates/evaluation-dataset', requireBusinessOwner, async (req, res, next) => {
  try {
    const accountId = req.session.userId;
    const [copies, { rows: acctRows }] = await Promise.all([
      listEvaluationDatasetCopies(accountId),
      pool.query('SELECT default_dataset_id FROM sme_accounts WHERE id = $1', [accountId]),
    ]);
    const defaultDatasetId = acctRows[0] ? acctRows[0].default_dataset_id : null;
    res.render('dashboard/evaluation-dataset-list', {
      title: 'My Evaluation Dataset Copies',
      // Same reasoning as the per-copy editor's own active value just
      // below — see that route's comment.
      active: 'evaluation-dataset-editor',
      copies,
      defaultDatasetId,
    });
  } catch (err) {
    next(err);
  }
});

// POST /sme-templates/evaluation-dataset/:datasetRowId/set-current — the
// listing page's own "Set as current" button: switches which existing
// copy is this account's default dataset WITHOUT touching its rows (just
// setDefaultDataset(), same as the "already have a copy of this category"
// branch of POST /sme-templates/set-evaluation-default above) — the
// non-destructive counterpart to that route for when the account already
// knows which copy (by id) it wants, rather than which category. Also
// keeps sme_accounts.evaluation_template_file in sync (resolved from this
// copy's own category back to its manifest template_file) since that
// column is still what Task 1's label and the read-only Template
// Evaluator page key off.
router.post('/sme-templates/evaluation-dataset/:datasetRowId/set-current', requireBusinessOwner, async (req, res, next) => {
  try {
    const accountId = req.session.userId;
    const datasetRowId = parseInt(req.params.datasetRowId, 10);
    if (!datasetRowId) return res.redirect('/sme-templates/evaluation-dataset');

    const datasetRow = await getEvaluationDatasetById(accountId, datasetRowId);
    if (!datasetRow) return res.redirect('/sme-templates/evaluation-dataset');

    await setDefaultDataset(accountId, datasetRow.id);

    const manifest = loadManifest();
    const manifestRow = manifest.find((r) => r.sme_business_category === datasetRow.domain);
    if (manifestRow) {
      await pool.query('UPDATE sme_accounts SET evaluation_template_file = $1 WHERE id = $2', [manifestRow.template_file, accountId]);
      req.session.user.evaluation_template_file = manifestRow.template_file;
    }
    req.session.user.default_dataset_id = datasetRow.id;

    res.redirect('/sme-templates/evaluation-dataset');
  } catch (err) {
    next(err);
  }
});

// GET /sme-templates/evaluation-dataset/:datasetRowId — the Excel-style
// CRUD grid for ONE specific copy, by its uploaded_datasets.id.
router.get('/sme-templates/evaluation-dataset/:datasetRowId', requireBusinessOwner, async (req, res, next) => {
  try {
    const accountId = req.session.userId;
    const datasetRowId = parseInt(req.params.datasetRowId, 10);
    if (!datasetRowId) return res.status(404).render('errors/404', { title: 'Not found', layout: false });

    const evalData = await loadEvaluationDataset(accountId, datasetRowId);
    if (!evalData) {
      req.session.flashError = 'Pick a business category template first, from Download SME Templates.';
      return res.redirect('/sme-templates');
    }
    // resolveColumnsForDataset() (above) is what makes a freshly-started
    // blank copy (zero rows) still show its full column grid, by reading
    // its category's template CSV header instead of row 0 — see that
    // function's own comment.
    const columns = resolveColumnsForDataset(evalData);
    // Drives the "Add new row" modal's per-field dropdowns — see
    // computeColumnChoices()'s own comment for the rule.
    const columnChoices = computeColumnChoices(columns, evalData.records);
    res.render('dashboard/evaluation-dataset-editor', {
      title: 'Edit Your Evaluation Dataset',
      // Own active value (not 'sme-templates') for the same reason
      // 'evaluation-data-browser' has one — see that route's comment —
      // plus views/partials/sidebar.ejs's matching lookup, extended to
      // treat this value as "on the Download SME Templates page" too.
      // Shared with the listing route above, so either page lights up
      // the same nav item.
      active: 'evaluation-dataset-editor',
      datasetRowId: evalData.datasetRowId,
      categoryLabel: evalData.categoryLabel,
      columns,
      records: evalData.records,
      columnChoices,
      // Added 3 October 2026 — see loadEvaluationDataset()'s own comment.
      // Only a blank-origin copy gets contenteditable cells and per-row
      // Delete in the view below; a prefilled copy stays exactly as
      // locked as it was before this feature existed.
      isBlankOrigin: evalData.isBlankOrigin,
    });
  } catch (err) {
    next(err);
  }
});

// POST /sme-templates/evaluation-dataset/:datasetRowId/rows — Create:
// appends one row (same columns as every existing row) at the next
// row_index, then bumps dataset_files so the four analytics modules
// recompute from it on next view. Refuses when the dataset has no rows
// yet to copy a column shape from — can't happen via the UI (which hides
// "Add row" in that case) but checked here too, since this is a real API
// a client could call with no UI in front of it.
//
// The new row's values come from the "Add row" modal's form
// (views/dashboard/evaluation-dataset-editor.ejs — added 3 October 2026,
// replacing the earlier "add a blank row, then edit each cell" flow): the
// request body carries a `data` object keyed by column name. Only keys
// that are already one of this dataset's own columns are accepted — never
// lets a request silently introduce a column the rest of the grid, and
// every analytics module reading this dataset, doesn't know about; any
// column missing from
// `data`, or sent with no `data` at all (the plain "+ Add row" case with
// no modal in front of it), falls back to ''. Every value is stored as a
// string, same shape as every CSV-ingested cell, so
// services/datasetProfiler.js's existing numeric/date coercion treats a
// typed-in cell exactly like an uploaded one.
router.post('/sme-templates/evaluation-dataset/:datasetRowId/rows', requireBusinessOwner, async (req, res, next) => {
  try {
    const accountId = req.session.userId;
    const datasetRowId = parseInt(req.params.datasetRowId, 10);
    if (!datasetRowId) return res.status(400).json({ error: 'bad_request' });

    const evalData = await loadEvaluationDataset(accountId, datasetRowId);
    if (!evalData) return res.status(404).json({ error: 'not_found' });

    // resolveColumnsForDataset() covers a freshly-started blank copy
    // (zero rows, columns read from its category's template header) as
    // well as a copy that already has rows — see that function's own
    // comment. This replaces the old hard refusal on "no rows yet," which
    // predates the blank-template feature and would otherwise block the
    // very first row ever added to a blank copy.
    const columns = resolveColumnsForDataset(evalData);
    if (columns.length === 0) {
      return res.status(400).json({ error: 'no_columns', message: 'This dataset has no columns to add a row against — pick a business category first.' });
    }
    const submitted = req.body && typeof req.body.data === 'object' && req.body.data !== null ? req.body.data : null;
    const newRow = {};
    columns.forEach((c) => {
      const v = submitted ? submitted[c] : undefined;
      newRow[c] = v === undefined || v === null ? '' : String(v);
    });

    const { rows: nextIndexRows } = await pool.query(
      `SELECT COALESCE(MAX(row_index), -1) + 1 AS next_index FROM dataset_records
        WHERE dataset_id = $1 AND account_id = $2 AND file_type = $3`,
      [evalData.datasetRowId, accountId, EVAL_FILE_TYPE]
    );
    const { rows: inserted } = await pool.query(
      `INSERT INTO dataset_records (dataset_id, account_id, file_type, row_index, data)
       VALUES ($1, $2, $3, $4, $5::jsonb) RETURNING id, data`,
      [evalData.datasetRowId, accountId, EVAL_FILE_TYPE, nextIndexRows[0].next_index, JSON.stringify(newRow)]
    );

    await touchEvaluationDataset(evalData.datasetRowId, accountId);
    await logEvent(req.session.user, 'row_added', {
      category: evalData.categoryLabel,
      datasetOrigin: evalData.isBlankOrigin ? 'blank' : 'prefilled',
    });
    res.json({ ok: true, row: inserted[0], columns });
  } catch (err) {
    next(err);
  }
});

// PATCH and DELETE /sme-templates/evaluation-dataset/:datasetRowId/rows/
// :recordId — removed entirely on 3 October 2026 (per Brenda: "the
// datasets is already past records, only allowing the business owners to
// Add New records"), then REINTRODUCED the same day, scoped ONLY to a
// blank-origin copy (loadEvaluationDataset()'s isBlankOrigin flag — see
// its own comment), per Brenda's follow-up request: a Business Owner
// Evaluator who started a copy blank is typing in their own real records
// from scratch, so those rows are never "already-recorded historical
// transactions" the way a prefilled copy's 50 synthetic rows are — full
// add/edit/delete makes sense there and nowhere else. A prefilled
// (EVALCOPY_/EVALUATION_DEFAULT) copy's rows stay exactly as locked as
// the comment above originally made them: both routes 403 immediately if
// isBlankOrigin is false, before touching a single row.
//
// Update: one cell at a time (column + new value), matching the editor's
// click-to-edit-a-cell UI (views/dashboard/evaluation-dataset-editor.ejs)
// rather than a whole-row replace — jsonb_set's own create_missing:true
// default means this also tolerates a row missing that key outright,
// though a blank-origin copy's rows are always written with every
// column present (this router's own POST /rows) so this should never
// actually need to create one.
router.patch('/sme-templates/evaluation-dataset/:datasetRowId/rows/:recordId', requireBusinessOwner, async (req, res, next) => {
  try {
    const accountId = req.session.userId;
    const datasetRowId = parseInt(req.params.datasetRowId, 10);
    const recordId = parseInt(req.params.recordId, 10);
    if (!datasetRowId || !recordId) return res.status(400).json({ error: 'bad_request' });

    const evalData = await loadEvaluationDataset(accountId, datasetRowId);
    if (!evalData) return res.status(404).json({ error: 'not_found' });
    if (!evalData.isBlankOrigin) {
      return res.status(403).json({ error: 'locked', message: "This copy's existing rows are locked — only a copy you started blank yourself can be edited here." });
    }

    const columns = resolveColumnsForDataset(evalData);
    const column = req.body && req.body.column;
    if (!column || !columns.includes(column)) {
      return res.status(400).json({ error: 'bad_column', message: 'Unknown column.' });
    }
    const value = req.body && req.body.value;
    const stringValue = value === undefined || value === null ? '' : String(value);

    const { rows: updated } = await pool.query(
      `UPDATE dataset_records SET data = jsonb_set(data, $1::text[], $2::jsonb, true)
        WHERE id = $3 AND dataset_id = $4 AND account_id = $5 AND file_type = $6
        RETURNING id, data`,
      [[column], JSON.stringify(stringValue), recordId, evalData.datasetRowId, accountId, EVAL_FILE_TYPE]
    );
    if (!updated[0]) return res.status(404).json({ error: 'not_found' });

    await touchEvaluationDataset(evalData.datasetRowId, accountId);
    res.json({ ok: true, row: updated[0] });
  } catch (err) {
    next(err);
  }
});

// Delete: removes one row outright. Scoped to isBlankOrigin, exactly
// like PATCH just above, for the same reason.
router.delete('/sme-templates/evaluation-dataset/:datasetRowId/rows/:recordId', requireBusinessOwner, async (req, res, next) => {
  try {
    const accountId = req.session.userId;
    const datasetRowId = parseInt(req.params.datasetRowId, 10);
    const recordId = parseInt(req.params.recordId, 10);
    if (!datasetRowId || !recordId) return res.status(400).json({ error: 'bad_request' });

    const evalData = await loadEvaluationDataset(accountId, datasetRowId);
    if (!evalData) return res.status(404).json({ error: 'not_found' });
    if (!evalData.isBlankOrigin) {
      return res.status(403).json({ error: 'locked', message: "This copy's existing rows are locked — only a copy you started blank yourself can have rows deleted here." });
    }

    const deleteResult = await pool.query(
      `DELETE FROM dataset_records WHERE id = $1 AND dataset_id = $2 AND account_id = $3 AND file_type = $4`,
      [recordId, evalData.datasetRowId, accountId, EVAL_FILE_TYPE]
    );
    if (!deleteResult.rowCount) return res.status(404).json({ error: 'not_found' });

    await touchEvaluationDataset(evalData.datasetRowId, accountId);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
