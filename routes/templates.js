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
const { ingestTemplateForEvaluation } = require('../services/templateEvaluationIngest');

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

function usesTemplateSystem(role) {
  return role === EXPERT_ROLE || role === BUSINESS_ROLE;
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
router.post('/sme-templates/set-evaluation-default', requireTemplateEligible, async (req, res, next) => {
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

module.exports = router;
