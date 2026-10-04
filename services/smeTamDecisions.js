// SME Owner-TAM Evaluator decision follow-up (added 4 October 2026).
//
// Evidence for decision-support effectiveness (the editorial reviewers'
// main concern): on each Prescriptive recommendation an owner can record
// what they will do with it, how confident they are in that decision, what
// they would change, and — returning later — what actually happened.
// Consent-first (RA 10173): nothing is written unless the account's
// evaluation session has consent_status = 'given'.
const pool = require('../db/pool');
const { SME_TAM_ROLE, getOrCreateSession } = require('./tamEvaluation');

const ACTION_STATUSES = [
  { value: 'already_acted', label: 'I have already acted on it' },
  { value: 'plan_to_act', label: 'I plan to act on it' },
  { value: 'will_not_act', label: 'I will not act on it' },
  { value: 'not_sure', label: "I'm not sure yet" },
];
const TEXT_MAX = 2000;

function clean(v) {
  const t = String(v === undefined || v === null ? '' : v).trim();
  return t ? t.slice(0, TEXT_MAX) : null;
}

// Returns { ok: true } or { ok: false, reason }.
async function saveDecisionFollowup(user, input) {
  if (!user || user.role !== SME_TAM_ROLE) return { ok: false, reason: 'role' };
  const key = String(input.recommendationKey || '').trim().slice(0, 150);
  if (!key) return { ok: false, reason: 'missing_recommendation' };
  const status = ACTION_STATUSES.find((s) => s.value === input.actionStatus);
  if (!status) return { ok: false, reason: 'missing_status' };
  const confidence = parseInt(input.confidence, 10);
  if (!(confidence >= 1 && confidence <= 5)) return { ok: false, reason: 'missing_confidence' };

  const session = await getOrCreateSession(user.id, SME_TAM_ROLE, 'direct');
  if (!session || session.consent_status !== 'given') return { ok: false, reason: 'consent' };

  const label = String(input.recommendationLabel || '').trim().slice(0, 200) || null;
  const intended = clean(input.intendedChange);
  const outcome = clean(input.outcomeText);

  await pool.query(
    `INSERT INTO sme_tam_decision_followups
       (account_id, session_id, recommendation_key, recommendation_label, action_status, confidence,
        intended_change, outcome_text, outcome_updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, CASE WHEN $8::text IS NULL THEN NULL ELSE now() END)
     ON CONFLICT (account_id, recommendation_key) DO UPDATE
        SET recommendation_label = COALESCE(EXCLUDED.recommendation_label, sme_tam_decision_followups.recommendation_label),
            action_status = EXCLUDED.action_status,
            confidence = EXCLUDED.confidence,
            intended_change = EXCLUDED.intended_change,
            outcome_text = EXCLUDED.outcome_text,
            outcome_updated_at = CASE
              WHEN EXCLUDED.outcome_text IS DISTINCT FROM sme_tam_decision_followups.outcome_text THEN
                CASE WHEN EXCLUDED.outcome_text IS NULL THEN NULL ELSE now() END
              ELSE sme_tam_decision_followups.outcome_updated_at END,
            updated_at = now()`,
    [user.id, session.id, key, label, status.value, confidence, intended, outcome]
  );
  return { ok: true };
}

// { [recommendation_key]: row } for the owner's own entries.
async function getDecisionFollowupsByKey(accountId) {
  const { rows } = await pool.query(
    'SELECT * FROM sme_tam_decision_followups WHERE account_id = $1', [accountId]);
  const out = {};
  rows.forEach((r) => { out[r.recommendation_key] = r; });
  return out;
}

// All entries of consenting SME-TAM owners, for the admin page + CSV.
async function listAllDecisionFollowups() {
  const { rows } = await pool.query(
    `SELECT d.*, a.username, a.owner_name, a.business_sector, a.business_size
       FROM sme_tam_decision_followups d
       JOIN sme_accounts a ON a.id = d.account_id
       JOIN sme_tam_evaluation_sessions s ON s.account_id = a.id AND s.consent_status = 'given'
      WHERE a.role = $1
      ORDER BY d.updated_at DESC`, [SME_TAM_ROLE]);
  return rows;
}

function csvCell(v) {
  if (v === null || v === undefined) return '';
  const s = v instanceof Date ? v.toISOString() : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function buildDecisionsCsv(rows) {
  const cols = [
    ['account_id', 'account_id'], ['username', 'username'], ['business_category', 'business_sector'],
    ['business_size', 'business_size'], ['recommendation', 'recommendation_label'], ['recommendation_key', 'recommendation_key'],
    ['action_status', 'action_status'], ['confidence_1_5', 'confidence'], ['intended_change', 'intended_change'],
    ['outcome_text', 'outcome_text'], ['outcome_updated_at', 'outcome_updated_at'],
    ['first_recorded_at', 'created_at'], ['last_updated_at', 'updated_at'],
  ];
  const lines = [cols.map(([h]) => h).join(',')];
  rows.forEach((r) => lines.push(cols.map(([, k]) => csvCell(r[k])).join(',')));
  return lines.join('\r\n') + '\r\n';
}

module.exports = {
  ACTION_STATUSES, TEXT_MAX,
  saveDecisionFollowup, getDecisionFollowupsByKey, listAllDecisionFollowups, buildDecisionsCsv,
};
