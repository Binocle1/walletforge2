/**
 * HUB NOTIFICATIONS — tout se pilote depuis un seul endroit.
 *   GET    /api/notifications/overview        → KPIs 30 j
 *   GET    /api/notifications/segments        → liste des ciblages + audience estimée
 *   GET    /api/notifications/campaigns       → liste des campagnes + perfs
 *   POST   /api/notifications/campaigns       → créer (brouillon / envoi immédiat / programmé)
 *   GET    /api/notifications/campaigns/:id   → détail + destinataires (qui a cliqué, qui est revenu)
 *   POST   /api/notifications/campaigns/:id/send    → envoyer maintenant
 *   POST   /api/notifications/campaigns/:id/cancel  → annuler une campagne programmée
 *   GET    /api/notifications/log             → journal unifié (tous canaux, filtrable)
 *   GET    /api/notifications/automations     → toutes les automatisations, tous programmes
 *   PATCH  /api/notifications/automations/:programId → les régler
 */
const router = require('express').Router();
const db = require('../db');
const { required, roles } = require('../auth');
const segments = require('../services/segments');
const messaging = require('../services/messaging');

const CAN_EDIT = ['owner', 'admin'];
const MAX_MSG = 240; // au-delà, Apple/Google tronquent l'affichage sur la carte

// ---------------------------------------------------------------- KPIs
router.get('/overview', required, async (req, res) => {
  const { rows } = await db.query(`
    SELECT
      count(*) FILTER (WHERE status IN ('sent','simulated'))                     AS sent,
      count(*) FILTER (WHERE delivered_at IS NOT NULL)                           AS delivered,
      count(*) FILTER (WHERE clicked_at IS NOT NULL)                             AS clicked,
      count(*) FILTER (WHERE converted_at IS NOT NULL)                           AS converted,
      count(*) FILTER (WHERE status = 'failed')                                  AS failed,
      coalesce(sum(revenue) FILTER (WHERE converted_at IS NOT NULL), 0)::float   AS revenue,
      count(*) FILTER (WHERE type = 'marketing')                                 AS marketing,
      count(*) FILTER (WHERE type = 'automation')                                AS automation,
      count(*) FILTER (WHERE type = 'transactional')                             AS transactional
    FROM notifications
    WHERE tenant_id = $1 AND created_at > now() - interval '30 days'`, [req.auth.tid]);

  const unsub = await db.query(`
    SELECT count(*)::int AS n FROM notification_events e
    WHERE e.tenant_id = $1 AND e.type = 'unsubscribe' AND e.created_at > now() - interval '30 days'`,
    [req.auth.tid]);

  const optin = await db.query(`
    SELECT count(*) FILTER (WHERE marketing_consent) ::int AS optin,
           count(*)::int AS total
    FROM customers WHERE tenant_id = $1 AND NOT anonymized`, [req.auth.tid]);

  const byDay = await db.query(`
    SELECT date_trunc('day', created_at)::date AS day,
           count(*)::int AS sent,
           count(*) FILTER (WHERE clicked_at IS NOT NULL)::int AS clicked
    FROM notifications
    WHERE tenant_id = $1 AND created_at > now() - interval '30 days'
    GROUP BY 1 ORDER BY 1`, [req.auth.tid]);

  const r = rows[0];
  const n = (x) => Number(x || 0);
  res.json({
    ...r,
    unsubscribed: unsub.rows[0].n,
    optin: optin.rows[0].optin,
    optin_total: optin.rows[0].total,
    // taux calculés côté serveur : une seule vérité
    delivery_rate: n(r.sent) ? Math.round((n(r.delivered) / n(r.sent)) * 100) : 0,
    click_rate:    n(r.sent) ? Math.round((n(r.clicked) / n(r.sent)) * 100) : 0,
    conv_rate:     n(r.sent) ? Math.round((n(r.converted) / n(r.sent)) * 100) : 0,
    by_day: byDay.rows,
  });
});

// ---------------------------------------------------------------- Segments + audience estimée
router.get('/segments', required, async (req, res) => {
  const programId = req.query.program_id || null;
  const out = [];
  for (const s of segments.list()) {
    const count = await segments.countAudience(db, s.key, req.auth.tid, programId).catch(() => 0);
    out.push({ ...s, count });
  }
  res.json(out);
});

// ---------------------------------------------------------------- Campagnes
router.get('/campaigns', required, async (req, res) => {
  const { rows } = await db.query(`
    SELECT c.*, pr.name AS program_name, u.full_name AS author,
           count(n.id)::int                                        AS sent,
           count(n.id) FILTER (WHERE n.delivered_at IS NOT NULL)::int AS delivered,
           count(n.id) FILTER (WHERE n.clicked_at IS NOT NULL)::int   AS clicked,
           count(n.id) FILTER (WHERE n.converted_at IS NOT NULL)::int AS converted,
           coalesce(sum(n.revenue), 0)::float                      AS revenue
    FROM notification_campaigns c
    LEFT JOIN notifications n ON n.campaign_id = c.id
    LEFT JOIN loyalty_programs pr ON pr.id = c.program_id
    LEFT JOIN users u ON u.id = c.created_by
    WHERE c.tenant_id = $1
    GROUP BY c.id, pr.name, u.full_name
    ORDER BY c.created_at DESC LIMIT 100`, [req.auth.tid]);
  res.json(rows);
});

router.post('/campaigns', required, roles(...CAN_EDIT), async (req, res) => {
  const { name, message, segment = 'all', program_id = null, cta_url = null, when = 'now', scheduled_at = null } = req.body;

  if (!name || !message) return res.status(400).json({ error: 'Nom et message requis' });
  if (message.length > MAX_MSG) return res.status(400).json({ error: `Message trop long (${message.length}/${MAX_MSG} caractères)` });
  if (!segments.SEGMENTS[segment]) return res.status(400).json({ error: 'Segment invalide' });
  if (cta_url && !/^https?:\/\//i.test(cta_url)) return res.status(400).json({ error: 'Le lien doit commencer par http(s)://' });
  if (when === 'schedule' && !scheduled_at) return res.status(400).json({ error: 'Date d\'envoi requise' });

  const audience = await segments.countAudience(db, segment, req.auth.tid, program_id);
  const status = when === 'schedule' ? 'scheduled' : (when === 'draft' ? 'draft' : 'draft');

  const { rows } = await db.query(
    `INSERT INTO notification_campaigns (tenant_id, program_id, name, kind, segment, message, cta_url,
                                         status, scheduled_at, audience_count, created_by)
     VALUES ($1,$2,$3,'manual',$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
    [req.auth.tid, program_id, name, segment, message, cta_url, status,
     when === 'schedule' ? scheduled_at : null, audience, req.auth.uid]);

  const camp = rows[0];

  if (when === 'now') {
    // On répond tout de suite : l'envoi tourne en tâche de fond (une campagne
    // de 5 000 cartes ne doit pas bloquer la requête HTTP).
    messaging.sendCampaign(camp.id).catch((e) => console.error('[campaign]', e.message));
    return res.json({ ...camp, status: 'sending', audience_count: audience });
  }
  res.json(camp);
});

router.get('/campaigns/:id', required, async (req, res) => {
  const c = await db.query('SELECT * FROM notification_campaigns WHERE id = $1 AND tenant_id = $2',
    [req.params.id, req.auth.tid]);
  if (!c.rows[0]) return res.status(404).json({ error: 'Campagne introuvable' });

  const recipients = await db.query(`
    SELECT n.id, n.status, n.delivered_at, n.clicked_at, n.converted_at, n.revenue, n.created_at,
           cu.first_name, cu.last_name, cu.email, p.wallet_status, p.serial_number
    FROM notifications n
    JOIN customers cu ON cu.id = n.customer_id
    JOIN customer_passes p ON p.id = n.pass_id
    WHERE n.campaign_id = $1
    ORDER BY (n.clicked_at IS NOT NULL) DESC, n.created_at DESC
    LIMIT 500`, [req.params.id]);

  res.json({ campaign: c.rows[0], recipients: recipients.rows });
});

router.post('/campaigns/:id/send', required, roles(...CAN_EDIT), async (req, res) => {
  const c = await db.query('SELECT id FROM notification_campaigns WHERE id = $1 AND tenant_id = $2',
    [req.params.id, req.auth.tid]);
  if (!c.rows[0]) return res.status(404).json({ error: 'Campagne introuvable' });
  messaging.sendCampaign(req.params.id).catch((e) => console.error('[campaign]', e.message));
  res.json({ ok: true, status: 'sending' });
});

router.post('/campaigns/:id/cancel', required, roles(...CAN_EDIT), async (req, res) => {
  const { rows } = await db.query(
    `UPDATE notification_campaigns SET status = 'canceled'
     WHERE id = $1 AND tenant_id = $2 AND status IN ('draft','scheduled') RETURNING id`,
    [req.params.id, req.auth.tid]);
  if (!rows[0]) return res.status(400).json({ error: 'Campagne non annulable (déjà envoyée ?)' });
  res.json({ ok: true });
});

// ---------------------------------------------------------------- Journal unifié
router.get('/log', required, async (req, res) => {
  const { type, status, q, page = 0 } = req.query;
  const vals = [req.auth.tid];
  let where = 'n.tenant_id = $1';
  if (type)   { vals.push(type);   where += ` AND n.type = $${vals.length}`; }
  if (status === 'clicked')   where += ' AND n.clicked_at IS NOT NULL';
  if (status === 'delivered') where += ' AND n.delivered_at IS NOT NULL';
  if (status === 'converted') where += ' AND n.converted_at IS NOT NULL';
  if (status === 'failed')    where += " AND n.status = 'failed'";
  if (q) { vals.push(`%${q}%`); where += ` AND (cu.first_name ILIKE $${vals.length} OR cu.last_name ILIKE $${vals.length} OR cu.email ILIKE $${vals.length} OR n.message ILIKE $${vals.length})`; }

  const limit = 100;
  const offset = Math.max(0, Number(page) || 0) * limit;
  vals.push(limit, offset);

  const { rows } = await db.query(`
    SELECT n.id, n.type, n.message, n.status, n.created_at, n.delivered_at, n.clicked_at,
           n.converted_at, n.revenue, n.automation_id,
           cu.first_name, cu.last_name, cu.email,
           p.wallet_status, c.name AS campaign_name
    FROM notifications n
    JOIN customers cu ON cu.id = n.customer_id
    JOIN customer_passes p ON p.id = n.pass_id
    LEFT JOIN notification_campaigns c ON c.id = n.campaign_id
    WHERE ${where}
    ORDER BY n.created_at DESC
    LIMIT $${vals.length - 1} OFFSET $${vals.length}`, vals);
  res.json(rows);
});

// ---------------------------------------------------------------- Automatisations (centralisées)
router.get('/automations', required, async (req, res) => {
  const { rows } = await db.query(
    `SELECT p.id AS program_id, p.name, p.type, p.active, p.automations,
            (SELECT count(*)::int FROM notifications n
              WHERE n.pass_id IN (SELECT id FROM customer_passes cp WHERE cp.program_id = p.id)
                AND n.type = 'automation' AND n.created_at > now() - interval '30 days') AS sent_30d
     FROM loyalty_programs p WHERE p.tenant_id = $1 ORDER BY p.created_at`, [req.auth.tid]);
  res.json(rows);
});

router.patch('/automations/:programId', required, roles(...CAN_EDIT), async (req, res) => {
  const { automations } = req.body;
  if (typeof automations !== 'object' || automations === null) {
    return res.status(400).json({ error: 'Objet automations requis' });
  }
  const { rows } = await db.query(
    `UPDATE loyalty_programs SET automations = $3 WHERE id = $1 AND tenant_id = $2 RETURNING id, automations`,
    [req.params.programId, req.auth.tid, JSON.stringify(automations)]);
  if (!rows[0]) return res.status(404).json({ error: 'Programme introuvable' });
  res.json(rows[0]);
});

module.exports = router;
