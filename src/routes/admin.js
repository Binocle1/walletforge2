const router = require('express').Router();
const db = require('../db');
const { required, roles } = require('../auth');

// GET /api/admin/tenants — Liste de tous les commerces
router.get('/tenants', required, roles('superadmin'), async (req, res) => {
  const { rows } = await db.query(`
    SELECT t.id AS tenant_id, t.name AS tenant_name, t.created_at,
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

// GET /api/admin/users — Liste des utilisateurs
router.get('/users', required, roles('superadmin'), async (req, res) => {
  const { rows } = await db.query(`
    SELECT u.id, u.email, u.full_name, u.role, u.created_at, t.name AS tenant_name
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
