/**
 * Cœur métier : création des cartes, application des transactions,
 * mise à jour des Wallets (Apple push + Google patch) et notifications.
 */
const crypto = require('crypto');
const db = require('../db');
const apple = require('./appleWallet');
const google = require('./googleWallet');

async function loadPassContext(passId) {
  const { rows } = await db.query(
    `SELECT p.*, c.first_name, c.last_name, c.email AS customer_email,
            pr.id AS pr_id, pr.name AS pr_name, pr.type AS pr_type, pr.stamps_required,
            pr.reward_label, pr.points_per_unit, pr.points_for_reward, pr.card_design, pr.barcode_type,
            b.id AS b_id, b.name AS b_name, b.brand_color, b.text_color, b.logo_url, b.back_links,
            b.currency, b.country, b.tenant_id AS b_tenant
     FROM customer_passes p
     JOIN customers c ON c.id = p.customer_id
     JOIN loyalty_programs pr ON pr.id = p.program_id
     JOIN businesses b ON b.id = pr.business_id
     WHERE p.id = $1`, [passId]);
  if (!rows[0]) return null;
  const r = rows[0];
  const locs = await db.query('SELECT latitude, longitude, relevant_text FROM locations WHERE business_id = $1 AND latitude IS NOT NULL', [r.b_id]);
  return {
    pass: r,
    customer: { id: r.customer_id, first_name: r.first_name, last_name: r.last_name, email: r.customer_email },
    program: { id: r.pr_id, name: r.pr_name, type: r.pr_type, stamps_required: r.stamps_required,
               reward_label: r.reward_label, points_per_unit: r.points_per_unit,
               points_for_reward: r.points_for_reward, card_design: r.card_design, barcode_type: r.barcode_type },
    business: { id: r.b_id, name: r.b_name, brand_color: r.brand_color, text_color: r.text_color,
                logo_url: r.logo_url, back_links: r.back_links, currency: r.currency, country: r.country },
    locations: locs.rows,
    tenantId: r.tenant_id,
  };
}

async function createPass(tenantId, customerId, programId) {
  const serial = crypto.randomUUID();
  const authToken = crypto.randomBytes(24).toString('hex');
  const { rows } = await db.query(
    `INSERT INTO customer_passes (tenant_id, customer_id, program_id, serial_number, auth_token)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (customer_id, program_id) DO UPDATE SET last_updated = now()
     RETURNING *`,
    [tenantId, customerId, programId, serial, authToken]);
  return rows[0];
}

/**
 * Applique une transaction et gère les règles de fidélité :
 * - stamps : incrémente, débloque la récompense au palier, remet le compteur à zéro
 * - points : crédite selon le ratio, convertit en récompense si demandé
 * Retourne { pass, message } — message = notification transactionnelle.
 */
async function applyTransaction({ passId, type, amount, userId, locationId, comment, source = 'scanner' }) {
  const ctx = await loadPassContext(passId);
  if (!ctx) throw new Error('Carte introuvable');
  const { pass, program } = ctx;

  let stampsDelta = 0, pointsDelta = 0, rewardsDelta = 0;
  let message = '';

  switch (type) {
    case 'purchase': {
      if (program.type === 'stamps') {
        stampsDelta = 1;
        const newStamps = pass.stamps + 1;
        if (newStamps >= program.stamps_required) {
          rewardsDelta = 1;
          stampsDelta = -pass.stamps; // reset compteur
          message = `🎉 Récompense débloquée : ${program.reward_label || 'récompense'} !`;
        } else {
          const left = program.stamps_required - newStamps;
          message = `Merci ! Plus que ${left} tampon${left > 1 ? 's' : ''} avant votre récompense.`;
        }
      } else {
        const pts = Math.round(Number(amount || 0) * Number(program.points_per_unit || 1) * 100) / 100;
        pointsDelta = pts;
        message = `Vous avez gagné ${pts} points. Merci pour votre achat !`;
      }
      break;
    }
    case 'add_stamp': stampsDelta = 1; message = 'Un tampon ajouté sur votre carte.'; break;
    case 'remove_stamp': stampsDelta = pass.stamps > 0 ? -1 : 0; message = 'Correction : un tampon retiré.'; break;
    case 'add_points': pointsDelta = Number(amount || 0); message = `${pointsDelta} points ajoutés.`; break;
    case 'remove_points': pointsDelta = -Math.min(Number(amount || 0), Number(pass.points)); message = 'Points débités.'; break;
    case 'reward_redeemed': {
      if (program.type === 'points') {
        if (Number(pass.points) < program.points_for_reward) throw new Error('Points insuffisants');
        pointsDelta = -program.points_for_reward;
      } else {
        if (pass.rewards_available < 1) throw new Error('Aucune récompense disponible');
        rewardsDelta = -1;
      }
      message = `Récompense utilisée : ${program.reward_label || 'récompense'}. À bientôt !`;
      break;
    }
    case 'adjustment': stampsDelta = 0; pointsDelta = Number(amount || 0); message = 'Ajustement effectué sur votre carte.'; break;
    default: throw new Error(`Type de transaction inconnu : ${type}`);
  }

  // Écriture atomique transaction + solde
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO transactions (tenant_id, pass_id, customer_id, program_id, location_id, user_id,
                                 type, amount, points_delta, stamps_delta, comment, source)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [ctx.tenantId, passId, pass.customer_id, program.id, locationId || null, userId || null,
       type, amount || null, pointsDelta, stampsDelta, comment || null, source]);
    const { rows } = await client.query(
      `UPDATE customer_passes
       SET stamps = greatest(0, stamps + $2),
           points = greatest(0, points + $3),
           rewards_available = greatest(0, rewards_available + $4),
           last_updated = now()
       WHERE id = $1 RETURNING *`,
      [passId, stampsDelta, pointsDelta, rewardsDelta]);
    await client.query('COMMIT');
    ctx.pass = { ...ctx.pass, ...rows[0] };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }

  // Notification + rafraîchissement des wallets (best-effort, non bloquant)
  notifyAndRefresh(ctx, message).catch((e) => console.error('[wallet-update]', e.message));

  return { pass: ctx.pass, message };
}

async function notifyAndRefresh(ctx, message) {
  let status = 'simulated';

  // Apple : push APNs vide -> l'iPhone re-télécharge le pass (la maj s'affiche sur l'écran verrouillé si champ "changeMessage")
  if (apple.isConfigured()) {
    const { rows } = await db.query(
      'SELECT push_token FROM apple_registrations WHERE pass_id = $1', [ctx.pass.id]);
    if (rows.length) {
      const r = await apple.pushUpdate(rows.map((x) => x.push_token));
      if (!r.simulated && r.sent > 0) status = 'sent';
    }
  }
  // Google : PATCH de l'objet + message sur la carte
  if (google.isConfigured() && ['google', 'both'].includes(ctx.pass.wallet_status)) {
    const r = await google.updateObject(ctx, message);
    if (r.updated) status = 'sent';
  }

  await db.query(
    `INSERT INTO notifications (tenant_id, customer_id, pass_id, type, message, status)
     VALUES ($1,$2,$3,'transactional',$4,$5)`,
    [ctx.tenantId, ctx.pass.customer_id, ctx.pass.id, message, status]);
}

module.exports = { loadPassContext, createPass, applyTransaction };
