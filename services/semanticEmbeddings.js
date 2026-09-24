// Round 22 — Semantic Field Detection Engine, embedding layer.
//
// Turns a column name into a word-embedding vector and scores it against
// every known role's concept phrases (services/semanticFieldOntology.js),
// so a column CMA-Flow has never literally seen a name for — "selling_amt",
// "gross_merch_value", "gmv" — can still be recognized as semantically
// close to a role it knows, the way a Sentence-BERT-style embedding
// comparison would, per the integration request this round implements.
//
// WHY wink-nlp + wink-embeddings-sg-100d instead of the originally-chosen
// @xenova/transformers (Sentence-BERT-style transformer embeddings):
// this sandbox's network egress allowlist blocks huggingface.co outright
// (confirmed: every huggingface.co/hf.co request returns a proxy-level
// 403, while registry.npmjs.org is explicitly allowlisted), so
// @xenova/transformers could not download ANY model here to build or
// verify against, at all. Rather than build an untestable code path, this
// round switched to wink-nlp (github.com/winkjs) + its companion
// wink-embeddings-sg-100d package: 341,479 pretrained 100-dimensional
// English word vectors, shipped as npm package DATA (no runtime download,
// no external host, ever, on any machine) — fetched once via `npm
// install` from registry.npmjs.org, the one host this environment (and
// essentially every real network) can always reach. That actually
// satisfies the ROUND'S OWN chosen rationale for transformers.js — "no
// network egress at inference time" — even more completely than
// transformers.js would have: there is no runtime model download step to
// depend on at all, on this sandbox OR on the live Windows deployment,
// so results are reproducible from a clean `npm install` on either
// machine. See claude/machine-learning-semantic-field-detection-engine.md
// for the full disclosure and the before/after verification numbers.
//
// Sentence embeddings here are simple mean-pooled word vectors (a
// well-established, citable baseline technique predating transformer
// sentence encoders) with one added preprocessing step: abbreviation
// expansion (semanticFieldOntology.ABBREVIATION_EXPANSIONS) — "amt" ->
// "amount", "qty" -> "quantity" — verified in this round to fix a real
// failure mode where raw abbreviations collapsed to the model's generic
// out-of-vocabulary vector and produced false-positive similarity noise
// across unrelated columns (e.g. "customer_no" reading as close to
// REVENUE before expansion).
const winkNLP = require('wink-nlp');
const model = require('wink-eng-lite-web-model');
const vectors = require('wink-embeddings-sg-100d');
const similarity = require('wink-nlp/utilities/similarity.js');
const { ROLE_ONTOLOGY, ABBREVIATION_EXPANSIONS, knownRoles } = require('./semanticFieldOntology');

const nlp = winkNLP(model, ['sbd'], vectors);
const its = nlp.its;
const as = nlp.as;

// In-process caches — this module is loaded once per server process and
// the vocabulary/concept-phrase set never changes at runtime, so both the
// concept-phrase vectors and any column-name vector are safe to memoize
// for the lifetime of the process. Same discipline already used by
// getOrBuildBusinessContext()'s in-process ctx cache (see round 19's
// Environment notes on when a process-lifetime Map, vs. a DB column, is
// the right cache shape for large/ephemeral vs. small/persisted data —
// these are small (100-dim float arrays), ephemeral, and per-process, so
// a Map is correct here too).
const nameVectorCache = new Map();
let conceptVectorCache = null;

function expandAbbreviations(text) {
  return text
    .split(/\s+/)
    .map((word) => ABBREVIATION_EXPANSIONS[word.toLowerCase()] || word)
    .join(' ');
}

// Column name -> readable text -> mean-pooled word vector. Ignores
// punctuation/stop-type tokens the same way this package's own
// documented example does (its.type === 'word' only) so a name like
// "order_id" doesn't get diluted by the underscore itself.
function textToVector(text) {
  const expanded = expandAbbreviations(text);
  const doc = nlp.readDoc(expanded);
  return doc.tokens()
    .filter((t) => t.out(its.type) === 'word')
    .out(its.value, as.vector);
}

function columnNameToVector(columnName) {
  if (nameVectorCache.has(columnName)) return nameVectorCache.get(columnName);
  const readable = columnName.replace(/[_\-.]+/g, ' ').trim();
  const vec = readable ? textToVector(readable) : null;
  nameVectorCache.set(columnName, vec);
  return vec;
}

function cosine(a, b) {
  if (!a || !b) return 0;
  return similarity.vector.cosine(a, b);
}

function buildConceptVectors() {
  if (conceptVectorCache) return conceptVectorCache;
  const table = {};
  Object.entries(ROLE_ONTOLOGY).forEach(([role, entry]) => {
    table[role] = entry.conceptPhrases.map((phrase) => textToVector(phrase));
  });
  conceptVectorCache = table;
  return table;
}

// Scores ONE column name against EVERY known role's concept phrases,
// returning a role -> similarity map (0..1, cosine similarity against
// the role's best-matching phrase) plus which role scored highest and by
// how much margin over the runner-up — the margin is what
// semanticFieldEngine.js uses to decide how much to trust this signal:
// a narrow margin (as seen live on ambiguous short names like
// "customer_no" in this round's own verification) means embeddings
// genuinely can't distinguish the candidates, and should defer more to
// the rule engine's structural/pattern evidence rather than override it.
function scoreColumnNameAgainstRoles(columnName) {
  const nameVec = columnNameToVector(columnName);
  const conceptVectors = buildConceptVectors();
  const perRole = {};
  let best = null;
  let bestScore = -Infinity;
  let secondScore = -Infinity;
  knownRoles().forEach((role) => {
    const sims = conceptVectors[role].map((cv) => cosine(nameVec, cv));
    const score = sims.length ? Math.max(...sims) : 0;
    perRole[role] = Math.round(score * 1000) / 1000;
    if (score > bestScore) { secondScore = bestScore; bestScore = score; best = role; } else if (score > secondScore) { secondScore = score; }
  });
  return {
    perRole,
    bestRole: best,
    bestScore: Math.round(Math.max(bestScore, 0) * 1000) / 1000,
    margin: Math.round((bestScore - secondScore) * 1000) / 1000,
  };
}

// Novelty signal for UNKNOWN_NEW_ROLE detection (services/
// semanticFieldEngine.js): the single highest similarity this column name
// reached against ANY known role's concept phrases at all. When this is
// low, the name doesn't read as close to anything CMA-Flow currently
// knows — a real candidate for a new semantic role, not just a weak fit
// for an existing one.
function maxSimilarityToAnyKnownRole(columnName) {
  return scoreColumnNameAgainstRoles(columnName).bestScore;
}

module.exports = {
  columnNameToVector,
  cosine,
  scoreColumnNameAgainstRoles,
  maxSimilarityToAnyKnownRole,
  expandAbbreviations, // exported for services/semanticFeatureExtraction.js and tests
};
