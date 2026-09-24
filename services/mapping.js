// Mapping-suggestion engine: given the actual column names found in one
// uploaded CSV (whatever they happen to be — every SME owner's dataset can
// differ) and a target CMA canonical entity, suggest which source column
// feeds each canonical field, with a confidence score. This is step one of
// "Transform" in the Clean -> Normalize -> Transform -> Tag -> Enrich ->
// Validate -> Freeze pipeline: nothing here is final until the SME owner
// reviews and confirms it in the mapping-review screen.
const { CANONICAL_ENTITIES } = require('../db/canonicalSchema');

// Lowercase and strip everything but letters/digits, so "Usage Start Date",
// "usage_start_date", and "UsageStartDate" all normalize the same way and
// can be compared against the synonym lists in canonicalSchema.js.
function normalizeHeader(header) {
  return String(header || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

// Score how well one source column matches one canonical field's synonym
// list. 1.0 = exact normalized match; 0.9 down to 0.8 = listed synonym
// match, graduated by the matched synonym's position in its field's
// synonym list (see below); 0.6 = one string contains the other; 0 = no
// relation at all.
//
// The synonym tier is graduated — rather than a flat 0.9 for every listed
// synonym — so that when several of a file's columns tie for the same
// canonical field (e.g. a cloud cost export where "Rounded Cost ($)",
// "Unrounded Cost ($)", and "Total Cost (INR)" all match `amount`'s
// synonym list), the tiebreak is the AUTHORED order of that field's
// synonyms in db/canonicalSchema.js — earlier entries are written as the
// more canonical/preferred name for that field — instead of falling back
// to arbitrary CSV column order via Array.sort's stability. The spread is
// capped at 0.1 regardless of list length, so it always stays above the
// 0.6 partial-match tier and below the 1.0 exact-field-name tier.
function scoreMatch(normalizedColumn, fieldKey, synonyms) {
  if (normalizedColumn === normalizeHeader(fieldKey)) return 1.0;
  const synIndex = synonyms.indexOf(normalizedColumn);
  if (synIndex !== -1) return 0.9 - (synIndex / synonyms.length) * 0.1;
  const partial = synonyms.some((syn) => (
    syn.length >= 3 && (normalizedColumn.includes(syn) || syn.includes(normalizedColumn))
  ));
  if (partial) return 0.6;
  return 0;
}

// Returns { [canonicalFieldKey]: { source: <original column name>|null,
//   confidence: 0-1, required: bool, description: string } } for every
// field of the given entity. Greedy, highest-confidence-first assignment
// so the same source column is never suggested for two canonical fields.
function suggestMapping(columns, entityName) {
  const entity = CANONICAL_ENTITIES[entityName];
  if (!entity) throw new Error(`Unknown canonical entity: ${entityName}`);

  const normalizedColumns = columns.map((c) => ({ original: c, normalized: normalizeHeader(c) }));
  const fieldKeys = Object.keys(entity.fields);

  // Build every (field, column) candidate score, sort best-first, then
  // greedily assign — this way a column that's a perfect match for one
  // field won't get "stolen" by a weaker partial match on another field
  // processed earlier.
  const candidates = [];
  fieldKeys.forEach((fieldKey) => {
    const { synonyms } = entity.fields[fieldKey];
    normalizedColumns.forEach(({ original, normalized }) => {
      const score = scoreMatch(normalized, fieldKey, synonyms);
      if (score > 0) candidates.push({ fieldKey, original, score });
    });
  });
  candidates.sort((a, b) => b.score - a.score);

  const result = {};
  const usedColumns = new Set();
  fieldKeys.forEach((fieldKey) => {
    result[fieldKey] = {
      source: null,
      confidence: 0,
      required: !!entity.fields[fieldKey].required,
      description: entity.fields[fieldKey].description,
      derivable: entity.fields[fieldKey].derivable || null,
    };
  });

  candidates.forEach(({ fieldKey, original, score }) => {
    if (result[fieldKey].source !== null) return; // field already assigned
    if (usedColumns.has(original)) return;        // column already claimed
    result[fieldKey].source = original;
    result[fieldKey].confidence = score;
    usedColumns.add(original);
  });

  return result;
}

// Content-aware entity classifier — the primary signal behind guessEntity()
// below. Reuses the SAME synonym lists each canonical field already
// carries in db/canonicalSchema.js (the ones suggestMapping() scores
// columns against) rather than a second, parallel keyword list that could
// drift out of sync as fields are added — for every one of the four
// entities, sums the best column-match score across its fields, and
// separately tracks whether every one of that entity's REQUIRED fields has
// at least one plausible column. A file whose columns can't satisfy an
// entity's required fields at all (e.g. an AWS/GCP price-list export with
// no customer/account column anywhere — every row would fail Validate no
// matter how the SME owner maps it) is disqualified from that entity,
// which is exactly the mismatch behind a dataset showing "0 valid" after
// transform with no obvious cause on the page.
function classifyFileShape(columns) {
  const normalizedColumns = columns.map((c) => normalizeHeader(c)).filter(Boolean);
  const scores = {};
  const requiredSatisfied = {};

  Object.entries(CANONICAL_ENTITIES).forEach(([entityName, entitySpec]) => {
    let score = 0;
    let requiredCount = 0;
    let requiredMatched = 0;
    Object.entries(entitySpec.fields).forEach(([fieldKey, fieldSpec]) => {
      const isRequired = !!fieldSpec.required;
      if (isRequired) requiredCount += 1;
      let best = 0;
      normalizedColumns.forEach((col) => {
        const s = scoreMatch(col, fieldKey, fieldSpec.synonyms || []);
        if (s > best) best = s;
      });
      if (best > 0) {
        score += best;
        if (isRequired) requiredMatched += 1;
      }
    });
    scores[entityName] = score;
    requiredSatisfied[entityName] = requiredCount === 0 || requiredMatched === requiredCount;
  });

  return { scores, requiredSatisfied };
}

// Non-authoritative default-entity suggester for the Map & Transform
// screen. Two signals, in priority order:
//
// 1. The file's ACTUAL columns (classifyFileShape() above), when any were
//    passed in — a direct read of what this file can validly become, not
//    a guess from its name. Only entities whose required fields are all
//    satisfiable by at least one column are considered; among those, the
//    one with the highest total field-coverage score wins. This is what
//    correctly defaults a pure AWS/GCP rate-card export (SKU, RateCode,
//    PriceDescription, EffectiveDate, PricePerUnit — no customer column
//    anywhere) to MonetizationConfig instead of the old filename fallback
//    of Transaction, which could never validate a single row from that
//    shape of data.
// 2. A fallback keyword match on the file's free-form file_type slug
//    (e.g. "feature_usage", "churn_events", "accounts") — used only when
//    no columns were supplied (an empty file) or no entity's required
//    fields could be satisfied by any column at all.
//
// Either way this is only a starting point on the Map & Transform screen;
// the SME owner is always free to pick a different entity, since neither
// a file's columns nor its name ever authoritatively determine its
// canonical entity (see db/canonicalSchema.js).
const ENTITY_KEYWORDS = {
  Customer: ['account', 'customer', 'client', 'subscriber', 'tenant', 'user', 'contact', 'company'],
  Entitlement: ['subscription', 'entitlement', 'license', 'plan', 'seat', 'access', 'membership'],
  MonetizationConfig: ['pricing', 'price', 'rate', 'config', 'sku', 'tier', 'catalog', 'offer'],
  Transaction: ['transaction', 'usage', 'event', 'billing', 'invoice', 'charge', 'payment',
    'order', 'churn', 'ticket', 'support', 'activity', 'log'],
};

function guessEntity(fileTypeSlug, columns = []) {
  if (columns && columns.length > 0) {
    const { scores, requiredSatisfied } = classifyFileShape(columns);
    const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1]);
    const viable = ranked.filter(([entityName]) => requiredSatisfied[entityName]);
    if (viable.length > 0 && viable[0][1] > 0) return viable[0][0];

    // No entity's required fields are fully satisfiable by this file's
    // columns (e.g. a usage/cost export with real field coverage but no
    // customer/account column anywhere — the SME_Provider_02/AWS GCP cost
    // file is exactly this shape). Still prefer the closest-matching
    // entity by total column coverage over the blind filename fallback
    // below, as long as SOMETHING in the file matched SOMETHING — this
    // keeps the starting suggestion grounded in what the file actually
    // contains. The required field that's missing shows up explicitly on
    // the Map & Transform screen (see unmappableRequired in
    // routes/dashboard.js) rather than silently producing 0 valid rows
    // with no visible cause.
    if (ranked.length > 0 && ranked[0][1] > 0) return ranked[0][0];
  }

  const words = String(fileTypeSlug || '').split('_').filter(Boolean);
  const joined = words.join('');
  let best = null;
  let bestScore = 0;

  Object.entries(ENTITY_KEYWORDS).forEach(([entity, keywords]) => {
    keywords.forEach((kw) => {
      if (words.includes(kw) || joined.includes(kw)) {
        if (kw.length > bestScore) { bestScore = kw.length; best = entity; }
      }
    });
  });

  // Most SME operational files are event/record-shaped (usage logs,
  // billing exports, tickets, ...), so that's the safest generic fallback
  // when no keyword hits at all — still just a starting suggestion.
  return best || 'Transaction';
}

// Non-authoritative default-model-type suggester for the "Import from
// Canonical Schema" screen (Set-up Monetization Configuration): given a
// raw model_type value found in frozen MonetizationConfig canonical
// records (e.g. "Pay-As-You-Go", "Recurring Plan"), guesses which of the
// four CMA revenue-model enum values it maps to. Same non-authoritative
// spirit as guessEntity() above — this only pre-selects a starting point
// on the import review form; the SME owner always confirms or changes it
// explicitly before anything becomes an active configuration. Returns
// null when nothing matches, which the caller treats as "no suggestion".
const MODEL_TYPE_KEYWORDS = {
  subscription: ['subscription', 'subscribe', 'recurring', 'monthly', 'annual', 'plan'],
  freemium: ['freemium', 'free'],
  pay_per_use: ['payperuse', 'payasyougo', 'usage', 'metered', 'ondemand', 'consumption', 'perunit', 'perusage'],
  data_as_a_service: ['dataasaservice', 'daas', 'dataservice', 'apiaccess'],
};

function guessConfigModelType(rawValue) {
  const normalized = normalizeHeader(rawValue);
  if (!normalized) return null;

  let best = null;
  let bestScore = 0;
  Object.entries(MODEL_TYPE_KEYWORDS).forEach(([modelType, keywords]) => {
    keywords.forEach((kw) => {
      if (normalized.includes(kw) && kw.length > bestScore) {
        bestScore = kw.length;
        best = modelType;
      }
    });
  });
  return best;
}

module.exports = {
  suggestMapping, normalizeHeader, guessEntity, guessConfigModelType,
};
