// Semantic-Role Inference evaluation — Step 1 of 2 (Node.js).
//
// Why this step exists in Node, not Python: CAAGA's Semantic Field
// Detection Engine (services/semanticFieldEngine.js, documented in
// claude/machine-learning-semantic-field-detection-engine.md) is a
// JavaScript module — rule engine + word-embedding similarity + a
// Random Forest classifier, all running in-process inside this app.
// There is no faithful way to get "what CAAGA actually predicted" from
// Python without literally re-running CAAGA's own code, so this script
// calls the exact same functions production uses
// (getOrBuildFullProfile -> buildSemanticModelHybrid) against every
// dataset already sitting in cmaDB, and writes the results to a CSV.
// Step 2 (evaluate_semantic_role_inference.py) then does the actual
// precision/recall/F1/macro-F1/kappa statistics in Python, against that
// CSV plus your two raters' independent labels — matching the paper's
// Section 4.4 procedure and filling in Section 5.2 / Table 3.
//
// Usage (run from the project root, D:\CMAFlow-Balala, with your real
// .env / DATABASE_URL pointed at the database that actually has the
// seventeen user-supplied datasets):
//
//   node scripts/exportSemanticRoleEvaluation.js
//
// Output: caaga_role_predictions.csv and rater_labeling_template.csv in
// the current directory.
require('dotenv').config();
const fs = require('fs');
const pool = require('../db/pool');
const { getOrBuildFullProfile } = require('../services/fullDescriptiveAnalytics');
const { buildSemanticModelHybrid } = require('../services/semanticFieldEngine');

// ---------------------------------------------------------------------
// IMPORTANT — fill this in before running for real.
//
// cmaDB accumulates every account ever created, including development/
// QA test accounts (auditbot01, verifybot01, icontest10, and similar)
// that are NOT part of the seventeen genuine user-supplied datasets the
// manuscript evaluates. List the exact `dataset_id` values (the short
// code shown in the app, e.g. "SME_Retail_07" — NOT the numeric
// database id) for the seventeen datasets you want included. Leaving
// this empty makes the script include every dataset it finds and print
// a loud warning, which is useful for a first look but should not be
// what you actually run the evaluation against.
// ---------------------------------------------------------------------
const INCLUDE_DATASET_IDS = [
  // 'SME_Retail_07',
  // 'SME_Cafe_03',
  // ... exactly the seventeen dataset_id values the paper evaluates
];

// ---------------------------------------------------------------------
// Coarse role mapping — CAAGA's 19 granular semantic roles (services/
// semanticFieldOntology.js) collapsed onto the manuscript's Table 3
// nine-role reporting scheme (plus 'other' for anything CAAGA left
// unresolved). THIS MAPPING IS A METHODOLOGICAL CHOICE, not a technical
// fact — state it explicitly in the paper's Section 4.4 procedure text
// so a reviewer can see exactly how granular engine output was collapsed
// to the reporting categories. A few of these are judgment calls worth
// re-checking against your own rater instructions before you commit to
// them:
//   - 'discount' -> Monetary amount (it's a $ or % adjustment to price)
//   - 'duration'  -> Quantity (closest existing bucket; there is no
//                    separate "Duration" row in Table 3)
//   - 'name_label' -> Free text (product/customer/item names read as
//                    unstructured text rather than a controlled
//                    vocabulary like Category)
// ---------------------------------------------------------------------
const COARSE_ROLE_MAP = {
  customer_id: 'Identifier',
  merchant_id: 'Identifier',
  product_id: 'Identifier',
  order_id: 'Identifier',
  date: 'Date/time',
  revenue: 'Monetary amount',
  price: 'Monetary amount',
  cost: 'Monetary amount',
  profit: 'Monetary amount',
  discount: 'Monetary amount',
  quantity: 'Quantity',
  duration: 'Quantity',
  cost_category: 'Category',
  subscription_plan: 'Category',
  rating: 'Rating',
  geo_dimension: 'Geography',
  status: 'Status',
  availability: 'Status',
  name_label: 'Free text',
};

function csvEscape(v) {
  const s = v === null || v === undefined ? '' : String(v);
  return `"${s.replace(/"/g, '""')}"`;
}

function writeCsv(path, header, rows) {
  const lines = [header, ...rows].map((r) => r.map(csvEscape).join(','));
  fs.writeFileSync(path, lines.join('\n') + '\n');
}

async function main() {
  const { rows: datasets } = await pool.query(
    `SELECT id, account_id, dataset_id, dataset_name FROM uploaded_datasets ORDER BY id`
  );

  const scoped = INCLUDE_DATASET_IDS.length
    ? datasets.filter((d) => INCLUDE_DATASET_IDS.includes(d.dataset_id))
    : datasets;

  if (!INCLUDE_DATASET_IDS.length) {
    console.warn(
      `WARNING: INCLUDE_DATASET_IDS is empty — running against ALL ${datasets.length} datasets in the ` +
      `database, which almost certainly includes non-paper test/QA accounts, not just the seventeen ` +
      `user-supplied ones the manuscript describes. Fill in INCLUDE_DATASET_IDS at the top of this file ` +
      `and re-run before using these numbers in the paper.`
    );
  } else if (scoped.length !== INCLUDE_DATASET_IDS.length) {
    console.warn(
      `WARNING: INCLUDE_DATASET_IDS lists ${INCLUDE_DATASET_IDS.length} dataset(s) but only ${scoped.length} ` +
      `were found in the database — check for typos or datasets that were deleted/renamed.`
    );
  }

  const predRows = [];
  const templateRows = [];

  function countRoledColumns(model) {
    return model.files.reduce((n, f) => n + Object.keys(f.columnRoles || {}).length, 0);
  }

  for (const ds of scoped) {
    const { files, relationships } = await getOrBuildFullProfile(ds.account_id, ds.id);
    if (!files.length) {
      console.warn(`  (skipping ${ds.dataset_id} — no files/profile found)`);
      continue;
    }

    const model = buildSemanticModelHybrid(files, relationships);

    model.files.forEach((fileEntry) => {
      const fp = files.find((f) => f.fileType === fileEntry.fileType);
      if (!fp) return;
      fp.columns.forEach((col) => {
        const roleEntry = fileEntry.columnRoles[col.name];
        const granular = roleEntry ? roleEntry.role : null;
        const coarse = granular ? (COARSE_ROLE_MAP[granular] || 'other') : 'other';

        predRows.push([
          ds.dataset_id, ds.dataset_name, fileEntry.fileType, col.name,
          granular || '', coarse,
          roleEntry ? roleEntry.confidence : '',
          roleEntry ? roleEntry.band : '',
        ]);
        templateRows.push([ds.dataset_id, ds.dataset_name, fileEntry.fileType, col.name, '', '', '']);
      });
    });

    console.log(`Processed ${ds.dataset_id} (${countRoledColumns(model)} columns).`);
  }

  writeCsv(
    'caaga_role_predictions.csv',
    ['dataset_id', 'dataset_name', 'file_type', 'column_name', 'caaga_role_granular', 'caaga_role_coarse', 'confidence', 'band'],
    predRows
  );
  writeCsv(
    'rater_labeling_template.csv',
    ['dataset_id', 'dataset_name', 'file_type', 'column_name', 'rater1_label', 'rater2_label', 'resolved_label'],
    templateRows
  );

  console.log('');
  console.log(`Wrote caaga_role_predictions.csv — ${predRows.length} columns across ${scoped.length} dataset(s).`);
  console.log(`Wrote rater_labeling_template.csv — fill in rater1_label / rater2_label independently, then`);
  console.log(`resolved_label after the two raters discuss any disagreement. Valid labels (Table 3's nine`);
  console.log(`roles, plus 'other' for anything that fits none of them):`);
  console.log(`  Identifier, Date/time, Monetary amount, Quantity, Category, Rating, Geography, Status, Free text, other`);

  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
