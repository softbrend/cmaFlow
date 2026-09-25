const { Pool } = require('pg');

// Render's managed Postgres (and most hosted Postgres providers) hand you
// a single DATABASE_URL connection string instead of discrete DB_HOST/
// DB_USER/etc, and require SSL on that connection. Prefer DATABASE_URL
// when present (production/Render); fall back to the discrete DB_* vars
// for local development, where .env.example's defaults still apply.
// DB_SSL=true is kept as an explicit override for either shape, in case a
// local Postgres install is also configured to require SSL.
// connectionTimeoutMillis caps how long a single connection ATTEMPT can
// hang before giving up — it does not retry anything by itself. Without
// it, `pg`'s default is no timeout at all, so a request arriving while
// Postgres is unreachable (mid-restart, network blip) could sit waiting
// indefinitely instead of failing fast into the app's own error handling.
// 10s is generous enough for a normal connection under load, short enough
// that a genuinely-down database doesn't pile up hung requests.
const pool = process.env.DATABASE_URL
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.DB_SSL === 'false' ? false : { rejectUnauthorized: false },
      connectionTimeoutMillis: 10000,
    })
  : new Pool({
      host: process.env.DB_HOST || 'localhost',
      port: parseInt(process.env.DB_PORT || '5432', 10),
      database: process.env.DB_NAME || 'cmadb',
      user: process.env.DB_USER || 'postgres',
      password: process.env.DB_PASSWORD || '',
      ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
      connectionTimeoutMillis: 10000,
    });

pool.on('error', (err) => {
  console.error('[cmaDB] Unexpected error on idle client', err);
});

module.exports = pool;
