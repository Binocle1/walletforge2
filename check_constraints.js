require('dotenv').config();
const db = require('./src/db');
(async () => {
  try {
    const { rows } = await db.query("SELECT conname, pg_get_constraintdef(c.oid) FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace WHERE conrelid = 'users'::regclass");
    console.log(rows);
  } catch (e) {
    console.error('Error:', e);
  } finally {
    process.exit(0);
  }
})();
