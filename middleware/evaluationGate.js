// Forces an SME owner through the TAM six-task walkthrough (see
// services/tamEvaluation.js, claude/tam-instrument-end-user-evaluation.md)
// before unlocking the rest of the app's navigation. Per Brenda's own
// choice, this applies to every sme_owner account whose evaluation isn't
// yet 'completed' — not just accounts created from here on — so an
// existing account that hasn't gone through it yet is gated too the next
// time it loads a page. Admin accounts are never gated: they view
// analytics read-only via "View analytics" on Manage Datasets, they never
// take this evaluation on their own account (see the Admin branch of
// views/partials/sidebar.ejs).
//
// Two things happen here:
//   1. res.locals.evaluationLocked is set on every request, so
//      views/partials/sidebar.ejs can render only the "End-User
//      Evaluation" link while true.
//   2. A direct visit (typed URL, bookmark, stale tab) to a route this
//      gate covers is redirected back to /evaluation if it isn't reachable
//      yet — sidebar-hiding alone wouldn't actually "force" anything.
//
// Only the sidebar's own destinations are covered — the six analytics/
// upload/browse modules and Monetization Discovery. Sub-screens reached
// FROM those modules (Review Field Roles, dataset exports, Setup &
// Configuration, etc.) are deliberately left ungated: they're not
// separate navigation choices, and gating them individually would risk
// breaking the walkthrough's own in-task links rather than adding
// anything the request asked for.
const pool = require('../db/pool');
const { WALKTHROUGH_TASKS } = require('../services/tamEvaluation');

// Each task's module unlocks progressively as the walkthrough reaches it
// (current_task advances via services/tamEvaluation.js's completeTask()),
// rather than all six being blocked until the very end — task 1's own
// "Open Upload New Dataset" button has to work from the first moment the
// account exists.
const TASK_ROUTE_PREFIXES = WALKTHROUGH_TASKS.map((t) => ({ number: t.number, prefix: t.href }));

// Locked until the WHOLE evaluation (walkthrough + questionnaire) is
// 'completed' — reaching a task number never unlocks these, since they
// aren't one of the six walkthrough modules at all.
const COMPLETED_ONLY_PREFIXES = ['/monetization-discovery'];

// Always reachable, whatever the lock state.
const ALWAYS_ALLOWED_PREFIXES = ['/evaluation', '/logout', '/healthz'];

function pathMatches(path, prefix) {
  return path === prefix || path.startsWith(`${prefix}/`);
}

function matchesAny(path, prefixes) {
  return prefixes.some((p) => pathMatches(path, p));
}

async function evaluationGate(req, res, next) {
  const user = req.session && req.session.user;
  if (!user || user.role === 'Admin') {
    res.locals.evaluationLocked = false;
    return next();
  }

  let session;
  try {
    const { rows } = await pool.query(
      `SELECT status, current_task FROM evaluation_sessions WHERE account_id = $1`,
      [user.id]
    );
    session = rows[0] || null;
  } catch (e) {
    console.error('[evaluationGate] status lookup failed:', e.message);
    // Fail open — a DB hiccup here should never lock a real SME owner out
    // of their own dashboard.
    res.locals.evaluationLocked = false;
    return next();
  }

  // No row yet == a brand-new account that hasn't visited /evaluation
  // once (that first visit is what creates it — see getOrCreateSession()),
  // which is equivalent to status 'walkthrough' at task 1.
  const status = session ? session.status : 'walkthrough';
  const currentTask = session ? session.current_task : 1;
  const locked = status !== 'completed';
  res.locals.evaluationLocked = locked;

  if (!locked) return next();
  if (matchesAny(req.path, ALWAYS_ALLOWED_PREFIXES)) return next();

  // Not using req.session.flashError here on purpose — that field is
  // consumed only by GET /login (routes/auth.js) and cleared on read; a
  // value set here could otherwise sit in the session and bleed into an
  // unrelated later login attempt. The evaluation-walkthrough page's own
  // subtitle already explains what's going on, so a plain redirect is
  // enough.
  if (matchesAny(req.path, COMPLETED_ONLY_PREFIXES)) {
    return res.redirect('/evaluation');
  }

  const taskMatch = TASK_ROUTE_PREFIXES.find((t) => pathMatches(req.path, t.prefix));
  if (taskMatch) {
    if (taskMatch.number <= currentTask) return next(); // this task's module (or an earlier one) is unlocked
    return res.redirect('/evaluation');
  }

  // The home page isn't "End-User Evaluation" either, so send it there
  // too. Everything else (Setup & Configuration, dataset sub-pages,
  // exports, review-fields, etc.) is intentionally left alone.
  if (req.path === '/') {
    return res.redirect('/evaluation');
  }
  return next();
}

module.exports = { evaluationGate };
