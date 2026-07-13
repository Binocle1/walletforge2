const router = require('express').Router();
const db = require('../db');
const { required, roles } = require('../auth');
const loyalty = require('../services/loyalty');

// ---------- PUBLIC : infos programme pour la landing ----------
router.get('/public/program/:programId', async (req, res) => {
  const { rows } = await db.query(
    `SELECT p.id, p.name, p.type, p.stamps_required, p.reward_label, p.points_per_unit,
            p.points_for_reward, p.card_design,
            b.name AS business_name, b.logo_url, b.brand_color, b.text_color
     FROM loyalty_programs p JOIN businesses b ON b.id = p.business_id
     WHERE p.id = $1 AND p.active`, [req.params.programId]);
  if (!rows[0]) return res.status(404).json({ error: 'Programme introuvable ou désactivé' });
  res.json(rows[0]);
});

// ---------- PUBLIC : inscription client depuis la landing ----------
router.post('/public/signup/:programId', async (req, res) => {
  const { first_name, last_name, email, phone, birthday, marketing_consent, source, source_ref } = req.body;
  if (!first_name || !email) return res.status(400).json({ error: 'Prénom et email requis' });
  if (marketing_consent !== true && marketing_consent !== false) {
    return res.status(400).json({ error: 'Le consentement marketing doit être explicitement accepté ou refusé' });
  }
  const p = await db.query('SELECT tenant_id, automations FROM loyalty_programs WHERE id = $1 AND active', [req.params.programId]);
  if (!p.rows[0]) return res.status(404).json({ error: 'Programme introuvable' });
  const tid = p.rows[0].tenant_id;
  const automations = p.rows[0].automations || {};

  const consentEntry = JSON.stringify([{ marketing: !!marketing_consent, at: new Date().toISOString(), via: 'landing' }]);
  const { rows } = await db.query(
    `INSERT INTO customers (tenant_id, first_name, last_name, email, phone, birthday, source, source_ref,
                            marketing_consent, consent_history)
     VALUES ($1,$2,$3,lower($4),$5,$6,$7,$8,$9,$10::jsonb)
     ON CONFLICT (tenant_id, email) DO UPDATE
       SET first_name = EXCLUDED.first_name,
           marketing_consent = EXCLUDED.marketing_consent,
           consent_history = customers.consent_history || EXCLUDED.consent_history
     RETURNING *`,
    [tid, first_name, last_name || null, email, phone || null, birthday || null,
     source || 'qr', source_ref || null, !!marketing_consent, consentEntry]);

  const pass = await loyalty.createPass(tid, rows[0].id, req.params.programId);
  
  if (automations.welcome?.active && automations.welcome?.msg) {
    const msg = automations.welcome.msg;
    await db.query('UPDATE customer_passes SET announcement = $1 WHERE id = $2', [msg, pass.id]);
    await db.query(`INSERT INTO notifications (tenant_id, customer_id, pass_id, type, message, status) VALUES ($1,$2,$3,'automation',$4,'simulated')`, [tid, rows[0].id, pass.id, msg]);
  }
  
  res.json({ customer_id: rows[0].id, pass_id: pass.id, serial: pass.serial_number });
});

// ---------- CRM (dashboard) ----------
router.get('/', required, async (req, res) => {
  const { q, tag } = req.query;
  const vals = [req.auth.tid];
  let where = 'c.tenant_id = $1 AND NOT c.anonymized';
  if (q) { vals.push(`%${q}%`); where += ` AND (c.first_name ILIKE $${vals.length} OR c.last_name ILIKE $${vals.length} OR c.email ILIKE $${vals.length} OR c.phone ILIKE $${vals.length})`; }
  if (tag) { vals.push(tag); where += ` AND $${vals.length} = ANY(c.tags)`; }
  const { rows } = await db.query(
    `SELECT c.id, c.first_name, c.last_name, c.email, c.phone, c.birthday, c.source, c.tags,
            c.marketing_consent, c.created_at,
            coalesce(json_agg(json_build_object('pass_id', p.id, 'program', pr.name, 'type', pr.type,
              'stamps', p.stamps, 'points', p.points, 'rewards', p.rewards_available,
              'wallet', p.wallet_status, 'serial', p.serial_number))
              FILTER (WHERE p.id IS NOT NULL), '[]') AS passes,
            (SELECT count(*)::int FROM transactions t WHERE t.customer_id = c.id AND t.type = 'purchase') AS visits,
            (SELECT coalesce(sum(stamps_delta),0)::int FROM transactions t WHERE t.customer_id = c.id) AS stamps_total,
            (SELECT coalesce(sum(t.amount),0) FROM transactions t WHERE t.customer_id = c.id AND t.type = 'purchase') AS total_spent,
            (SELECT max(t.created_at) FROM transactions t WHERE t.customer_id = c.id) AS last_visit
     FROM customers c
     LEFT JOIN customer_passes p ON p.customer_id = c.id
     LEFT JOIN loyalty_programs pr ON pr.id = p.program_id
     WHERE ${where}
     GROUP BY c.id ORDER BY c.created_at DESC LIMIT 500`, vals);
  res.json(rows);
});

// GET /api/customers/:id/export — export RGPD (toutes les données du client)
router.get('/:id/export', required, roles('owner', 'admin'), async (req, res) => {
  const c = await db.query('SELECT * FROM customers WHERE id = $1 AND tenant_id = $2', [req.params.id, req.auth.tid]);
  if (!c.rows[0]) return res.status(404).json({ error: 'Client introuvable' });
  const [passes, tx, notifs] = await Promise.all([
    db.query('SELECT * FROM customer_passes WHERE customer_id = $1', [req.params.id]),
    db.query('SELECT * FROM transactions WHERE customer_id = $1 ORDER BY created_at', [req.params.id]),
    db.query('SELECT * FROM notifications WHERE customer_id = $1 ORDER BY created_at', [req.params.id]),
  ]);
  res.set('Content-Disposition', `attachment; filename=export-client-${req.params.id}.json`);
  res.json({ customer: c.rows[0], passes: passes.rows, transactions: tx.rows, notifications: notifs.rows });
});

// GET /api/customers/:id — détail du client pour la fiche client
router.get('/:id', required, async (req, res) => {
  const { rows } = await db.query(
    `SELECT c.id, c.first_name, c.last_name, c.email, c.phone, c.birthday, c.source, c.tags,
            c.marketing_consent, c.created_at,
            coalesce(json_agg(json_build_object('pass_id', p.id, 'program', pr.name, 'type', pr.type,
              'stamps', p.stamps, 'points', p.points, 'rewards', p.rewards_available,
              'wallet', p.wallet_status, 'serial', p.serial_number))
              FILTER (WHERE p.id IS NOT NULL), '[]') AS passes,
            (SELECT count(*)::int FROM transactions t WHERE t.customer_id = c.id AND t.type = 'purchase') AS visits,
            (SELECT coalesce(sum(stamps_delta),0)::int FROM transactions t WHERE t.customer_id = c.id) AS stamps_total,
            (SELECT coalesce(sum(t.amount),0) FROM transactions t WHERE t.customer_id = c.id AND t.type = 'purchase') AS total_spent,
            (SELECT max(t.created_at) FROM transactions t WHERE t.customer_id = c.id) AS last_visit
     FROM customers c
     LEFT JOIN customer_passes p ON p.customer_id = c.id
     LEFT JOIN loyalty_programs pr ON pr.id = p.program_id
     WHERE c.id = $1 AND c.tenant_id = $2
     GROUP BY c.id`, [req.params.id, req.auth.tid]);
  if (!rows[0]) return res.status(404).json({ error: 'Client introuvable' });
  res.json(rows[0]);
});

// POST /api/customers/notify_all — envoie un message push à tous
router.post('/notify_all', required, roles('owner', 'admin'), async (req, res) => {
  const { message, target } = req.body;
  if (!message) return res.status(400).json({ error: 'Message requis' });
  
  let query = 'UPDATE customer_passes SET announcement = $1, last_updated = now() WHERE tenant_id = $2';
  
  if (target === 'recent_7') {
    query += ` AND EXISTS (SELECT 1 FROM transactions t WHERE t.customer_id = customer_passes.customer_id AND t.created_at >= now() - interval '7 days')`;
  } else if (target === 'recent_30') {
    query += ` AND EXISTS (SELECT 1 FROM transactions t WHERE t.customer_id = customer_passes.customer_id AND t.created_at >= now() - interval '30 days')`;
  } else if (target === 'inactive_30') {
    query += ` AND EXISTS (SELECT 1 FROM transactions t WHERE t.customer_id = customer_passes.customer_id AND t.created_at < now() - interval '30 days')
               AND NOT EXISTS (SELECT 1 FROM transactions t WHERE t.customer_id = customer_passes.customer_id AND t.created_at >= now() - interval '30 days')`;
  } else if (target === 'inactive_60') {
    query += ` AND EXISTS (SELECT 1 FROM transactions t WHERE t.customer_id = customer_passes.customer_id AND t.created_at < now() - interval '60 days')
               AND NOT EXISTS (SELECT 1 FROM transactions t WHERE t.customer_id = customer_passes.customer_id AND t.created_at >= now() - interval '60 days')`;
  } else if (target === 'zero_visits') {
    query += ` AND NOT EXISTS (SELECT 1 FROM transactions t WHERE t.customer_id = customer_passes.customer_id AND t.type = 'purchase')`;
  }
  
  query += ' RETURNING id, customer_id';
  
  const passes = await db.query(query, [message, req.auth.tid]);
  for (const pass of passes.rows) {
     await db.query(`INSERT INTO notifications (tenant_id, customer_id, pass_id, type, message, status) VALUES ($1,$2,$3,'marketing',$4,'simulated')`, [req.auth.tid, pass.customer_id, pass.id, message]);
  }
  res.json({ success: true, totalSent: passes.rows.length, simulated: true });
});

// POST /api/customers/:id/notify — envoie un message push au client
router.post('/:id/notify', required, roles('owner', 'admin', 'manager'), async (req, res) => {
  const { message } = req.body;
  if (!message) return res.status(400).json({ error: 'Message requis' });
  
  const passes = await db.query('UPDATE customer_passes SET announcement = $1, last_updated = now() WHERE customer_id = $2 AND tenant_id = $3 RETURNING id', [message, req.params.id, req.auth.tid]);
  for (const pass of passes.rows) {
     await db.query(`INSERT INTO notifications (tenant_id, customer_id, pass_id, type, message, status) VALUES ($1,$2,$3,'marketing',$4,'simulated')`, [req.auth.tid, req.params.id, pass.id, message]);
  }
  res.json({ success: true, passesUpdated: passes.rows.length, simulated: true });
});

// DELETE /api/customers/:id — anonymisation RGPD (conserve les stats agrégées)
router.delete('/:id', required, roles('owner', 'admin'), async (req, res) => {
  const { rows } = await db.query(
    `UPDATE customers SET first_name = 'Anonyme', last_name = NULL, email = NULL, phone = NULL,
            birthday = NULL, tags = '{}', marketing_consent = false, anonymized = true
     WHERE id = $1 AND tenant_id = $2 RETURNING id`, [req.params.id, req.auth.tid]);
  if (!rows[0]) return res.status(404).json({ error: 'Client introuvable' });
  await db.query(`INSERT INTO audit_logs (tenant_id, user_id, action, details)
                  VALUES ($1,$2,'customer_anonymized',$3)`,
    [req.auth.tid, req.auth.uid, JSON.stringify({ customer_id: req.params.id })]);
  res.json({ ok: true, anonymized: rows[0].id });
});

// PATCH /api/customers/:id — édition + tags
router.patch('/:id', required, roles('owner', 'admin', 'manager'), async (req, res) => {
  const allowed = ['first_name', 'last_name', 'phone', 'birthday', 'tags'];
  const sets = [], vals = [req.params.id, req.auth.tid];
  for (const k of allowed) if (k in req.body) { vals.push(req.body[k]); sets.push(`${k} = $${vals.length}`); }
  if (!sets.length) return res.status(400).json({ error: 'Rien à modifier' });
  const { rows } = await db.query(
    `UPDATE customers SET ${sets.join(', ')} WHERE id = $1 AND tenant_id = $2 RETURNING *`, vals);
  if (!rows[0]) return res.status(404).json({ error: 'Client introuvable' });
  res.json(rows[0]);
});

module.exports = router;
