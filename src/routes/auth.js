const router = require('express').Router();
const bcrypt = require('bcryptjs');
const db = require('../db');
const { sign, required, roles, bruteForceGuard } = require('../auth');

// POST /api/auth/register — crée tenant + business + owner
router.post('/register', async (req, res) => {
  const { business_name, full_name, email, password, phone, country, currency, business_type } = req.body;
  if (!business_name || !email || !password || password.length < 8) {
    return res.status(400).json({ error: 'Nom du commerce, email et mot de passe (8+ caractères) requis' });
  }
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const t = await client.query(`INSERT INTO tenants (name) VALUES ($1) RETURNING *`, [business_name]);
    const b = await client.query(
      `INSERT INTO businesses (tenant_id, name, business_type, country, currency, phone)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [t.rows[0].id, business_name, business_type || null, country || 'FR', currency || 'EUR', phone || null]);
    await client.query(
      `INSERT INTO locations (tenant_id, business_id, name) VALUES ($1,$2,'Principal')`,
      [t.rows[0].id, b.rows[0].id]);
    const hash = await bcrypt.hash(password, 12);
    const u = await client.query(
      `INSERT INTO users (tenant_id, email, password_hash, full_name, role)
       VALUES ($1, lower($2), $3, $4, 'owner') RETURNING *`,
      [t.rows[0].id, email, hash, full_name || business_name]);
    await client.query('COMMIT');
    res.json({ token: sign(u.rows[0]), user: { email: u.rows[0].email, role: 'owner', full_name: u.rows[0].full_name } });
  } catch (e) {
    await client.query('ROLLBACK');
    if (e.code === '23505') return res.status(409).json({ error: 'Un compte existe déjà avec cet email' });
    console.error(e);
    res.status(500).json({ error: 'Erreur lors de la création du compte' });
  } finally {
    client.release();
  }
});

// POST /api/auth/login
router.post('/login', bruteForceGuard, async (req, res) => {
  const { email, password } = req.body;
  const loginId = (email || '').toLowerCase();
  const { rows } = await db.query('SELECT * FROM users WHERE email = $1 OR username = $1', [loginId]);
  const user = rows[0];
  if (!user || !(await bcrypt.compare(password || '', user.password_hash))) {
    req.loginFail();
    return res.status(401).json({ error: 'Email ou mot de passe incorrect' });
  }
  req.loginOk();
  await db.query(`INSERT INTO audit_logs (tenant_id, user_id, action, ip) VALUES ($1,$2,'login',$3)`,
    [user.tenant_id, user.id, req.ip]);
  res.json({ token: sign(user), user: { email: user.email, role: user.role, full_name: user.full_name } });
});

// POST /api/auth/invite — owner/admin invite un manager ou caissier
router.post('/invite', required, roles('owner', 'admin'), async (req, res) => {
  const { email, username, full_name, password, role, location_id } = req.body;
  if (!['admin', 'manager', 'cashier', 'readonly'].includes(role)) {
    return res.status(400).json({ error: 'Rôle invalide' });
  }
  if (!email && !username) {
    return res.status(400).json({ error: 'Email ou nom d\'utilisateur requis' });
  }
  const hash = await bcrypt.hash(password || Math.random().toString(36), 12);
  const finalEmail = email ? email.toLowerCase() : `sub_${Date.now()}_${username}@walletforge.local`;
  const finalUsername = username ? username.toLowerCase() : null;

  try {
    const u = await db.query(
      `INSERT INTO users (tenant_id, email, username, password_hash, full_name, role, location_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id, email, username, role, full_name`,
      [req.auth.tid, finalEmail, finalUsername, hash, full_name || finalUsername || finalEmail, role, location_id || null]);
    res.json(u.rows[0]);
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'Cet email a déjà un compte' });
    throw e;
  }
});

// GET /api/auth/me
router.get('/me', required, async (req, res) => {
  const { rows } = await db.query(
    `SELECT u.email, u.username, u.full_name, u.role, t.plan, t.plan_limits, t.subscription_status, b.id AS business_id, b.name AS business_name
     FROM users u JOIN tenants t ON t.id = u.tenant_id
     LEFT JOIN businesses b ON b.tenant_id = t.id
     WHERE u.id = $1`, [req.auth.uid]);
  res.json(rows[0] || {});
});

// GET /api/auth/users — Liste de l'équipe
router.get('/users', required, roles('owner', 'admin'), async (req, res) => {
  const { rows } = await db.query('SELECT id, email, username, full_name, role, created_at FROM users WHERE tenant_id = $1 ORDER BY created_at', [req.auth.tid]);
  res.json(rows);
});

// DELETE /api/auth/users/:id — Supprimer un membre
router.delete('/users/:id', required, roles('owner', 'admin'), async (req, res) => {
  if (req.params.id === req.auth.uid) return res.status(400).json({ error: 'Vous ne pouvez pas vous supprimer vous-même' });
  await db.query('DELETE FROM users WHERE id = $1 AND tenant_id = $2', [req.params.id, req.auth.tid]);
  res.json({ ok: true });
});

const nodemailer = require('nodemailer');
const crypto = require('crypto');

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || 'localhost',
  port: process.env.SMTP_PORT || 1025,
  auth: process.env.SMTP_USER ? {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS
  } : undefined
});

// POST /api/auth/forgot-password
router.post('/forgot-password', bruteForceGuard, async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email requis' });
  
  const { rows } = await db.query('SELECT id, email FROM users WHERE email = lower($1) OR username = lower($1)', [email]);
  if (!rows[0]) return res.json({ ok: true }); // Ne pas révéler si le compte existe ou non

  const token = crypto.randomBytes(32).toString('hex');
  await db.query(
    `UPDATE users SET reset_token = $1, reset_expires = now() + interval '1 hour' WHERE id = $2`,
    [token, rows[0].id]
  );

  const resetLink = `${process.env.BASE_URL}/dashboard?reset=${token}`;
  
  if (process.env.SMTP_HOST) {
    try {
      await transporter.sendMail({
        from: process.env.SMTP_FROM || '"WalletForge" <noreply@walletforge.com>',
        to: rows[0].email,
        subject: 'Réinitialisation de votre mot de passe',
        text: `Cliquez sur le lien suivant pour réinitialiser votre mot de passe : ${resetLink}\n\nCe lien expire dans 1 heure.`
      });
    } catch(e) { console.error('SMTP Error:', e); }
  } else {
    console.log('\\n[DEBUG] SMTP non configuré. Lien de reset pour', rows[0].email, ':', resetLink, '\\n');
  }

  res.json({ ok: true, message: 'Si ce compte existe, un lien a été envoyé.' });
});

// POST /api/auth/reset-password
router.post('/reset-password', async (req, res) => {
  const { token, password } = req.body;
  if (!token || !password || password.length < 8) return res.status(400).json({ error: 'Mot de passe invalide (8 caractères min)' });

  const { rows } = await db.query(
    'SELECT id FROM users WHERE reset_token = $1 AND reset_expires > now()', [token]
  );
  if (!rows[0]) return res.status(400).json({ error: 'Lien invalide ou expiré' });

  const hash = await bcrypt.hash(password, 12);
  await db.query(
    'UPDATE users SET password_hash = $1, reset_token = NULL, reset_expires = NULL WHERE id = $2',
    [hash, rows[0].id]
  );

  res.json({ ok: true, message: 'Mot de passe mis à jour.' });
});

module.exports = router;
