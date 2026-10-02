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

module.exports = { loadCategories, isValidCategory };
