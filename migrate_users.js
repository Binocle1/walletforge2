require('dotenv').config();
const db = require('./src/db');

async function migrate() {
  try {
    console.log('Migrating users table...');
    // Add username column
    await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS username TEXT UNIQUE`);
    // Add reset token columns
    await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS reset_token TEXT`);
    await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS reset_expires TIMESTAMPTZ`);
    console.log('Migration successful.');
  } catch (e) {
    console.error('Migration failed:', e);
  } finally {
    process.exit(0);
  }
}
migrate();
