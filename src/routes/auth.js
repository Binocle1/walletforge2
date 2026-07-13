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
  const { rows } = await db.query('SELECT * FROM users WHERE email = lower($1)', [email || '']);
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
  const { email, full_name, password, role, location_id } = req.body;
  if (!['admin', 'manager', 'cashier', 'readonly'].includes(role)) {
    return res.status(400).json({ error: 'Rôle invalide' });
  }
  // Contrôle de la limite managers du plan
  const t = await db.query('SELECT plan_limits FROM tenants WHERE id = $1', [req.auth.tid]);
  const limit = t.rows[0].plan_limits.managers ?? 0;
  const count = await db.query(
    `SELECT count(*)::int AS n FROM users WHERE tenant_id = $1 AND role IN ('admin','manager','cashier')`, [req.auth.tid]);
  if (count.rows[0].n >= limit) {
    return res.status(402).json({ error: `Limite de ${limit} membre(s) d'équipe atteinte sur ton plan. Passe au plan supérieur.` });
  }
  const hash = await bcrypt.hash(password || Math.random().toString(36), 12);
  try {
    const u = await db.query(
      `INSERT INTO users (tenant_id, email, password_hash, full_name, role, location_id)
       VALUES ($1, lower($2), $3, $4, $5, $6) RETURNING id, email, role, full_name`,
      [req.auth.tid, email, hash, full_name || email, role, location_id || null]);
    res.json(u.rows[0]);
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'Cet email a déjà un compte' });
    throw e;
  }
});

// GET /api/auth/me
router.get('/me', required, async (req, res) => {
  const { rows } = await db.query(
    `SELECT u.email, u.full_name, u.role, t.plan, t.plan_limits, t.subscription_status, b.id AS business_id, b.name AS business_name
     FROM users u JOIN tenants t ON t.id = u.tenant_id
     LEFT JOIN businesses b ON b.tenant_id = t.id
     WHERE u.id = $1`, [req.auth.uid]);
  res.json(rows[0] || {});
});

module.exports = router;
