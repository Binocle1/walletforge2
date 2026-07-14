const router = require('express').Router();
const db = require('../db');
const loyalty = require('../services/loyalty');
const apple = require('../services/appleWallet');
const google = require('../services/googleWallet');

// ---------- PUBLIC : infos du pass (pour landing "Renvoyer ma carte") ----------
router.get('/pass-info/:serial', async (req, res) => {
  const { rows } = await db.query(
    `SELECT p.id as pass_id, b.name as business_name, c.first_name 
     FROM customer_passes p 
     JOIN loyalty_programs pr ON pr.id = p.program_id 
     JOIN businesses b ON b.id = pr.business_id 
     JOIN customers c ON c.id = p.customer_id
     WHERE p.serial_number = $1`, [req.params.serial]);
  if (!rows[0]) return res.status(404).json({ error: 'Carte introuvable' });
  res.json(rows[0]);
});

// ---------- PUBLIC : téléchargement du .pkpass ----------
router.get('/apple/:passId.pkpass', async (req, res) => {
  const ctx = await loyalty.loadPassContext(req.params.passId);
  if (!ctx) return res.status(404).json({ error: 'Carte introuvable' });
  if (!apple.isConfigured()) {
    return res.status(503).json({ error: 'Apple Wallet non configuré sur ce serveur' });
  }
  try {
    const buf = await apple.generatePkpass(ctx);
    await db.query(
      `UPDATE customer_passes SET wallet_status = CASE wallet_status WHEN 'google' THEN 'both' ELSE 'apple' END
       WHERE id = $1`, [ctx.pass.id]);
    res.set({ 'Content-Type': 'application/vnd.apple.pkpass', 'Content-Disposition': 'attachment; filename=carte.pkpass' });
    res.send(buf);
  } catch (e) {
    console.error('[pkpass]', e);
    res.status(500).json({ error: 'Erreur de génération du pass' });
  }
});

// ---------- PUBLIC : lien Add to Google Wallet ----------
router.get('/google/:passId', async (req, res) => {
  const ctx = await loyalty.loadPassContext(req.params.passId);
  if (!ctx) return res.status(404).json({ error: 'Carte introuvable' });
  try {
    let url;
    url = await google.saveLink(ctx);
    await db.query(
      `UPDATE customer_passes SET wallet_status = CASE wallet_status WHEN 'apple' THEN 'both' ELSE 'google' END
       WHERE id = $1`, [ctx.pass.id]);
    res.json({ url });
  } catch (e) {
    console.error('[gwallet]', e);
    res.status(500).json({ error: 'Erreur Google Wallet: ' + (e.message || 'Inconnue') });
  }
});

// ============================================================
// Web service Apple Wallet (spec officielle PassKit Web Service)
// Base : /api/apple/v1/...   — auth par ApplePass <authToken>
// ============================================================
async function passByAuth(req, res) {
  const h = req.headers.authorization || '';
  if (!h.startsWith('ApplePass ')) { res.status(401).end(); return null; }
  const { rows } = await db.query(
    'SELECT * FROM customer_passes WHERE serial_number = $1 AND auth_token = $2',
    [req.params.serial, h.slice(10)]);
  if (!rows[0]) { res.status(401).end(); return null; }
  return rows[0];
}

// Enregistrement d'un device (l'iPhone appelle ça après l'ajout du pass)
router.post('/v1/devices/:deviceId/registrations/:passTypeId/:serial', async (req, res) => {
  const pass = await passByAuth(req, res);
  if (!pass) return;
  const { rows } = await db.query(
    `INSERT INTO apple_registrations (pass_id, device_library_id, push_token)
     VALUES ($1,$2,$3) ON CONFLICT (pass_id, device_library_id) DO UPDATE SET push_token = $3
     RETURNING (xmax = 0) AS inserted`,
    [pass.id, req.params.deviceId, req.body.pushToken]);
  res.status(rows[0].inserted ? 201 : 200).end();
});

// Désenregistrement (pass supprimé du téléphone)
router.delete('/v1/devices/:deviceId/registrations/:passTypeId/:serial', async (req, res) => {
  const pass = await passByAuth(req, res);
  if (!pass) return;
  await db.query('DELETE FROM apple_registrations WHERE pass_id = $1 AND device_library_id = $2',
    [pass.id, req.params.deviceId]);
  res.status(200).end();
});

// Liste des serials mis à jour pour un device (appelé après un push APNs)
router.get('/v1/devices/:deviceId/registrations/:passTypeId', async (req, res) => {
  const since = req.query.passesUpdatedSince ? new Date(Number(req.query.passesUpdatedSince)) : new Date(0);
  const { rows } = await db.query(
    `SELECT p.serial_number, p.last_updated FROM customer_passes p
     JOIN apple_registrations r ON r.pass_id = p.id
     WHERE r.device_library_id = $1 AND p.last_updated > $2`,
    [req.params.deviceId, since]);
  if (!rows.length) return res.status(204).end();
  res.json({
    serialNumbers: rows.map((r) => r.serial_number),
    lastUpdated: String(Math.max(...rows.map((r) => new Date(r.last_updated).getTime()))),
  });
});

// Le device re-télécharge la dernière version du pass
router.get('/v1/passes/:passTypeId/:serial', async (req, res) => {
  const pass = await passByAuth(req, res);
  if (!pass) return;
  const ctx = await loyalty.loadPassContext(pass.id);
  try {
    const buf = await apple.generatePkpass(ctx);
    // Le téléphone vient de retélécharger le pass : c'est la preuve que la notif
    // est bien arrivée sur l'appareil -> on marque les notifs en attente comme "délivrées".
    loyalty.markDelivered(pass.id).catch(() => {});
    res.set('Content-Type', 'application/vnd.apple.pkpass').send(buf);
  } catch {
    res.status(503).end();
  }
});

// Logs d'erreurs remontés par les devices
router.post('/v1/log', async (req, res) => {
  console.warn('[apple-device-log]', req.body.logs);
  await db.query(`INSERT INTO audit_logs (action, details) VALUES ('apple_device_log', $1)`,
    [JSON.stringify(req.body)]).catch(() => {});
  res.status(200).end();
});

module.exports = router;
