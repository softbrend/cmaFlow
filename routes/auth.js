const express = require('express');
const bcrypt = require('bcryptjs');
const { body, validationResult } = require('express-validator');
const pool = require('../db/pool');
const { redirectIfAuthed } = require('../middleware/auth');
const { ensureDefaultDataset } = require('../services/accountDatasets');
const { loadCategories, isValidCategory } = require('../services/smeCategories');
const { ingestDefaultTemplateForCategory, ingestDefaultBlankTemplateForCategory } = require('../services/templateEvaluationIngest');

const router = express.Router();
const SALT_ROUNDS = 12;

// New-account registration was closed while the TAM/user-acceptance
// evaluation was underway (JIOS manuscript, Section 5.8), so the
// respondent roster stayed fixed to the invited participants. Re-opened
// now that the evaluation window has closed.
const SIGNUPS_OPEN = true;

// ------------------------------------------------------------------
// GET /signup
// ------------------------------------------------------------------
router.get('/signup', redirectIfAuthed, (req, res) => {
  if (!SIGNUPS_OPEN) {
    req.session.flashError = 'New account registration is temporarily closed.';
    return res.redirect('/login');
  }
  res.render('auth/signup', {
    title: 'Create your SME account',
    layout: 'layout-auth',
    errors: [],
    old: {},
  });
});

// ------------------------------------------------------------------
// POST /signup
// ------------------------------------------------------------------
const signupValidators = [
  body('username')
    .trim()
    .matches(/^[A-Za-z0-9_-]{3,50}$/)
    .withMessage('Username must be 3-50 characters (letters, numbers, - or _ only).'),
  body('owner_name').trim().notEmpty().withMessage('SME owner full name is required.'),
  body('business_name').trim().notEmpty().withMessage('Business / SME name is required.'),
  body('email').trim().isEmail().withMessage('A valid business email is required.').normalizeEmail(),
  body('phone').trim().optional({ checkFalsy: true }),
  body('business_sector').trim().notEmpty().withMessage('Business sector is required.'),
  body('business_region').trim().notEmpty().withMessage('Business region is required.'),
  body('password').isLength({ min: 8 }).withMessage('Password must be at least 8 characters.'),
  body('confirm_password').custom((value, { req }) => value === req.body.password)
    .withMessage('Passwords do not match.'),
];

router.post('/signup', redirectIfAuthed, signupValidators, async (req, res, next) => {
  if (!SIGNUPS_OPEN) {
    req.session.flashError = 'New account registration is temporarily closed.';
    return res.redirect('/login');
  }

  const result = validationResult(req);

  if (!result.isEmpty()) {
    return res.status(400).render('auth/signup', {
      title: 'Create your SME account',
      layout: 'layout-auth',
      errors: result.array(),
      old: req.body,
    });
  }

  const {
    username, owner_name, business_name, email, phone,
    business_sector, business_region, password,
  } = req.body;

  try {
    const password_hash = await bcrypt.hash(password, SALT_ROUNDS);
    const { rows } = await pool.query(
      `INSERT INTO sme_accounts
         (username, owner_name, business_name, email, phone, business_sector, business_region, password_hash)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id, username, owner_name, business_name, email, role, assigned_dataset`,
      [username, owner_name, business_name, email, phone || null, business_sector, business_region, password_hash]
    );

    const account = rows[0];
    req.session.userId = account.id;
    req.session.user = account;
    return res.redirect('/');
  } catch (err) {
    // Unique violation (username or email already taken)
    if (err.code === '23505') {
      return res.status(400).render('auth/signup', {
        title: 'Create your SME account',
        layout: 'layout-auth',
        errors: [{ msg: 'That username or business email is already registered.' }],
        old: req.body,
      });
    }
    next(err);
  }
});

// ------------------------------------------------------------------
// Template Evaluator signup — added 30 September 2026 for the field-
// generalization evaluation round. Deliberately NOT linked from /login,
// /signup, or anywhere else in the app's nav: this is a purposively-
// recruited population (domain experts, not the general public), so the
// flow sits behind a shared access code before the registration form is
// even shown, the same way the TAM evaluation roster itself was kept
// closed to invited participants only (see SIGNUPS_OPEN's history
// above). The code lives in EXPERT_SIGNUP_CODE (.env / Render env var) —
// never hard-coded to a value visible in this file — with a fallback
// default ONLY for local dev so a fresh checkout isn't locked out before
// .env is configured; set a real value in production.
//
// GET  /expert-signup            -> the access-code form
// POST /expert-signup            -> verifies the code, flags the session
// GET  /expert-signup/register   -> the actual signup form (code-gated)
// POST /expert-signup/register   -> creates the role='Template Evaluator' account
//
// req.session.expertCodeVerified is a one-time flag: it's set on a
// correct code and cleared the moment an account is actually created (or
// never set at all without one), so it can't be reused to register a
// second account without re-entering the code.
// ------------------------------------------------------------------
const EXPERT_SIGNUP_CODE = process.env.EXPERT_SIGNUP_CODE || 'cmaflow-expert-2026';

router.get('/expert-signup', redirectIfAuthed, (req, res) => {
  res.render('auth/expert-signup-code', {
    title: 'Template Evaluator Access',
    layout: 'layout-auth',
    error: null,
  });
});

router.post('/expert-signup', redirectIfAuthed, (req, res) => {
  const submitted = (req.body.access_code || '').trim();
  if (!submitted || submitted !== EXPERT_SIGNUP_CODE) {
    return res.status(400).render('auth/expert-signup-code', {
      title: 'Template Evaluator Access',
      layout: 'layout-auth',
      error: 'That access code is not correct.',
    });
  }
  req.session.expertCodeVerified = true;
  return res.redirect('/expert-signup/register');
});

router.get('/expert-signup/register', redirectIfAuthed, (req, res) => {
  if (!req.session.expertCodeVerified) {
    return res.redirect('/expert-signup');
  }
  res.render('auth/expert-signup', {
    title: 'Create your Template Evaluator account',
    layout: 'layout-auth',
    errors: [],
    old: {},
    categories: loadCategories(),
  });
});

// business_category replaces what was originally a free-text, optional
// "area of expertise" field (added 30 September 2026, revised 1 October
// 2026): a Template Evaluator's actual job here is to pick one of the 20
// SME Business Categories, download that category's CSV template, fill
// it with a realistic dataset, and evaluate CMA-Flow's analytics against
// it — so capturing that choice as a required, validated selection from
// the same list the templates page offers is far more useful than a free-
// text professional-expertise field no other part of the app reads.
// Still stored in sme_accounts.business_sector (no schema change) —
// only the meaning of that column for this role changed, from "their own
// expertise" to "the business category they're evaluating". See
// services/smeCategories.js for the shared category list this validates
// against.
const expertSignupValidators = [
  body('username')
    .trim()
    .matches(/^[A-Za-z0-9_-]{3,50}$/)
    .withMessage('Username must be 3-50 characters (letters, numbers, - or _ only).'),
  body('full_name').trim().notEmpty().withMessage('Your full name is required.'),
  body('affiliation').trim().notEmpty().withMessage('Your affiliation or organization is required.'),
  body('email').trim().isEmail().withMessage('A valid email is required.').normalizeEmail(),
  body('business_category')
    .trim()
    .notEmpty().withMessage('Select the business category you will evaluate.')
    .bail()
    .custom((value) => isValidCategory(value))
    .withMessage('Select a valid business category from the list.'),
  body('password').isLength({ min: 8 }).withMessage('Password must be at least 8 characters.'),
  body('confirm_password').custom((value, { req }) => value === req.body.password)
    .withMessage('Passwords do not match.'),
];

router.post('/expert-signup/register', redirectIfAuthed, expertSignupValidators, async (req, res, next) => {
  if (!req.session.expertCodeVerified) {
    return res.redirect('/expert-signup');
  }

  const result = validationResult(req);
  if (!result.isEmpty()) {
    return res.status(400).render('auth/expert-signup', {
      title: 'Create your Template Evaluator account',
      layout: 'layout-auth',
      errors: result.array(),
      old: req.body,
      categories: loadCategories(),
    });
  }

  const {
    username, full_name, affiliation, email, business_category, password,
  } = req.body;

  try {
    const password_hash = await bcrypt.hash(password, SALT_ROUNDS);
    // evaluation_flow = 'direct' is a literal here, never taken from
    // req.body — every Template Evaluator account created from here on
    // gets the new ungated flow (upload-or-pick-a-template, no six-task
    // gate, automatic per-module time logging); the 15 accounts that
    // predate this column keep 'walkthrough' via its own DEFAULT (see
    // db/schema.sql). See claude/direct-flow-template-evaluator.md.
    const { rows } = await pool.query(
      `INSERT INTO sme_accounts
         (username, owner_name, business_name, email, business_sector, password_hash, role, evaluation_flow)
       VALUES ($1, $2, $3, $4, $5, $6, 'Template Evaluator', 'direct')
       RETURNING id, username, owner_name, business_name, email, role, business_sector, assigned_dataset, evaluation_flow`,
      [username, full_name, affiliation, email, business_category, password_hash]
    );

    const account = rows[0];
    delete req.session.expertCodeVerified; // one-time: re-entering the code is required for the next account

    // Auto-default (added 2 October 2026, per Brenda's explicit request):
    // the business category just declared above becomes this account's
    // default CSV for evaluation immediately, through the exact same
    // ingest a manual "Use for evaluation" click on /sme-templates runs
    // (services/templateEvaluationIngest.js) — so a brand-new evaluator
    // sees real output on all four analytics modules right away, with no
    // extra trip required. They can still switch to any OTHER category's
    // template at any time from that same page; this only sets the
    // starting point. Non-fatal and never allowed to fail the signup
    // itself: on any error here the account still exists and is usable,
    // just starting with no dataset assigned (today's behavior), exactly
    // as if this line didn't exist.
    try {
      const ingested = await ingestDefaultTemplateForCategory(account.id, business_category);
      if (ingested) {
        await pool.query('UPDATE sme_accounts SET evaluation_template_file = $1 WHERE id = $2', [ingested.templateFile, account.id]);
        account.evaluation_template_file = ingested.templateFile;
        account.default_dataset_id = ingested.datasetRowId;
      }
    } catch (ingestErr) {
      console.error('[expert-signup] auto-default template ingest failed:', ingestErr.message);
    }

    req.session.userId = account.id;
    req.session.user = account;
    return res.redirect('/');
  } catch (err) {
    if (err.code === '23505') {
      return res.status(400).render('auth/expert-signup', {
        title: 'Create your Template Evaluator account',
        layout: 'layout-auth',
        errors: [{ msg: 'That username or email is already registered.' }],
        old: req.body,
        categories: loadCategories(),
      });
    }
    next(err);
  }
});

// ------------------------------------------------------------------
// Business Owner Evaluator signup — added 2 October 2026, the population
// that takes the new ISO/IEC 25010 Quality-in-Use questionnaire (see
// services/tamEvaluation.js's header comment). Mirrors the Template
// Evaluator signup above almost exactly (access-code gate before the
// registration form, the same one-time req.session.businessOwnerCodeVerified
// flag), deliberately kept as its own separate code path rather than a
// third branch grafted onto the expert-signup routes — this is a
// different population answering a different instrument, and the two
// access codes must never be interchangeable.
//
// Revised 2 October 2026 (same day, per Brenda's explicit follow-up): this
// role now carries the SAME business-category selection as Template
// Evaluator, not the free-text owner_name/business_name/phone/sector/
// region fields the public /signup form uses. The signup form fields,
// validators, and the account-creation INSERT below are now a near-exact
// copy of expertSignupValidators/the /expert-signup/register handler
// above — username/full_name/affiliation/email/business_category/
// password — including the same auto-default template ingest on success
// (ingestDefaultTemplateForCategory, services/templateEvaluationIngest.js)
// so a fresh Business Owner Evaluator account sees real output on all
// four analytics modules immediately, exactly like a fresh Template
// Evaluator account does. The only things that still differ from Template
// Evaluator: the role string itself ('Business Owner Evaluator'), no
// evaluation_flow override (this role has no 'direct'-flow variant — it
// stays on the column's own 'walkthrough' default, always six-task-gated,
// see middleware/evaluationGate.js), and of course the questionnaire
// instrument it answers (handled entirely in services/tamEvaluation.js,
// never here). See routes/templates.js's usesTemplateSystem() for where
// the shared /sme-templates system itself now recognizes both roles.
//
// GET  /businessOwner-signup            -> the access-code form
// POST /businessOwner-signup            -> verifies the code, flags the session
// GET  /businessOwner-signup/register   -> the actual signup form (code-gated)
// POST /businessOwner-signup/register   -> creates the role='Business Owner Evaluator' account
// ------------------------------------------------------------------
const BUSINESS_OWNER_SIGNUP_CODE = process.env.BUSINESS_OWNER_SIGNUP_CODE || 'cmaflow-bizowner-2026';

router.get('/businessOwner-signup', redirectIfAuthed, (req, res) => {
  res.render('auth/businessOwner-signup-code', {
    title: 'Business Owner Evaluator Access',
    layout: 'layout-auth',
    error: null,
  });
});

router.post('/businessOwner-signup', redirectIfAuthed, (req, res) => {
  const submitted = (req.body.access_code || '').trim();
  if (!submitted || submitted !== BUSINESS_OWNER_SIGNUP_CODE) {
    return res.status(400).render('auth/businessOwner-signup-code', {
      title: 'Business Owner Evaluator Access',
      layout: 'layout-auth',
      error: 'That access code is not correct.',
    });
  }
  req.session.businessOwnerCodeVerified = true;
  return res.redirect('/businessOwner-signup/register');
});

router.get('/businessOwner-signup/register', redirectIfAuthed, (req, res) => {
  if (!req.session.businessOwnerCodeVerified) {
    return res.redirect('/businessOwner-signup');
  }
  res.render('auth/businessOwner-signup', {
    title: 'Create your Business Owner Evaluator account',
    layout: 'layout-auth',
    errors: [],
    old: {},
    categories: loadCategories(),
  });
});

// Same business_category field/validation as expertSignupValidators above
// (see services/smeCategories.js) — stored in sme_accounts.business_sector,
// same column Template Evaluator uses it for, no schema change needed.
const businessOwnerSignupValidators = [
  body('username')
    .trim()
    .matches(/^[A-Za-z0-9_-]{3,50}$/)
    .withMessage('Username must be 3-50 characters (letters, numbers, - or _ only).'),
  body('full_name').trim().notEmpty().withMessage('Your full name is required.'),
  body('affiliation').trim().notEmpty().withMessage('Your business / affiliation name is required.'),
  body('email').trim().isEmail().withMessage('A valid email is required.').normalizeEmail(),
  body('business_category')
    .trim()
    .notEmpty().withMessage('Select the business category you will evaluate.')
    .bail()
    .custom((value) => isValidCategory(value))
    .withMessage('Select a valid business category from the list.'),
  body('password').isLength({ min: 8 }).withMessage('Password must be at least 8 characters.'),
  body('confirm_password').custom((value, { req }) => value === req.body.password)
    .withMessage('Passwords do not match.'),
];

router.post('/businessOwner-signup/register', redirectIfAuthed, businessOwnerSignupValidators, async (req, res, next) => {
  if (!req.session.businessOwnerCodeVerified) {
    return res.redirect('/businessOwner-signup');
  }

  const result = validationResult(req);
  if (!result.isEmpty()) {
    return res.status(400).render('auth/businessOwner-signup', {
      title: 'Create your Business Owner Evaluator account',
      layout: 'layout-auth',
      errors: result.array(),
      old: req.body,
      categories: loadCategories(),
    });
  }

  const {
    username, full_name, affiliation, email, business_category, password, dataset_origin,
  } = req.body;
  // Added 3 October 2026, per Brenda's "both" instruction (offer the
  // blank-vs-prefilled choice at signup AND again later from Download
  // SME Templates): 'blank' means this account's very first copy is a
  // zero-row, real-data working copy instead of the 50 synthetic rows.
  // Anything else (missing field, old client, bad value) defaults to the
  // existing prefilled behavior — the exact same default every account
  // created before this choice existed already got.
  const useBlankDataset = dataset_origin === 'blank';

  try {
    const password_hash = await bcrypt.hash(password, SALT_ROUNDS);
    const { rows } = await pool.query(
      `INSERT INTO sme_accounts
         (username, owner_name, business_name, email, business_sector, password_hash, role)
       VALUES ($1, $2, $3, $4, $5, $6, 'Business Owner Evaluator')
       RETURNING id, username, owner_name, business_name, email, role, business_sector, assigned_dataset`,
      [username, full_name, affiliation, email, business_category, password_hash]
    );

    const account = rows[0];
    delete req.session.businessOwnerCodeVerified; // one-time: re-entering the code is required for the next account

    // Auto-default, same as /expert-signup/register above: the business
    // category just declared becomes this account's default CSV for
    // evaluation immediately, through the exact same ingest a manual "Use
    // for evaluation" (or, new as of 3 October 2026, "Start with blank
    // template") click on /sme-templates runs. Non-fatal — on any error
    // here the account still exists and is usable, just starting with no
    // dataset assigned, exactly as if this block didn't run.
    try {
      const ingested = useBlankDataset
        ? await ingestDefaultBlankTemplateForCategory(account.id, business_category)
        : await ingestDefaultTemplateForCategory(account.id, business_category);
      if (ingested) {
        await pool.query('UPDATE sme_accounts SET evaluation_template_file = $1 WHERE id = $2', [ingested.templateFile, account.id]);
        account.evaluation_template_file = ingested.templateFile;
        account.default_dataset_id = ingested.datasetRowId;
      }
    } catch (ingestErr) {
      console.error('[businessOwner-signup] auto-default template ingest failed:', ingestErr.message);
    }

    req.session.userId = account.id;
    req.session.user = account;
    return res.redirect('/');
  } catch (err) {
    if (err.code === '23505') {
      return res.status(400).render('auth/businessOwner-signup', {
        title: 'Create your Business Owner Evaluator account',
        layout: 'layout-auth',
        errors: [{ msg: 'That username or email is already registered.' }],
        old: req.body,
        categories: loadCategories(),
      });
    }
    next(err);
  }
});

// ------------------------------------------------------------------
// GET /login
// ------------------------------------------------------------------
router.get('/login', redirectIfAuthed, (req, res) => {
  const flashError = req.session.flashError;
  req.session.flashError = null;
  res.render('auth/login', { title: 'Sign in', layout: 'layout-auth', error: flashError, old: {} });
});

// ------------------------------------------------------------------
// POST /login
// ------------------------------------------------------------------
router.post('/login', redirectIfAuthed, async (req, res, next) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).render('auth/login', {
      title: 'Sign in',
      layout: 'layout-auth',
      error: 'Username and password are required.',
      old: { username },
    });
  }

  try {
    // business_sector and evaluation_template_file included here (not
    // just in the registration RETURNING clauses) so both are populated
    // on every login, not only immediately after signup — a Template
    // Evaluator's declared category (routes/templates.js's
    // assignedCategory) and their chosen default CSV for evaluation
    // (evaluationTemplateFile) both depend on these still being there
    // after they log back in on a later visit.
    // evaluation_flow included here (not just in the registration
    // RETURNING clause) so it's populated on every login too, same
    // reasoning as business_sector/evaluation_template_file just below —
    // middleware/evaluationGate.js and routes/dashboard.js both read
    // req.session.user.evaluation_flow on every request.
    const { rows } = await pool.query(
      `SELECT id, username, owner_name, business_name, email, role, business_sector,
              evaluation_template_file, assigned_dataset, evaluation_flow, password_hash
         FROM sme_accounts WHERE username = $1`,
      [username.trim()]
    );

    const account = rows[0];
    const passwordOk = account ? await bcrypt.compare(password, account.password_hash) : false;

    if (!account || !passwordOk) {
      return res.status(401).render('auth/login', {
        title: 'Sign in',
        layout: 'layout-auth',
        error: 'Incorrect username or password.',
        old: { username },
      });
    }

    delete account.password_hash;

    // An Admin account has no datasets of its own to land on — send it
    // straight to the admin section instead of the SME Owner Portal home
    // page (which would just render empty). Everything below this branch
    // (default-dataset bookkeeping) is SME-owner-only and skipped for Admin.
    if (account.role === 'Admin') {
      req.session.userId = account.id;
      req.session.user = account;
      return res.redirect('/admin');
    }

    // "Always have a dataset assigned to the SME owner upon successful
    // log-in if there were already uploaded datasets" — this is where
    // that happens. Never overwrites a default the SME owner already
    // chose and that's still valid; only fills the gap (no default yet,
    // or more than one dataset uploaded and none picked as default yet)
    // by falling back to whichever dataset this account uploaded most
    // recently. See services/accountDatasets.js.
    const { defaultDatasetId } = await ensureDefaultDataset(account.id);
    account.default_dataset_id = defaultDatasetId;

    req.session.userId = account.id;
    req.session.user = account;
    return res.redirect('/');
  } catch (err) {
    next(err);
  }
});

// ------------------------------------------------------------------
// GET /logout
// ------------------------------------------------------------------
router.get('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

module.exports = router;
