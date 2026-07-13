require('dotenv').config();
const db = require('./src/db');
const bcrypt = require('bcryptjs');

async function test() {
  try {
    const hash = await bcrypt.hash('testpass', 12);
    const tenant = await db.query('SELECT id FROM tenants LIMIT 1');
    const tid = tenant.rows[0].id;

    const u = await db.query(
      `INSERT INTO users (tenant_id, email, username, password_hash, full_name, role)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, email, username, role, full_name`,
      [tid, `sub_${Date.now()}_testuser@walletforge.local`, 'testuser', hash, 'Test User', 'cashier']
    );
    console.log('Success:', u.rows[0]);
  } catch (e) {
    console.error('Error:', e.message);
  } finally {
    process.exit(0);
  }
}
test();
