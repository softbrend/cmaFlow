// Admin section — a role='Admin' account (see db/schema.sql's
// sme_accounts.role column, and scripts/promoteToAdmin.js for how an
// account gets that role) can manage accounts for THREE separate
// populations and browse each one's own evaluation data, never mixed:
//   - SME Owner — the original population, takes the 17-item TAM
//     questionnaire (services/tamEvaluation.js's TAM_ITEMS), browsed at
//     /admin/evaluations against evaluation_*.
//   - Template Evaluator (added 30 September 2026) — also takes TAM,
//     unchanged (Brenda's own instruction, see claude/direct-flow-
//     template-evaluator.md: "the previous evaluation done by the 15
//     that they upload their own datasets should not be touched"),
//     browsed separately at /admin/expert-evaluations against the
//     parallel expert_evaluation_* tables.
//   - Business Owner Evaluator (added 2 October 2026, access-code-gated
//     /businessOwner-signup) — the new, purpose-built population that
//     alone takes the 15-item ISO/IEC 25010 Quality-in-Use instrument
//     (tamEvaluation.js's ISO25010_ITEMS), browsed at
//     /admin/business-owner-evaluations against business_owner_
//     evaluation_*. Neither TAM population's instrument or already-
//     collected data is touched by this role's existence.
// Each population also gets its own accounts page (/admin/accounts,
// /admin/expert-accounts, /admin/business-owner-accounts) and dataset
// list (/admin/datasets, /admin/expert-datasets, /admin/business-owner-
// datasets) — see services/adminAccounts.js and services/
// adminDatasets.js for why these are kept as separate, near-duplicate
// queries rather than one shared parameterized helper.
//
// Entirely separate router from routes/dashboard.js's SME Owner Portal —
// an Admin account has no datasets/analytics of its own, so none of that
// router's pages apply to it. requireAdmin (middleware/auth.js) gates
// every route below; a signed-in non-admin gets a 403, not a redirect to
// /login (they ARE authenticated, just not authorized for this section).
const express = require('express');
const { body, validationResult } = require('express-validator');
const pool = require('../db/pool');
const { requireAdmin } = require('../middleware/auth');
const {
  listAccounts, listExpertAccounts, listBusinessOwnerAccounts, listSmeTamAccounts, getAccountById, resetPassword, countAdmins,
  createAdminAccount, promoteToAdmin, demoteToOwner, setCohort, COHORT_LABELS,
} = require('../services/adminAccounts');
const {
  WALKTHROUGH_TASKS, groupItemsByDomain, EXPERT_ROLE, BUSINESS_ROLE, SME_TAM_ROLE, SME_ROLE, itemsFor,
  getEvaluationStateReadOnly, listAllEvaluationStatuses, getCompletedResponseSummary,
  listAllExpertEvaluationStatuses, getCompletedExpertResponseSummary,
  listAllBusinessOwnerEvaluationStatuses, getCompletedBusinessOwnerResponseSummary, getModuleVisits,
  listAllSmeTamEvaluationStatuses, getCompletedSmeTamResponseSummary,
} = require('../services/tamEvaluation');
const { listAllDatasets, getDatasetForAdmin, deleteDataset } = require('../services/adminDatasets');
const { getActivityReport, buildCsv } = require('../services/smeTamActivity');
const { listAllDecisionFollowups, buildDecisionsCsv } = require('../services/smeTamDecisions');
const {
  startRun, logTrustRating, getDatasetComparisonSummary,
} = require('../services/gatingComparison');
const { getOrBuildFullProfile } = require('../services/fullDescriptiveAnalytics');
const { buildSemanticModelHybrid } = require('../services/semanticFieldEngine');
const { buildErdDefinition } = require('../services/erdDiagram');
const { humanizeFileType } = require('../middleware/browse');

const router = express.Router();
router.use(requireAdmin);

// ------------------------------------------------------------------
// GET /admin — overview: account counts + evaluation-progress counts,
// with quick links into the two sections below.
// ------------------------------------------------------------------
router.get('/admin', async (req, res, next) => {
  try {
    const [{ rows: countRows }, statuses, expertStatuses, businessOwnerStatuses, smeTamStatuses, allDatasets] = await Promise.all([
      // Explicit role = equality for each count, not "!= 'Admin'" — now
      // that a third and fourth role (Template Evaluator, Business Owner
      // Evaluator) exist, "!= 'Admin'" would silently fold them into
      // sme_count. Each count below matches exactly one role, so adding a
      // future role again can only ever under-count here (an account
      // matching none of the four), never mix two populations into one
      // tile.
      pool.query(
        `SELECT COUNT(*) FILTER (WHERE role = 'SME Owner')::int AS sme_count,
                COUNT(*) FILTER (WHERE role = 'Admin')::int AS admin_count,
                COUNT(*) FILTER (WHERE role = 'Template Evaluator')::int AS expert_count,
                COUNT(*) FILTER (WHERE role = 'Business Owner Evaluator')::int AS business_owner_count,
                COUNT(*) FILTER (WHERE role = 'SME Owner-TAM Evaluator')::int AS sme_tam_count
           FROM sme_accounts`
      ),
      listAllEvaluationStatuses(),
      listAllExpertEvaluationStatuses(),
      listAllBusinessOwnerEvaluationStatuses(),
      listAllSmeTamEvaluationStatuses(),
      listAllDatasets(),
    ]);
    const counts = countRows[0];
    const completed = statuses.filter((s) => s.status === 'completed').length;
    const inProgress = statuses.filter((s) => s.status === 'walkthrough' || s.status === 'questionnaire').length;
    const notStarted = statuses.filter((s) => !s.status).length;
    const expertCompleted = expertStatuses.filter((s) => s.status === 'completed').length;
    const expertInProgress = expertStatuses.filter((s) => s.status === 'walkthrough' || s.status === 'questionnaire').length;
    const expertNotStarted = expertStatuses.filter((s) => !s.status).length;
    const businessOwnerCompleted = businessOwnerStatuses.filter((s) => s.status === 'completed').length;
    const businessOwnerInProgress = businessOwnerStatuses.filter((s) => s.status === 'walkthrough' || s.status === 'questionnaire').length;
    const businessOwnerNotStarted = businessOwnerStatuses.filter((s) => !s.status).length;
    const smeTamCompleted = smeTamStatuses.filter((s) => s.status === 'completed').length;
    const smeTamInProgress = smeTamStatuses.filter((s) => s.status === 'walkthrough' || s.status === 'questionnaire').length;
    const smeTamNotStarted = smeTamStatuses.filter((s) => !s.status).length;

    res.render('dashboard/admin-home', {
      title: 'Admin',
      active: 'admin',
      adminSection: 'home',
      smeCount: counts.sme_count,
      adminCount: counts.admin_count,
      expertCount: counts.expert_count,
      businessOwnerCount: counts.business_owner_count,
      smeTamCount: counts.sme_tam_count,
      datasetCount: allDatasets.length,
      completed,
      inProgress,
      notStarted,
      expertCompleted,
      expertInProgress,
      expertNotStarted,
      businessOwnerCompleted,
      businessOwnerInProgress,
      businessOwnerNotStarted,
      smeTamCompleted,
      smeTamInProgress,
      smeTamNotStarted,
    });
  } catch (err) {
    next(err);
  }
});

// ------------------------------------------------------------------
// GET /admin/accounts — searchable list of every account, with a
// "Change password" action per row.
// ------------------------------------------------------------------
router.get('/admin/accounts', async (req, res, next) => {
  try {
    const accounts = await listAccounts(req.query.q);
    res.render('dashboard/admin-accounts', {
      title: 'Manage SME Accounts',
      active: 'admin',
      adminSection: 'accounts',
      accounts,
      cohortLabels: COHORT_LABELS,
      q: req.query.q || '',
      passwordReset: req.query.passwordReset || null,
      created: req.query.created || null,
      promoted: req.query.promoted || null,
      demoted: req.query.demoted || null,
      cohortSet: req.query.cohortSet || null,
      currentAdminId: req.session.userId,
    });
  } catch (err) {
    next(err);
  }
});

// ------------------------------------------------------------------
// GET /admin/expert-accounts — same search-list-and-"Change password"
// page as /admin/accounts above, but for role = 'Template Evaluator'
// accounts only (added 30 September 2026). A separate page rather than a
// filter on the SME-owner one, per the "store/browse separately"
// requirement for this round — nothing here ever appears mixed with an
// SME owner's row. No make-admin/remove-admin actions: a Template
// Evaluator account is never promoted to Admin from here.
// ------------------------------------------------------------------
router.get('/admin/expert-accounts', async (req, res, next) => {
  try {
    const accounts = await listExpertAccounts(req.query.q);
    res.render('dashboard/admin-expert-accounts', {
      title: 'Manage Template Evaluators',
      active: 'admin',
      adminSection: 'expert-accounts',
      accounts,
      q: req.query.q || '',
      passwordReset: req.query.passwordReset || null,
    });
  } catch (err) {
    next(err);
  }
});

// ------------------------------------------------------------------
// GET /admin/business-owner-accounts — same search-list-and-"Change
// password" page again, for role = 'Business Owner Evaluator' accounts
// only (added 2 October 2026, registered through the separate
// access-code signup at /businessOwner-signup). Never listed alongside
// SME owner or Template Evaluator accounts, same discipline as
// /admin/expert-accounts above. No make-admin/remove-admin actions here
// either.
// ------------------------------------------------------------------
router.get('/admin/business-owner-accounts', async (req, res, next) => {
  try {
    const accounts = await listBusinessOwnerAccounts(req.query.q);
    res.render('dashboard/admin-business-owner-accounts', {
      title: 'Manage Business Owner Evaluators',
      active: 'admin',
      adminSection: 'business-owner-accounts',
      accounts,
      q: req.query.q || '',
      passwordReset: req.query.passwordReset || null,
    });
  } catch (err) {
    next(err);
  }
});

// ------------------------------------------------------------------
// GET /admin/sme-tam-accounts — same search-list-and-"Change password"
// page again, for role = 'SME Owner-TAM Evaluator' accounts only (added
// 4 October 2026, registered through the separate open signup at
// /smeOwnerTam-signup). Never listed alongside any other population.
// ------------------------------------------------------------------
router.get('/admin/sme-tam-accounts', async (req, res, next) => {
  try {
    const accounts = await listSmeTamAccounts(req.query.q);
    res.render('dashboard/admin-sme-tam-accounts', {
      title: 'Manage SME Owner-TAM Evaluators',
      active: 'admin',
      adminSection: 'sme-tam-accounts',
      accounts,
      q: req.query.q || '',
      passwordReset: req.query.passwordReset || null,
    });
  } catch (err) {
    next(err);
  }
});

// ------------------------------------------------------------------
// GET/POST /admin/accounts/new — create a brand-new account with
// role='Admin' directly. Deliberately NOT reachable except through this
// already-requireAdmin-gated router — unlike /signup, there's no public
// URL for this, since an Admin account isn't something a stranger should
// ever be able to self-create. scripts/promoteToAdmin.js still exists
// for bootstrapping the very first admin (before any admin account can
// sign in to reach this form at all).
// ------------------------------------------------------------------
router.get('/admin/accounts/new', (req, res) => {
  res.render('dashboard/admin-new-admin', {
    title: 'Add admin',
    active: 'admin',
    adminSection: 'accounts',
    errors: [],
    old: {},
  });
});

const newAdminValidators = [
  body('username')
    .trim()
    .matches(/^[A-Za-z0-9_-]{3,50}$/)
    .withMessage('Username must be 3-50 characters (letters, numbers, - or _ only).'),
  body('owner_name').trim().notEmpty().withMessage('Name is required.'),
  body('email').trim().isEmail().withMessage('A valid email is required.').normalizeEmail(),
  body('password').isLength({ min: 8 }).withMessage('Password must be at least 8 characters.'),
  body('confirm_password').custom((value, { req }) => value === req.body.password)
    .withMessage('Passwords do not match.'),
];

router.post('/admin/accounts/new', newAdminValidators, async (req, res, next) => {
  const result = validationResult(req);
  if (!result.isEmpty()) {
    return res.status(400).render('dashboard/admin-new-admin', {
      title: 'Add admin',
      active: 'admin',
      adminSection: 'accounts',
      errors: result.array(),
      old: req.body,
    });
  }

  try {
    const account = await createAdminAccount({
      username: req.body.username,
      owner_name: req.body.owner_name,
      email: req.body.email,
      password: req.body.password,
    });
    return res.redirect(`/admin/accounts?created=${encodeURIComponent(account.username)}`);
  } catch (err) {
    if (err.code === '23505') {
      return res.status(400).render('dashboard/admin-new-admin', {
        title: 'Add admin',
        active: 'admin',
        adminSection: 'accounts',
        errors: [{ msg: 'That username or email is already registered.' }],
        old: req.body,
      });
    }
    next(err);
  }
});

// ------------------------------------------------------------------
// GET/POST /admin/accounts/:id/make-admin — promote an existing SME
// owner account to Admin. Two-step (confirm page, then the actual
// change) rather than a one-click button, since this is a permission
// escalation, not a routine edit.
// ------------------------------------------------------------------
router.get('/admin/accounts/:id/make-admin', async (req, res, next) => {
  try {
    const account = await getAccountById(req.params.id);
    if (!account) return res.status(404).render('errors/404', { title: 'Not found', layout: false });
    res.render('dashboard/admin-role-confirm', {
      title: `Make admin — ${account.username}`,
      active: 'admin',
      adminSection: 'accounts',
      account,
      mode: 'promote',
    });
  } catch (err) {
    next(err);
  }
});

router.post('/admin/accounts/:id/make-admin', async (req, res, next) => {
  try {
    const account = await getAccountById(req.params.id);
    if (!account) return res.status(404).render('errors/404', { title: 'Not found', layout: false });
    await promoteToAdmin(account.id);
    return res.redirect(`/admin/accounts?promoted=${encodeURIComponent(account.username)}`);
  } catch (err) {
    next(err);
  }
});

// ------------------------------------------------------------------
// GET/POST /admin/accounts/:id/remove-admin — demote an Admin back to
// SME Owner. Blocked in two cases, both checked at POST time: demoting
// yourself (avoids an admin locking themselves out mid-click) and
// demoting the very last remaining admin (avoids leaving the app with
// no way back into /admin short of a direct database edit).
// ------------------------------------------------------------------
router.get('/admin/accounts/:id/remove-admin', async (req, res, next) => {
  try {
    const account = await getAccountById(req.params.id);
    if (!account) return res.status(404).render('errors/404', { title: 'Not found', layout: false });
    res.render('dashboard/admin-role-confirm', {
      title: `Remove admin — ${account.username}`,
      active: 'admin',
      adminSection: 'accounts',
      account,
      mode: 'demote',
      isSelf: account.id === req.session.userId,
    });
  } catch (err) {
    next(err);
  }
});

router.post('/admin/accounts/:id/remove-admin', async (req, res, next) => {
  try {
    const account = await getAccountById(req.params.id);
    if (!account) return res.status(404).render('errors/404', { title: 'Not found', layout: false });

    if (account.id === req.session.userId) {
      return res.status(400).render('dashboard/admin-role-confirm', {
        title: `Remove admin — ${account.username}`,
        active: 'admin',
        adminSection: 'accounts',
        account,
        mode: 'demote',
        isSelf: true,
        error: "You can't remove your own admin access.",
      });
    }

    const adminCount = await countAdmins();
    if (adminCount <= 1) {
      return res.status(400).render('dashboard/admin-role-confirm', {
        title: `Remove admin — ${account.username}`,
        active: 'admin',
        adminSection: 'accounts',
        account,
        mode: 'demote',
        isSelf: false,
        error: "This is the only remaining admin account — add another admin first before removing this one.",
      });
    }

    await demoteToOwner(account.id);
    return res.redirect(`/admin/accounts?demoted=${encodeURIComponent(account.username)}`);
  } catch (err) {
    next(err);
  }
});

// ------------------------------------------------------------------
// GET/POST /admin/accounts/:id/password — set a new password for an
// account on its behalf (no need to know the old one — this is an admin
// override, e.g. for a locked-out SME owner during a pilot session).
// ------------------------------------------------------------------
// Picks which of the three accounts pages (and admin nav section) this
// account's "Change password" action belongs under — added 2 October
// 2026 as a 3-way version of the old isExpert ? ... : ... ternary, now
// that Business Owner Evaluator is a third accounts-page population
// alongside SME Owner/Admin and Template Evaluator.
function accountsSectionFor(role) {
  if (role === EXPERT_ROLE) return { adminSection: 'expert-accounts', listPath: '/admin/expert-accounts' };
  if (role === BUSINESS_ROLE) return { adminSection: 'business-owner-accounts', listPath: '/admin/business-owner-accounts' };
  if (role === SME_TAM_ROLE) return { adminSection: 'sme-tam-accounts', listPath: '/admin/sme-tam-accounts' };
  return { adminSection: 'accounts', listPath: '/admin/accounts' };
}

router.get('/admin/accounts/:id/password', async (req, res, next) => {
  try {
    const account = await getAccountById(req.params.id);
    if (!account) return res.status(404).render('errors/404', { title: 'Not found', layout: false });
    const { adminSection, listPath } = accountsSectionFor(account.role);
    res.render('dashboard/admin-reset-password', {
      title: `Change password — ${account.username}`,
      active: 'admin',
      adminSection,
      backHref: listPath,
      account,
      errors: [],
    });
  } catch (err) {
    next(err);
  }
});

const resetPasswordValidators = [
  body('new_password').isLength({ min: 8 }).withMessage('Password must be at least 8 characters.'),
  body('confirm_password').custom((value, { req }) => value === req.body.new_password)
    .withMessage('Passwords do not match.'),
];

router.post('/admin/accounts/:id/password', resetPasswordValidators, async (req, res, next) => {
  try {
    const account = await getAccountById(req.params.id);
    if (!account) return res.status(404).render('errors/404', { title: 'Not found', layout: false });
    const { adminSection, listPath } = accountsSectionFor(account.role);

    const result = validationResult(req);
    if (!result.isEmpty()) {
      return res.status(400).render('dashboard/admin-reset-password', {
        title: `Change password — ${account.username}`,
        active: 'admin',
        adminSection,
        backHref: listPath,
        account,
        errors: result.array(),
      });
    }

    await resetPassword(account.id, req.body.new_password);
    return res.redirect(`${listPath}?passwordReset=${encodeURIComponent(account.username)}`);
  } catch (err) {
    next(err);
  }
});

// ------------------------------------------------------------------
// POST /admin/accounts/:id/cohort — tags (or clears) which recruitment
// pool an SME Owner account's TAM responses belong to. See
// sme_accounts.cohort in db/schema.sql for the full reasoning: this
// answers peer-review recommendation #4's contamination concern by
// letting an Admin distinguish the existing MIT 267 course-cohort
// respondents from any future real-SME field-study respondent, so a
// later reliability recomputation can filter one population out rather
// than silently mixing both. Deliberately NOT exposed on the public
// /signup form — a real SME owner filling out a business account signup
// has no reason to understand research-cohort terminology; an Admin who
// actually knows how each account was recruited sets this instead, same
// authorization model as resetPassword()/promoteToAdmin() above. Allowed
// on any account's id (not just SME Owner), consistent with every other
// action on this page — setCohort() itself is the single source of truth
// for which values are valid, so a bad value here is rejected with a
// normal flash-style error rather than a raw Postgres constraint error.
// ------------------------------------------------------------------
router.post('/admin/accounts/:id/cohort', async (req, res, next) => {
  try {
    const account = await getAccountById(req.params.id);
    if (!account) return res.status(404).render('errors/404', { title: 'Not found', layout: false });
    await setCohort(account.id, req.body.cohort);
    return res.redirect(`/admin/accounts?cohortSet=${encodeURIComponent(account.username)}`);
  } catch (err) {
    next(err);
  }
});

// ------------------------------------------------------------------
// GET /admin/evaluations — every SME owner account's evaluation
// progress, plus the cross-respondent descriptive summary for the
// 17-item TAM questionnaire (completed evaluations only — see
// getCompletedResponseSummary()). The ISO/IEC 25010 Quality-in-Use
// instrument is a different population entirely (Business Owner
// Evaluator, added 2 October 2026) — browsed separately below at
// /admin/business-owner-evaluations, never here.
// ------------------------------------------------------------------
router.get('/admin/evaluations', async (req, res, next) => {
  try {
    const [statuses, summary] = await Promise.all([
      listAllEvaluationStatuses(),
      getCompletedResponseSummary(),
    ]);
    res.render('dashboard/admin-evaluations', {
      title: 'View Evaluation Report',
      active: 'admin',
      adminSection: 'evaluations',
      statuses,
      summary,
      totalItems: itemsFor(SME_ROLE).length,
    });
  } catch (err) {
    next(err);
  }
});

// ------------------------------------------------------------------
// GET /admin/evaluations/:accountId — one account's full evaluation
// detail: the six-task walkthrough log and every questionnaire answer
// saved so far. Read-only, and works at any stage (not just completed) —
// an admin can check in on an evaluation that's still in progress.
// ------------------------------------------------------------------
router.get('/admin/evaluations/:accountId', async (req, res, next) => {
  try {
    const account = await getAccountById(req.params.accountId);
    if (!account) return res.status(404).render('errors/404', { title: 'Not found', layout: false });

    const { session, taskLogs, responses } = await getEvaluationStateReadOnly(account.id);
    res.render('dashboard/admin-evaluation-detail', {
      title: `Evaluation — ${account.username}`,
      active: 'admin',
      adminSection: 'evaluations',
      account,
      session,
      tasks: WALKTHROUGH_TASKS,
      taskLogs,
      domains: groupItemsByDomain(SME_ROLE),
      responses,
    });
  } catch (err) {
    next(err);
  }
});

// ------------------------------------------------------------------
// GET /admin/expert-evaluations — same shape as /admin/evaluations above,
// for Template Evaluator accounts against the separate
// expert_evaluation_* tables (added 30 September 2026). Deliberately a
// distinct page, not a filter/tab on the SME-owner one: the "store and
// report separately" requirement for this round means the two
// cross-respondent summaries (and the manuscript counts drawn from them)
// must never be computed from a single combined query.
// ------------------------------------------------------------------
router.get('/admin/expert-evaluations', async (req, res, next) => {
  try {
    const [statuses, summary] = await Promise.all([
      listAllExpertEvaluationStatuses(),
      getCompletedExpertResponseSummary(),
    ]);
    res.render('dashboard/admin-expert-evaluations', {
      title: 'View Template Evaluation Report',
      active: 'admin',
      adminSection: 'expert-evaluations',
      statuses,
      summary,
    });
  } catch (err) {
    next(err);
  }
});

// ------------------------------------------------------------------
// GET /admin/expert-evaluations/:accountId — one Template Evaluator
// account's full evaluation detail, read from expert_evaluation_* via
// getEvaluationStateReadOnly(id, EXPERT_ROLE).
// ------------------------------------------------------------------
router.get('/admin/expert-evaluations/:accountId', async (req, res, next) => {
  try {
    const account = await getAccountById(req.params.accountId);
    if (!account) return res.status(404).render('errors/404', { title: 'Not found', layout: false });

    const { session, taskLogs, responses } = await getEvaluationStateReadOnly(account.id, EXPERT_ROLE);
    const isDirectFlow = account.evaluation_flow === 'direct';
    const moduleVisits = (isDirectFlow && session) ? await getModuleVisits(session.id) : null;
    res.render('dashboard/admin-expert-evaluation-detail', {
      title: `Template Evaluation — ${account.username}`,
      active: 'admin',
      adminSection: 'expert-evaluations',
      account,
      session,
      tasks: WALKTHROUGH_TASKS,
      taskLogs,
      moduleVisits,
      isDirectFlow,
      domains: groupItemsByDomain(EXPERT_ROLE),
      responses,
    });
  } catch (err) {
    next(err);
  }
});

// ------------------------------------------------------------------
// GET /admin/business-owner-evaluations — same shape as /admin/evaluations
// and /admin/expert-evaluations above, for Business Owner Evaluator
// accounts against the separate business_owner_evaluation_* tables
// (added 2 October 2026) — the population that takes the 15-item
// ISO/IEC 25010 Quality-in-Use instrument. Its own distinct page, same
// "store and report separately" discipline as the other two: never
// computed from, or shown alongside, either TAM population's summary.
// ------------------------------------------------------------------
router.get('/admin/business-owner-evaluations', async (req, res, next) => {
  try {
    const [statuses, summary] = await Promise.all([
      listAllBusinessOwnerEvaluationStatuses(),
      getCompletedBusinessOwnerResponseSummary(),
    ]);
    res.render('dashboard/admin-business-owner-evaluations', {
      title: 'View Business Owner Evaluation Report',
      active: 'admin',
      adminSection: 'business-owner-evaluations',
      statuses,
      summary,
    });
  } catch (err) {
    next(err);
  }
});

// ------------------------------------------------------------------
// GET /admin/business-owner-evaluations/:accountId — one Business Owner
// Evaluator account's full evaluation detail, read from
// business_owner_evaluation_* via getEvaluationStateReadOnly(id,
// BUSINESS_ROLE). Always walkthrough-flow (no direct-flow variant for
// this role — see middleware/evaluationGate.js), so unlike the Template
// Evaluator detail page above, this never needs getModuleVisits().
// ------------------------------------------------------------------
router.get('/admin/business-owner-evaluations/:accountId', async (req, res, next) => {
  try {
    const account = await getAccountById(req.params.accountId);
    if (!account) return res.status(404).render('errors/404', { title: 'Not found', layout: false });

    const { session, taskLogs, responses } = await getEvaluationStateReadOnly(account.id, BUSINESS_ROLE);
    res.render('dashboard/admin-business-owner-evaluation-detail', {
      title: `Business Owner Evaluation — ${account.username}`,
      active: 'admin',
      adminSection: 'business-owner-evaluations',
      account,
      session,
      tasks: WALKTHROUGH_TASKS,
      taskLogs,
      domains: groupItemsByDomain(BUSINESS_ROLE),
      responses,
    });
  } catch (err) {
    next(err);
  }
});

// ------------------------------------------------------------------
// GET /admin/sme-tam-evaluations — same shape as the other three
// evaluation-report pages, for SME Owner-TAM Evaluator accounts against
// the separate sme_tam_evaluation_* tables (added 4 October 2026) — the
// population that answers the REWORDED 17-item TAM questionnaire. Its own
// distinct page: never computed from, or shown alongside, any other
// population's summary, since the wording differs from the original TAM.
// ------------------------------------------------------------------
router.get('/admin/sme-tam-evaluations', async (req, res, next) => {
  try {
    const [statuses, summary] = await Promise.all([
      listAllSmeTamEvaluationStatuses(),
      getCompletedSmeTamResponseSummary(),
    ]);
    res.render('dashboard/admin-sme-tam-evaluations', {
      title: 'View SME Owner-TAM Evaluation Report',
      active: 'admin',
      adminSection: 'sme-tam-evaluations',
      statuses,
      summary,
    });
  } catch (err) {
    next(err);
  }
});

// GET /admin/sme-tam-activity — how the SME Owner-TAM Evaluators actually
// used the provided templates (added 4 October 2026): prefilled-template
// use, blank-template downloads, rows added, uploads (and whether the
// upload matched a template), plus real-data semantic-role confirmation
// and correction rates from field_role_feedback. Consenting respondents
// only. /admin/sme-tam-activity.csv is the same table as a download.
router.get('/admin/sme-tam-activity', async (req, res, next) => {
  try {
    const [report, decisions] = await Promise.all([getActivityReport(), listAllDecisionFollowups()]);
    res.render('dashboard/admin-sme-tam-activity', {
      title: 'SME Owner-TAM Template Activity',
      active: 'admin',
      adminSection: 'sme-tam-activity',
      rows: report.consenting,
      totals: report.totals,
      decisions,
    });
  } catch (err) {
    next(err);
  }
});

router.get('/admin/sme-tam-decisions.csv', async (req, res, next) => {
  try {
    const rows = await listAllDecisionFollowups();
    const stamp = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="sme_tam_decision_followups_${stamp}.csv"`);
    res.send('\uFEFF' + buildDecisionsCsv(rows));
  } catch (err) {
    next(err);
  }
});

router.get('/admin/sme-tam-activity.csv', async (req, res, next) => {
  try {
    const report = await getActivityReport();
    const stamp = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="sme_tam_template_activity_${stamp}.csv"`);
    res.send('\uFEFF' + buildCsv(report.consenting));
  } catch (err) {
    next(err);
  }
});

// GET /admin/sme-tam-evaluations/:accountId — one SME Owner-TAM
// Evaluator account's full evaluation detail, read from
// sme_tam_evaluation_* via getEvaluationStateReadOnly(id, SME_TAM_ROLE).
// Always direct-flow, so module visits are always read.
router.get('/admin/sme-tam-evaluations/:accountId', async (req, res, next) => {
  try {
    const account = await getAccountById(req.params.accountId);
    if (!account || account.role !== SME_TAM_ROLE) return res.status(404).render('errors/404', { title: 'Not found', layout: false });

    const { session, taskLogs, responses } = await getEvaluationStateReadOnly(account.id, SME_TAM_ROLE);
    const moduleVisits = session ? await getModuleVisits(session.id, SME_TAM_ROLE) : null;
    res.render('dashboard/admin-sme-tam-evaluation-detail', {
      title: `SME Owner-TAM Evaluation — ${account.username}`,
      active: 'admin',
      adminSection: 'sme-tam-evaluations',
      account,
      session,
      tasks: WALKTHROUGH_TASKS,
      taskLogs,
      moduleVisits,
      isDirectFlow: true,
      domains: groupItemsByDomain(SME_TAM_ROLE),
      responses,
    });
  } catch (err) {
    next(err);
  }
});

// ------------------------------------------------------------------
// GET /admin/datasets — every dataset uploaded by every SME owner
// account, with file/row counts and a Delete action per row. Grouped by
// owner (alphabetical) with each owner's own datasets most-recently-
// uploaded first — see services/adminDatasets.js's listAllDatasets() for
// the ORDER BY that makes the view's grouping work with no extra sort
// step. `?q=` narrows to owners matching that search term.
// ------------------------------------------------------------------
router.get('/admin/datasets', async (req, res, next) => {
  try {
    const q = req.query.q || '';
    const datasets = await listAllDatasets(q); // roleMode defaults to 'sme' — excludes Template Evaluator uploads
    res.render('dashboard/admin-datasets', {
      title: 'Manage datasets',
      active: 'admin',
      adminSection: 'datasets',
      datasets,
      q,
      deleted: req.query.deleted || null,
    });
  } catch (err) {
    next(err);
  }
});

// ------------------------------------------------------------------
// GET /admin/expert-datasets — same page as /admin/datasets above, for
// Template Evaluator uploads only (listAllDatasets(q, 'expert')). The
// underlying uploaded_datasets table is shared (see db/schema.sql's note
// on the Template Evaluator role), but this keeps the two populations'
// uploads from ever being browsed in the same list. The existing
// /admin/datasets/:id/view, /erd, and /delete routes below work unchanged
// for a dataset reached from here — they operate on the dataset's own
// row id, not its owner's role.
// ------------------------------------------------------------------
router.get('/admin/expert-datasets', async (req, res, next) => {
  try {
    const q = req.query.q || '';
    const datasets = await listAllDatasets(q, 'expert');
    res.render('dashboard/admin-datasets', {
      title: 'Template Evaluator Datasets',
      active: 'admin',
      adminSection: 'expert-datasets',
      datasets,
      q,
      deleted: req.query.deleted || null,
      basePath: '/admin/expert-datasets',
      ownerLabel: 'Template Evaluator',
    });
  } catch (err) {
    next(err);
  }
});

// ------------------------------------------------------------------
// GET /admin/business-owner-datasets — same page again, for Business
// Owner Evaluator uploads only (listAllDatasets(q, 'businessOwner'),
// added 2 October 2026). Kept separate for the same reason
// /admin/expert-datasets is: so this role's uploads are never browsed
// in the same list as an SME owner's or Template Evaluator's.
// ------------------------------------------------------------------
router.get('/admin/business-owner-datasets', async (req, res, next) => {
  try {
    const q = req.query.q || '';
    const datasets = await listAllDatasets(q, 'businessOwner');
    res.render('dashboard/admin-datasets', {
      title: 'Business Owner Evaluator Datasets',
      active: 'admin',
      adminSection: 'business-owner-datasets',
      datasets,
      q,
      deleted: req.query.deleted || null,
      basePath: '/admin/business-owner-datasets',
      ownerLabel: 'Business Owner Evaluator',
    });
  } catch (err) {
    next(err);
  }
});

// ------------------------------------------------------------------
// GET /admin/sme-tam-datasets — same page again, for SME Owner-TAM
// Evaluator datasets only (listAllDatasets(q, 'smeTam'), added 4 October
// 2026), so this role's datasets are never browsed in another
// population's list.
// ------------------------------------------------------------------
router.get('/admin/sme-tam-datasets', async (req, res, next) => {
  try {
    const q = req.query.q || '';
    const datasets = await listAllDatasets(q, 'smeTam');
    res.render('dashboard/admin-datasets', {
      title: 'SME Owner-TAM Evaluator Datasets',
      active: 'admin',
      adminSection: 'sme-tam-datasets',
      datasets,
      q,
      deleted: req.query.deleted || null,
      basePath: '/admin/sme-tam-datasets',
      ownerLabel: 'SME Owner-TAM Evaluator',
    });
  } catch (err) {
    next(err);
  }
});

// ------------------------------------------------------------------
// GET /admin/datasets/:id/view — enters read-only "viewing as admin"
// mode for this dataset's account, then sends the admin to Descriptive
// analytics with that dataset selected. routes/dashboard.js's
// resolveAccountId()/attachAdminViewingBanner() (only wired into the
// four analytics routes, not the rest of that SME-owner-facing router)
// are what actually make this account's data show up instead of the
// admin's own empty one — see the comment there for why this is scoped
// to just those four pages rather than blanket session impersonation.
// ------------------------------------------------------------------
router.get('/admin/datasets/:id/view', async (req, res, next) => {
  try {
    const dataset = await getDatasetForAdmin(req.params.id);
    if (!dataset) return res.status(404).render('errors/404', { title: 'Not found', layout: false });
    req.session.adminViewAccountId = dataset.account_id;
    return res.redirect(`/descriptive-analytics?dataset=${dataset.id}`);
  } catch (err) {
    next(err);
  }
});

// Picks which of the three dataset-list pages (and admin nav section) a
// dataset's owner_role belongs under — added 2 October 2026 as a 3-way
// version of the old isExpert ? ... : ... ternary, now that Business
// Owner Evaluator is a third dataset-list population alongside SME
// Owner and Template Evaluator.
function datasetsSectionFor(role) {
  if (role === EXPERT_ROLE) return { adminSection: 'expert-datasets', listPath: '/admin/expert-datasets', label: '← Template Evaluator Datasets' };
  if (role === BUSINESS_ROLE) return { adminSection: 'business-owner-datasets', listPath: '/admin/business-owner-datasets', label: '← Business Owner Evaluator Datasets' };
  if (role === SME_TAM_ROLE) return { adminSection: 'sme-tam-datasets', listPath: '/admin/sme-tam-datasets', label: '← SME Owner-TAM Evaluator Datasets' };
  return { adminSection: 'datasets', listPath: '/admin/datasets', label: '← Manage Datasets' };
}

// ------------------------------------------------------------------
// GET /admin/exit-view — leaves "viewing as admin" mode.
// ------------------------------------------------------------------
router.get('/admin/exit-view', async (req, res, next) => {
  try {
    const viewedAccountId = req.session.adminViewAccountId;
    delete req.session.adminViewAccountId;
    if (viewedAccountId) {
      const account = await getAccountById(viewedAccountId);
      if (account) {
        const { listPath } = datasetsSectionFor(account.role);
        if (listPath !== '/admin/datasets') return res.redirect(listPath);
      }
    }
    res.redirect('/admin/datasets');
  } catch (err) {
    next(err);
  }
});

// ------------------------------------------------------------------
// GET /admin/datasets/:id/erd — Entity-Relationship Diagram for any
// dataset, by dataset id, with no ownership restriction (this is the
// Admin-oversight counterpart to the SME owner's own GET
// /browse-dataset/:id/erd in routes/dashboard.js — see
// claude/erd-diagram.md for the generation algorithm, which this route
// reuses unchanged). Deliberately does NOT go through
// resolveAccountId()/session impersonation — an ERD only needs the
// dataset row's own account_id to look up its cached profile, so there's
// no need to set req.session.adminViewAccountId just to view a schema
// diagram. Reachable both from a "View analytics" — the read-only
// four-analytics oversight route — and directly from a "🗺️ ERD" link on
// each row of Manage Datasets.
// ------------------------------------------------------------------
router.get('/admin/datasets/:id/erd', async (req, res, next) => {
  try {
    const dataset = await getDatasetForAdmin(req.params.id);
    if (!dataset) return res.status(404).render('errors/404', { title: 'Not found', layout: false });

    const bundle = await getOrBuildFullProfile(dataset.account_id, dataset.id);
    const erd = buildErdDefinition(bundle.files, bundle.relationships);
    const { adminSection, listPath, label } = datasetsSectionFor(dataset.owner_role);

    res.render('dashboard/erd', {
      title: `Entity-Relationship Diagram — ${dataset.dataset_name}`,
      active: 'admin',
      adminSection,
      dataset,
      erd,
      humanizeFileType,
      backHref: listPath,
      backLabel: label,
    });
  } catch (err) {
    next(err);
  }
});

// ------------------------------------------------------------------
// GET/POST /admin/datasets/:id/delete — two-step confirm + delete for
// one SME owner's dataset (all of its files/rows/cached analytics go
// with it — see services/adminDatasets.js for exactly what cascades).
// Irreversible, so this gets the same confirm-page pattern as the
// admin/accounts role-change actions rather than a one-click button.
// ------------------------------------------------------------------
router.get('/admin/datasets/:id/delete', async (req, res, next) => {
  try {
    const dataset = await getDatasetForAdmin(req.params.id);
    if (!dataset) return res.status(404).render('errors/404', { title: 'Not found', layout: false });
    const { adminSection, listPath } = datasetsSectionFor(dataset.owner_role);
    res.render('dashboard/admin-dataset-delete-confirm', {
      title: `Delete dataset — ${dataset.dataset_name}`,
      active: 'admin',
      adminSection,
      backHref: listPath,
      dataset,
    });
  } catch (err) {
    next(err);
  }
});

router.post('/admin/datasets/:id/delete', async (req, res, next) => {
  try {
    const dataset = await getDatasetForAdmin(req.params.id);
    if (!dataset) return res.status(404).render('errors/404', { title: 'Not found', layout: false });
    const { listPath } = datasetsSectionFor(dataset.owner_role);
    await deleteDataset(dataset.id);
    return res.redirect(`${listPath}?deleted=${encodeURIComponent(dataset.dataset_name)}`);
  } catch (err) {
    next(err);
  }
});

// ------------------------------------------------------------------
// Gating Comparison — answers a peer-review recommendation: does CAAGA's
// eligibility/suppression gate actually add value? See db/schema.sql's
// own comment on gating_comparison_runs for the full design, and
// services/predictiveAnalyticsDynamic.js / services/prescriptiveEngine.js
// for how gate_mode='off' is simulated without ever fabricating from
// genuinely absent data. This never changes what an ordinary SME owner
// sees — it only ever activates for the admin running the comparison,
// via req.session.adminGatingRun (read by routes/dashboard.js's
// Predictive/Prescriptive handlers), exactly the same "explicit opt-in,
// not global middleware" pattern already used for adminViewAccountId.
// ------------------------------------------------------------------
router.get('/admin/gating-comparison', async (req, res, next) => {
  try {
    // 'all' — unlike every other admin dataset list, this internal
    // diagnostic deliberately mixes SME owner and Template Evaluator
    // datasets (see services/adminDatasets.js's own comment on this mode).
    const datasets = await listAllDatasets('', 'all');
    res.render('dashboard/admin-gating-comparison-start', {
      title: 'Gating Comparison',
      active: 'admin',
      adminSection: 'gating-comparison',
      datasets,
    });
  } catch (err) {
    next(err);
  }
});

router.post('/admin/gating-comparison/start', async (req, res, next) => {
  try {
    const datasetRowId = Number(req.body.dataset_row_id);
    const gateMode = req.body.gate_mode === 'off' ? 'off' : 'on';
    const dataset = await getDatasetForAdmin(datasetRowId);
    if (!dataset) return res.status(404).render('errors/404', { title: 'Not found', layout: false });

    const run = await startRun(datasetRowId, req.session.userId, gateMode, req.body.notes || null);
    req.session.adminViewAccountId = dataset.account_id;
    req.session.adminGatingRun = { runId: run.id, datasetRowId, gateMode };
    const target = req.body.module === 'prescriptive' ? 'prescriptive-recommendations' : 'predictive-analytics';
    return res.redirect(`/${target}?dataset=${datasetRowId}`);
  } catch (err) {
    next(err);
  }
});

// GET, not POST — reached from a plain link in the comparison banner, the
// same convention as the pre-existing /admin/exit-view; nothing it does
// is destructive (it only clears session state, same as exit-view).
router.get('/admin/gating-comparison/exit', (req, res) => {
  const { datasetRowId } = req.session.adminGatingRun || {};
  delete req.session.adminGatingRun;
  delete req.session.adminViewAccountId;
  res.redirect(datasetRowId ? `/admin/gating-comparison/${datasetRowId}/report` : '/admin/gating-comparison');
});

router.post('/admin/gating-comparison/trust', async (req, res, next) => {
  try {
    const active = req.session.adminGatingRun;
    const rating = Number(req.body.trust_rating);
    if (active && Number.isInteger(rating) && rating >= 1 && rating <= 5) {
      await logTrustRating(active.runId, req.body.output_key, rating, req.body.rater_label || null);
    }
    const returnTo = typeof req.body.return_to === 'string' && req.body.return_to.startsWith('/')
      ? req.body.return_to
      : '/predictive-analytics';
    return res.redirect(returnTo);
  } catch (err) {
    next(err);
  }
});

router.get('/admin/gating-comparison/:datasetId/report', async (req, res, next) => {
  try {
    const datasetRowId = Number(req.params.datasetId);
    const dataset = await getDatasetForAdmin(datasetRowId);
    if (!dataset) return res.status(404).render('errors/404', { title: 'Not found', layout: false });
    const summary = await getDatasetComparisonSummary(datasetRowId);
    res.render('dashboard/admin-gating-comparison-report', {
      title: `Gating Comparison — ${dataset.dataset_name}`,
      active: 'admin',
      adminSection: 'gating-comparison',
      dataset,
      summary,
    });
  } catch (err) {
    next(err);
  }
});

// ------------------------------------------------------------------
// TEMPORARY — GET /admin/debug-schema — read-only column listing for the
// three evaluation tables, added 26 September 2026 only to confirm the
// consent_status/consent_decided_at migration reached production when
// external database access (pgAdmin, etc.) was unavailable. Plain text,
// admin-gated by the router.use(requireAdmin) above. Safe to delete once
// that's confirmed — it exists purely as a diagnostic, not a feature.
// ------------------------------------------------------------------
router.get('/admin/debug-schema', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT table_name, column_name, data_type, column_default
         FROM information_schema.columns
        WHERE table_name IN ('evaluation_sessions', 'evaluation_task_logs', 'evaluation_responses')
        ORDER BY table_name, ordinal_position`
    );
    const lines = rows.map((r) => `${r.table_name}.${r.column_name}  (${r.data_type})${r.column_default ? '  default=' + r.column_default : ''}`);
    res.type('text/plain').send(lines.join('\n') || 'No columns found — do these tables exist?');
  } catch (err) {
    next(err);
  }
});

// ------------------------------------------------------------------
// TEMPORARY — GET /admin/debug-tam-reliability — Cronbach's alpha for
// each SME Owner questionnaire domain (PU/PEOU/BI, the 17-item TAM
// instrument), computed from the raw per-respondent, per-item ratings
// already stored in evaluation_responses. Added 26 September 2026 to
// fill in the manuscript's reliability placeholder without needing
// external database access (pgAdmin, etc.) — same reasoning as
// /admin/debug-schema above. groupItemsByDomain(SME_ROLE) below reflects
// the TAM domains, unchanged — SME Owner was never switched to the new
// ISO/IEC 25010 Quality-in-Use instrument (that one belongs solely to
// the separate Business Owner Evaluator population added 2 October
// 2026, scored by its own getCompletedBusinessOwnerResponseSummary()
// instead, never through this route). Plain text, admin-gated. Safe to
// delete once you have the numbers — it's a diagnostic, not a feature.
// Template Evaluator / TAM reliability is unaffected either — it is
// scored separately and still reads TAM_ITEMS via EXPERT_ROLE elsewhere
// in this file, never through this route.
//
// Only status='completed' sessions are included, matching
// getCompletedResponseSummary()'s own "final data only" discipline
// (services/tamEvaluation.js) — a still-in-progress respondent's
// partial ratings never enter the reliability computation either.
//
// alpha = (k / (k-1)) * (1 - sum(item variances) / variance of the
// summed domain score), sample variance (n-1 denominator) throughout —
// the standard Cronbach's alpha formula.
// ------------------------------------------------------------------
router.get('/admin/debug-tam-reliability', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT s.id AS session_id, r.item_code, r.rating
         FROM evaluation_responses r
         JOIN evaluation_sessions s ON s.id = r.session_id
        WHERE s.status = 'completed' AND r.rating IS NOT NULL
        ORDER BY s.id, r.item_code`
    );

    const bySession = new Map();
    rows.forEach((r) => {
      if (!bySession.has(r.session_id)) bySession.set(r.session_id, {});
      bySession.get(r.session_id)[r.item_code] = r.rating;
    });

    function mean(arr) { return arr.reduce((a, b) => a + b, 0) / arr.length; }
    function sampleVariance(arr) {
      if (arr.length < 2) return null;
      const m = mean(arr);
      return arr.reduce((a, b) => a + (b - m) ** 2, 0) / (arr.length - 1);
    }

    const lines = [];
    groupItemsByDomain(SME_ROLE).forEach((domain) => {
      const codes = domain.items.map((it) => it.code);
      const k = codes.length;

      // Only respondents who answered every item in THIS domain — for a
      // status='completed' session that should be all of them (Section
      // 4.1's own submit-time validation requires every item answered),
      // but this stays defensive rather than assuming it.
      const completeRespondents = [...bySession.values()].filter((answers) =>
        codes.every((c) => typeof answers[c] === 'number')
      );
      const n = completeRespondents.length;

      lines.push(`${domain.label} (${domain.domain}) — k=${k} items, n=${n} respondents`);
      if (n < 2) {
        lines.push('  alpha: cannot compute (fewer than 2 fully-answered respondents)');
        lines.push('');
        return;
      }

      const itemVariances = codes.map((c) => sampleVariance(completeRespondents.map((a) => a[c])));
      const totalScores = completeRespondents.map((a) => codes.reduce((sum, c) => sum + a[c], 0));
      const totalVariance = sampleVariance(totalScores);

      codes.forEach((c, i) => lines.push(`  ${c} variance: ${itemVariances[i].toFixed(4)}`));
      lines.push(`  sum-score variance: ${totalVariance.toFixed(4)}`);

      if (totalVariance === 0) {
        lines.push('  alpha: undefined (every respondent gave an identical total score — zero variance)');
      } else {
        const sumItemVar = itemVariances.reduce((a, b) => a + b, 0);
        const alpha = (k / (k - 1)) * (1 - sumItemVar / totalVariance);
        lines.push(`  Cronbach's alpha: ${alpha.toFixed(2)}`);
      }
      lines.push('');
    });

    res.type('text/plain').send(lines.join('\n'));
  } catch (err) {
    next(err);
  }
});

// ------------------------------------------------------------------
// TEMPORARY — GET /admin/debug-dataset-columns — read-only dump of the
// exact files/columns/relationships CMA-Flow has on record for the
// Maven Pizza Challenge and Seattle Airbnb Open Data datasets, so the
// manuscript's description of what two respondents changed in their
// own uploaded data (which columns/files they kept or added) can be
// written from real database state rather than read off a screenshot.
// Matches dataset_name loosely (ILIKE) since respondents typed their
// own dataset names on upload — there is no fixed vocabulary for it
// (see uploaded_datasets.dataset_name in db/schema.sql). Ordered by
// account then created_at ASC so, when the same account re-uploaded a
// revised version (Implementation: "revised uploads are retained as
// separate versions rather than overwriting earlier data"), the
// earlier/later relationship between two rows is unambiguous from the
// output alone. Reuses getOrBuildFullProfile() — the exact function
// production uses to render the ERD page — so this is not a
// reimplementation that could disagree with what the screenshots show.
// Safe to delete once the manuscript text is written; it's a
// diagnostic, not a feature.
// ------------------------------------------------------------------
router.get('/admin/debug-dataset-columns', async (req, res, next) => {
  try {
    const { rows: datasets } = await pool.query(
      `SELECT ud.id, ud.account_id, ud.dataset_id, ud.dataset_name, ud.created_at
         FROM uploaded_datasets ud
        WHERE ud.dataset_name ILIKE '%maven%' OR ud.dataset_name ILIKE '%airbnb%'
        ORDER BY ud.account_id ASC, ud.created_at ASC`
    );

    const lines = [];
    if (!datasets.length) {
      lines.push('No uploaded_datasets rows found with dataset_name matching "maven" or "airbnb".');
    }

    for (const ds of datasets) {
      const { files, relationships } = await getOrBuildFullProfile(ds.account_id, ds.id);
      lines.push(
        `Dataset: "${ds.dataset_name}"  (dataset_id=${ds.dataset_id}, uploaded_datasets.id=${ds.id}, ` +
        `account_id=${ds.account_id}, created_at=${new Date(ds.created_at).toISOString()})`
      );
      if (!files.length) {
        lines.push('  (no files/profile found for this dataset)');
        lines.push('');
        continue;
      }
      files.forEach((f) => {
        lines.push(`  File: ${f.fileType}  (${f.columns.length} columns)`);
        f.columns.forEach((c) => { lines.push(`    - ${c.name}  [${c.kind}]`); });
      });
      if (relationships.length) {
        lines.push('  Relationships detected:');
        relationships.forEach((r) => {
          lines.push(
            `    - ${r.fromFile}.${r.fromColumn} ~ ${r.toFile}.${r.toColumn} ` +
            `(overlap ${r.overlapPct.toFixed(1)}%)`
          );
        });
      } else {
        lines.push('  Relationships detected: none');
      }
      lines.push('');
    }

    res.type('text/plain').send(lines.join('\n'));
  } catch (err) {
    next(err);
  }
});

// ------------------------------------------------------------------
// TEMPORARY — GET /admin/debug-semantic-role-export — server-side
// equivalent of scripts/exportSemanticRoleEvaluation.js, for producing
// the Section 4.4 rater-labeling inputs without needing a working local
// DATABASE_URL connection to production (the same DB-connectivity
// problem the /admin/debug-schema and /admin/debug-tam-reliability
// routes were built to route around). Runs the exact same production
// functions — getOrBuildFullProfile() + buildSemanticModelHybrid() — so
// this can't disagree with what CAAGA actually inferred for these
// datasets.
//
// Usage:
//   1. GET /admin/datasets — find the dataset_id (not the numeric row
//      id) for each of the seventeen genuine graduate-student datasets,
//      as opposed to any development/QA test account.
//   2. GET /admin/debug-semantic-role-export?ids=id1,id2,...  (no
//      &file= yet) — a plain-text preview confirming which of those
//      dataset_id values were found/not found, and how many columns
//      each contributed, BEFORE downloading anything. Fix the ids list
//      here first.
//   3. GET /admin/debug-semantic-role-export?ids=...&file=predictions
//      — downloads caaga_role_predictions.csv.
//   4. GET /admin/debug-semantic-role-export?ids=...&file=template
//      — downloads rater_labeling_template.csv, with rater1_label,
//      rater2_label, resolved_label left blank for two independent
//      people to fill in by hand (see scripts/
//      evaluate_semantic_role_inference.py's own module docstring for
//      the full labeling procedure).
// Safe to delete once Section 4.4's real numbers are in the manuscript.
// ------------------------------------------------------------------
// Mirrors scripts/exportSemanticRoleEvaluation.js's COARSE_ROLE_MAP
// exactly (see that file for the full rationale on each mapping
// choice) — keep both copies in sync if CAAGA's granular role
// vocabulary (services/semanticFieldOntology.js) ever changes.
const DEBUG_COARSE_ROLE_MAP = {
  customer_id: 'Identifier', merchant_id: 'Identifier', product_id: 'Identifier', order_id: 'Identifier',
  date: 'Date/time',
  revenue: 'Monetary amount', price: 'Monetary amount', cost: 'Monetary amount', profit: 'Monetary amount', discount: 'Monetary amount',
  quantity: 'Quantity', duration: 'Quantity',
  cost_category: 'Category', subscription_plan: 'Category',
  rating: 'Rating',
  geo_dimension: 'Geography',
  status: 'Status', availability: 'Status',
  name_label: 'Free text',
};

function debugCsvEscape(v) {
  const s = v === null || v === undefined ? '' : String(v);
  return `"${s.replace(/"/g, '""')}"`;
}
function debugCsvBody(header, rows) {
  return [header, ...rows].map((r) => r.map(debugCsvEscape).join(',')).join('\n') + '\n';
}

router.get('/admin/debug-semantic-role-export', async (req, res, next) => {
  try {
    const idsParam = (req.query.ids || '').trim();
    if (!idsParam) {
      return res.type('text/plain').send(
        'Pass the dataset_id values (not the numeric row id) for the seventeen real datasets as a ' +
        'comma-separated ?ids= query parameter, e.g.:\n' +
        '  /admin/debug-semantic-role-export?ids=SME_Retail_07,SME_Cafe_03\n' +
        'Use GET /admin/datasets first to look up each dataset_id. That URL alone (no &file=) shows a ' +
        'preview of what would be exported, so you can fix the ids list before downloading anything. ' +
        'Add &file=predictions or &file=template to actually download the corresponding CSV.'
      );
    }
    const wantedIds = idsParam.split(',').map((s) => s.trim()).filter(Boolean);
    const fileParam = req.query.file === 'template' ? 'template'
      : req.query.file === 'predictions' ? 'predictions' : null;

    const { rows: datasets } = await pool.query(
      `SELECT id, account_id, dataset_id, dataset_name
         FROM uploaded_datasets WHERE dataset_id = ANY($1::text[]) ORDER BY dataset_id`,
      [wantedIds]
    );
    const foundIds = new Set(datasets.map((d) => d.dataset_id));
    const missingIds = wantedIds.filter((id) => !foundIds.has(id));

    const predRows = [];
    const templateRows = [];
    const preview = [];

    for (const ds of datasets) {
      const { files, relationships } = await getOrBuildFullProfile(ds.account_id, ds.id);
      if (!files.length) {
        preview.push(`${ds.dataset_id}: no files/profile found — skipped`);
        continue;
      }
      const model = buildSemanticModelHybrid(files, relationships);
      let colCount = 0;
      model.files.forEach((fileEntry) => {
        const fp = files.find((f) => f.fileType === fileEntry.fileType);
        if (!fp) return;
        fp.columns.forEach((col) => {
          const roleEntry = fileEntry.columnRoles[col.name];
          const granular = roleEntry ? roleEntry.role : null;
          const coarse = granular ? (DEBUG_COARSE_ROLE_MAP[granular] || 'other') : 'other';
          predRows.push([
            ds.dataset_id, ds.dataset_name, fileEntry.fileType, col.name,
            granular || '', coarse, roleEntry ? roleEntry.confidence : '', roleEntry ? roleEntry.band : '',
          ]);
          templateRows.push([ds.dataset_id, ds.dataset_name, fileEntry.fileType, col.name, '', '', '']);
          colCount += 1;
        });
      });
      preview.push(`${ds.dataset_id} ("${ds.dataset_name}"): ${colCount} columns across ${model.files.length} file(s)`);
    }

    if (fileParam === 'predictions') {
      const csv = debugCsvBody(
        ['dataset_id', 'dataset_name', 'file_type', 'column_name', 'caaga_role_granular', 'caaga_role_coarse', 'confidence', 'band'],
        predRows
      );
      res.set('Content-Disposition', 'attachment; filename="caaga_role_predictions.csv"');
      return res.type('text/csv').send(csv);
    }
    if (fileParam === 'template') {
      const csv = debugCsvBody(
        ['dataset_id', 'dataset_name', 'file_type', 'column_name', 'rater1_label', 'rater2_label', 'resolved_label'],
        templateRows
      );
      res.set('Content-Disposition', 'attachment; filename="rater_labeling_template.csv"');
      return res.type('text/csv').send(csv);
    }

    const lines = [
      `Requested ${wantedIds.length} dataset_id(s); found ${datasets.length}, missing ${missingIds.length}.`,
      '',
      ...preview,
    ];
    if (missingIds.length) {
      lines.push('', 'NOT FOUND (check spelling/case against /admin/datasets):', ...missingIds.map((id) => `  - ${id}`));
    }
    lines.push(
      '',
      `Total columns that would be exported: ${predRows.length}`,
      '',
      'If this looks right, re-run with &file=predictions or &file=template to download.'
    );
    res.type('text/plain').send(lines.join('\n'));
  } catch (err) {
    next(err);
  }
});

// ------------------------------------------------------------------
// TEMPORARY — GET/POST /admin/debug-consent-backfill
//
// consent_status (db/schema.sql, RA10173 Data Privacy Act gate) was
// added to evaluation_sessions AFTER several respondents had already
// finished the full six-task walkthrough + 17-item questionnaire, so
// the column's NOT NULL DEFAULT 'pending' retroactively stamped every
// pre-existing session as pending — not because those respondents
// never consented, but because the column didn't exist yet to record
// it (see View Evaluation Report: several rows show Status=Completed,
// 6/6 tasks, 17/17 items, but Consent=Pending). This is a one-time
// data-integrity backfill for THOSE rows only, not a blanket
// pending -> given flip: it never touches a session that is still
// mid-walkthrough (status='walkthrough' or 'questionnaire'), so an
// account that has not actually finished can never be marked
// consented by this route. consent_decided_at is backfilled to that
// session's own completed_at (the real moment they finished), not
// now(), so the record honestly reflects when the work happened
// rather than when this backfill ran.
//
// GET  — plain-text preview of exactly which accounts/sessions would
//        change (no writes).
// POST — performs the UPDATE, scoped identically, then reports how
//        many rows changed.
// Safe to delete once every genuinely-completed respondent's consent
// is fixed and the manuscript's respondent roster is final.
// ------------------------------------------------------------------
async function findConsentBackfillCandidates() {
  const { rows } = await pool.query(
    `SELECT s.id AS session_id, a.username, a.owner_name, a.business_name,
            s.status, s.consent_status, s.completed_at, s.walkthrough_completed_at
       FROM evaluation_sessions s
       JOIN sme_accounts a ON a.id = s.account_id
      WHERE s.consent_status = 'pending'
        AND s.status = 'completed'
      ORDER BY a.business_name ASC`
  );
  return rows;
}

router.get('/admin/debug-consent-backfill', async (req, res, next) => {
  try {
    const candidates = await findConsentBackfillCandidates();
    const lines = [
      `Found ${candidates.length} session(s) with status='completed' but consent_status='pending'.`,
      candidates.length
        ? 'Only these rows would change — nothing still mid-walkthrough or mid-questionnaire is touched.'
        : 'Nothing to backfill.',
      '',
      ...candidates.map((r) =>
        `  session ${r.session_id} - ${r.owner_name} (${r.username}, ${r.business_name}) - ` +
        `completed_at=${r.completed_at ? r.completed_at.toISOString() : 'null'}`
      ),
    ];
    if (candidates.length) {
      lines.push(
        '',
        `POST this same URL (e.g. curl -X POST, logged in as admin) to set consent_status='given' and ` +
        `consent_decided_at=completed_at for exactly these ${candidates.length} row(s).`
      );
    }
    res.type('text/plain').send(lines.join('\n'));
  } catch (err) {
    next(err);
  }
});

router.post('/admin/debug-consent-backfill', async (req, res, next) => {
  try {
    const candidates = await findConsentBackfillCandidates();
    if (!candidates.length) {
      return res.type('text/plain').send("Nothing to backfill — 0 sessions matched status='completed' AND consent_status='pending'.");
    }
    const { rows: updated } = await pool.query(
      `UPDATE evaluation_sessions
          SET consent_status = 'given',
              consent_decided_at = COALESCE(completed_at, walkthrough_completed_at, started_at)
        WHERE consent_status = 'pending'
          AND status = 'completed'
        RETURNING id, account_id`
    );
    res.type('text/plain').send(
      `Updated ${updated.length} session(s): consent_status set to 'given', consent_decided_at backfilled to ` +
      `each session's own completed_at.\n\n` +
      updated.map((r) => `  session ${r.id} (account ${r.account_id})`).join('\n') + '\n'
    );
  } catch (err) {
    next(err);
  }
});

module.exports = router;
