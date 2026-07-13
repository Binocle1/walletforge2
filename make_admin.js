require('dotenv').config();
const db = require('./src/db');
async function run() {
  const r = await db.query("UPDATE users SET role = 'superadmin' WHERE id = (SELECT id FROM users ORDER BY created_at LIMIT 1) RETURNING email");
  console.log('Superadmin set to:', r.rows[0]?.email);
  process.exit(0);
}
run();
