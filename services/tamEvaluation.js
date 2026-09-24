// TAM End-User Evaluation — six-task walkthrough + 17-item Technology
// Acceptance Model questionnaire, embedded in the running app for the
// sme_owner to complete against the six live analytics-pipeline modules.
// This is the app-side implementation of the instrument described in
// claude/tam-instrument-end-user-evaluation.md (Table 1's six tasks,
// Tables 2-4's PU/PEOU/BI items) — same task order, same item wording,
// same "rating <=3 needs a remark" rule, same six modules. Persisted in
// evaluation_sessions / evaluation_task_logs / evaluation_responses
// (db/schema.sql) so an account can always resume exactly where it left
// off, across logins and devices, rather than losing progress to a
// closed tab.
const pool = require('../db/pool');
const { quantile, mean } = require('./statsUtils');

// ------------------------------------------------------------------
// The six-task walkthrough (Table 1) — one task per in-scope module, in
// administration order. `slug`/`href` point at that module's real route
// so "open the module" and "log completion" are two different actions:
// the SME owner actually does the task in the live app, then comes back
// here to say so.
// ------------------------------------------------------------------
const WALKTHROUGH_TASKS = [
  {
    number: 1,
    moduleSlug: 'upload-dataset',
    moduleLabel: 'Upload New Dataset',
    href: '/upload-dataset',
    instructions: 'Upload a dataset (a sample one is fine). If CMA-Flow’s Semantic Field Detection Engine flags any column as uncertain, confirm or correct its meaning on the Review Field Roles screen.',
  },
  {
    number: 2,
    moduleSlug: 'browse-dataset',
    moduleLabel: 'Browse Dataset',
    href: '/browse-dataset',
    instructions: 'Browse your uploaded dataset and open either its Evaluation Report or its entity-relationship diagram.',
  },
  {
    number: 3,
    moduleSlug: 'descriptive-analytics',
    moduleLabel: 'Descriptive Analytics',
    href: '/descriptive-analytics',
    instructions: 'Find this dataset’s top-selling category and total revenue for the most recent period.',
  },
  {
    number: 4,
    moduleSlug: 'diagnostic-insights',
    moduleLabel: 'Diagnostic Insights',
    href: '/diagnostic-insights',
    instructions: 'Find why revenue changed between two specific months, using whichever finding is ranked highest by Priority.',
  },
  {
    number: 5,
    moduleSlug: 'predictive-analytics',
    moduleLabel: 'Predictive Analytics',
    href: '/predictive-analytics',
    instructions: 'Check the revenue forecast or churn-risk table for the next period, then try the What-if pricing scenario tool.',
  },
  {
    number: 6,
    moduleSlug: 'prescriptive-recommendations',
    moduleLabel: 'Prescriptive Recommendations',
    href: '/prescriptive-recommendations',
    instructions: 'Review the recommended monetization mechanism — its Evidence, Recommendation, and Expected KPI — and note its stated Confidence level.',
  },
];

// ------------------------------------------------------------------
// The 17-item TAM questionnaire (Tables 2-4): Perceived Usefulness (7),
// Perceived Ease of Use (7), Behavioral Intention to Use (3).
// ------------------------------------------------------------------
const DOMAIN_LABELS = {
  PU: 'Perceived Usefulness',
  PEOU: 'Perceived Ease of Use',
  BI: 'Behavioral Intention to Use',
};

const TAM_ITEMS = [
  { code: 'PU-01', domain: 'PU', text: 'Using CMA-Flow’s analytics pipeline would help me understand how my business is currently making money.' },
  { code: 'PU-02', domain: 'PU', text: 'Using CMA-Flow’s analytics pipeline would help me understand why my revenue or customer activity changed from one period to the next.' },
  { code: 'PU-03', domain: 'PU', text: 'Using CMA-Flow’s analytics pipeline would help me anticipate changes in my revenue or customers before they happen.' },
  { code: 'PU-04', domain: 'PU', text: 'Using CMA-Flow’s analytics pipeline would help me decide which pricing or monetization approach to pursue next.' },
  { code: 'PU-05', domain: 'PU', text: 'Using CMA-Flow’s analytics pipeline would improve my ability to make monetization decisions compared with how I currently review my own data.' },
  { code: 'PU-06', domain: 'PU', text: 'Overall, I would find CMA-Flow’s analytics pipeline useful for running my business.' },
  { code: 'PU-07', domain: 'PU', text: 'CMA-Flow’s automatic detection of what each column in my data means (for example, revenue, customer ID, or product category) saved me time compared with labeling it myself.' },
  { code: 'PEOU-01', domain: 'PEOU', text: 'Uploading my own data file into CMA-Flow was easy for me.' },
  { code: 'PEOU-02', domain: 'PEOU', text: 'Learning to move between CMA-Flow’s Upload, Browse, Descriptive, Diagnostic, Predictive, and Prescriptive screens was easy for me.' },
  { code: 'PEOU-03', domain: 'PEOU', text: 'It was easy for me to find the specific information I was looking for within each analytics screen.' },
  { code: 'PEOU-04', domain: 'PEOU', text: 'When a result was not available (for example, "not enough data yet"), CMA-Flow’s explanation of why was clear to me.' },
  { code: 'PEOU-05', domain: 'PEOU', text: 'I did not need help from anyone else to complete the six tasks in the walkthrough.' },
  { code: 'PEOU-06', domain: 'PEOU', text: 'Overall, I found CMA-Flow’s analytics pipeline easy to use.' },
  { code: 'PEOU-07', domain: 'PEOU', text: 'When CMA-Flow asked me to confirm or correct what a column in my data meant, it was easy for me to understand what it was asking and to answer it.' },
  { code: 'BI-01', domain: 'BI', text: 'If CMA-Flow were available to me, I intend to use its analytics pipeline regularly to monitor my business.' },
  { code: 'BI-02', domain: 'BI', text: 'I would use CMA-Flow’s analytics pipeline again the next time I have new business data to review.' },
  { code: 'BI-03', domain: 'BI', text: 'I would recommend CMA-Flow’s analytics pipeline to another SME owner.' },
];

const TAM_ITEMS_BY_CODE = new Map(TAM_ITEMS.map((item) => [item.code, item]));

function groupItemsByDomain() {
  return ['PU', 'PEOU', 'BI'].map((domain) => ({
    domain,
    label: DOMAIN_LABELS[domain],
    items: TAM_ITEMS.filter((item) => item.domain === domain),
  }));
}

// ------------------------------------------------------------------
// Session lifecycle
// ------------------------------------------------------------------

// Finds this account's evaluation session, creating one (at task 1) the
// first time it's ever needed. UNIQUE(account_id) plus ON CONFLICT DO
// NOTHING makes this safe to call on every GET /evaluation without a
// separate existence check or a race on double-submission.
async function getOrCreateSession(accountId) {
  await pool.query(
    `INSERT INTO evaluation_sessions (account_id) VALUES ($1)
     ON CONFLICT (account_id) DO NOTHING`,
    [accountId]
  );
  const { rows } = await pool.query(
    `SELECT * FROM evaluation_sessions WHERE account_id = $1`,
    [accountId]
  );
  return rows[0];
}

async function getTaskLogs(sessionId) {
  const { rows } = await pool.query(
    `SELECT * FROM evaluation_task_logs WHERE session_id = $1 ORDER BY task_number`,
    [sessionId]
  );
  return rows;
}

async function getResponses(sessionId) {
  const { rows } = await pool.query(
    `SELECT * FROM evaluation_responses WHERE session_id = $1`,
    [sessionId]
  );
  const byCode = new Map(rows.map((r) => [r.item_code, r]));
  return byCode;
}

// Full state for rendering GET /evaluation: the session, every task log
// so far (for the completed-so-far checklist), and every saved response
// (for pre-filling the questionnaire on resume).
async function getEvaluationState(accountId) {
  const session = await getOrCreateSession(accountId);
  const [taskLogs, responses] = await Promise.all([
    getTaskLogs(session.id),
    getResponses(session.id),
  ]);
  return { session, taskLogs, responses };
}

// Stamps started_at for the current task the first time the account
// lands on its walkthrough screen. ON CONFLICT DO NOTHING means a page
// refresh or a later revisit never resets the clock.
async function startTaskIfNeeded(sessionId, accountId, taskNumber) {
  const task = WALKTHROUGH_TASKS.find((t) => t.number === taskNumber);
  if (!task) return;
  await pool.query(
    `INSERT INTO evaluation_task_logs (session_id, account_id, task_number, module_slug)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (session_id, task_number) DO NOTHING`,
    [sessionId, accountId, taskNumber, task.moduleSlug]
  );
}

// Marks a task complete: fills in completed_at/time_on_task_seconds and
// the assistance/error/notes the SME owner reported, then advances the
// session to the next task — or to the questionnaire once task 6 is
// done. Returns the updated session row.
async function completeTask(session, accountId, taskNumber, { neededAssistance, hadError, notes }) {
  const task = WALKTHROUGH_TASKS.find((t) => t.number === taskNumber);
  // INSERT ... ON CONFLICT rather than a bare UPDATE: normally
  // startTaskIfNeeded() already created this row when the walkthrough
  // page was loaded, so this is an update in practice, but self-healing
  // here means a task can always be marked complete even if that first
  // insert was ever skipped (e.g. a restart between viewing the task and
  // submitting it) — a silent no-op UPDATE that matched zero rows would
  // otherwise lose the completion without any error.
  await pool.query(
    `INSERT INTO evaluation_task_logs
       (session_id, account_id, task_number, module_slug, completed_at, time_on_task_seconds, needed_assistance, had_error, notes)
     VALUES ($1, $2, $3, $4, now(), 0, $5, $6, $7)
     ON CONFLICT (session_id, task_number) DO UPDATE
        SET completed_at = now(),
            time_on_task_seconds = GREATEST(0, EXTRACT(EPOCH FROM (now() - evaluation_task_logs.started_at))::INTEGER),
            needed_assistance = excluded.needed_assistance,
            had_error = excluded.had_error,
            notes = excluded.notes`,
    [session.id, accountId, taskNumber, task ? task.moduleSlug : null, !!neededAssistance, !!hadError, notes || null]
  );

  const isLastTask = taskNumber >= WALKTHROUGH_TASKS.length;
  // $3 cast to VARCHAR(20) explicitly: used both as the plain column
  // assignment (status = $3) and inside the CASE comparison below, and
  // Postgres can't unify a bare parameter's type across two different
  // expression contexts in one query ("inconsistent types deduced for
  // parameter $3") without an explicit cast pinning it down.
  const { rows } = await pool.query(
    `UPDATE evaluation_sessions
        SET current_task = $2,
            status = $3::VARCHAR(20),
            walkthrough_completed_at = CASE WHEN $3::VARCHAR(20) = 'questionnaire' THEN now() ELSE walkthrough_completed_at END
      WHERE id = $1
      RETURNING *`,
    [
      session.id,
      isLastTask ? taskNumber : taskNumber + 1,
      isLastTask ? 'questionnaire' : 'walkthrough',
    ]
  );
  return rows[0];
}

// Upserts whatever answers were submitted — used both by "Save progress"
// (partial, any subset of the 17 items) and by the final "Submit
// evaluation" (all 17). `answers` is [{ code, rating, remark }, ...].
async function saveResponses(session, accountId, answers) {
  for (const answer of answers) {
    const item = TAM_ITEMS_BY_CODE.get(answer.code);
    if (!item) continue; // ignore anything not a real item code
    const rating = answer.rating === null || answer.rating === undefined || answer.rating === ''
      ? null
      : Math.min(5, Math.max(1, parseInt(answer.rating, 10)));
    await pool.query(
      `INSERT INTO evaluation_responses (session_id, account_id, item_code, domain, rating, remark)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (session_id, item_code)
       DO UPDATE SET rating = excluded.rating, remark = excluded.remark, answered_at = now()`,
      [session.id, accountId, item.code, item.domain, Number.isNaN(rating) ? null : rating, answer.remark || null]
    );
  }
}

// Validates the full 17-item instrument's own rule (Section 4.1): every
// item must be rated, and any rating of 3 or below must carry a remark.
// Returns { ok, missingCodes, needsRemarkCodes } — both arrays empty
// means the questionnaire is ready to be marked complete.
async function validateQuestionnaire(sessionId) {
  const responses = await getResponses(sessionId);
  const missingCodes = [];
  const needsRemarkCodes = [];
  for (const item of TAM_ITEMS) {
    const r = responses.get(item.code);
    if (!r || r.rating === null || r.rating === undefined) {
      missingCodes.push(item.code);
      continue;
    }
    if (r.rating <= 3 && (!r.remark || !r.remark.trim())) {
      needsRemarkCodes.push(item.code);
    }
  }
  return { ok: missingCodes.length === 0 && needsRemarkCodes.length === 0, missingCodes, needsRemarkCodes };
}

async function markCompleted(sessionId) {
  const { rows } = await pool.query(
    `UPDATE evaluation_sessions SET status = 'completed', completed_at = now() WHERE id = $1 RETURNING *`,
    [sessionId]
  );
  return rows[0];
}

// ------------------------------------------------------------------
// Admin browsing — read-only, never mutates state
// ------------------------------------------------------------------

// Same shape as getEvaluationState(), but for an Admin looking at
// SOMEONE ELSE's account. Unlike getEvaluationState(), this never creates
// a session row as a side effect: an admin opening an account that hasn't
// started its evaluation yet should see "not started", not silently
// enroll that account into the walkthrough. session is null when the
// account has never visited /evaluation.
async function getEvaluationStateReadOnly(accountId) {
  const { rows } = await pool.query(
    `SELECT * FROM evaluation_sessions WHERE account_id = $1`,
    [accountId]
  );
  const session = rows[0] || null;
  if (!session) return { session: null, taskLogs: [], responses: new Map() };
  const [taskLogs, responses] = await Promise.all([
    getTaskLogs(session.id),
    getResponses(session.id),
  ]);
  return { session, taskLogs, responses };
}

// One row per sme_owner account (Admin accounts excluded — this
// evaluation is end-user/SME-owner-facing only), left-joined to that
// account's evaluation session if it has one, for the admin Evaluations
// list: who's done, who's mid-walkthrough/questionnaire, who hasn't
// started at all.
async function listAllEvaluationStatuses() {
  const { rows } = await pool.query(
    `SELECT a.id AS account_id, a.username, a.owner_name, a.business_name,
            s.status, s.current_task, s.started_at,
            s.walkthrough_completed_at, s.completed_at,
            (SELECT COUNT(*)::int FROM evaluation_task_logs tl
              WHERE tl.session_id = s.id AND tl.completed_at IS NOT NULL) AS tasks_done,
            (SELECT COUNT(*)::int FROM evaluation_responses r
              WHERE r.session_id = s.id AND r.rating IS NOT NULL) AS items_answered
       FROM sme_accounts a
       LEFT JOIN evaluation_sessions s ON s.account_id = a.id
      WHERE a.role != 'Admin'
      ORDER BY a.created_at DESC`
  );
  return rows;
}

// Cross-respondent descriptive summary of the 17-item questionnaire —
// the instrument's own Section 6 scoring/analysis plan (median/IQR per
// item and domain, %agree; see claude/tam-instrument-end-user-evaluation.md
// in the project docs), computed here instead of by hand from an export.
// Only FULLY COMPLETED evaluations are included (status = 'completed'),
// so a still-in-progress respondent's partial ratings never skew the
// reported figures — matches the same "final data only" discipline the
// instrument's own scoring plan assumes. %agree = the share of ratings
// that are 4 or 5 (Agree/Strongly Agree on the 5-point scale), the
// standard TAM reporting convention.
async function getCompletedResponseSummary() {
  const { rows } = await pool.query(
    `SELECT r.item_code, r.domain, r.rating
       FROM evaluation_responses r
       JOIN evaluation_sessions s ON s.id = r.session_id
      WHERE s.status = 'completed' AND r.rating IS NOT NULL`
  );
  const { rows: completedCountRows } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM evaluation_sessions WHERE status = 'completed'`
  );

  function summarize(values) {
    const sorted = [...values].sort((a, b) => a - b);
    const n = sorted.length;
    if (n === 0) return {
      n: 0, mean: null, median: null, q1: null, q3: null, percentAgree: null,
    };
    const agree = sorted.filter((v) => v >= 4).length;
    return {
      n,
      mean: mean(sorted),
      median: quantile(sorted, 0.5),
      q1: quantile(sorted, 0.25),
      q3: quantile(sorted, 0.75),
      percentAgree: (agree / n) * 100,
    };
  }

  const byItem = TAM_ITEMS.map((item) => {
    const values = rows.filter((r) => r.item_code === item.code).map((r) => r.rating);
    return { code: item.code, domain: item.domain, text: item.text, ...summarize(values) };
  });

  const byDomain = ['PU', 'PEOU', 'BI'].map((domain) => {
    const values = rows.filter((r) => r.domain === domain).map((r) => r.rating);
    return { domain, label: DOMAIN_LABELS[domain], ...summarize(values) };
  });

  return { byItem, byDomain, completedCount: completedCountRows[0].n };
}

module.exports = {
  WALKTHROUGH_TASKS,
  TAM_ITEMS,
  DOMAIN_LABELS,
  groupItemsByDomain,
  getOrCreateSession,
  getEvaluationState,
  startTaskIfNeeded,
  completeTask,
  saveResponses,
  validateQuestionnaire,
  markCompleted,
  getEvaluationStateReadOnly,
  listAllEvaluationStatuses,
  getCompletedResponseSummary,
};
