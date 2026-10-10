require('dotenv').config();

const fs = require('fs');
const express = require('express');
const path = require('path');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const expressLayouts = require('express-ejs-layouts');

const pool = require('./db/pool');
const { attachUser } = require('./middleware/auth');
const { evaluationGate } = require('./middleware/evaluationGate');
const { respondentProfileGate } = require('./middleware/respondentProfileGate');
const { TMP_ROOT } = require('./middleware/upload');
const { reconcileStuckUploadJobs } = require('./services/uploadJobs');
const authRoutes = require('./routes/auth');
const dashboardRoutes = require('./routes/dashboard');
const evaluationRoutes = require('./routes/evaluation');
const adminRoutes = require('./routes/admin');
const templateRoutes = require('./routes/templates');

// Clear any dataset-upload temp files left behind by a request that never
// finished (e.g. the process was killed mid-upload) — safe to wipe on
// startup since nothing in there is referenced by the database yet.
fs.rmSync(TMP_ROOT, { recursive: true, force: true });

// Same reasoning, for the background ingest jobs those temp files fed
// (services/datasetIngestService.js): a job still 'processing' at this
// point belongs to a request that was killed mid-ingest, and its temp
// files were just deleted by the wipe above — mark it failed so its
// processing page (still polling in a leftover browser tab) sees an
// answer instead of spinning forever. Fire-and-forget: this must never
// delay the server actually starting to accept requests.
reconcileStuckUploadJobs().catch((e) => console.error('[uploadJobs] boot reconcile failed:', e));

const app = express();
const PORT = process.env.PORT || 3000;

// --- View engine ---
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(expressLayouts);
app.set('layout', 'layout');
// Express only turns on compiled-template caching automatically when
// NODE_ENV=production, which `npm start` never sets here (see package.json
// — plain `node server.js`, no env var). Without it, EVERY request
// recompiles the full EJS template chain (layout + partials + page) from
// disk from scratch — layout.ejs, header.ejs, sidebar.ejs, and (on the
// four analytics pages) stage-pipeline.ejs too, on top of the page's own
// template, all re-read and re-parsed every single time. That's real,
// avoidable per-request latency on every page for every dataset, worse on
// Windows' slower filesystem I/O than this sandbox's Linux. Since this app
// already has no file-watching (a template edit needs a server restart
// regardless — see the audit doc's round 4 note), there's no live-editing
// workflow this caching could break; turning it on unconditionally is safe.
app.set('view cache', true);

// --- Core middleware ---
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Cache-busting query string for /css/style.css (added 3 October 2026,
// after a style.css fix — the Add-row modal's scroll/footer layout —
// deployed correctly server-side but a browser that had already loaded
// the OLD stylesheet kept using its own cached copy, since a plain
// <link href="/css/style.css"> with no version has nothing to tell the
// browser the file changed: express.static sets no Cache-Control here,
// so browsers fall back to HTTP's heuristic freshness, which can treat
// an unchanged-URL file as "fresh" for a long time without even
// re-checking the server. Computed once at boot from the file's own
// mtime (so every deploy — a new file on disk — gets a new value
// automatically, no version number to remember to bump by hand) and
// exposed to every view as `cssVersion`; views/layout.ejs and
// layout-auth.ejs append it as ?v=<cssVersion> on the stylesheet link,
// which forces a fresh fetch the instant the file actually changes.
try {
  app.locals.cssVersion = fs.statSync(path.join(__dirname, 'public', 'css', 'style.css')).mtimeMs;
} catch (e) {
  app.locals.cssVersion = Date.now(); // missing file in some dev setup — still busts the cache, just not deploy-stable
}

// --- Health check (Render's own health probe hits this to decide whether
// the running instance is "up" — this MUST be registered before any
// DB-backed middleware. It used to sit after the session middleware below,
// with a comment claiming it had "no DB round-trip" — that was the intent,
// but Express runs middleware in registration order for every route
// including this one, so every request (healthz included) was still
// passing through the session middleware's own per-request Postgres query
// first. During a brief database restart/recovery window, that query
// failed, the session middleware's error reached our error handler, and
// Render's health probe saw a 500 from /healthz — indistinguishable, from
// Render's side, from the app itself being down — and marked the whole
// instance "failed," which then needed a manual restart to clear even
// though the Node process itself was never down. Moving this above the
// session middleware actually delivers on the original comment's intent:
// this route now genuinely never touches the database, so a transient DB
// blip no longer takes the instance out of rotation on its own. ---
app.get('/healthz', (req, res) => res.status(200).send('ok'));

// --- Sessions (persisted in cmaDB via connect-pg-simple) ---
app.use(session({
  // createTableIfMissing is deliberately false — the "session" table is
  // now created by db/schema.sql (npm run db:init, applied idempotently on
  // every deploy) instead of by connect-pg-simple probing for it on first
  // use. See the schema.sql comment above the table's definition for why:
  // that lazy first-use check is what let a single brief database restart
  // permanently break every session-touching request until the process
  // was manually restarted.
  store: new pgSession({ pool, createTableIfMissing: false, tableName: 'session' }),
  secret: process.env.SESSION_SECRET || 'dev-secret-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 1000 * 60 * 60 * 8, // 8 hours
    httpOnly: true,
    sameSite: 'lax',
  },
}));

app.use(attachUser);
app.use(evaluationGate);
// SME Owner-TAM Evaluators must answer the position and decision-making
// questions before using the app (added 10 October 2026).
app.use(respondentProfileGate);

// --- Routes ---
// templateRoutes MUST be registered before adminRoutes. adminRoutes opens
// with an unconditional `router.use(requireAdmin)` (routes/admin.js) with
// no path restriction — Express runs that for ANY request that falls
// through every earlier router unmatched, not just requests actually
// aimed at /admin/*, because the whole router is mounted at '/'. Since
// /sme-templates isn't defined in authRoutes/dashboardRoutes/
// evaluationRoutes, a request for it used to fall through all the way to
// adminRoutes and get wrongly turned away with "this section is for
// Admin accounts only" before templateRoutes ever got a chance to handle
// it — even though GET /sme-templates itself only requires requireAuth
// (any signed-in account). Registering templateRoutes first means its
// own routes get matched and handled on their own merits; anything that
// still isn't matched (i.e. genuinely meant for /admin/*) falls through
// to adminRoutes exactly as before.
app.use('/', authRoutes);
app.use('/', dashboardRoutes);
app.use('/', evaluationRoutes);
app.use('/', templateRoutes);
app.use('/', adminRoutes);

// --- 404 ---
app.use((req, res) => {
  res.status(404).render('errors/404', { title: 'Not found', layout: false });
});

// --- Error handler ---
app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  console.error(err);
  res.status(500).render('errors/500', {
    title: 'Something went wrong',
    layout: false,
    message: process.env.NODE_ENV === 'production' ? null : err.message,
  });
});

app.listen(PORT, () => {
  console.log(`CMA-Flow running at http://localhost:${PORT}`);
  const dbTarget = process.env.DATABASE_URL
    ? 'DATABASE_URL target'
    : `${process.env.DB_NAME || 'cmadb'} @ ${process.env.DB_HOST || 'localhost'}:${process.env.DB_PORT || 5432}`;
  console.log(`Connected to cmaDB target: ${dbTarget}`);
});
