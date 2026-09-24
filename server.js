require('dotenv').config();

const fs = require('fs');
const express = require('express');
const path = require('path');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const expressLayouts = require('express-ejs-layouts');

const pool = require('./db/pool');
const { attachUser } = require('./middleware/auth');
const { TMP_ROOT } = require('./middleware/upload');
const authRoutes = require('./routes/auth');
const dashboardRoutes = require('./routes/dashboard');
const evaluationRoutes = require('./routes/evaluation');

// Clear any dataset-upload temp files left behind by a request that never
// finished (e.g. the process was killed mid-upload) — safe to wipe on
// startup since nothing in there is referenced by the database yet.
fs.rmSync(TMP_ROOT, { recursive: true, force: true });

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

// --- Sessions (persisted in cmaDB via connect-pg-simple) ---
app.use(session({
  store: new pgSession({ pool, createTableIfMissing: true, tableName: 'session' }),
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

// --- Health check (Render's deploy/monitoring probe hits this — no DB
// round-trip so it stays fast and doesn't fail during a brief DB blip) ---
app.get('/healthz', (req, res) => res.status(200).send('ok'));

// --- Routes ---
app.use('/', authRoutes);
app.use('/', dashboardRoutes);
app.use('/', evaluationRoutes);

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
