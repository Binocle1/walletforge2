/**
 * Envoi des campagnes de notification.
 *
 * Ce qui est RÉELLEMENT traçable sur un wallet (soyons honnêtes) :
 *   • envoyé    → l'APNs / Google a accepté le push
 *   • délivré   → le téléphone a re-téléchargé le pass (web service Apple) = preuve d'arrivée
 *   • cliqué    → le client a tapé le lien tracké /n/:token présent au dos de la carte
 *   • converti  → une transaction a eu lieu sur cette carte dans les 72 h
 *   • désinscrit→ le client a coupé le marketing depuis le lien de la carte
 *
 * Il n'existe PAS de "taux d'ouverture" façon email sur Apple/Google Wallet :
 * personne ne peut le mesurer, ni nous ni la concurrence. « Délivré » est
 * l'équivalent le plus proche et il est fiable.
 */
const db = require('../db');
const loyalty = require('./loyalty');
const segments = require('./segments');

const CONCURRENCY = 8; // on pousse par paquets pour ne pas saturer APNs

/** Envoie une campagne (async, non bloquant pour la requête HTTP). */
async function sendCampaign(campaignId) {
  const { rows: cRows } = await db.query('SELECT * FROM notification_campaigns WHERE id = $1', [campaignId]);
  const camp = cRows[0];
  if (!camp) throw new Error('Campagne introuvable');
  if (!['draft', 'scheduled'].includes(camp.status)) throw new Error(`Campagne déjà ${camp.status}`);

  await db.query(`UPDATE notification_campaigns SET status = 'sending' WHERE id = $1`, [campaignId]);

  try {
    const q = segments.audienceQuery(camp.segment, camp.tenant_id, camp.program_id);
    const { rows: audience } = await db.query(q.text, q.values);

    let sent = 0, failed = 0;
    for (let i = 0; i < audience.length; i += CONCURRENCY) {
      const batch = audience.slice(i, i + CONCURRENCY);
      await Promise.all(batch.map(async (row) => {
        try {
          const ctx = await loyalty.loadPassContext(row.pass_id);
          if (!ctx) return;
          const r = await loyalty.notifyAndRefresh(
            ctx, camp.message,
            camp.kind === 'automation' ? 'automation' : 'marketing',
            camp.automation_key || null,
            { campaignId: camp.id, ctaUrl: camp.cta_url || null }
          );
          if (r.status === 'failed') failed++; else sent++;
        } catch (e) {
          failed++;
          console.error('[campaign]', row.pass_id, e.message);
        }
      }));
    }

    await db.query(
      `UPDATE notification_campaigns SET status = 'sent', sent_at = now(), audience_count = $2 WHERE id = $1`,
      [campaignId, audience.length]);
    return { sent, failed, audience: audience.length };
  } catch (e) {
    await db.query(`UPDATE notification_campaigns SET status = 'failed' WHERE id = $1`, [campaignId]);
    throw e;
  }
}

/** Le client a cliqué sur le lien de la carte → on trace puis on redirige. */
async function trackClick(token, { ip, userAgent } = {}) {
  const { rows } = await db.query(
    `UPDATE notifications
     SET clicked_at = coalesce(clicked_at, now())
     WHERE click_token = $1
     RETURNING id, tenant_id, pass_id, cta_url`, [token]);
  if (!rows[0]) return null;
  await db.query(
    `INSERT INTO notification_events (notification_id, tenant_id, type, ip, user_agent)
     VALUES ($1,$2,'click',$3,$4)`,
    [rows[0].id, rows[0].tenant_id, ip || null, (userAgent || '').slice(0, 300)]).catch(() => {});
  return rows[0];
}

/** Traite les campagnes programmées arrivées à échéance (appelé par le cron). */
async function runScheduled() {
  const { rows } = await db.query(
    `SELECT id FROM notification_campaigns
     WHERE status = 'scheduled' AND scheduled_at <= now() LIMIT 20`);
  for (const c of rows) {
    await sendCampaign(c.id).catch((e) => console.error('[cron-campaign]', c.id, e.message));
  }
  return rows.length;
}

module.exports = { sendCampaign, trackClick, runScheduled };
