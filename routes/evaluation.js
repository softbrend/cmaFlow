// TAM End-User Evaluation — routes for the six-task walkthrough and the
// 17-item questionnaire it unlocks. Shared by sme_owner accounts AND
// Template Evaluator accounts (added 30 September 2026) — every call into
// services/tamEvaluation.js below passes the signed-in account's own
// role, which is what picks evaluation_sessions/_task_logs/_responses
// (SME owner) vs expert_evaluation_sessions/_task_logs/_responses
// (Template Evaluator); see that service's header comment and db/schema.sql's note
// on the expert_* tables for why. Everything else here — routing,
// request handling, the views rendered — is identical for both
// populations, which is the point: the instrument itself does not
// change, only where its answers are stored.
const express = require('express');
const { requireAuth } = require('../middleware/auth');
const {
  WALKTHROUGH_TASKS, itemsFor, groupItemsByDomain, EXPERT_ROLE, BUSINESS_ROLE, SME_TAM_ROLE,
  isDirectFlow: isDirectFlowFor,
  getEvaluationState, recordConsent, startTaskIfNeeded, completeTask,
  saveResponses, saveFeedback, FEEDBACK_MAX_LENGTH, validateQuestionnaire, markCompleted, getModuleVisits,
} = require('../services/tamEvaluation');
// Only for the Task 1 card's "dataset assigned at sign-up" readout below —
// labelForTemplateFile() turns the evaluation_template_file a Template
// Evaluator or Business Owner Evaluator picked (or was auto-assigned at
// signup, see routes/auth.js's ingestDefaultTemplateForCategory()) back
// into its human-readable category name, the same one routes/templates.js
// and views/dashboard/sme-templates.ejs already show.
const { labelForTemplateFile } = require('../services/smeCategories');

const router = express.Router();
router.use(requireAuth);

// Only these three decisions are ever written, and each maps to exactly
// one consent_status value — see recordConsent() in tamEvaluation.js.
const CONSENT_DECISIONS = { agree: 'given', decline: 'declined', reconsider: 'pending' };

// Page-title label for the five evaluation-*.ejs views — added 2 October
// 2026 alongside the Business Owner Evaluator role. isExpert (below) is
// still kept and passed separately: it also decides isDirectFlow, which
// is Template-Evaluator-specific and has nothing to do with this third
// role. Business Owner Evaluator is always walkthrough-gated, same as
// an SME Owner, so it needs no equivalent of isDirectFlow — only its own
// label here.
function evalRoleLabelFor(role) {
  if (role === EXPERT_ROLE) return 'Template Evaluator Evaluation';
  if (role === BUSINESS_ROLE) return 'Business Owner Evaluator Evaluation';
  // SME Owner-TAM Evaluator (added 4 October 2026) — always direct flow
  // (see isDirectFlowFor() in services/tamEvaluation.js), so it never
  // reaches the walkthrough screen; only this label is new.
  if (role === SME_TAM_ROLE) return 'SME Owner-TAM Evaluation';
  return 'End-User Evaluation';
}

// ------------------------------------------------------------------
// GET /evaluation — single entry point. Always resumes wherever this
// account left off: creates the session on first visit, then routes to
// the informed-consent screen, the declined screen, or (once consent has
// been given) the current walkthrough task, the questionnaire, or the
// completed summary — purely from what's already saved in Postgres.
// ------------------------------------------------------------------
router.get('/evaluation', async (req, res, next) => {
  try {
    const accountId = req.session.userId;
    const role = req.session.user && req.session.user.role;
    const isExpert = role === EXPERT_ROLE;
    // Only ever true for a Template Evaluator — an SME Owner's
    // evaluation_flow column exists but is always 'walkthrough' (nothing
    // ever sets it otherwise), so this check is effectively isExpert-only
    // in practice, written out in full for clarity.
    // isDirectFlowFor(): Template Evaluator on the 'direct' flow, OR any
    // SME Owner-TAM Evaluator (always direct — no walkthrough variant).
    const isDirectFlow = isDirectFlowFor(role, req.session.user && req.session.user.evaluation_flow);
    const evalRoleLabel = evalRoleLabelFor(role);
    // Either template-system role (Template Evaluator or Business Owner
    // Evaluator) gets a default dataset ingested automatically at signup
    // from the business category they declared — surfaced on Task 1's
    // walkthrough card below (the "Upload New Dataset" step) as a
    // "Use <category> (Evaluation Template)" shortcut, so the account
    // doesn't have to already know this happened or go find /sme-templates
    // to see what was picked for them. null for an SME Owner (no template
    // system) and for anyone who hasn't been assigned one yet.
    const evaluationTemplateFile = (isExpert || role === BUSINESS_ROLE) && req.session.user.evaluation_template_file
      ? req.session.user.evaluation_template_file
      : null;
    const evaluationDatasetLabel = evaluationTemplateFile
      ? `${labelForTemplateFile(evaluationTemplateFile) || evaluationTemplateFile} (Evaluation Template)`
      : null;
    // Business Owner Evaluator only (added 2 October 2026) — lets Task 1's
    // card offer a direct link into the new editable CRUD grid at GET
    // /sme-templates/evaluation-dataset/:id (routes/templates.js),
    // alongside the "Use" button both template-system roles already get.
    // Template Evaluator never sees this link: its own evaluation dataset
    // stays read-only (see requireBusinessOwner()'s comment in
    // routes/templates.js).
    const isBusinessOwnerRole = role === BUSINESS_ROLE;
    // The account's CURRENT copy's own row id (added 3 October 2026,
    // alongside the multi-copy model — an account can hold several
    // copies at once, one per category, so Task 1 links straight at
    // whichever one is "default" rather than a bare, id-less route that
    // no longer exists on its own). null until the account has a default
    // dataset at all, in which case the walkthrough view falls back to
    // linking the "My evaluation dataset copies" listing instead.
    const evaluationDatasetRowId = (isBusinessOwnerRole && req.session.user.default_dataset_id) || null;
    const { session, taskLogs, responses } = await getEvaluationState(accountId, role, req.session.user && req.session.user.evaluation_flow);

    // Republic Act No. 10173 (Data Privacy Act of 2012): no walkthrough or
    // questionnaire screen is ever served until the respondent has
    // affirmatively and voluntarily agreed to take part. A fresh session
    // defaults to 'pending', so this is the very first thing every account
    // sees at /evaluation.
    if (session.consent_status === 'pending') {
      return res.render('dashboard/evaluation-consent', {
        title: 'End-User Evaluation — Informed Consent',
        active: 'evaluation',
        session,
        isExpert,
        isDirectFlow,
        evalRoleLabel,
        questionnaireItemCount: itemsFor(role).length,
      });
    }

    if (session.consent_status === 'declined') {
      return res.render('dashboard/evaluation-declined', {
        title: 'End-User Evaluation',
        active: 'evaluation',
        session,
        isExpert,
        isDirectFlow,
        evalRoleLabel,
      });
    }

    if (session.status === 'walkthrough') {
      // Never reached for a direct-flow session — getOrCreateSession()
      // seeds it straight at 'questionnaire' — but left intact for the
      // 'walkthrough'-flow population this route still fully serves.
      await startTaskIfNeeded(session.id, accountId, session.current_task, role);
      const refreshed = await getEvaluationState(accountId, role);
      const currentTask = WALKTHROUGH_TASKS.find((t) => t.number === refreshed.session.current_task);
      return res.render('dashboard/evaluation-walkthrough', {
        title: 'End-User Evaluation',
        active: 'evaluation',
        session: refreshed.session,
        tasks: WALKTHROUGH_TASKS,
        taskLogs: refreshed.taskLogs,
        currentTask,
        isExpert,
        isDirectFlow,
        evalRoleLabel,
        evaluationTemplateFile,
        evaluationDatasetLabel,
        isBusinessOwnerRole,
        evaluationDatasetRowId,
      });
    }

    if (session.status === 'questionnaire') {
      // active is 'evaluation-questionnaire' here, not the 'evaluation'
      // every other screen in this file uses (added 2 October 2026, per
      // Brenda's request to give this specific page its own, wider layout
      // — see public/css/style.css's body.stage-evaluation-questionnaire
      // rules). views/partials/sidebar.ejs treats the two as equivalent
      // for nav highlighting, so the "Evaluation" link still lights up.
      return res.render('dashboard/evaluation-questionnaire', {
        title: 'End-User Evaluation — Questionnaire',
        active: 'evaluation-questionnaire',
        session,
        domains: groupItemsByDomain(role),
        responses,
        errors: null,
        isExpert,
        isDirectFlow,
        evalRoleLabel,
        hasFeedback: role === SME_TAM_ROLE,
        feedbackMaxLength: FEEDBACK_MAX_LENGTH,
      });
    }

    // completed
    const moduleVisits = isDirectFlow ? await getModuleVisits(session.id, role) : null;
    return res.render('dashboard/evaluation-complete', {
      title: 'End-User Evaluation — Complete',
      active: 'evaluation',
      session,
      tasks: WALKTHROUGH_TASKS,
      taskLogs,
      moduleVisits,
      domains: groupItemsByDomain(role),
      responses,
      isExpert,
      isDirectFlow,
      evalRoleLabel,
      hasFeedback: role === SME_TAM_ROLE,
    });
  } catch (err) {
    next(err);
  }
});

// ------------------------------------------------------------------
// POST /evaluation/consent — the respondent's own voluntary-participation
// choice (RA 10173): agree, decline, or reconsider (declined -> pending,
// so a "changed my mind" respondent sees the full informed-consent screen
// again rather than being silently re-enrolled).
// ------------------------------------------------------------------
router.post('/evaluation/consent', async (req, res, next) => {
  try {
    const accountId = req.session.userId;
    const role = req.session.user && req.session.user.role;
    const { session } = await getEvaluationState(accountId, role);
    const nextStatus = CONSENT_DECISIONS[req.body.decision];
    if (nextStatus) {
      await recordConsent(session, nextStatus, role);
    }
    return res.redirect('/evaluation');
  } catch (err) {
    next(err);
  }
});

// ------------------------------------------------------------------
// POST /evaluation/task/:n/complete — logs completion/assistance/error
// for the walkthrough's current task and advances to the next one (or
// to the questionnaire, after task 6).
// ------------------------------------------------------------------
router.post('/evaluation/task/:n/complete', async (req, res, next) => {
  try {
    const accountId = req.session.userId;
    const role = req.session.user && req.session.user.role;
    const taskNumber = parseInt(req.params.n, 10);
    const { session } = await getEvaluationState(accountId, role);

    // Consent must still be 'given' — a mid-evaluation withdrawal (see the
    // "Withdraw from this evaluation" link) must stop this from silently
    // logging further task data. Also guards against a stale/replayed form
    // (e.g. the back button) skipping ahead or re-logging an
    // already-completed task: only the account's actual current task can
    // be completed.
    if (session.consent_status !== 'given' || session.status !== 'walkthrough' || taskNumber !== session.current_task) {
      return res.redirect('/evaluation');
    }

    await completeTask(session, accountId, taskNumber, {
      neededAssistance: req.body.needed_assistance === 'on',
      hadError: req.body.had_error === 'on',
      notes: req.body.notes,
    }, role);

    return res.redirect('/evaluation');
  } catch (err) {
    next(err);
  }
});

// ------------------------------------------------------------------
// POST /evaluation/questionnaire — one form posts all 17 items at once.
// action=save just upserts whatever was filled in and stays on the
// questionnaire (the resume point); action=submit additionally requires
// every item answered, with a remark on any rating <=3, before marking
// the evaluation complete.
// ------------------------------------------------------------------
router.post('/evaluation/questionnaire', async (req, res, next) => {
  try {
    const accountId = req.session.userId;
    const role = req.session.user && req.session.user.role;
    const isExpert = role === EXPERT_ROLE;
    const isDirectFlow = isDirectFlowFor(role, req.session.user && req.session.user.evaluation_flow);
    const evalRoleLabel = evalRoleLabelFor(role);
    const { session } = await getEvaluationState(accountId, role, req.session.user && req.session.user.evaluation_flow);
    if (session.consent_status !== 'given' || session.status !== 'questionnaire') {
      return res.redirect('/evaluation');
    }

    const answers = itemsFor(role).map((item) => ({
      code: item.code,
      rating: req.body[`rating_${item.code}`],
      remark: req.body[`remark_${item.code}`],
    }));
    await saveResponses(session, accountId, answers, role);
    // SME Owner-TAM Evaluator only: the optional improvement-feedback box.
    // Saved on both "Save progress" and "Submit", and mirrored onto the
    // in-memory session so a validation re-render keeps what was typed.
    if (role === SME_TAM_ROLE) {
      session.feedback = await saveFeedback(session.id, req.body.feedback, role);
    }

    if (req.body.action === 'submit') {
      const validation = await validateQuestionnaire(session.id, role);
      if (!validation.ok) {
        const { responses } = await getEvaluationState(accountId, role);
        return res.status(400).render('dashboard/evaluation-questionnaire', {
          title: 'End-User Evaluation — Questionnaire',
          active: 'evaluation-questionnaire',
          session,
          domains: groupItemsByDomain(role),
          responses,
          errors: validation,
          isExpert,
          isDirectFlow,
          evalRoleLabel,
          hasFeedback: role === SME_TAM_ROLE,
          feedbackMaxLength: FEEDBACK_MAX_LENGTH,
        });
      }
      await markCompleted(session.id, role);
    }

    return res.redirect('/evaluation');
  } catch (err) {
    next(err);
  }
});

module.exports = router;
