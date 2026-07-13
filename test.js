require('dotenv').config();
const db = require('./src/db');
(async () => {
  try {
    const { rows: tRows } = await db.query('SELECT id FROM tenants LIMIT 1');
    const tid = tRows[0].id;
    const finalEmail = `sub_${Date.now()}_test@walletforge.local`;
    const finalUsername = 'testuser';
    const hash = 'hashedpassword';
    const full_name = 'Test User';
    const role = 'cashier';
    const location_id = null;
    
    console.log('Inserting with tid:', tid);
    const u = await db.query(
      `INSERT INTO users (tenant_id, email, username, password_hash, full_name, role, location_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id, email, username, role, full_name`,
      [tid, finalEmail, finalUsername, hash, full_name, role, location_id]);
    console.log('Success:', u.rows[0]);
  } catch (e) {
    console.error('Error:', e);
  } finally {
    process.exit(0);
  }
})();
