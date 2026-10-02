// Single source of truth for the 20 SME Business Categories — reads
// data/sme-templates/00_CMAFlow_SME_Template_Manifest.csv, the same
// manifest routes/templates.js serves to the "Download SME Templates"
// page. Shared here so the Template Evaluator signup's category dropdown
// (routes/auth.js, views/auth/expert-signup.ejs) can never drift out of
// sync with the actual downloadable templates — one edit to the manifest
// CSV updates both places at once, rather than a hardcoded list in two
// files slowly going stale against each other.
const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');

const MANIFEST_PATH = path.join(__dirname, '..', 'data', 'sme-templates', '00_CMAFlow_SME_Template_Manifest.csv');

// Re-reads the manifest on every call rather than caching — this is a
// 20-row CSV read at signup-form-render time and at submit-validation
// time only (never on a hot path), so the simplicity of "always current
// with whatever's on disk" outweighs the cost of re-parsing it.
function loadCategories() {
  const raw = fs.readFileSync(MANIFEST_PATH, 'utf-8');
  const rows = parse(raw, { columns: true, skip_empty_lines: true });
  return rows.map((r) => ({ name: r.sme_business_category, examples: r.examples }));
}

function isValidCategory(name) {
  return loadCategories().some((c) => c.name === name);
}

// Reverse lookup of loadCategories()/routes/templates.js's own manifest
// read — given a stored sme_accounts.evaluation_template_file (a CSV
// filename, e.g. "07_retail_ecommerce_template.csv"), returns the
// matching sme_business_category string ("Retail & E-Commerce"), or null
// if the file isn't in the manifest (should never happen for a value this
// app itself wrote, but a route rendering a walkthrough card is not the
// place to throw over a stale/edited manifest). Added 2 October 2026 so
// views/dashboard/evaluation-walkthrough.ejs's Task 1 card can show the
// category name for the dataset auto-assigned at signup (routes/auth.js's
// ingestDefaultTemplateForCategory()) without re-implementing the CSV
// read routes/templates.js and services/templateEvaluationIngest.js
// already each do their own version of.
function labelForTemplateFile(templateFile) {
  if (!templateFile) return null;
  const raw = fs.readFileSync(MANIFEST_PATH, 'utf-8');
  const rows = parse(raw, { columns: true, skip_empty_lines: true });
  const row = rows.find((r) => r.template_file === templateFile);
  return row ? row.sme_business_category : null;
}

module.exports = { loadCategories, isValidCategory, labelForTemplateFile };
