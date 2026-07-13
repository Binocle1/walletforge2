require('dotenv').config();
const bcrypt = require('bcryptjs');
const db = require('./src/db');

async function run() {
  const newPassword = 'Password123!';
  const hash = await bcrypt.hash(newPassword, 12);
  const r = await db.query(
    "UPDATE users SET password_hash = $1 WHERE email = 'balon@yopmail.com' RETURNING email",
    [hash]
  );
  if (r.rows.length) {
    console.log('Password reset successfully for:', r.rows[0].email);
    console.log('New password:', newPassword);
  } else {
    console.log('User not found.');
  }
  process.exit(0);
}
run();
