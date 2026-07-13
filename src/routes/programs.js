const router = require('express').Router();
const QRCode = require('qrcode');
const db = require('../db');
const { required, roles } = require('../auth');

// GET /api/programs
router.get('/', required, async (req, res) => {
  const { rows } = await db.query(
    `SELECT p.*, (SELECT count(*)::int FROM customer_passes cp WHERE cp.program_id = p.id) AS cards
     FROM loyalty_programs p WHERE p.tenant_id = $1 ORDER BY p.created_at DESC`, [req.auth.tid]);
  res.json(rows);
});

// POST /api/programs — création
router.post('/', required, roles('owner', 'admin'), async (req, res) => {
  const { name, type, stamps_required, reward_label, points_per_unit, points_for_reward, card_design, barcode_type } = req.body;
  if (!name || !['stamps', 'points'].includes(type)) {
    return res.status(400).json({ error: 'Nom et type (stamps ou points) requis' });
  }
  const b = await db.query('SELECT id FROM businesses WHERE tenant_id = $1 LIMIT 1', [req.auth.tid]);
  const { rows } = await db.query(
    `INSERT INTO loyalty_programs (tenant_id, business_id, name, type, stamps_required, reward_label,
                                   points_per_unit, points_for_reward, card_design, barcode_type)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
    [req.auth.tid, b.rows[0].id, name, type,
     type === 'stamps' ? (stamps_required || 10) : null, reward_label || null,
     type === 'points' ? (points_per_unit || 1) : null,
     type === 'points' ? (points_for_reward || 100) : null,
     card_design || {}, barcode_type || 'qr']);
  res.json(rows[0]);
});

// PATCH /api/programs/:id
router.patch('/:id', required, roles('owner', 'admin'), async (req, res) => {
  const allowed = ['name', 'active', 'stamps_required', 'reward_label', 'points_per_unit', 'points_for_reward', 'card_design', 'barcode_type', 'automations'];
  const sets = [], vals = [req.params.id, req.auth.tid];
  for (const k of allowed) if (k in req.body) { vals.push(['card_design', 'automations'].includes(k) ? JSON.stringify(req.body[k]) : req.body[k]); sets.push(`${k} = $${vals.length}`); }
  if (!sets.length) return res.status(400).json({ error: 'Rien à modifier' });
  const { rows } = await db.query(
    `UPDATE loyalty_programs SET ${sets.join(', ')} WHERE id = $1 AND tenant_id = $2 RETURNING *`, vals);
  if (!rows[0]) return res.status(404).json({ error: 'Programme introuvable' });
  res.json(rows[0]);
});

// GET /api/programs/:id/qr — QR d'inscription (PNG) pointant vers la landing
router.get('/:id/qr', required, async (req, res) => {
  const { rows } = await db.query(
    'SELECT id FROM loyalty_programs WHERE id = $1 AND tenant_id = $2', [req.params.id, req.auth.tid]);
  if (!rows[0]) return res.status(404).json({ error: 'Programme introuvable' });
  const url = `${process.env.BASE_URL}/join/${rows[0].id}${req.query.src ? `?src=${encodeURIComponent(req.query.src)}` : ''}`;
  const png = await QRCode.toBuffer(url, { width: 600, margin: 2 });
  res.set('Content-Type', 'image/png').send(png);
});

// GET/PATCH /api/business — profil commerce (couleurs, liens verso, avis Google...)
router.get('/business/profile', required, async (req, res) => {
  const { rows } = await db.query('SELECT * FROM businesses WHERE tenant_id = $1 LIMIT 1', [req.auth.tid]);
  res.json(rows[0] || {});
});
router.patch('/business/profile', required, roles('owner', 'admin'), async (req, res) => {
  const allowed = ['name', 'business_type', 'country', 'currency', 'phone', 'website', 'address',
                   'logo_url', 'brand_color', 'text_color', 'google_review_url', 'social_links', 'back_links'];
  const sets = [], vals = [req.auth.tid];
  for (const k of allowed) if (k in req.body) {
    vals.push(['social_links', 'back_links'].includes(k) ? JSON.stringify(req.body[k]) : req.body[k]);
    sets.push(`${k} = $${vals.length}`);
  }
  if (!sets.length) return res.status(400).json({ error: 'Rien à modifier' });
  const { rows } = await db.query(
    `UPDATE businesses SET ${sets.join(', ')} WHERE tenant_id = $1 RETURNING *`, vals);
  res.json(rows[0]);
});

// GET /api/programs/business/location — infos de géolocalisation pour le geofencing
router.get('/business/location', required, async (req, res) => {
  const { rows } = await db.query('SELECT * FROM locations WHERE tenant_id = $1 LIMIT 1', [req.auth.tid]);
  res.json(rows[0] || {});
});

// PATCH /api/programs/business/location
router.patch('/business/location', required, roles('owner', 'admin'), async (req, res) => {
  const allowed = ['address', 'latitude', 'longitude', 'relevant_text'];
  const sets = [], vals = [req.auth.tid];
  for (const k of allowed) if (k in req.body) { vals.push(req.body[k]); sets.push(`${k} = $${vals.length}`); }
  if (!sets.length) return res.status(400).json({ error: 'Rien à modifier' });
  
  const { rows } = await db.query(
    `UPDATE locations SET ${sets.join(', ')} WHERE tenant_id = $1 RETURNING *`, vals);
  
  // Si aucune ligne n'existe, on la crée
  if (!rows[0]) {
    const b = await db.query('SELECT id FROM businesses WHERE tenant_id = $1 LIMIT 1', [req.auth.tid]);
    if(b.rows[0]) {
       const ins = await db.query(`INSERT INTO locations (tenant_id, business_id, name, address, latitude, longitude, relevant_text) VALUES ($1,$2,'Principal',$3,$4,$5,$6) RETURNING *`, 
       [req.auth.tid, b.rows[0].id, req.body.address, req.body.latitude, req.body.longitude, req.body.relevant_text]);
       return res.json(ins.rows[0]);
    }
  }
  res.json(rows[0] || {});
});

module.exports = router;
