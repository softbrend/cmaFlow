// Applies db/schema.sql against cmaDB. Run with: npm run db:init
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const pool = require('./pool');

async function main() {
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  const target = process.env.DATABASE_URL
    ? 'DATABASE_URL target'
    : `${process.env.DB_NAME || 'cmadb'} on ${process.env.DB_HOST || 'localhost'}:${process.env.DB_PORT || 5432}`;
  console.log(`Connecting to ${target}...`);
  const client = await pool.connect();
  try {
    await client.query(sql);
    console.log('✓ cmaDB schema applied successfully.');
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error('✗ Failed to apply schema:', err.message);
  process.exit(1);
});
