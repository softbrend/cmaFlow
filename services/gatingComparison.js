// Admin-only "Gating Comparison" — DB access layer answering a peer-
// review recommendation: does CAAGA's eligibility/suppression gate (the
// "applicable: false rather than a fabricated number" discipline, see
// claude/caaga-algorithm-revised.md) actually add value? An Admin runs
// Predictive/Prescriptive Analytics against the SAME already-uploaded
// dataset twice — once with gate_mode='on' (the evidence-strength
// thresholds enforced exactly as every real SME owner already
// experiences them), once with gate_mode='off' (the same thresholds
// deliberately relaxed, simulating a naively permissive tool) — while
// every gate decision made along the way is logged here, so the two runs
// can be counted and compared afterward.
//
// This module ONLY persists events a caller hands it; it never decides
// what counts as a gate or recomputes anything itself — that discipline
// lives in services/predictiveAnalyticsDynamic.js and services/
// prescriptiveEngine.js (see their own gateMode/onGateEvent comments).
const pool = require('../db/pool');

async function startRun(datasetRowId, adminAccountId, gateMode, notes = null) {
  const { rows } = await pool.query(
    `INSERT INTO gating_comparison_runs (dataset_row_id, admin_account_id, gate_mode, notes)
     VALUES ($1, $2, $3, $4) RETURNING id, dataset_row_id, gate_mode, started_at`,
    [datasetRowId, adminAccountId, gateMode, notes]
  );
  return rows[0];
}

async function getRun(runId) {
  const { rows } = await pool.query(
    `SELECT r.id, r.dataset_row_id, r.admin_account_id, r.gate_mode, r.started_at, r.notes,
            ud.dataset_name, ud.dataset_id AS dataset_short_id
       FROM gating_comparison_runs r
       JOIN uploaded_datasets ud ON ud.id = r.dataset_row_id
      WHERE r.id = $1`,
    [runId]
  );
  return rows[0] || null;
}

// Logs one gate decision. Safe to call many times per page render (once
// per candidate output) — there is no uniqueness constraint, since a
// page can legitimately be viewed more than once within the same run and
// each view is its own evidence of what that mode actually showed.
async function logGateEvent(runId, event) {
  await pool.query(
    `INSERT INTO gating_comparison_events
       (run_id, module, output_key, would_suppress, shown, evidence_strength, evidence_strength_kind, reason)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      runId,
      event.module,
      event.outputKey,
      !!event.wouldSuppress,
      !!event.shown,
      event.evidenceStrength === undefined || event.evidenceStrength === null ? null : Number(event.evidenceStrength),
      event.evidenceStrengthKind || null,
      event.reason || null,
    ]
  );
}

async function logTrustRating(runId, outputKey, trustRating, raterLabel = null) {
  await pool.query(
    `INSERT INTO gating_comparison_trust_ratings (run_id, output_key, trust_rating, rater_label)
     VALUES ($1, $2, $3, $4)`,
    [runId, outputKey, trustRating, raterLabel]
  );
}

// Everything the report page needs for one dataset, across every run
// (both modes, however many times each was run) ever started against it:
// per-mode totals, the specific "unsupported output shown" count (the
// reviewer's own framing — would_suppress=true AND shown=true, which by
// construction only ever happens in an 'off' run), a reason breakdown,
// and the trust-vs-evidence-strength comparison.
async function getDatasetComparisonSummary(datasetRowId) {
  const { rows: runs } = await pool.query(
    `SELECT id, gate_mode, started_at, notes FROM gating_comparison_runs
      WHERE dataset_row_id = $1 ORDER BY started_at ASC`,
    [datasetRowId]
  );
  if (runs.length === 0) return { runs: [], byMode: {}, reasonBreakdown: [], trustByMode: {} };

  const runIds = runs.map((r) => r.id);

  const { rows: perMode } = await pool.query(
    `SELECT r.gate_mode,
            COUNT(*)::int AS total_events,
            COUNT(*) FILTER (WHERE e.shown)::int AS total_shown,
            COUNT(*) FILTER (WHERE e.would_suppress AND e.shown)::int AS unsupported_shown,
            COUNT(*) FILTER (WHERE e.would_suppress AND NOT e.shown)::int AS correctly_suppressed,
            AVG(e.evidence_strength) FILTER (WHERE e.evidence_strength_kind = 'confidence') AS avg_confidence
       FROM gating_comparison_events e
       JOIN gating_comparison_runs r ON r.id = e.run_id
      WHERE e.run_id = ANY($1::int[])
      GROUP BY r.gate_mode`,
    [runIds]
  );

  const { rows: reasonBreakdown } = await pool.query(
    `SELECT r.gate_mode, e.module, e.reason,
            COUNT(*)::int AS occurrences,
            COUNT(*) FILTER (WHERE e.shown)::int AS shown_count
       FROM gating_comparison_events e
       JOIN gating_comparison_runs r ON r.id = e.run_id
      WHERE e.run_id = ANY($1::int[]) AND e.would_suppress
      GROUP BY r.gate_mode, e.module, e.reason
      ORDER BY r.gate_mode, occurrences DESC`,
    [runIds]
  );

  // Trust vs. evidence strength: for every rated output, pair its stated
  // trust with the evidence_strength logged for that same output_key
  // within the same run — this is the direct "did trust track the
  // strength of the evidence" measure the recommendation asks for.
  const { rows: trustPairs } = await pool.query(
    `SELECT r.gate_mode, t.output_key, t.trust_rating, e.evidence_strength, e.would_suppress
       FROM gating_comparison_trust_ratings t
       JOIN gating_comparison_runs r ON r.id = t.run_id
       LEFT JOIN gating_comparison_events e
              ON e.run_id = t.run_id AND e.output_key = t.output_key
      WHERE t.run_id = ANY($1::int[])
      ORDER BY r.gate_mode, t.created_at ASC`,
    [runIds]
  );

  const byMode = {};
  perMode.forEach((row) => {
    byMode[row.gate_mode] = {
      totalEvents: row.total_events,
      totalShown: row.total_shown,
      unsupportedShown: row.unsupported_shown,
      correctlySuppressed: row.correctly_suppressed,
      avgConfidence: row.avg_confidence === null ? null : Number(row.avg_confidence),
    };
  });

  const trustByMode = { on: [], off: [] };
  trustPairs.forEach((row) => {
    (trustByMode[row.gate_mode] || (trustByMode[row.gate_mode] = [])).push({
      outputKey: row.output_key,
      trustRating: row.trust_rating,
      evidenceStrength: row.evidence_strength === null ? null : Number(row.evidence_strength),
      wouldSuppress: row.would_suppress,
    });
  });

  return { runs, byMode, reasonBreakdown, trustByMode };
}

module.exports = {
  startRun, getRun, logGateEvent, logTrustRating, getDatasetComparisonSummary,
};
