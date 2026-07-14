const router = require('express').Router();
const db = require('../db');
const { required, roles } = require('../auth');

// GET /api/admin/tenants — Liste de tous les commerces
router.get('/tenants', required, roles('superadmin'), async (req, res) => {
  const { rows } = await db.query(`
    SELECT t.id AS tenant_id, t.name AS tenant_name, t.created_at, t.is_frozen,
           b.id AS business_id, b.name AS business_name, b.country, b.phone, b.website,
           (SELECT count(*) FROM users u WHERE u.tenant_id = t.id) AS users_count,
           (SELECT count(*) FROM customer_passes p WHERE p.tenant_id = t.id) AS passes_count,
           (SELECT count(*) FROM transactions tx WHERE tx.tenant_id = t.id) AS tx_count
    FROM tenants t
    LEFT JOIN businesses b ON b.tenant_id = t.id
    ORDER BY t.created_at DESC
  `);
  res.json(rows);
});

// PATCH /api/admin/tenants/:id/freeze — Geler ou dégeler un magasin
router.patch('/tenants/:id/freeze', required, roles('superadmin'), async (req, res) => {
  const { is_frozen } = req.body;
  const { rows } = await db.query(`UPDATE tenants SET is_frozen = $1 WHERE id = $2 RETURNING id, is_frozen`, [!!is_frozen, req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'Tenant introuvable' });
  res.json({ ok: true, is_frozen: rows[0].is_frozen });
});

// GET /api/admin/tenants/:id/users — Liste des vendeurs/utilisateurs pour un commerce précis
router.get('/tenants/:id/users', required, roles('superadmin'), async (req, res) => {
  const { rows } = await db.query(`
    SELECT u.id, u.email, u.username, u.full_name, u.role, u.created_at, t.name AS tenant_name
    FROM users u
    JOIN tenants t ON t.id = u.tenant_id
    WHERE u.tenant_id = $1
    ORDER BY u.created_at DESC
  `, [req.params.id]);
  res.json(rows);
});

// GET /api/admin/users — Liste globale des utilisateurs
router.get('/users', required, roles('superadmin'), async (req, res) => {
  const { rows } = await db.query(`
    SELECT u.id, u.email, u.username, u.full_name, u.role, u.created_at, t.name AS tenant_name, t.id AS tenant_id
    FROM users u
    JOIN tenants t ON t.id = u.tenant_id
    ORDER BY u.created_at DESC
  `);
  res.json(rows);
});

// PATCH /api/admin/users/:id/role — Modifier le rôle d'un utilisateur
router.patch('/users/:id/role', required, roles('superadmin'), async (req, res) => {
  const { role } = req.body;
  if (!['superadmin', 'owner', 'admin', 'manager', 'cashier'].includes(role)) {
    return res.status(400).json({ error: 'Rôle invalide' });
  }
  await db.query(`UPDATE users SET role = $1 WHERE id = $2`, [role, req.params.id]);
  res.json({ ok: true, message: 'Rôle mis à jour' });
});

module.exports = router;
