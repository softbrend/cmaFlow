// Round 22 — trains the semantic field classifier on the seed dataset
// (ml-data/seed-training-data.json), evaluates it on a held-out split,
// and saves the model + its evaluation metrics to ml-models/semantic-
// role-classifier.json (see services/semanticFieldClassifier.js's header
// for why Random Forest / why this isn't retrained on every server
// start).
//
// Run: node scripts/trainSemanticClassifier.js
const fs = require('fs');
const path = require('path');
const {
  trainModel, saveModel, evaluate,
} = require('../services/semanticFieldClassifier');

const SEED_PATH = path.join(__dirname, '..', 'ml-data', 'seed-training-data.json');
const TEST_FRACTION = 0.25;

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

function main() {
  if (!fs.existsSync(SEED_PATH)) {
    console.error(`Seed dataset not found at ${SEED_PATH} — run scripts/generateSeedTrainingData.js first.`);
    process.exit(1);
  }
  const seed = JSON.parse(fs.readFileSync(SEED_PATH, 'utf8'));
  console.log(`Loaded ${seed.rowCount} seed rows (source: ${seed.source}).`);

  const { train, test } = stratifiedSplit(seed.rows, TEST_FRACTION);
  console.log(`Train: ${train.length} rows, Test (held out): ${test.length} rows.`);

  const { classifier, labels } = trainModel(train);
  console.log(`Trained Random Forest on ${labels.length} classes: ${labels.join(', ')}`);

  const metrics = evaluate(classifier, labels, test);
  console.log('\n--- Evaluation (held-out test split) ---');
  console.log(`Overall accuracy: ${(metrics.accuracy * 100).toFixed(1)}%`);
  console.log(`Macro precision: ${(metrics.macroPrecision * 100).toFixed(1)}%  Macro recall: ${(metrics.macroRecall * 100).toFixed(1)}%  Macro F1: ${(metrics.macroF1 * 100).toFixed(1)}%`);
  console.log('\nPer-class:');
  metrics.perClass.forEach((c) => {
    const p = c.precision === null ? 'n/a' : `${(c.precision * 100).toFixed(0)}%`;
    const r = c.recall === null ? 'n/a' : `${(c.recall * 100).toFixed(0)}%`;
    const f = c.f1 === null ? 'n/a' : `${(c.f1 * 100).toFixed(0)}%`;
    console.log(`  ${c.label.padEnd(18)} precision=${p.padEnd(6)} recall=${r.padEnd(6)} f1=${f.padEnd(6)} support=${c.support}`);
  });

  // Now retrain on the FULL seed dataset (train+test) for the model
  // that actually ships — held-out evaluation above is what earns the
  // reported metrics; the shipped model itself should use every labeled
  // example available, which is standard practice once evaluation is
  // done and reported.
  const full = trainModel(seed.rows);
  const savedPath = saveModel(full.classifier, full.labels, {
    ...metrics,
    trainedOn: 'full-seed-dataset',
    evaluatedOn: 'held-out-25pct-stratified-split',
    seedRowCount: seed.rowCount,
    trainedAt: new Date().toISOString(),
  });
  console.log(`\nSaved model (trained on full ${seed.rowCount}-row seed set) to ${savedPath}`);
}

main();
