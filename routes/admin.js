// Admin section — a role='Admin' account (see db/schema.sql's
// sme_accounts.role column, and scripts/promoteToAdmin.js for how an
// account gets that role) can manage SME owner accounts (reset a
// forgotten/locked-out password) and browse the TAM end-user evaluation
// data every SME owner account logs at /evaluation (routes/evaluation.js,
// services/tamEvaluation.js): each account's six-task walkthrough log,
// its 17-item questionnaire answers, and a cross-respondent descriptive
// summary matching the instrument's own Section 6 scoring plan.
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
  listAccounts, getAccountById, resetPassword, countAdmins,
  createAdminAccount, promoteToAdmin, demoteToOwner,
} = require('../services/adminAccounts');
const {
  WALKTHROUGH_TASKS, groupItemsByDomain,
  getEvaluationStateReadOnly, listAllEvaluationStatuses, getCompletedResponseSummary,
} = require('../services/tamEvaluation');
const { listAllDatasets, getDatasetForAdmin, deleteDataset } = require('../services/adminDatasets');
const { getOrBuildFullProfile } = require('../services/fullDescriptiveAnalytics');
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
    const [{ rows: countRows }, statuses, allDatasets] = await Promise.all([
      pool.query(
        `SELECT COUNT(*) FILTER (WHERE role != 'Admin')::int AS sme_count,
                COUNT(*) FILTER (WHERE role = 'Admin')::int AS admin_count
           FROM sme_accounts`
      ),
      listAllEvaluationStatuses(),
      listAllDatasets(),
    ]);
    const counts = countRows[0];
    const completed = statuses.filter((s) => s.status === 'completed').length;
    const inProgress = statuses.filter((s) => s.status === 'walkthrough' || s.status === 'questionnaire').length;
    const notStarted = statuses.filter((s) => !s.status).length;

    res.render('dashboard/admin-home', {
      title: 'Admin',
      active: 'admin',
      adminSection: 'home',
      smeCount: counts.sme_count,
      adminCount: counts.admin_count,
      datasetCount: allDatasets.length,
      completed,
      inProgress,
      notStarted,
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
      q: req.query.q || '',
      passwordReset: req.query.passwordReset || null,
      created: req.query.created || null,
      promoted: req.query.promoted || null,
      demoted: req.query.demoted || null,
      currentAdminId: req.session.userId,
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
router.get('/admin/accounts/:id/password', async (req, res, next) => {
  try {
    const account = await getAccountById(req.params.id);
    if (!account) return res.status(404).render('errors/404', { title: 'Not found', layout: false });
    res.render('dashboard/admin-reset-password', {
      title: `Change password — ${account.username}`,
      active: 'admin',
      adminSection: 'accounts',
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

    const result = validationResult(req);
    if (!result.isEmpty()) {
      return res.status(400).render('dashboard/admin-reset-password', {
        title: `Change password — ${account.username}`,
        active: 'admin',
        adminSection: 'accounts',
        account,
        errors: result.array(),
      });
    }

    await resetPassword(account.id, req.body.new_password);
    return res.redirect(`/admin/accounts?passwordReset=${encodeURIComponent(account.username)}`);
  } catch (err) {
    next(err);
  }
});

// ------------------------------------------------------------------
// GET /admin/evaluations — every SME owner account's evaluation
// progress, plus the cross-respondent 17-item descriptive summary
// (completed evaluations only — see getCompletedResponseSummary()).
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
      domains: groupItemsByDomain(),
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
    const datasets = await listAllDatasets(q);
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

// ------------------------------------------------------------------
// GET /admin/exit-view — leaves "viewing as admin" mode.
// ------------------------------------------------------------------
router.get('/admin/exit-view', (req, res) => {
  delete req.session.adminViewAccountId;
  res.redirect('/admin/datasets');
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

    res.render('dashboard/erd', {
      title: `Entity-Relationship Diagram — ${dataset.dataset_name}`,
      active: 'admin',
      adminSection: 'datasets',
      dataset,
      erd,
      humanizeFileType,
      backHref: '/admin/datasets',
      backLabel: '← Manage Datasets',
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
    res.render('dashboard/admin-dataset-delete-confirm', {
      title: `Delete dataset — ${dataset.dataset_name}`,
      active: 'admin',
      adminSection: 'datasets',
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
    await deleteDataset(dataset.id);
    return res.redirect(`/admin/datasets?deleted=${encodeURIComponent(dataset.dataset_name)}`);
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

module.exports = router;
