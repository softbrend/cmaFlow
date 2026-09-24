// Priority + Confidence Engine — CAAGA Stage 6. Formalizes the ranking
// step the CAAGA algorithm write-up specifies (claude/cma-flow-app-
// conceptual-framework-audit.md, Round 17) but that this codebase never
// actually implemented before now: eligible findings were shown in fixed
// definition order, or sorted by a single statistical metric (a
// correlation, a chi-square, a coefficient of variation) — never RANKED by
// a blend of business relevance, statistical strength, data quality,
// semantic confidence, actionability, and computational cost the way a
// real "which of these 12 findings deserves the SME's attention first"
// decision should be.
//
// Priority(A) = w1*R + w2*S + w3*Q + w4*C + w5*X - w6*K
//   R = business relevance   (does this finding touch a core financial KPI?)
//   S = statistical strength (how strong/certain is the underlying association?)
//   Q = data quality         (how much good, non-missing evidence backs it?)
//   C = semantic confidence  (how sure is CAAGA Stage 2 about the columns used?)
//   X = actionability        (does the finding name a concrete lever, not just a trend?)
//   K = computational cost   (how much of the dataset did this scan?)
//
// Every input is normalized to [0, 1] before the weights are applied, so
// the weights themselves are the only place "how much does X matter"
// is decided — and they're fixed constants declared once, here, rather
// than tuned per dataset or silently changed between runs (the CAAGA
// document's own validation-plan section calls this out explicitly).
//
// A separate Confidence(finding) score is NOT the same number as
// Priority — CAAGA's write-up keeps them distinct on purpose: Priority
// asks "how much does this deserve the SME's attention", Confidence asks
// "how much should the SME trust it if they do look". A finding can be
// low-priority-but-certain (a small, well-measured effect) or
// high-priority-but-shaky (a big swing on a thin sample) — collapsing
// them into one number would hide that distinction.
const clamp01 = (x) => (Number.isFinite(x) ? Math.max(0, Math.min(1, x)) : 0);

// Weights sum to 1 across the five positive terms; the cost penalty is a
// modest, separate subtraction so a merely-expensive-to-compute finding is
// never ranked below a cheap-but-weak one purely on cost. Declared as a
// named export (not a local const) specifically so a future validation
// round can run the documented ablation ("remove one weight, compare
// rankings against expert judgment") without editing this file — see
// claude/cma-flow-app-conceptual-framework-audit.md's Round 17 entry.
const DEFAULT_PRIORITY_WEIGHTS = Object.freeze({
  R: 0.30, S: 0.25, Q: 0.15, C: 0.15, X: 0.15, K: 0.10,
});

function bandFor(score) {
  // Identical thresholds to services/businessSemantics.js's bandName() —
  // a 0.72 "High" should mean the same thing everywhere in this app, not
  // a different cutoff depending on which engine computed it.
  return score >= 0.7 ? 'High' : score >= 0.4 ? 'Medium' : 'Low';
}

// factors: { relevance, strength, quality, confidence, actionability, cost }
// — every field already expected in [0, 1]; this function does not
// re-normalize them (see the individual normalize* helpers below for that),
// so a caller that hands in an out-of-range number gets it clamped here as
// a last line of defense, not silently trusted.
function computePriority(factors, weights = DEFAULT_PRIORITY_WEIGHTS) {
  const R = clamp01(factors.relevance);
  const S = clamp01(factors.strength);
  const Q = clamp01(factors.quality);
  const C = clamp01(factors.confidence);
  const X = clamp01(factors.actionability);
  const K = clamp01(factors.cost);
  const raw = (weights.R * R) + (weights.S * S) + (weights.Q * Q)
    + (weights.C * C) + (weights.X * X) - (weights.K * K);
  const score = clamp01(raw);
  return {
    score: Math.round(score * 1000) / 1000,
    band: bandFor(score),
    factors: {
      relevance: R, strength: S, quality: Q, semanticConfidence: C, actionability: X, cost: K,
    },
  };
}

// Confidence(finding) — CAAGA's write-up: "a separate confidence score can
// combine semantic certainty, sample sufficiency, missingness, model
// validation quality, and stability across resamples." This codebase has
// no bootstrap/resampling infrastructure (a real stability measure would
// need one), so `stability` here is an honest, documented PROXY — sample
// size cleared relative to a 3x-of-minimum bar — not a resampled estimate;
// see the file-level comment in services/diagnosticEngine.js's
// scoreDiagnosticFinding() for exactly how each input is derived per
// finding type, and claude/cma-flow-app-conceptual-framework-audit.md's
// Round 17 "Still open" note for what a real stability measure would need.
function computeConfidence({
  semanticConfidence, sampleSufficiency, missingnessRatio, stability,
}) {
  const parts = [
    clamp01(semanticConfidence),
    clamp01(sampleSufficiency),
    clamp01(1 - (missingnessRatio || 0)),
    clamp01(stability),
  ];
  const score = parts.reduce((s, v) => s + v, 0) / parts.length;
  return { score: Math.round(score * 1000) / 1000, band: bandFor(score) };
}

// How far past a stated minimum sample size a finding's actual sample
// sits, reaching full credit at `targetMultiple`x the minimum rather than
// exactly at it — a diagnostic that JUST clears its own applicability gate
// (e.g. exactly 20 paired rows where 20 is the minimum) is real but thin;
// one with 3x that margin is meaningfully more trustworthy, and this
// should read as higher quality/confidence, not identical to the bare
// minimum.
function sufficiencyRatio(actualN, minRequiredN, targetMultiple = 3) {
  if (!minRequiredN || minRequiredN <= 0) return actualN > 0 ? 1 : 0;
  return clamp01(actualN / (minRequiredN * targetMultiple));
}

// Cramér's V — the standard chi-square-based association-strength measure,
// naturally bounded to [0, 1] (unlike the raw chi-square statistic itself,
// which grows with sample size and has no fixed ceiling). V = sqrt(chi2 /
// (n * (min(rows, cols) - 1))). Used wherever a diagnostic finding's
// strongest signal is a chi-square test (cancellation, payment behavior,
// repeat purchase) rather than a correlation/eta/Cohen's d, all three of
// which are already naturally bounded and just need clamp01().
function cramersVFromChiSquare(chiSquare, n, rowCount, colCount) {
  if (!Number.isFinite(chiSquare) || !n || n <= 0) return 0;
  const minDim = Math.max(1, Math.min(rowCount || 2, colCount || 2) - 1);
  return clamp01(Math.sqrt(chiSquare / (n * minDim)));
}

// Cohen's d has no fixed upper bound the way a correlation coefficient
// does (d=0.2 is conventionally "small", d=0.8 "large", but d=5 is
// possible on a clean synthetic separation) — squashed via d/(d+1) so a
// "large" effect (0.8) still reads around 0.44 and only an extreme,
// near-total separation approaches 1, rather than a naive clamp(d) that
// would treat any d >= 1 as maximal strength.
function normalizeCohensD(d) {
  if (!Number.isFinite(d)) return 0;
  const abs = Math.abs(d);
  return clamp01(abs / (abs + 1));
}

function normalizeCorrelation(r) {
  return Number.isFinite(r) ? clamp01(Math.abs(r)) : 0;
}

module.exports = {
  DEFAULT_PRIORITY_WEIGHTS,
  clamp01,
  bandFor,
  computePriority,
  computeConfidence,
  sufficiencyRatio,
  cramersVFromChiSquare,
  normalizeCohensD,
  normalizeCorrelation,
};
