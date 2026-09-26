// TAM End-User Evaluation — routes for the six-task walkthrough and the
// 17-item questionnaire it unlocks. See services/tamEvaluation.js for the
// task/item content and all the persistence logic; this file is just
// routing + request handling on top of it.
const express = require('express');
const { requireAuth } = require('../middleware/auth');
const {
  WALKTHROUGH_TASKS, TAM_ITEMS, groupItemsByDomain,
  getEvaluationState, recordConsent, startTaskIfNeeded, completeTask,
  saveResponses, validateQuestionnaire, markCompleted,
} = require('../services/tamEvaluation');

const router = express.Router();
router.use(requireAuth);

// Only these three decisions are ever written, and each maps to exactly
// one consent_status value — see recordConsent() in tamEvaluation.js.
const CONSENT_DECISIONS = { agree: 'given', decline: 'declined', reconsider: 'pending' };

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
    const { session, taskLogs, responses } = await getEvaluationState(accountId);

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
      });
    }

    if (session.consent_status === 'declined') {
      return res.render('dashboard/evaluation-declined', {
        title: 'End-User Evaluation',
        active: 'evaluation',
        session,
      });
    }

    if (session.status === 'walkthrough') {
      await startTaskIfNeeded(session.id, accountId, session.current_task);
      const refreshed = await getEvaluationState(accountId);
      const currentTask = WALKTHROUGH_TASKS.find((t) => t.number === refreshed.session.current_task);
      return res.render('dashboard/evaluation-walkthrough', {
        title: 'End-User Evaluation',
        active: 'evaluation',
        session: refreshed.session,
        tasks: WALKTHROUGH_TASKS,
        taskLogs: refreshed.taskLogs,
        currentTask,
      });
    }

    if (session.status === 'questionnaire') {
      return res.render('dashboard/evaluation-questionnaire', {
        title: 'End-User Evaluation — Questionnaire',
        active: 'evaluation',
        session,
        domains: groupItemsByDomain(),
        responses,
        errors: null,
      });
    }

    // completed
    return res.render('dashboard/evaluation-complete', {
      title: 'End-User Evaluation — Complete',
      active: 'evaluation',
      session,
      tasks: WALKTHROUGH_TASKS,
      taskLogs,
      domains: groupItemsByDomain(),
      responses,
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
    const { session } = await getEvaluationState(accountId);
    const nextStatus = CONSENT_DECISIONS[req.body.decision];
    if (nextStatus) {
      await recordConsent(session, nextStatus);
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
    const taskNumber = parseInt(req.params.n, 10);
    const { session } = await getEvaluationState(accountId);

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
    });

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
    const { session } = await getEvaluationState(accountId);
    if (session.consent_status !== 'given' || session.status !== 'questionnaire') {
      return res.redirect('/evaluation');
    }

    const answers = TAM_ITEMS.map((item) => ({
      code: item.code,
      rating: req.body[`rating_${item.code}`],
      remark: req.body[`remark_${item.code}`],
    }));
    await saveResponses(session, accountId, answers);

    if (req.body.action === 'submit') {
      const validation = await validateQuestionnaire(session.id);
      if (!validation.ok) {
        const { responses } = await getEvaluationState(accountId);
        return res.status(400).render('dashboard/evaluation-questionnaire', {
          title: 'End-User Evaluation — Questionnaire',
          active: 'evaluation',
          session,
          domains: groupItemsByDomain(),
          responses,
          errors: validation,
        });
      }
      await markCompleted(session.id);
    }

    return res.redirect('/evaluation');
  } catch (err) {
    next(err);
  }
});

module.exports = router;
