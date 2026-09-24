// Round 22 — periodic/batch retraining, folding accumulated SME feedback
// (field_role_feedback, written by GET/POST /dataset/:id/review-fields)
// into the classifier's next training run.
//
// Deliberately NOT run automatically after every single confirmation —
// the integration request's own section 6 explicitly recommends against
// that ("I recommend periodic/batch retraining, not automatically
// changing the production model after every single upload. That prevents
// one incorrect SME label from immediately corrupting future
// classifications."). This script is meant to be run by hand
// (`node scripts/retrainSemanticClassifier.js`) once real feedback has
// accumulated — there is no scheduled task wired up to call it, and it
// should stay that way until enough confirmed labels exist for a
// person to sanity-check the resulting metrics before they ship.
//
// Real SME-confirmed rows are recovered from field_role_feedback by
// looking each column back up in its dataset_profiles.profile JSONB
// (the SAME cached column-stat profile the live engine itself reads) and
// re-running services/semanticFeatureExtraction.js's extractColumnFeatures()
// on it — this guarantees the retrain uses features computed EXACTLY the
// same way the live app computes them for a fresh column, not a
// separately-maintained copy of that logic.
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const pool = require('../db/pool');
const { extractColumnFeatures } = require('../services/semanticFeatureExtraction');
const {
  trainModel, saveModel, evaluate,
} = require('../services/semanticFieldClassifier');

const SEED_PATH = path.join(__dirname, '..', 'ml-data', 'seed-training-data.json');
const TEST_FRACTION = 0.25;

async function loadRealFeedbackRows() {
  const { rows: feedback } = await pool.query(
    `SELECT dataset_id, file_type, column_name, confirmed_role
       FROM field_role_feedback`
  );
  if (feedback.length === 0) return [];

  const profileCache = new Map(); // `${dataset_id}\u0000${file_type}` -> profile JSONB
  const rows = [];
  for (const fb of feedback) {
    const cacheKey = `${fb.dataset_id}\u0000${fb.file_type}`;
    let profile = profileCache.get(cacheKey);
    if (profile === undefined) {
      const { rows: profRows } = await pool.query(
        `SELECT profile FROM dataset_profiles WHERE dataset_id = $1 AND file_type = $2`,
        [fb.dataset_id, fb.file_type]
      );
      profile = profRows[0] ? profRows[0].profile : null;
      profileCache.set(cacheKey, profile);
    }
    if (!profile) continue; // dataset/file since deleted or never profiled — skip, can't recover features
    const col = profile.columns.find((c) => c.name === fb.column_name);
    if (!col) continue;
    const { vector } = extractColumnFeatures(col, profile);
    rows.push({
      columnName: fb.column_name, role: fb.confirmed_role, vector, source: 'sme-confirmed',
    });
  }
  return rows;
}

function stratifiedSplit(rows, testFraction) {
  const byRole = new Map();
  rows.forEach((r) => {
    if (!byRole.has(r.role)) byRole.set(r.role, []);
    byRole.get(r.role).push(r);
  });
  const train = [];
  const test = [];
  byRole.forEach((group) => {
    const nTest = Math.max(1, Math.round(group.length * testFraction));
    test.push(...group.slice(0, nTest));
    train.push(...group.slice(nTest));
  });
  return { train, test };
}

async function main() {
  if (!fs.existsSync(SEED_PATH)) {
    console.error(`Seed dataset not found at ${SEED_PATH} — run scripts/generateSeedTrainingData.js first.`);
    process.exit(1);
  }
  const seed = JSON.parse(fs.readFileSync(SEED_PATH, 'utf8'));
  const realRows = await loadRealFeedbackRows();

  console.log(`Seed rows (synthetic): ${seed.rowCount}`);
  console.log(`Real SME-confirmed rows recovered from field_role_feedback: ${realRows.length}`);
  if (realRows.length === 0) {
    console.log('No real feedback yet — nothing new to fold in. Run this again once SME owners have confirmed some fields on /dataset/:id/review-fields.');
  }

  const combined = [...seed.rows, ...realRows];
  const { train, test } = stratifiedSplit(combined, TEST_FRACTION);
  console.log(`Combined training pool: ${combined.length} rows. Train: ${train.length}, Test (held out): ${test.length}.`);

  const { classifier, labels } = trainModel(train);
  const metrics = evaluate(classifier, labels, test);
  console.log(`\nHeld-out accuracy: ${(metrics.accuracy * 100).toFixed(1)}%  Macro F1: ${(metrics.macroF1 * 100).toFixed(1)}%`);

  const full = trainModel(combined);
  const savedPath = saveModel(full.classifier, full.labels, {
    ...metrics,
    trainedOn: 'seed-plus-sme-feedback',
    seedRowCount: seed.rowCount,
    realFeedbackRowCount: realRows.length,
    evaluatedOn: 'held-out-25pct-stratified-split',
    trainedAt: new Date().toISOString(),
  });
  console.log(`\nSaved retrained model (${combined.length} total rows, ${realRows.length} of them real SME feedback) to ${savedPath}`);
  await pool.end();
}

main().catch((err) => {
  console.error('Retraining failed:', err);
  process.exit(1);
});
