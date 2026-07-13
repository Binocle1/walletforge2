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

  // Anti-fraude caissier : 2 transactions max par heure par carte
  if (['purchase', 'add_stamp', 'add_points'].includes(type)) {
    const recent = await db.query(
      `SELECT count(*) FROM transactions WHERE pass_id = $1 AND type IN ('purchase','add_stamp','add_points') AND created_at > now() - interval '1 hour'`,
      [pass_id]
    );
    if (parseInt(recent.rows[0].count) >= 2) {
      return res.status(429).json({ error: 'Sécurité : Limite de 2 actions par heure sur la même carte.' });
    }
  }

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
      tx_id: result.tx_id,
      pass: {
        stamps: result.pass.stamps, points: result.pass.points,
        rewards_available: result.pass.rewards_available,
      },
    });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// DELETE /api/transactions/:id — Annuler une transaction (Undo 10s)
router.delete('/transactions/:id', required, roles(...CAN_SCAN), async (req, res) => {
  const tx = await db.query('SELECT * FROM transactions WHERE id = $1 AND tenant_id = $2', [req.params.id, req.auth.tid]);
  if (!tx.rows[0]) return res.status(404).json({ error: 'Introuvable' });
  const t = tx.rows[0];
  
  // 5 minutes max pour undo
  if (Date.now() - new Date(t.created_at).getTime() > 5 * 60000) {
    return res.status(400).json({ error: 'Délai d\'annulation dépassé' });
  }
  
  let rewardsDelta = 0;
  if (t.type === 'reward_redeemed') rewardsDelta = 1;
  // Si c'était un achat qui a déclenché une récompense, on retire la récompense
  if (t.type === 'purchase' && t.stamps_delta < 0) rewardsDelta = -1;

  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM transactions WHERE id = $1', [t.id]);
    await client.query(
      `UPDATE customer_passes 
       SET stamps = greatest(0, stamps - $2), 
           points = greatest(0, points - $3),
           rewards_available = greatest(0, rewards_available + $4)
       WHERE id = $1`, [t.pass_id, t.stamps_delta, t.points_delta, rewardsDelta]);
    await client.query('COMMIT');
    res.json({ success: true });
  } catch(e) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
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

// GET /api/notifications — historique des envois
router.get('/notifications', required, async (req, res) => {
  const { rows } = await db.query(
    `SELECT n.id, n.type, n.message, n.status, n.created_at, c.first_name, c.last_name, p.wallet_status
     FROM notifications n
     JOIN customers c ON c.id = n.customer_id
     JOIN customer_passes p ON p.id = n.pass_id
     WHERE n.tenant_id = $1 ORDER BY n.created_at DESC LIMIT 200`, [req.auth.tid]);
  res.json(rows);
});

// GET /api/stats — dashboard statistiques
router.get('/stats', required, async (req, res) => {
  const [stats, recent, notifs, top_customers, rewards] = await Promise.all([
    db.query('SELECT * FROM v_tenant_stats WHERE tenant_id = $1', [req.auth.tid]),
    db.query(
      `SELECT date_trunc('day', created_at)::date AS day, count(*)::int AS n
       FROM transactions WHERE tenant_id = $1 AND created_at > now() - interval '30 days'
       GROUP BY 1 ORDER BY 1`, [req.auth.tid]),
    db.query(`SELECT count(*)::int AS n FROM notifications WHERE tenant_id = $1`, [req.auth.tid]),
    db.query(
      `SELECT c.first_name, c.last_name, 
              coalesce(sum(t.amount), 0) AS spent, 
              coalesce(sum(t.stamps_delta), 0) AS stamps
       FROM customers c
       JOIN transactions t ON t.customer_id = c.id
       WHERE c.tenant_id = $1 AND t.type IN ('purchase', 'add_stamp')
       GROUP BY c.id
       ORDER BY spent DESC, stamps DESC
       LIMIT 5`, [req.auth.tid]),
    db.query(`SELECT count(*)::int AS n FROM transactions WHERE tenant_id = $1 AND type = 'reward_redeemed'`, [req.auth.tid])
  ]);
  const newCustomers = await db.query(
    `SELECT count(*)::int AS n FROM customers WHERE tenant_id = $1 AND created_at > now() - interval '30 days'`,
    [req.auth.tid]);
  const retention = await db.query(
    `SELECT 
      (SELECT count(*)::float FROM (SELECT customer_id FROM transactions WHERE tenant_id = $1 AND type='purchase' GROUP BY customer_id HAVING count(*) > 1) t) / 
      GREATEST((SELECT count(*)::float FROM customers WHERE tenant_id = $1), 1) * 100 AS return_rate,
      (SELECT avg(amount)::float FROM transactions WHERE tenant_id = $1 AND type='purchase' AND amount > 0) AS avg_basket
    `, [req.auth.tid]);

  const vendor_stats = await db.query(`
    SELECT u.full_name, u.username, 
           count(t.id)::int AS tx_count,
           sum(CASE WHEN t.type = 'purchase' THEN t.amount ELSE 0 END)::float AS total_amount,
           sum(t.stamps_delta)::int AS total_stamps,
           sum(t.points_delta)::float AS total_points
    FROM users u
    LEFT JOIN transactions t ON t.user_id = u.id AND t.created_at > now() - interval '30 days'
    WHERE u.tenant_id = $1
    GROUP BY u.id
    ORDER BY tx_count DESC
  `, [req.auth.tid]);
    
  res.json({
    ...(stats.rows[0] || {}),
    new_customers_30d: newCustomers.rows[0].n,
    notifications_sent: notifs.rows[0].n,
    tx_by_day: recent.rows,
    top_customers: top_customers.rows,
    vendor_stats: vendor_stats.rows,
    rewards_redeemed: rewards.rows[0].n,
    return_rate: Math.round(retention.rows[0].return_rate || 0),
    avg_basket: Math.round((retention.rows[0].avg_basket || 0) * 100) / 100
  });
});

module.exports = router;
