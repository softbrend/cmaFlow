const express = require('express');
const bcrypt = require('bcryptjs');
const { body, validationResult } = require('express-validator');
const pool = require('../db/pool');
const { redirectIfAuthed } = require('../middleware/auth');
const { ensureDefaultDataset } = require('../services/accountDatasets');

const router = express.Router();
const SALT_ROUNDS = 12;

// New-account registration is closed while the TAM/user-acceptance
// evaluation is underway (JIOS manuscript, Section 5.8) — the respondent
// roster is fixed to the invited participants, so no walk-up SME account
// should be able to self-register and skew or dilute that dataset. Flip
// back to `true` once the evaluation window closes.
const SIGNUPS_OPEN = false;

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
    const { rows } = await pool.query(
      `SELECT id, username, owner_name, business_name, email, role, assigned_dataset, password_hash
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
