// TAM End-User Evaluation — routes for the six-task walkthrough and the
// 17-item questionnaire it unlocks. See services/tamEvaluation.js for the
// task/item content and all the persistence logic; this file is just
// routing + request handling on top of it.
const express = require('express');
const { requireAuth } = require('../middleware/auth');
const {
  WALKTHROUGH_TASKS, TAM_ITEMS, groupItemsByDomain,
  getEvaluationState, startTaskIfNeeded, completeTask,
  saveResponses, validateQuestionnaire, markCompleted,
} = require('../services/tamEvaluation');

const router = express.Router();
router.use(requireAuth);

// ------------------------------------------------------------------
// GET /evaluation — single entry point. Always resumes wherever this
// account left off: creates the session on first visit, then routes to
// the current walkthrough task, the questionnaire, or the completed
// summary, purely from what's already saved in Postgres.
// ------------------------------------------------------------------
router.get('/evaluation', async (req, res, next) => {
  try {
    const accountId = req.session.userId;
    const { session, taskLogs, responses } = await getEvaluationState(accountId);

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
// POST /evaluation/task/:n/complete — logs completion/assistance/error
// for the walkthrough's current task and advances to the next one (or
// to the questionnaire, after task 6).
// ------------------------------------------------------------------
router.post('/evaluation/task/:n/complete', async (req, res, next) => {
  try {
    const accountId = req.session.userId;
    const taskNumber = parseInt(req.params.n, 10);
    const { session } = await getEvaluationState(accountId);

    // Only the account's actual current task can be completed — guards
    // against a stale/replayed form (e.g. the back button) silently
    // skipping ahead or re-logging an already-completed task.
    if (session.status !== 'walkthrough' || taskNumber !== session.current_task) {
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
    if (session.status !== 'questionnaire') {
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
