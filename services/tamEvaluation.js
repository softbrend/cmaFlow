// End-User Evaluation — six-task walkthrough + questionnaire, embedded in
// the running app, for THREE populations, each with its own fully
// separate table set (never queried, counted, or summarized together):
//   - an SME Owner account (persisted in
//     evaluation_sessions / evaluation_task_logs / evaluation_responses) —
//     the original population (incl. the MIT 267 course cohort whose TAM
//     results are already reported in the manuscript) — takes the
//     original 17-item TAM questionnaire, unchanged.
//   - a Template Evaluator account, added 30 September 2026 for the
//     synthetic-template validation round (persisted in the parallel
//     expert_evaluation_sessions / _task_logs / _responses tables) — also
//     takes TAM, unchanged. Brenda's explicit instruction (see
//     claude/direct-flow-template-evaluator.md): "the previous evaluation
//     done by the 15 that they upload their own datasets should not be
//     touched" — so this population's instrument was deliberately left
//     alone rather than being switched to ISO/IEC 25010.
//   - a Business Owner Evaluator account, added 2 October 2026 (persisted
//     in business_owner_evaluation_sessions / _task_logs / _responses) —
//     a third, access-code-gated population (routes/auth.js's
//     /businessOwner-signup) created specifically to take the NEW
//     15-item ISO/IEC 25010 Quality-in-Use questionnaire (ISO25010_ITEMS
//     below), answering the editorial letter's decision-support-
//     effectiveness critique without touching either TAM population's
//     already-collected data.
// Every function below takes the account's role as its last argument and
// picks the matching table set via tablesFor() — the task list and all
// the business rules (consent, the six-task walkthrough, the "rating <=3
// needs a remark" validation) are shared code; only the storage target
// and the question set differ. This is deliberate: db/schema.sql's
// comments on the expert_*/business_owner_evaluation_* tables explain why
// they must never be queried together with the SME-owner ones, and
// keeping one copy of this logic (instead of three forked sibling files)
// is what keeps every population's evaluation actually identical in how
// it's administered and scored, modulo only the question set.
const pool = require('../db/pool');
const { quantile, mean } = require('./statsUtils');

const SME_ROLE = 'SME Owner';
const EXPERT_ROLE = 'Template Evaluator';
const BUSINESS_ROLE = 'Business Owner Evaluator';
// SME Owner-TAM Evaluator (added 4 October 2026) — a FOURTH, fully separate
// population: real SME owners (own access-code-gated /smeOwnerTam-signup)
// who use the Business Owner Evaluator's portal features and the
// Template-Evaluator-style DIRECT flow (no six-task walkthrough), then
// answer a REWORDED 17-item TAM questionnaire (SME_TAM_ITEMS below)
// persisted to its own sme_tam_evaluation_* tables, so nothing already
// collected for the other three populations is ever touched.
const SME_TAM_ROLE = 'SME Owner-TAM Evaluator';

// The three table sets this ever resolves to — role is always either an
// account's own sme_accounts.role or explicitly passed by a caller that
// already knows which population it's asking about; anything other than
// the literal 'Template Evaluator'/'Business Owner Evaluator' strings
// (including undefined, for every call site written before the Template
// Evaluator round) resolves to the original SME-owner tables, so this has
// stayed purely additive across both rounds.
const TABLE_SETS = {
  sme: {
    sessions: 'evaluation_sessions',
    taskLogs: 'evaluation_task_logs',
    responses: 'evaluation_responses',
  },
  expert: {
    sessions: 'expert_evaluation_sessions',
    taskLogs: 'expert_evaluation_task_logs',
    responses: 'expert_evaluation_responses',
    visits: 'expert_evaluation_module_visits',
  },
  businessOwner: {
    sessions: 'business_owner_evaluation_sessions',
    taskLogs: 'business_owner_evaluation_task_logs',
    responses: 'business_owner_evaluation_responses',
  },
  smeTam: {
    sessions: 'sme_tam_evaluation_sessions',
    taskLogs: 'sme_tam_evaluation_task_logs',
    responses: 'sme_tam_evaluation_responses',
    visits: 'sme_tam_evaluation_module_visits',
  },
};

function tablesFor(role) {
  if (role === EXPERT_ROLE) return TABLE_SETS.expert;
  if (role === BUSINESS_ROLE) return TABLE_SETS.businessOwner;
  if (role === SME_TAM_ROLE) return TABLE_SETS.smeTam;
  return TABLE_SETS.sme;
}

// Direct flow = no six-task walkthrough: a new session starts straight at
// 'questionnaire', all four analytics modules are open immediately, and
// time-on-module is logged automatically instead. Template Evaluator is
// direct only when its sme_accounts.evaluation_flow says so (the 15
// grandfathered accounts are not); SME Owner-TAM Evaluator is ALWAYS
// direct — it has no walkthrough variant at all, so this never depends on
// the evaluation_flow column for that role.
function isDirectFlow(role, evaluationFlow) {
  return (role === EXPERT_ROLE && evaluationFlow === 'direct') || role === SME_TAM_ROLE;
}

// ------------------------------------------------------------------
// The six-task walkthrough (Table 1) — one task per in-scope module, in
// administration order. `slug`/`href` point at that module's real route
// so "open the module" and "log completion" are two different actions:
// the respondent actually does the task in the live app, then comes back
// here to say so. Shared by both populations — a Template Evaluator works
// through the exact same six modules, on whatever dataset they uploaded
// (see views/dashboard/sme-templates for how they pick/download a
// category template first), as an SME owner does.
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
// Perceived Ease of Use (7), Behavioral Intention to Use (3). Shared
// wording for both populations — a Template Evaluator answers the same
// instrument an SME owner does, so the two are directly comparable.
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
const TAM_DOMAIN_CODES = ['PU', 'PEOU', 'BI'];

// ------------------------------------------------------------------
// Reworded 17-item TAM questionnaire for the SME Owner-TAM Evaluator role
// (added 4 October 2026, per Brenda's explicit choice to reword rather
// than reuse the original items). Same structure as TAM_ITEMS above — the
// same item codes and the same three domains (PU 7 / PEOU 7 / BI 3) — so
// scoring/reporting code is shared, but the WORDING is adapted for real
// business owners using their own records in the direct flow: no
// reference to "the six tasks in the walkthrough" (this role has none),
// "business data"/"data file" becomes "business records", and the
// recommend-to item says "another business owner". Because the wording
// differs, these responses are stored separately
// (sme_tam_evaluation_responses) and must not be pooled with the original
// TAM_ITEMS responses without an explicit equivalence argument.
// ------------------------------------------------------------------
const SME_TAM_ITEMS = [
  { code: 'PU-01', domain: 'PU', text: 'Using CMA-Flow with my own business records helped me understand how my business is currently making money.' },
  { code: 'PU-02', domain: 'PU', text: 'CMA-Flow helped me understand why my sales or customer activity changed from one period to the next.' },
  { code: 'PU-03', domain: 'PU', text: 'CMA-Flow helped me anticipate changes in my sales or customers before they happen.' },
  { code: 'PU-04', domain: 'PU', text: 'CMA-Flow helped me decide which pricing or monetization approach to try next in my business.' },
  { code: 'PU-05', domain: 'PU', text: 'Using CMA-Flow improved my ability to make decisions about how my business earns money, compared with how I review my own records today.' },
  { code: 'PU-06', domain: 'PU', text: 'Overall, I find CMA-Flow useful for running my business.' },
  { code: 'PU-07', domain: 'PU', text: 'CMA-Flow’s automatic recognition of what each column in my records means (for example, sales amount, customer, or product) saved me time compared with labeling it myself.' },
  { code: 'PEOU-01', domain: 'PEOU', text: 'Loading or entering my own business records into CMA-Flow was easy for me.' },
  { code: 'PEOU-02', domain: 'PEOU', text: 'Learning to move between CMA-Flow’s Descriptive, Diagnostic, Predictive, and Prescriptive screens was easy for me.' },
  { code: 'PEOU-03', domain: 'PEOU', text: 'It was easy for me to find the specific information I was looking for on each analytics screen.' },
  { code: 'PEOU-04', domain: 'PEOU', text: 'When a result was not available (for example, "not enough data yet"), CMA-Flow’s explanation of why was clear to me.' },
  { code: 'PEOU-05', domain: 'PEOU', text: 'I did not need help from anyone else to use CMA-Flow’s analytics screens.' },
  { code: 'PEOU-06', domain: 'PEOU', text: 'Overall, I found CMA-Flow easy to use.' },
  { code: 'PEOU-07', domain: 'PEOU', text: 'When CMA-Flow asked me to confirm or correct what a column in my records meant, it was easy for me to understand what it was asking and to answer it.' },
  { code: 'BI-01', domain: 'BI', text: 'If CMA-Flow were available to me, I intend to use it regularly to monitor my business.' },
  { code: 'BI-02', domain: 'BI', text: 'I would use CMA-Flow again the next time I have new business records to review.' },
  { code: 'BI-03', domain: 'BI', text: 'I would recommend CMA-Flow to another business owner.' },
];

const SME_TAM_ITEMS_BY_CODE = new Map(SME_TAM_ITEMS.map((item) => [item.code, item]));

// ------------------------------------------------------------------
// ISO/IEC 25010 Quality-in-Use instrument — added 2 October 2026 in
// response to the editorial decision letter's core complaint: TAM
// measures acceptance (would a respondent adopt the tool), not
// decision-support effectiveness (did using it produce a good decision).
//
// Taken ONLY by the new Business Owner Evaluator role (BUSINESS_ROLE,
// business_owner_evaluation_* tables, routes/auth.js's access-code-gated
// /businessOwner-signup) — a third, purpose-built population created
// specifically for this instrument. Both SME Owner AND Template Evaluator
// accounts are explicitly UNCHANGED — they keep taking TAM_ITEMS above,
// so neither the manuscript's already-reported SME Owner TAM dataset nor
// the Template Evaluator synthetic-validation round's TAM dataset
// (Brenda's own words, claude/direct-flow-template-evaluator.md: "the
// previous evaluation done by the 15 that they upload their own datasets
// should not be touched") is ever touched by this. See
// claude/field-study-and-semantic-retest-plan.md for the companion
// external decision-report form + blind-rating rubric this pairs with;
// this questionnaire alone is still self-report and does not by itself
// constitute the "validation" the letter asks for.
//
// Four Quality-in-Use characteristics, operationalized around the
// actual monetization decision reached rather than generic software
// quality (see each item's wording):
//   EFF   Effectiveness — "accuracy and completeness with which users
//         achieve specified goals" (ISO/IEC 25010), here: did the SME
//         owner reach an accurate, complete monetization decision.
//   RISK  Freedom from Economic Risk — "the degree to which a product
//         mitigates potential risk to economic status" (ISO/IEC
//         25010), here: did CMA-Flow reduce the risk of a costly
//         monetization mistake.
//   SAT   Satisfaction — trust in and satisfaction with the
//         RECOMMENDATION specifically, not the interface (that's what
//         distinguishes this from a usability satisfaction item).
//   EFFIC Efficiency — effort/time to reach the decision, the one
//         domain that still gives a rough point of comparison against
//         TAM's old ground (PEOU covered ease of use; this covers
//         decision effort instead).
// ------------------------------------------------------------------
const ISO_DOMAIN_LABELS = {
  EFF: 'Effectiveness',
  RISK: 'Freedom from Economic Risk',
  SAT: 'Satisfaction',
  EFFIC: 'Efficiency',
};
const ISO_DOMAIN_CODES = ['EFF', 'RISK', 'SAT', 'EFFIC'];

const ISO25010_ITEMS = [
  { code: 'EFF-01', domain: 'EFF', text: 'The reports CMA-Flow generated gave me enough information to reach an accurate monetization decision for my business.' },
  { code: 'EFF-02', domain: 'EFF', text: 'I was able to fully complete the monetization decision I set out to make, using CMA-Flow’s reports.' },
  { code: 'EFF-03', domain: 'EFF', text: 'The monetization recommendation CMA-Flow gave me matched what I know to be true about my own business.' },
  { code: 'EFF-04', domain: 'EFF', text: 'Using CMA-Flow helped me consider factors in my monetization decision that I would otherwise have overlooked.' },
  { code: 'EFF-05', domain: 'EFF', text: 'Overall, the monetization decision I reached using CMA-Flow was more complete and accurate than one I would have reached on my own.' },
  { code: 'RISK-01', domain: 'RISK', text: 'Using CMA-Flow reduced my risk of choosing a monetization approach that would hurt my business financially.' },
  { code: 'RISK-02', domain: 'RISK', text: 'When CMA-Flow did not have enough evidence to support a recommendation, it told me so rather than giving me a risky answer anyway.' },
  { code: 'RISK-03', domain: 'RISK', text: 'I feel more confident that my monetization decision will not lead to a costly mistake, because I used CMA-Flow.' },
  { code: 'RISK-04', domain: 'RISK', text: 'Without CMA-Flow, I would have been more likely to change my monetization approach based on guesswork rather than evidence.' },
  { code: 'SAT-01', domain: 'SAT', text: 'I trust the monetization recommendation CMA-Flow gave me.' },
  { code: 'SAT-02', domain: 'SAT', text: 'I am satisfied with the monetization decision I reached using CMA-Flow.' },
  { code: 'SAT-03', domain: 'SAT', text: 'I would rely on CMA-Flow’s recommendation again the next time I need to make a monetization decision.' },
  { code: 'EFFIC-01', domain: 'EFFIC', text: 'I reached my monetization decision faster using CMA-Flow than I would have on my own.' },
  { code: 'EFFIC-02', domain: 'EFFIC', text: 'Reaching a monetization decision using CMA-Flow took less effort than reviewing my own records and spreadsheets myself.' },
  { code: 'EFFIC-03', domain: 'EFFIC', text: 'Overall, CMA-Flow made the process of reaching a monetization decision efficient.' },
];

const ISO25010_ITEMS_BY_CODE = new Map(ISO25010_ITEMS.map((item) => [item.code, item]));

// ------------------------------------------------------------------
// Role-aware lookups — every place in this file (and its callers in
// routes/evaluation.js, routes/admin.js) that used to reach straight
// for TAM_ITEMS / TAM_ITEMS_BY_CODE / DOMAIN_LABELS now goes through
// one of these instead, mirroring tablesFor()'s own three-way split
// above: only BUSINESS_ROLE gets the new ISO/IEC 25010 instrument —
// SME Owner and Template Evaluator (or any other/absent role, same
// default tablesFor() already uses) both get the original TAM
// instrument, unchanged.
// ------------------------------------------------------------------
function itemsFor(role) {
  if (role === BUSINESS_ROLE) return ISO25010_ITEMS;
  if (role === SME_TAM_ROLE) return SME_TAM_ITEMS;
  return TAM_ITEMS;
}
function itemsByCodeFor(role) {
  if (role === BUSINESS_ROLE) return ISO25010_ITEMS_BY_CODE;
  if (role === SME_TAM_ROLE) return SME_TAM_ITEMS_BY_CODE;
  return TAM_ITEMS_BY_CODE;
}
// SME_TAM_ROLE shares the TAM domain codes/labels (PU/PEOU/BI) — only its
// item WORDING differs — so it falls through to the TAM defaults here.
function domainCodesFor(role) {
  return role === BUSINESS_ROLE ? ISO_DOMAIN_CODES : TAM_DOMAIN_CODES;
}
function domainLabelsFor(role) {
  return role === BUSINESS_ROLE ? ISO_DOMAIN_LABELS : DOMAIN_LABELS;
}

function groupItemsByDomain(role) {
  const items = itemsFor(role);
  const labels = domainLabelsFor(role);
  return domainCodesFor(role).map((domain) => ({
    domain,
    label: labels[domain],
    items: items.filter((item) => item.domain === domain),
  }));
}

// ------------------------------------------------------------------
// Session lifecycle
// ------------------------------------------------------------------

// Finds this account's evaluation session, creating one the first time
// it's ever needed. UNIQUE(account_id) plus ON CONFLICT DO NOTHING makes
// this safe to call on every GET /evaluation without a separate
// existence check or a race on double-submission.
//
// evaluationFlow (sme_accounts.evaluation_flow — only ever meaningful for
// role === EXPERT_ROLE; every other caller either omits it or passes
// 'walkthrough') decides what a BRAND NEW session starts at: a
// 'walkthrough'-flow account (every SME Owner, and the 15 Template
// Evaluator accounts grandfathered into this flow) starts at task 1 same
// as always; a 'direct'-flow account skips the six-task walkthrough
// entirely — there's nothing to gate it on — and starts straight at
// status='questionnaire', current_task sitting unused at its column
// default. Only the INSERT's own default values are affected; a session
// that already exists is never rewritten by a later call with a
// different evaluationFlow, so this is safe to call from anywhere that
// doesn't happen to know the account's flow (callers that do know it
// should still pass it, so the FIRST visit — whichever route that
// happens to be — starts the session correctly).
async function getOrCreateSession(accountId, role, evaluationFlow) {
  const t = tablesFor(role);
  const startsDirect = isDirectFlow(role, evaluationFlow);
  await pool.query(
    `INSERT INTO ${t.sessions} (account_id, status) VALUES ($1, $2)
     ON CONFLICT (account_id) DO NOTHING`,
    [accountId, startsDirect ? 'questionnaire' : 'walkthrough']
  );
  const { rows } = await pool.query(
    `SELECT * FROM ${t.sessions} WHERE account_id = $1`,
    [accountId]
  );
  return rows[0];
}

async function getTaskLogs(sessionId, role) {
  const t = tablesFor(role);
  const { rows } = await pool.query(
    `SELECT * FROM ${t.taskLogs} WHERE session_id = $1 ORDER BY task_number`,
    [sessionId]
  );
  return rows;
}

async function getResponses(sessionId, role) {
  const t = tablesFor(role);
  const { rows } = await pool.query(
    `SELECT * FROM ${t.responses} WHERE session_id = $1`,
    [sessionId]
  );
  const byCode = new Map(rows.map((r) => [r.item_code, r]));
  return byCode;
}

// Full state for rendering GET /evaluation: the session, every task log
// so far (for the completed-so-far checklist), and every saved response
// (for pre-filling the questionnaire on resume).
async function getEvaluationState(accountId, role, evaluationFlow) {
  const session = await getOrCreateSession(accountId, role, evaluationFlow);
  const [taskLogs, responses] = await Promise.all([
    getTaskLogs(session.id, role),
    getResponses(session.id, role),
  ]);
  return { session, taskLogs, responses };
}

// Stamps started_at for the current task the first time the account
// lands on its walkthrough screen. ON CONFLICT DO NOTHING means a page
// refresh or a later revisit never resets the clock.
async function startTaskIfNeeded(sessionId, accountId, taskNumber, role) {
  const t = tablesFor(role);
  const task = WALKTHROUGH_TASKS.find((x) => x.number === taskNumber);
  if (!task) return;
  await pool.query(
    `INSERT INTO ${t.taskLogs} (session_id, account_id, task_number, module_slug)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (session_id, task_number) DO NOTHING`,
    [sessionId, accountId, taskNumber, task.moduleSlug]
  );
}

// Records the respondent's own consent decision (Republic Act No. 10173 —
// Data Privacy Act of 2012): 'given' to start/continue the walkthrough and
// questionnaire, 'declined' to stop serving those screens without touching
// anything already logged, or 'pending' to show the informed-consent
// screen again after a decline (a later, freshly-affirmed "agree" is what
// actually resumes the evaluation — reconsidering never skips straight
// back to 'given'). consent_decided_at is stamped for a real decision and
// cleared for 'pending' so it always reflects the latest choice.
async function recordConsent(session, consentStatus, role) {
  const t = tablesFor(role);
  const { rows } = await pool.query(
    `UPDATE ${t.sessions}
        SET consent_status = $2::VARCHAR(20),
            consent_decided_at = CASE WHEN $2::VARCHAR(20) = 'pending' THEN NULL ELSE now() END
      WHERE id = $1
      RETURNING *`,
    [session.id, consentStatus]
  );
  return rows[0];
}

// Marks a task complete: fills in completed_at/time_on_task_seconds and
// the assistance/error/notes the respondent reported, then advances the
// session to the next task — or to the questionnaire once task 6 is
// done. Returns the updated session row.
async function completeTask(session, accountId, taskNumber, { neededAssistance, hadError, notes }, role) {
  const t = tablesFor(role);
  const task = WALKTHROUGH_TASKS.find((x) => x.number === taskNumber);
  // INSERT ... ON CONFLICT rather than a bare UPDATE: normally
  // startTaskIfNeeded() already created this row when the walkthrough
  // page was loaded, so this is an update in practice, but self-healing
  // here means a task can always be marked complete even if that first
  // insert was ever skipped (e.g. a restart between viewing the task and
  // submitting it) — a silent no-op UPDATE that matched zero rows would
  // otherwise lose the completion without any error.
  await pool.query(
    `INSERT INTO ${t.taskLogs}
       (session_id, account_id, task_number, module_slug, completed_at, time_on_task_seconds, needed_assistance, had_error, notes)
     VALUES ($1, $2, $3, $4, now(), 0, $5, $6, $7)
     ON CONFLICT (session_id, task_number) DO UPDATE
        SET completed_at = now(),
            time_on_task_seconds = GREATEST(0, EXTRACT(EPOCH FROM (now() - ${t.taskLogs}.started_at))::INTEGER),
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
    `UPDATE ${t.sessions}
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
async function saveResponses(session, accountId, answers, role) {
  const t = tablesFor(role);
  const itemsByCode = itemsByCodeFor(role);
  for (const answer of answers) {
    const item = itemsByCode.get(answer.code);
    if (!item) continue; // ignore anything not a real item code
    const rating = answer.rating === null || answer.rating === undefined || answer.rating === ''
      ? null
      : Math.min(5, Math.max(1, parseInt(answer.rating, 10)));
    await pool.query(
      `INSERT INTO ${t.responses} (session_id, account_id, item_code, domain, rating, remark)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (session_id, item_code)
       DO UPDATE SET rating = excluded.rating, remark = excluded.remark, answered_at = now()`,
      [session.id, accountId, item.code, item.domain, Number.isNaN(rating) ? null : rating, answer.remark || null]
    );
  }
}

// Validates the full instrument's own rule (Section 4.1, carried over
// unchanged for the ISO/IEC 25010 instrument): every item must be
// rated, and any rating of 3 or below must carry a remark. Returns
// { ok, missingCodes, needsRemarkCodes } — both arrays empty means the
// questionnaire is ready to be marked complete. itemsFor(role) picks the
// 17-item TAM set for a Template Evaluator or the 15-item ISO/IEC 25010
// set for everyone else, same split as groupItemsByDomain()/saveResponses().
async function validateQuestionnaire(sessionId, role) {
  const responses = await getResponses(sessionId, role);
  const missingCodes = [];
  const needsRemarkCodes = [];
  for (const item of itemsFor(role)) {
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

async function markCompleted(sessionId, role) {
  const t = tablesFor(role);
  const { rows } = await pool.query(
    `UPDATE ${t.sessions} SET status = 'completed', completed_at = now() WHERE id = $1 RETURNING *`,
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
async function getEvaluationStateReadOnly(accountId, role) {
  const t = tablesFor(role);
  const { rows } = await pool.query(
    `SELECT * FROM ${t.sessions} WHERE account_id = $1`,
    [accountId]
  );
  const session = rows[0] || null;
  if (!session) return { session: null, taskLogs: [], responses: new Map() };
  const [taskLogs, responses] = await Promise.all([
    getTaskLogs(session.id, role),
    getResponses(session.id, role),
  ]);
  return { session, taskLogs, responses };
}

// One row per sme_owner account, left-joined to that account's evaluation
// session if it has one, for the admin "View Evaluation Report" list: who's
// done, who's mid-walkthrough/questionnaire, who hasn't started at all.
// Filters to role = 'SME Owner' explicitly (not just "!= 'Admin'") so that
// adding the Template Evaluator role never silently pulls those accounts
// into this list — they have their own listAllExpertEvaluationStatuses()
// below, reading an entirely different pair of tables.
async function listAllEvaluationStatuses() {
  const { rows } = await pool.query(
    `SELECT a.id AS account_id, a.username, a.owner_name, a.business_name,
            s.status, s.current_task, s.started_at,
            s.consent_status, s.consent_decided_at,
            s.walkthrough_completed_at, s.completed_at,
            (SELECT COUNT(*)::int FROM evaluation_task_logs tl
              WHERE tl.session_id = s.id AND tl.completed_at IS NOT NULL) AS tasks_done,
            (SELECT COUNT(*)::int FROM evaluation_responses r
              WHERE r.session_id = s.id AND r.rating IS NOT NULL) AS items_answered
       FROM sme_accounts a
       LEFT JOIN evaluation_sessions s ON s.account_id = a.id
      WHERE a.role = 'SME Owner'
      ORDER BY a.created_at DESC`
  );
  return rows;
}

// Same shape as listAllEvaluationStatuses(), for Template Evaluator accounts
// against the separate expert_evaluation_* tables. Deliberately a
// near-duplicate of the query above rather than a shared parameterized
// helper: these two lists back two different admin pages
// (/admin/evaluations vs /admin/expert-evaluations) that must never be
// combined, so keeping them as textually separate queries makes it
// obvious at a glance that neither one can leak into the other.
async function listAllExpertEvaluationStatuses() {
  const { rows } = await pool.query(
    `SELECT a.id AS account_id, a.username, a.owner_name, a.business_name, a.evaluation_flow,
            s.status, s.current_task, s.started_at,
            s.consent_status, s.consent_decided_at,
            s.walkthrough_completed_at, s.completed_at,
            (SELECT COUNT(*)::int FROM expert_evaluation_task_logs tl
              WHERE tl.session_id = s.id AND tl.completed_at IS NOT NULL) AS tasks_done,
            (SELECT COUNT(*)::int FROM expert_evaluation_module_visits mv
              WHERE mv.session_id = s.id) AS modules_opened,
            (SELECT COUNT(*)::int FROM expert_evaluation_responses r
              WHERE r.session_id = s.id AND r.rating IS NOT NULL) AS items_answered
       FROM sme_accounts a
       LEFT JOIN expert_evaluation_sessions s ON s.account_id = a.id
      WHERE a.role = 'Template Evaluator'
      ORDER BY a.created_at DESC`
  );
  return rows;
}

// Same shape again, for Business Owner Evaluator accounts against the
// separate business_owner_evaluation_* tables — the population that takes
// the new ISO/IEC 25010 instrument. No evaluation_flow/modules_opened
// columns here: unlike Template Evaluator, this role has only ever had
// one flow (always six-task walkthrough-gated, see
// middleware/evaluationGate.js), so there's no split to report.
async function listAllBusinessOwnerEvaluationStatuses() {
  const { rows } = await pool.query(
    `SELECT a.id AS account_id, a.username, a.owner_name, a.business_name,
            s.status, s.current_task, s.started_at,
            s.consent_status, s.consent_decided_at,
            s.walkthrough_completed_at, s.completed_at,
            (SELECT COUNT(*)::int FROM business_owner_evaluation_task_logs tl
              WHERE tl.session_id = s.id AND tl.completed_at IS NOT NULL) AS tasks_done,
            (SELECT COUNT(*)::int FROM business_owner_evaluation_responses r
              WHERE r.session_id = s.id AND r.rating IS NOT NULL) AS items_answered
       FROM sme_accounts a
       LEFT JOIN business_owner_evaluation_sessions s ON s.account_id = a.id
      WHERE a.role = 'Business Owner Evaluator'
      ORDER BY a.created_at DESC`
  );
  return rows;
}

// Same shape again, for SME Owner-TAM Evaluator accounts (added 4 October
// 2026) against the separate sme_tam_evaluation_* tables. Direct flow only,
// so it reports modules_opened (distinct modules visited) instead of
// walkthrough tasks_done, like listAllExpertEvaluationStatuses() does for
// its direct-flow accounts.
async function listAllSmeTamEvaluationStatuses() {
  const { rows } = await pool.query(
    `SELECT a.id AS account_id, a.username, a.owner_name, a.business_name,
            s.status, s.current_task, s.started_at,
            s.consent_status, s.consent_decided_at,
            s.walkthrough_completed_at, s.completed_at,
            (SELECT COUNT(*)::int FROM sme_tam_evaluation_module_visits mv
              WHERE mv.session_id = s.id) AS modules_opened,
            (SELECT COUNT(*)::int FROM sme_tam_evaluation_responses r
              WHERE r.session_id = s.id AND r.rating IS NOT NULL) AS items_answered
       FROM sme_accounts a
       LEFT JOIN sme_tam_evaluation_sessions s ON s.account_id = a.id
      WHERE a.role = 'SME Owner-TAM Evaluator'
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
// evaluationFlowFilter ('walkthrough' | 'direct' | undefined) — when set,
// joins back to sme_accounts and restricts to accounts on that flow.
// getCompletedExpertResponseSummary() below always sets it (never
// undefined) for exactly this reason: a Template Evaluator's
// evaluation_flow decides which population a completed response belongs
// to, and the two must never be averaged together (see the
// expert_evaluation_sessions header comment in db/schema.sql). sme_owner
// callers never pass it — every SME Owner account is 'walkthrough', so
// filtering would be a no-op there, not an omission.
//
// role picks which item list/domain set this summary is scored against —
// itemsFor(role)/domainCodesFor(role)/domainLabelsFor(role): the 15-item
// ISO/IEC 25010 instrument for BUSINESS_ROLE callers
// (getCompletedBusinessOwnerResponseSummary), or the original 17-item TAM
// instrument for everyone else (getCompletedResponseSummary,
// getCompletedExpertResponseSummary — both unchanged).
async function summarizeCompletedResponses(responsesTable, sessionsTable, evaluationFlowFilter, role) {
  const params = [];
  let flowJoin = '';
  if (evaluationFlowFilter) {
    flowJoin = 'JOIN sme_accounts acc ON acc.id = s.account_id AND acc.evaluation_flow = $1';
    params.push(evaluationFlowFilter);
  }
  const { rows } = await pool.query(
    `SELECT r.item_code, r.domain, r.rating
       FROM ${responsesTable} r
       JOIN ${sessionsTable} s ON s.id = r.session_id
       ${flowJoin}
      WHERE s.status = 'completed' AND r.rating IS NOT NULL`,
    params
  );
  const { rows: completedCountRows } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM ${sessionsTable} s ${flowJoin} WHERE s.status = 'completed'`,
    params
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

  const items = itemsFor(role);
  const labels = domainLabelsFor(role);
  const byItem = items.map((item) => {
    const values = rows.filter((r) => r.item_code === item.code).map((r) => r.rating);
    return { code: item.code, domain: item.domain, text: item.text, ...summarize(values) };
  });

  const byDomain = domainCodesFor(role).map((domain) => {
    const values = rows.filter((r) => r.domain === domain).map((r) => r.rating);
    return { domain, label: labels[domain], ...summarize(values) };
  });

  return { byItem, byDomain, completedCount: completedCountRows[0].n };
}

async function getCompletedResponseSummary() {
  return summarizeCompletedResponses('evaluation_responses', 'evaluation_sessions', undefined, SME_ROLE);
}

// Returns { walkthrough, direct } — two separate summaries, never one
// combined figure, because sme_accounts.evaluation_flow splits Template
// Evaluator accounts into the original six-task-gated population (the
// 15 grandfathered accounts) and the direct-flow population added
// 2 October 2026. GET /admin/expert-evaluations renders both sections
// side by side rather than merging them into a single cross-respondent
// table.
async function getCompletedExpertResponseSummary() {
  const [walkthrough, direct] = await Promise.all([
    summarizeCompletedResponses('expert_evaluation_responses', 'expert_evaluation_sessions', 'walkthrough', EXPERT_ROLE),
    summarizeCompletedResponses('expert_evaluation_responses', 'expert_evaluation_sessions', 'direct', EXPERT_ROLE),
  ]);
  return { walkthrough, direct };
}

// Single summary (no flow split — this role has only one flow) for
// Business Owner Evaluator accounts, scored against the 15-item ISO/IEC
// 25010 instrument via business_owner_evaluation_responses/_sessions.
async function getCompletedBusinessOwnerResponseSummary() {
  return summarizeCompletedResponses('business_owner_evaluation_responses', 'business_owner_evaluation_sessions', undefined, BUSINESS_ROLE);
}

// Single summary (this role has one flow) for SME Owner-TAM Evaluator
// accounts, scored against the reworded 17-item TAM set (SME_TAM_ITEMS) via
// sme_tam_evaluation_responses/_sessions. Never combined with
// getCompletedResponseSummary()/getCompletedExpertResponseSummary(): the
// wording differs, so the three TAM-family result sets stay separate.
async function getCompletedSmeTamResponseSummary() {
  return summarizeCompletedResponses('sme_tam_evaluation_responses', 'sme_tam_evaluation_sessions', undefined, SME_TAM_ROLE);
}

// ------------------------------------------------------------------
// Direct-flow time-on-module logging (expert_evaluation_module_visits —
// see its header comment in db/schema.sql). Only ever meaningful for a
// 'direct'-flow Template Evaluator account; callers (routes/dashboard.js's
// trackDirectFlowModuleVisit()) only ever invoke this after already
// checking the account's role and evaluation_flow themselves.
// ------------------------------------------------------------------
const MODULE_VISIT_MAX_GAP_SECONDS = 30 * 60; // an idle tab left open overnight shouldn't inflate time-on-module

async function recordModuleVisit(accountId, moduleSlug, role = EXPERT_ROLE) {
  const t = tablesFor(role);
  // getOrCreateSession(..., 'direct') is safe to call even if this
  // account's session already exists at 'questionnaire' from an earlier
  // /evaluation visit, or doesn't exist yet because this is literally the
  // first page this account ever opened after signing up — either way
  // ON CONFLICT DO NOTHING means the existing row (whatever its actual
  // status) is simply returned untouched.
  const session = await getOrCreateSession(accountId, role, 'direct');

  // RA 10173 — no data collection before the respondent has affirmatively
  // agreed to take part. Browsing the analytics pages themselves is never
  // gated on consent (middleware/evaluationGate.js bypasses the lock
  // entirely for a direct-flow account), but logging how long they spend
  // on each one is itself evaluation data, so it waits for 'given' the
  // same way the walkthrough/questionnaire screens do.
  if (session.consent_status !== 'given') return;

  // Credit the elapsed time since this account's own last page-open to
  // whichever module it was LAST seen on (not the one it's entering now)
  // — that's the module it was actually reading in between. A gap beyond
  // the cap is treated as "came back after being away" and credits
  // nothing, rather than crediting a huge, meaningless idle duration.
  const { rows: lastRows } = await pool.query(
    `SELECT module_slug, last_opened_at FROM ${t.visits}
      WHERE session_id = $1 ORDER BY last_opened_at DESC LIMIT 1`,
    [session.id]
  );
  const last = lastRows[0];
  if (last) {
    const gapSeconds = Math.max(0, (Date.now() - new Date(last.last_opened_at).getTime()) / 1000);
    if (gapSeconds > 0 && gapSeconds <= MODULE_VISIT_MAX_GAP_SECONDS) {
      await pool.query(
        `UPDATE ${t.visits}
            SET total_seconds = total_seconds + $3
          WHERE session_id = $1 AND module_slug = $2`,
        [session.id, last.module_slug, Math.round(gapSeconds)]
      );
    }
  }

  await pool.query(
    `INSERT INTO ${t.visits} (session_id, account_id, module_slug)
     VALUES ($1, $2, $3)
     ON CONFLICT (session_id, module_slug) DO UPDATE
        SET last_opened_at = now(),
            open_count = ${t.visits}.open_count + 1`,
    [session.id, accountId, moduleSlug]
  );
}

// Fixed display order matching STUB_SECTIONS in routes/dashboard.js
// (Descriptive -> Diagnostic -> Predictive -> Prescriptive), not whatever
// order the account happened to visit them in — used by the completed-
// evaluation summary and the admin detail page, both of which want a
// stable, readable row order regardless of visit history.
const MODULE_VISIT_SLUG_ORDER = [
  'descriptive-analytics', 'diagnostic-insights', 'predictive-analytics', 'prescriptive-recommendations',
];

async function getModuleVisits(sessionId, role = EXPERT_ROLE) {
  const { rows } = await pool.query(
    `SELECT * FROM ${tablesFor(role).visits} WHERE session_id = $1`,
    [sessionId]
  );
  const bySlug = new Map(rows.map((r) => [r.module_slug, r]));
  return MODULE_VISIT_SLUG_ORDER.map((slug) => bySlug.get(slug) || null);
}

module.exports = {
  SME_ROLE,
  EXPERT_ROLE,
  BUSINESS_ROLE,
  SME_TAM_ROLE,
  isDirectFlow,
  WALKTHROUGH_TASKS,
  TAM_ITEMS,
  SME_TAM_ITEMS,
  DOMAIN_LABELS,
  ISO25010_ITEMS,
  ISO_DOMAIN_LABELS,
  itemsFor,
  itemsByCodeFor,
  domainCodesFor,
  domainLabelsFor,
  groupItemsByDomain,
  getOrCreateSession,
  getEvaluationState,
  recordConsent,
  startTaskIfNeeded,
  completeTask,
  saveResponses,
  validateQuestionnaire,
  markCompleted,
  getEvaluationStateReadOnly,
  listAllEvaluationStatuses,
  listAllExpertEvaluationStatuses,
  listAllBusinessOwnerEvaluationStatuses,
  listAllSmeTamEvaluationStatuses,
  getCompletedResponseSummary,
  getCompletedExpertResponseSummary,
  getCompletedBusinessOwnerResponseSummary,
  getCompletedSmeTamResponseSummary,
  recordModuleVisit,
  getModuleVisits,
  MODULE_VISIT_SLUG_ORDER,
};
