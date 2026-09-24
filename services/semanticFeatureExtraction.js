// Round 22 — Semantic Field Detection Engine, feature extraction.
//
// Builds ONE fixed-length numeric feature vector for a column, combining
// exactly the evidence categories the integration request asked for:
//   - Name features: the column-name embedding's similarity to every
//     known role (services/semanticEmbeddings.js) — 18 features, one per
//     role in the ontology.
//   - Structural features: kind (one-hot), uniqueness ratio, null ratio.
//   - Statistical features: mean/max magnitude (log-scaled), coefficient
//     of variation, whether negative values occur.
//   - Pattern features: currency-kind flag, percentage-kind flag,
//     bounded-small-range flag (the same "looks like a 0-5/0-10 rating,
//     not a raw count" check services/businessSemantics.js's own rule
//     table already uses).
//   - Contextual features: does this column's FILE look transactional
//     (has a date column, an event-id-shaped column, a customer-id-shaped
//     column)? A lightweight name-pattern proxy, deliberately NOT a call
//     into services/businessSemantics.js's own fileLooksTransactional()
//     (kept private to that module) — duplicating three cheap regex
//     tests here is simpler and safer than exporting an internal helper
//     across a service boundary for one caller.
//
// Pure function, no I/O — same discipline as services/datasetProfiler.js
// and services/businessSemantics.js. The output is a plain array of
// numbers (FEATURE_NAMES gives the name for each index, for
// inspectability/debugging) so it can feed either the classifier
// (services/semanticFieldClassifier.js) or a training-data row.
const { scoreColumnNameAgainstRoles } = require('./semanticEmbeddings');
const { knownRoles } = require('./semanticFieldOntology');

const KINDS = ['numeric', 'currency', 'percentage', 'rating', 'id', 'date', 'boolean', 'category', 'text', 'url', 'geo_lat', 'geo_lng'];
const ROLES = knownRoles();

const EVENT_ID_NAME_RE = /\b(order|transaction|invoice|txn|receipt|booking|reservation)s?[_]?id\b|^(order|transaction|txn)$/i;
const CUSTOMER_ID_NAME_RE = /\b(customer|user|client|member|buyer|guest|shopper|reviewer)s?[_]?id\b/i;

function fileContextFeatures(fileProfile) {
  const cols = (fileProfile && fileProfile.columns) || [];
  const hasDate = cols.some((c) => c.kind === 'date' && c.count > 0);
  const hasEventId = cols.some((c) => c.kind === 'id' && EVENT_ID_NAME_RE.test(c.name));
  const hasCustomerLikeId = cols.some((c) => c.kind === 'id' && CUSTOMER_ID_NAME_RE.test(c.name));
  return [hasDate ? 1 : 0, hasEventId ? 1 : 0, hasCustomerLikeId ? 1 : 0];
}

const FEATURE_NAMES = [
  ...KINDS.map((k) => `kind_${k}`),
  'uniqueRatio', 'nullRatio', 'meanMagnitudeLog', 'maxMagnitudeLog', 'coefficientOfVariation',
  'hasNegativeValues', 'looksBoundedSmall', 'looksFraction01',
  'file_hasDate', 'file_hasEventId', 'file_hasCustomerLikeId',
  ...ROLES.map((r) => `embedSim_${r}`),
];

function safeLog(x) {
  return Math.log10(Math.abs(x) + 1);
}

// col: one column profile (services/datasetProfiler.js's profileColumn()
// shape). fileProfile: the owning file's full profile (for context
// features). Returns { vector: number[], names: string[] } — names
// repeated on every call rather than cached statically-only for
// readability; the array itself is the same FEATURE_NAMES constant.
function extractColumnFeatures(col, fileProfile) {
  const kindOneHot = KINDS.map((k) => (col.kind === k ? 1 : 0));

  const totalRows = (col.count || 0) + (col.missing || 0);
  const nullRatio = totalRows > 0 ? (col.missing || 0) / totalRows : 0;
  let uniqueRatio = 0.5; // neutral default for kinds with no meaningful uniqueness concept (date/boolean/text)
  if (typeof col.uniqueCount === 'number' && col.count > 0) uniqueRatio = col.uniqueCount / col.count;
  else if (typeof col.uniquenessRatio === 'number') uniqueRatio = col.uniquenessRatio;

  const mean = typeof col.mean === 'number' ? col.mean : 0;
  const max = typeof col.max === 'number' ? col.max : 0;
  const min = typeof col.min === 'number' ? col.min : 0;
  const cv = typeof col.cv === 'number' && Number.isFinite(col.cv) ? Math.min(col.cv, 500) / 500 : 0; // capped + normalized to 0..1
  const hasNegative = (col.negativeCount || 0) > 0 ? 1 : 0;
  const looksBoundedSmall = (col.max !== null && col.max !== undefined && col.max <= 10 && col.min !== null && col.min !== undefined && col.min >= 0) ? 1 : 0;
  const looksFraction01 = (max <= 1 && min >= 0 && col.kind !== undefined) ? 1 : 0;

  const embedding = scoreColumnNameAgainstRoles(col.name);
  const embedFeatures = ROLES.map((r) => embedding.perRole[r] || 0);

  const vector = [
    ...kindOneHot,
    uniqueRatio, nullRatio, safeLog(mean), safeLog(max), cv,
    hasNegative, looksBoundedSmall, looksFraction01,
    ...fileContextFeatures(fileProfile),
    ...embedFeatures,
  ];

  return { vector, names: FEATURE_NAMES, embedding };
}

module.exports = {
  extractColumnFeatures,
  FEATURE_NAMES,
  KINDS,
  ROLES,
};
