const router = require('express').Router();
const QRCode = require('qrcode');
const db = require('../db');
const { required, roles } = require('../auth');

function escHtml(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

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
  
  // Check plan limits
  const { checkPlanLimit } = require('../services/planLimits');
  try {
    await checkPlanLimit(req.auth.tid, 'programs', 'loyalty_programs');
  } catch (e) {
    return res.status(403).json({ error: e.message });
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

// (Moved /:id routes down to avoid capturing /business)
// (Moved /:id patch down)
// GET /api/programs/:id/qr — QR d'inscription (PNG) pointant vers la landing
router.get('/:id/qr', required, async (req, res) => {
  const { rows } = await db.query(
    'SELECT id FROM loyalty_programs WHERE id = $1 AND tenant_id = $2', [req.params.id, req.auth.tid]);
  if (!rows[0]) return res.status(404).json({ error: 'Programme introuvable' });
  const url = `${process.env.BASE_URL}/join/${rows[0].id}${req.query.src ? `?src=${encodeURIComponent(req.query.src)}` : ''}`;
  const png = await QRCode.toBuffer(url, { width: 600, margin: 2 });
  res.set('Content-Type', 'image/png').send(png);
});

// GET /api/programs/:id/chevalet — Page HTML (A6) prête à imprimer
router.get('/:id/chevalet', required, async (req, res) => {
  const { rows } = await db.query(
    `SELECT p.name AS p_name, p.card_design, b.name AS b_name, b.logo_url
     FROM loyalty_programs p JOIN businesses b ON p.business_id = b.id
     WHERE p.id = $1 AND p.tenant_id = $2`, [req.params.id, req.auth.tid]);
  if (!rows[0]) return res.status(404).send('Introuvable');
  const p = rows[0];
  const url = `${process.env.BASE_URL}/join/${req.params.id}`;
  const qrBase64 = (await QRCode.toDataURL(url, { margin: 1, width: 400 })).toString();
  const color = (p.card_design || {}).bg_color || '#16453a';
  
  res.send(`<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8"><title>Chevalet - ${escHtml(p.b_name)}</title>
<link href="https://fonts.googleapis.com/css2?family=Sora:wght@600;700&family=Inter:wght@400;600&display=swap" rel="stylesheet">
<style>
  @page { size: A6 portrait; margin: 0; }
  body { font-family: Inter, sans-serif; text-align: center; margin: 0; padding: 0; background: #fff; color: #10231f; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  .chevalet { width: 105mm; height: 148mm; margin: 0 auto; display: flex; flex-direction: column; padding: 12mm 8mm; box-sizing: border-box; position: relative; overflow: hidden; page-break-after: always; }
  .bg { position: absolute; inset: 0; background: ${color}; z-index: -1; }
  .logo { max-width: 60px; max-height: 60px; border-radius: 8px; margin-bottom: 8px; }
  h1 { font-family: Sora; font-size: 20px; color: #fff; margin: 0 0 16px 0; }
  .card { background: #fff; border-radius: 16px; padding: 16px; box-shadow: 0 4px 20px rgba(0,0,0,0.1); margin: auto; }
  .qr { width: 100%; max-width: 220px; border-radius: 8px; margin-bottom: 12px; }
  p { font-size: 15px; font-weight: 600; margin: 0; color: #10231f; }
  .footer { color: rgba(255,255,255,0.8); font-size: 11px; margin-top: auto; }
</style>
</head>
<body onload="window.print()">
  <div class="chevalet">
    <div class="bg"></div>
    ${p.logo_url ? `<img src="${escHtml(p.logo_url)}" class="logo">` : ''}
    <h1>${escHtml(p.p_name)}</h1>
    <div class="card">
      <img src="${qrBase64}" class="qr">
      <p>Scannez pour rejoindre<br>notre programme !</p>
    </div>
    <div class="footer">Ouvrez l'appareil photo de votre téléphone</div>
  </div>
</body>
</html>`);
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

// GET /api/programs/:id — détail d'un programme
router.get('/:id', required, async (req, res) => {
  try {
    const { rows } = await db.query(
      'SELECT * FROM loyalty_programs WHERE id = $1 AND tenant_id = $2', [req.params.id, req.auth.tid]);
    if (!rows[0]) return res.status(404).json({ error: 'Programme introuvable' });
    res.json(rows[0]);
  } catch (e) {
    res.status(400).json({ error: 'ID invalide' });
  }
});

// PATCH /api/programs/:id
router.patch('/:id', required, roles('owner', 'admin'), async (req, res) => {
  const allowed = ['name', 'active', 'stamps_required', 'reward_label', 'points_per_unit', 'points_for_reward', 'card_design', 'barcode_type', 'automations'];
  const sets = [], vals = [req.params.id, req.auth.tid];
  for (const k of allowed) if (k in req.body) { vals.push(['card_design', 'automations'].includes(k) ? JSON.stringify(req.body[k]) : req.body[k]); sets.push(`${k} = $${vals.length}`); }
  if (!sets.length) return res.status(400).json({ error: 'Rien à modifier' });
  try {
    const { rows } = await db.query(
      `UPDATE loyalty_programs SET ${sets.join(', ')} WHERE id = $1 AND tenant_id = $2 RETURNING *`, vals);
    if (!rows[0]) return res.status(404).json({ error: 'Programme introuvable' });
    res.json(rows[0]);
  } catch (e) {
    res.status(400).json({ error: 'ID invalide' });
  }
});

module.exports = router;
