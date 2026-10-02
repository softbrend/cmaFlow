// SME business-category CSV templates — added 30 September 2026 for the
// Template Evaluator field-generalization round. A Template Evaluator picks
// an SME business category here, downloads its CSV template (the exact
// column set CMA-Flow expects for that category — see
// data/sme-templates/00_CMAFlow_SME_Template_Manifest.csv), fills it with
// a realistic (not necessarily their own live) dataset, and uploads it
// as Task 1 of the TAM walkthrough. Static reference data checked into
// the repo (not anything a user uploads), so it lives under data/, not
// uploads/ (which is gitignored and per-account).
//
// Reachable by any signed-in account (requireAuth only) — the SME
// business categories and field names here carry no participant data of
// any kind, so there is no reason to restrict them by role. It's only
// ever linked from the Template Evaluator's own sidebar branch (see
// views/partials/sidebar.ejs), and middleware/evaluationGate.js always
// allows /sme-templates regardless of lock state, the same as /evaluation
// itself, since a Template Evaluator needs a template before Task 1.
const express = require('express');
const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');
const { requireAuth } = require('../middleware/auth');
const pool = require('../db/pool');
const { ingestTemplateForEvaluation } = require('../services/templateEvaluationIngest');

const router = express.Router();
const TEMPLATES_ROOT = path.join(__dirname, '..', 'data', 'sme-templates');
const MANIFEST_PATH = path.join(TEMPLATES_ROOT, '00_CMAFlow_SME_Template_Manifest.csv');
const EXPERT_ROLE = 'Template Evaluator';

// Same shape as requireAdmin in middleware/auth.js — a signed-in account
// that isn't a Template Evaluator gets a plain 403, not a bounce to
// /login, since they ARE authenticated, just not the role this section
// (choosing/browsing the "default CSV for evaluation") is for. Kept
// local to this router since nothing outside routes/templates.js needs
// it yet.
function requireExpertEvaluator(req, res, next) {
  if (!(req.session && req.session.userId)) {
    req.session.flashError = 'Please sign in to continue.';
    return res.redirect('/login');
  }
  if (req.session.user && req.session.user.role === EXPERT_ROLE) {
    return next();
  }
  return res.status(403).render('errors/403', { title: 'Not authorized', layout: false });
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

router.get('/sme-templates', requireAuth, (req, res, next) => {
  try {
    const manifest = loadManifest();
    const user = req.session.user;
    // A Template Evaluator declares their business category at signup
    // (routes/auth.js's business_category field, stored in
    // sme_accounts.business_sector) — surfaced here so the row matching
    // that choice is easy to find rather than making them re-scan all 20.
    // null for an SME owner (whose business_sector is their own actual
    // sector, not one of these 20 categories necessarily) and for anyone
    // without a declared category yet.
    const assignedCategory = (user && user.role === 'Template Evaluator' && user.business_sector) || null;
    // Each of the 20 templates now ships with 50 synthetic rows (see
    // data/sme-templates/*_template.csv) built so they drive real output
    // across all four analytics modules. A Template Evaluator can mark one
    // as their "default CSV for evaluation" below and then browse/filter
    // its exact rows (GET /sme-templates/evaluation-data) to cross-check
    // report numbers against known source values — an SME owner has no
    // equivalent concept, since their reports are built from their own
    // uploaded data.
    const isExpertEvaluator = !!(user && user.role === EXPERT_ROLE);
    const isDirectFlow = isExpertEvaluator && user.evaluation_flow === 'direct';
    const evaluationTemplateFile = (isExpertEvaluator && user.evaluation_template_file) || null;
    res.render('dashboard/sme-templates', {
      title: 'Download SME Templates',
      active: 'sme-templates',
      manifest,
      assignedCategory,
      isExpertEvaluator,
      isDirectFlow,
      evaluationTemplateFile,
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
  res.download(resolved.fullPath, resolved.row.template_file);
});

// POST /sme-templates/set-evaluation-default — a Template Evaluator's own
// explicit choice of which template they want to use for the evaluation.
// This does two things, not just one: it records the choice (sme_accounts
// .evaluation_template_file, for the "browse these exact rows" page
// below), AND it actually ingests that template's 50 rows as this
// account's own working dataset — the same uploaded_datasets/
// dataset_files/dataset_records shape a real upload produces (see
// services/templateEvaluationIngest.js) — and sets it as their
// default_dataset_id. That second part is what makes "default" mean what
// it says: the Descriptive/Diagnostic/Predictive/Prescriptive pages (and
// Task 1's "Upload New Dataset" step) read an account's default dataset
// with no manual upload needed, so picking a template here is enough to
// drive all four analytics modules from it.
router.post('/sme-templates/set-evaluation-default', requireExpertEvaluator, async (req, res, next) => {
  try {
    const resolved = resolveTemplateFile(req.body.template_file);
    if (!resolved) {
      return res.redirect('/sme-templates');
    }

    const raw = fs.readFileSync(resolved.fullPath, 'utf-8');
    const records = parse(raw, { columns: true, skip_empty_lines: true });

    const { datasetRowId } = await ingestTemplateForEvaluation(req.session.userId, resolved, records);

    await pool.query(
      'UPDATE sme_accounts SET evaluation_template_file = $1 WHERE id = $2',
      [resolved.row.template_file, req.session.userId],
    );
    req.session.user.evaluation_template_file = resolved.row.template_file;
    req.session.user.default_dataset_id = datasetRowId;

    res.redirect('/sme-templates');
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
router.get('/sme-templates/evaluation-data', requireExpertEvaluator, (req, res, next) => {
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
      active: 'sme-templates',
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

module.exports = router;
