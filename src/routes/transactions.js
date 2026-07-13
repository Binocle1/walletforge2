const router = require('express').Router();
const db = require('../db');
const { required, roles } = require('../auth');
const loyalty = require('../services/loyalty');

const CAN_SCAN = ['owner', 'admin', 'manager', 'cashier'];

// GET /api/scan/:serial — le scanner lit un QR et affiche le profil fidélité
router.get('/scan/:serial', required, roles(...CAN_SCAN), async (req, res) => {
  const { rows } = await db.query(
    `SELECT p.id AS pass_id, p.serial_number, p.stamps, p.points, p.rewards_available, p.wallet_status,
            c.id AS customer_id, c.first_name, c.last_name, c.email,
            pr.name AS program_name, pr.type, pr.stamps_required, pr.reward_label,
            pr.points_per_unit, pr.points_for_reward
     FROM customer_passes p
     JOIN customers c ON c.id = p.customer_id
     JOIN loyalty_programs pr ON pr.id = p.program_id
     WHERE p.serial_number = $1 AND p.tenant_id = $2`,
    [req.params.serial, req.auth.tid]);
  if (!rows[0]) return res.status(404).json({ error: 'Carte inconnue pour ce commerce' });
  const recent = await db.query(
    `SELECT type, amount, points_delta, stamps_delta, created_at FROM transactions
     WHERE pass_id = $1 ORDER BY created_at DESC LIMIT 5`, [rows[0].pass_id]);
  res.json({ ...rows[0], recent: recent.rows });
});

// GET /api/customers/search?q= — recherche manuelle depuis le scanner
router.get('/scan-search', required, roles(...CAN_SCAN), async (req, res) => {
  const q = `%${req.query.q || ''}%`;
  const { rows } = await db.query(
    `SELECT p.serial_number, c.first_name, c.last_name, c.email, pr.name AS program_name
     FROM customer_passes p JOIN customers c ON c.id = p.customer_id
     JOIN loyalty_programs pr ON pr.id = p.program_id
     WHERE p.tenant_id = $1 AND NOT c.anonymized
       AND (c.first_name ILIKE $2 OR c.last_name ILIKE $2 OR c.email ILIKE $2 OR c.phone ILIKE $2)
     LIMIT 10`, [req.auth.tid, q]);
  res.json(rows);
});

// POST /api/transactions — appliquer une action (achat, tampon, points, récompense…)
router.post('/transactions', required, roles(...CAN_SCAN), async (req, res) => {
  const { pass_id, type, amount, comment, location_id } = req.body;
  // Vérif isolation tenant
  const p = await db.query('SELECT id FROM customer_passes WHERE id = $1 AND tenant_id = $2', [pass_id, req.auth.tid]);
  if (!p.rows[0]) return res.status(404).json({ error: 'Carte introuvable' });
  try {
    const result = await loyalty.applyTransaction({
      passId: pass_id, type, amount, comment,
      userId: req.auth.uid,
      locationId: location_id || req.auth.loc || null,
      source: req.body.source || 'scanner',
    });
    res.json({
      ok: true,
      message: result.message,
      pass: {
        stamps: result.pass.stamps, points: result.pass.points,
        rewards_available: result.pass.rewards_available,
      },
    });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// GET /api/transactions — historique (dashboard)
router.get('/transactions', required, async (req, res) => {
  const { rows } = await db.query(
    `SELECT t.*, c.first_name, c.last_name, pr.name AS program_name, u.full_name AS staff_name
     FROM transactions t
     JOIN customers c ON c.id = t.customer_id
     JOIN loyalty_programs pr ON pr.id = t.program_id
     LEFT JOIN users u ON u.id = t.user_id
     WHERE t.tenant_id = $1 ORDER BY t.created_at DESC LIMIT 200`, [req.auth.tid]);
  res.json(rows);
});

// GET /api/stats — dashboard statistiques
router.get('/stats', required, async (req, res) => {
  const [stats, recent, notifs] = await Promise.all([
    db.query('SELECT * FROM v_tenant_stats WHERE tenant_id = $1', [req.auth.tid]),
    db.query(
      `SELECT date_trunc('day', created_at)::date AS day, count(*)::int AS n
       FROM transactions WHERE tenant_id = $1 AND created_at > now() - interval '30 days'
       GROUP BY 1 ORDER BY 1`, [req.auth.tid]),
    db.query(`SELECT count(*)::int AS n FROM notifications WHERE tenant_id = $1`, [req.auth.tid]),
  ]);
  const newCustomers = await db.query(
    `SELECT count(*)::int AS n FROM customers WHERE tenant_id = $1 AND created_at > now() - interval '30 days'`,
    [req.auth.tid]);
  res.json({
    ...(stats.rows[0] || {}),
    new_customers_30d: newCustomers.rows[0].n,
    notifications_sent: notifs.rows[0].n,
    tx_by_day: recent.rows,
  });
});

module.exports = router;
