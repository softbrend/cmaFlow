// SME business-category CSV templates — added 30 September 2026 for the
// Expert Evaluator field-generalization round. An Expert Evaluator picks
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
// ever linked from the Expert Evaluator's own sidebar branch (see
// views/partials/sidebar.ejs), and middleware/evaluationGate.js always
// allows /sme-templates regardless of lock state, the same as /evaluation
// itself, since an Expert Evaluator needs a template before Task 1.
const express = require('express');
const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
const TEMPLATES_ROOT = path.join(__dirname, '..', 'data', 'sme-templates');
const MANIFEST_PATH = path.join(TEMPLATES_ROOT, '00_CMAFlow_SME_Template_Manifest.csv');

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
    // An Expert Evaluator declares their business category at signup
    // (routes/auth.js's business_category field, stored in
    // sme_accounts.business_sector) — surfaced here so the row matching
    // that choice is easy to find rather than making them re-scan all 20.
    // null for an SME owner (whose business_sector is their own actual
    // sector, not one of these 20 categories necessarily) and for anyone
    // without a declared category yet.
    const assignedCategory = (user && user.role === 'Expert Evaluator' && user.business_sector) || null;
    res.render('dashboard/sme-templates', {
      title: 'Download SME Templates',
      active: 'sme-templates',
      manifest,
      assignedCategory,
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
