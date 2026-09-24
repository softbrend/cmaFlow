const { Pool } = require('pg');

// Render's managed Postgres (and most hosted Postgres providers) hand you
// a single DATABASE_URL connection string instead of discrete DB_HOST/
// DB_USER/etc, and require SSL on that connection. Prefer DATABASE_URL
// when present (production/Render); fall back to the discrete DB_* vars
// for local development, where .env.example's defaults still apply.
// DB_SSL=true is kept as an explicit override for either shape, in case a
// local Postgres install is also configured to require SSL.
const pool = process.env.DATABASE_URL
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.DB_SSL === 'false' ? false : { rejectUnauthorized: false },
    })
  : new Pool({
      host: process.env.DB_HOST || 'localhost',
      port: parseInt(process.env.DB_PORT || '5432', 10),
      database: process.env.DB_NAME || 'cmadb',
      user: process.env.DB_USER || 'postgres',
      password: process.env.DB_PASSWORD || '',
      ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
    });

pool.on('error', (err) => {
  console.error('[cmaDB] Unexpected error on idle client', err);
});

module.exports = pool;
