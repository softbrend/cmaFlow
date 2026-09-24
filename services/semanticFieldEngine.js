// Round 22 — Semantic Field Detection Engine, hybrid orchestrator.
//
// Blends three independent signals for "what business role does this
// column play" — exactly the architecture the integration request asked
// for (rule-based profiling + embeddings + a supervised classifier +
// confidence-gated human feedback):
//   1. RULE score — services/businessSemantics.js's ROLE_RULES, unchanged,
//      tuned across 21 prior rounds of live verification on real SME
//      datasets (Olist, Airbnb, synthetic e-commerce, ...).
//   2. EMBEDDING score — services/semanticEmbeddings.js's word-vector
//      similarity between the column's own name and every role's concept
//      phrases, which is what lets CMA-Flow recognize a name it has never
//      literally seen (the request's own worked example: "selling_amt",
//      "gross_merch_value" reading as REVENUE without a dedicated regex).
//   3. CLASSIFIER score — services/semanticFieldClassifier.js's Random
//      Forest, trained on structural/statistical/pattern/contextual
//      features (services/semanticFeatureExtraction.js), which is what
//      lets a column with an AMBIGUOUS or unfamiliar name still resolve
//      correctly from how its VALUES behave (a customer_id-shaped column
//      that happens to be named something odd).
//
// Deliberately AUGMENTS the rule engine rather than replacing it: a
// column the rule engine already resolved with HIGH confidence keeps
// that rule-only result untouched (21 rounds of tuning stays
// authoritative for the cases it already handles well) — the hybrid
// blend only ever RUNS for a column the rule engine left unresolved or
// only weakly resolved (Medium/Low band), where ML evidence has real
// room to help rather than second-guess a proven call. This is the
// "CMA-Flow should never blindly accept every ML prediction" principle
// from the integration request, applied structurally rather than just as
// a confidence threshold.
const businessSemantics = require('./businessSemantics');
const { scoreColumnNameAgainstRoles } = require('./semanticEmbeddings');
const { extractColumnFeatures } = require('./semanticFeatureExtraction');
const { predictProbabilities, isModelAvailable } = require('./semanticFieldClassifier');
const { knownRoles } = require('./semanticFieldOntology');

// Sums to 1.0 when the classifier is available; when it isn't (model
// file missing/corrupt — see semanticFieldClassifier.js's defensive
// load), RULE_W/EMBED_W are rescaled proportionally so the blend still
// sums to 1.0 on just those two signals. Rule engine kept dominant
// (0.55) — it is the one component with 21 rounds of real-dataset
// verification behind it; the two ML signals are additive help, not
// co-equal votes, consistent with this round's own "augment, don't
// override a confident rule result" design.
const RULE_W = 0.55;
const EMBED_W = 0.20;
const CLASSIFIER_W = 0.25;

// Proposal's own confidence-banding thresholds (integration request,
// section 5): >=0.90 auto-accept, 0.70-0.89 accept-but-flag, <0.70 ask.
// Deliberately a SEPARATE scale from businessSemantics.js's own
// bandName()/ACCEPT_THRESHOLD (0.5/0.7 cut points) — this is the
// SME-facing confirmation-gating scale, not the internal rule-acceptance
// scale; the two serve different purposes and conflating them would blur
// "is this role plausible at all" with "should a human be asked."
const AUTO_ACCEPT_THRESHOLD = 0.90;
const FLAG_THRESHOLD = 0.70;

// Below this, nothing in the known ontology reads as a plausible match
// at all (by embedding similarity) — a real candidate for
// UNKNOWN_NEW_ROLE rather than just a weak fit for an existing role.
const NOVELTY_SIMILARITY_THRESHOLD = 0.45;

function confidenceBand(score) {
  if (score >= AUTO_ACCEPT_THRESHOLD) return { band: 'High', action: 'auto-accept' };
  if (score >= FLAG_THRESHOLD) return { band: 'Medium', action: 'flag-for-confirmation' };
  return { band: 'Low', action: 'ask-sme' };
}

// Every role whose declared expectedKinds includes this column's kind —
// the SAME hard kind-gate the rule engine itself enforces, applied here
// independent of whether the column's NAME hinted at the role at all
// (scoreAllColumnRoleCandidates additionally requires a name hint for
// non-id kinds — deliberately loosened here, since recognizing an
// unfamiliar name via embeddings/classifier is the entire point).
function kindPlausibleRoles(kind) {
  return businessSemantics.ROLE_RULES.filter((r) => r.expectedKinds.has(kind)).map((r) => r.role);
}

// Scores ONE column across rules + embeddings + classifier and returns
// the single best-blended role, fully explainable (every component's own
// contribution is kept, not just the final number) — never a bare score
// handed to the view layer, the same discipline businessSemantics.js's
// own scoreColumnRoles() already follows.
function inferColumnRoleHybrid(col, fileProfile, relationships) {
  if (businessSemantics.ID_LIKE_EXCLUDE_RE && businessSemantics.ID_LIKE_EXCLUDE_RE.test(col.name) && col.kind !== 'id') return null;

  const ruleCandidates = businessSemantics.scoreAllColumnRoleCandidates(col, fileProfile, relationships);
  const ruleByRole = new Map(ruleCandidates.map((c) => [c.role, c]));

  const embedding = scoreColumnNameAgainstRoles(col.name);

  let classifierProbs = null;
  if (isModelAvailable()) {
    const { vector } = extractColumnFeatures(col, fileProfile);
    classifierProbs = predictProbabilities(vector);
  }
  const classifierAvailable = !!classifierProbs;
  const effRuleW = classifierAvailable ? RULE_W : RULE_W / (RULE_W + EMBED_W);
  const effEmbedW = classifierAvailable ? EMBED_W : EMBED_W / (RULE_W + EMBED_W);
  const effClassifierW = classifierAvailable ? CLASSIFIER_W : 0;

  const candidateRoles = kindPlausibleRoles(col.kind);
  let best = null;
  candidateRoles.forEach((role) => {
    const ruleEntry = ruleByRole.get(role);
    const ruleScore = ruleEntry ? ruleEntry.confidence : 0;
    const embedScore = embedding.perRole[role] || 0;
    const classifierScore = classifierAvailable ? (classifierProbs[role] || 0) : 0;
    const blended = (ruleScore * effRuleW) + (embedScore * effEmbedW) + (classifierScore * effClassifierW);

    if (!best || blended > best.confidence) {
      const evidence = ruleEntry ? [...ruleEntry.evidence] : [`no rule-based naming pattern matched "${col.name}" for ${role.replace(/_/g, ' ')}`];
      evidence.push(`name-embedding similarity to "${role.replace(/_/g, ' ')}" concept phrases: ${(embedScore * 100).toFixed(0)}%`);
      if (classifierAvailable) evidence.push(`classifier vote share for ${role.replace(/_/g, ' ')}: ${(classifierScore * 100).toFixed(0)}% (Random Forest, trained on a synthetic seed dataset — see claude/machine-learning-semantic-field-detection-engine.md)`);
      best = {
        role,
        confidence: Math.round(blended * 1000) / 1000,
        ruleScore,
        embedScore,
        classifierScore: classifierAvailable ? classifierScore : null,
        evidence,
        relationshipEdge: ruleEntry ? ruleEntry.relationshipEdge : null,
      };
    }
  });

  if (!best) return null;
  const { band, action } = confidenceBand(best.confidence);
  const isCandidateNewRole = best.confidence < FLAG_THRESHOLD && embedding.bestScore < NOVELTY_SIMILARITY_THRESHOLD;
  return {
    ...best,
    band,
    confirmationAction: action,
    isCandidateNewRole,
    source: 'hybrid',
  };
}

// Column-level entry point mirroring businessSemantics.js's
// inferColumnSemanticRoles(), but hybrid — used by buildSemanticModelHybrid
// below. Deliberately does NOT special-case the file's own date column
// here (buildSemanticModelHybrid starts from the rule engine's own
// baseline model, which already assigned that role with confidence 1 —
// see below).
function inferColumnRolesForFile(fileProfile, relationships) {
  const roles = {};
  fileProfile.columns.forEach((col) => {
    const hybrid = inferColumnRoleHybrid(col, fileProfile, relationships);
    if (hybrid && hybrid.confidence >= businessSemantics.ACCEPT_THRESHOLD) roles[col.name] = hybrid;
  });
  return roles;
}

// Whole-dataset orchestration. Starts from businessSemantics.js's own
// buildSemanticModel() (pure rule-based — unchanged, including its
// revenue<->cost reclassification pass and file-role classification) as
// the authoritative baseline, then ENHANCES only the columns that
// baseline left unresolved or resolved with Medium/Low confidence,
// using the hybrid blend. A column the rule engine already resolved with
// HIGH confidence is never touched.
//
// A column the hybrid layer newly recognizes DOES feed back into
// classifyFileRole() and the fact-file selection below — a file the rule
// engine initially left "unclassified" because its only revenue-shaped
// column had an unfamiliar name (verified live this round with a
// synthetic "gmv" column) correctly becomes the transaction fact table
// once the hybrid layer resolves that column. Known, disclosed scope
// limit that remains: businessSemantics.js's OWN internal
// reclassifyAmbiguousRevenueAsCost() pass (revenue<->cost disambiguation
// by cloud-billing vocabulary/vendor-dimension context) runs only once,
// inside buildSemanticModel(), BEFORE the hybrid layer's enhancements —
// a column the hybrid layer newly recognizes as 'revenue' is never
// re-examined for that specific reclassification. Deliberately deferred
// rather than exporting and re-running that internal pass here too, to
// keep this round's change set additive and independently testable, the
// same scoping discipline rounds 17 and 20 already documented for
// similar cross-cutting follow-on work.
function buildSemanticModelHybrid(fileProfiles, relationships) {
  let baseline;
  try {
    baseline = businessSemantics.buildSemanticModel(fileProfiles, relationships);
  } catch (err) {
    // The rule engine must never fail because of this module — if
    // buildSemanticModel itself throws, that's a pre-existing bug
    // unrelated to the hybrid layer; surface it exactly as before.
    throw err;
  }

  const pendingReview = [];
  const fileProfileByType = new Map(fileProfiles.map((fp) => [fp.fileType, fp]));

  let hybridApplied = true;
  try {
    baseline.files.forEach((fileEntry) => {
      const fp = fileProfileByType.get(fileEntry.fileType);
      if (!fp) return;
      fp.columns.forEach((col) => {
        const existing = fileEntry.columnRoles[col.name];
        if (existing && existing.band === 'High') return; // rule engine already confident — leave it alone
        if (existing && existing.role === 'date') return; // the file's own date column, always trusted as-is

        const hybrid = inferColumnRoleHybrid(col, fp, relationships);
        if (!hybrid) return;

        if (!existing || hybrid.confidence > existing.confidence) {
          fileEntry.columnRoles[col.name] = hybrid;
        }

        const finalEntry = fileEntry.columnRoles[col.name];
        if (finalEntry && (finalEntry.band !== 'High' || finalEntry.isCandidateNewRole)) {
          pendingReview.push({
            fileType: fileEntry.fileType,
            columnName: col.name,
            role: finalEntry.role,
            confidence: finalEntry.confidence,
            band: finalEntry.band,
            confirmationAction: finalEntry.confirmationAction || (finalEntry.band === 'Medium' ? 'flag-for-confirmation' : 'ask-sme'),
            isCandidateNewRole: !!finalEntry.isCandidateNewRole,
            evidence: finalEntry.evidence,
          });
        }
      });
    });
    // Re-run file-role classification now that hybrid-enhanced columns
    // may have added evidence the baseline pass never saw (e.g. a
    // revenue column the rule engine missed entirely, only recognized
    // via embedding/classifier) — the SAME re-classification pattern
    // businessSemantics.js's own buildSemanticModel() already uses after
    // ITS OWN reclassifyAmbiguousRevenueAsCost() pass, applied here for
    // the analogous reason: column roles changed, so the file-level
    // verdict that reads them needs a fresh pass too. Verified live this
    // round: without this, a file whose only revenue-shaped column had
    // an unfamiliar name (e.g. "gmv") stayed "unclassified" even after
    // the hybrid layer correctly recognized that column as revenue.
    baseline.files.forEach((fileEntry, i) => {
      Object.assign(fileEntry, businessSemantics.classifyFileRole(fileProfiles[i], fileEntry.columnRoles, relationships, fileProfiles));
    });
    const factCandidates = baseline.files.filter((f) => f.role === 'transaction_fact');
    baseline.factFileType = factCandidates.length
      ? factCandidates.sort((a, b) => b.confidence - a.confidence || b.rowCount - a.rowCount)[0].fileType
      : null;
  } catch (err) {
    // The hybrid enhancement pass is optional by design — a bug or
    // missing dependency (e.g. the model/embedding packages) here must
    // degrade to the pure rule-based baseline, never break dataset
    // profiling. Logged, not swallowed silently.
    console.error('[semanticFieldEngine] hybrid enhancement pass failed, falling back to rule-only model:', err.message);
    hybridApplied = false;
  }

  return { ...baseline, pendingReview: hybridApplied ? pendingReview : [], hybridApplied };
}

module.exports = {
  inferColumnRoleHybrid,
  inferColumnRolesForFile,
  buildSemanticModelHybrid,
  confidenceBand,
  AUTO_ACCEPT_THRESHOLD,
  FLAG_THRESHOLD,
  NOVELTY_SIMILARITY_THRESHOLD,
};
