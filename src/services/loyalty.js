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
            pr.automations AS pr_automations,
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
               points_for_reward: r.points_for_reward, card_design: r.card_design, barcode_type: r.barcode_type,
               automations: r.pr_automations || {} },
    business: { id: r.b_id, name: r.b_name, brand_color: r.brand_color, text_color: r.text_color,
                logo_url: r.logo_url, back_links: r.back_links, currency: r.currency, country: r.country },
    locations: locs.rows,
    tenantId: r.tenant_id,
  };
}

async function createPass(tenantId, customerId, programId, source = null) {
  const serial = crypto.randomUUID();
  const authToken = crypto.randomBytes(24).toString('hex');
  const { rows } = await db.query(
    `INSERT INTO customer_passes (tenant_id, customer_id, program_id, serial_number, auth_token, source)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (customer_id, program_id) DO UPDATE SET last_updated = now()
     RETURNING *`,
    [tenantId, customerId, programId, serial, authToken, source]);
  return rows[0];
}

/**
 * Applique une transaction et gère les règles de fidélité :
 * - stamps : incrémente, débloque la récompense au palier, remet le compteur à zéro
 * - points : crédite selon le ratio, convertit en récompense si demandé
 * Retourne { pass, message } — message = notification transactionnelle.
 *
 * The entire read + write is done inside a single BEGIN / FOR UPDATE block
 * to prevent race conditions and TOCTOU on anti-fraud checks.
 */
async function applyTransaction({ passId, type, amount, userId, locationId, comment, source = 'scanner', client_tx_id }) {
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');

    // ── Load pass context inside the transaction with FOR UPDATE ──
    const { rows: ctxRows } = await client.query(
      `SELECT p.*, c.first_name, c.last_name, c.email AS customer_email,
              pr.id AS pr_id, pr.name AS pr_name, pr.type AS pr_type, pr.stamps_required,
              pr.reward_label, pr.points_per_unit, pr.points_for_reward, pr.card_design, pr.barcode_type,
              pr.automations AS pr_automations,
              b.id AS b_id, b.name AS b_name, b.brand_color, b.text_color, b.logo_url, b.back_links,
              b.currency, b.country, b.tenant_id AS b_tenant,
              tn.is_frozen
       FROM customer_passes p
       JOIN customers c ON c.id = p.customer_id
       JOIN loyalty_programs pr ON pr.id = p.program_id
       JOIN businesses b ON b.id = pr.business_id
       JOIN tenants tn ON tn.id = p.tenant_id
       WHERE p.id = $1
       FOR UPDATE OF p`, [passId]);
    if (!ctxRows[0]) throw new Error('Carte introuvable');
    const r = ctxRows[0];
    if (r.is_frozen) {
      await client.query('ROLLBACK');
      throw new Error('Action impossible : Ce commerce est temporairement suspendu.');
    }
    const locs = await client.query('SELECT latitude, longitude, relevant_text FROM locations WHERE business_id = $1 AND latitude IS NOT NULL', [r.b_id]);
    const ctx = {
      pass: r,
      customer: { id: r.customer_id, first_name: r.first_name, last_name: r.last_name, email: r.customer_email },
      program: { id: r.pr_id, name: r.pr_name, type: r.pr_type, stamps_required: r.stamps_required,
                 reward_label: r.reward_label, points_per_unit: r.points_per_unit,
                 points_for_reward: r.points_for_reward, card_design: r.card_design, barcode_type: r.barcode_type,
                 automations: r.pr_automations || {} },
      business: { id: r.b_id, name: r.b_name, brand_color: r.brand_color, text_color: r.text_color,
                  logo_url: r.logo_url, back_links: r.back_links, currency: r.currency, country: r.country },
      locations: locs.rows,
      tenantId: r.tenant_id,
    };
    const { pass, program } = ctx;

    // ── Anti-fraud check INSIDE the transaction (TOCTOU-safe) ──
    if (['purchase', 'add_stamp', 'add_points'].includes(type)) {
      const fraudLimit = (program.automations && program.automations.fraud_limit) || 5;
      const recent = await client.query(
        `SELECT count(*)::int AS n FROM transactions
         WHERE pass_id = $1 AND type IN ('purchase','add_stamp','add_points')
           AND created_at > now() - interval '1 hour'`,
        [passId]
      );
      if (recent.rows[0].n >= fraudLimit) {
        // Log alert
        await client.query(`INSERT INTO alerts (tenant_id, pass_id, type, description) VALUES ($1,$2,$3,$4)`,
          [ctx.tenantId, passId, 'fraud_limit_exceeded', `Limite horaire dépassée (${recent.rows[0].n} scans)`]);
        await client.query('ROLLBACK');
        throw new Error(`Sécurité : Activité anormale détectée, action bloquée et gérant notifié.`);
      }
    }

    // ── Gamification, Happy Hour & Multipliers ──
    let multiplier = 1;
    let hh = program.automations?.happy_hour;
    if (hh && hh.active) {
      const currentHour = new Date().getHours();
      if (currentHour >= hh.start && currentHour < hh.end) {
        multiplier = hh.multiplier || 2;
      }
    }

    // VIP Multiplier (based on tags)
    if (pass.tags && pass.tags.includes('VIP Or')) multiplier = Math.max(multiplier, 2);
    else if (pass.tags && pass.tags.includes('VIP Argent')) multiplier = Math.max(multiplier, 1.5);

    // ── Business logic ──
    let stampsDelta = 0, pointsDelta = 0, rewardsDelta = 0;
    let streakDelta = 0;
    let message = '';

    switch (type) {
      case 'purchase': {
        if (program.type === 'giftcard') {
          const spend = Number(amount || 0);
          if (spend <= 0) throw new Error('Montant invalide');
          if (Number(pass.points) < spend) throw new Error(`Solde insuffisant (${Number(pass.points).toFixed(2)} € disponibles)`);
          pointsDelta = -spend;
          message = `${spend.toFixed(2)} € débités. Nouveau solde : ${(Number(pass.points) - spend).toFixed(2)} €`;
        } else if (program.type === 'stamps') {
          stampsDelta = 1 * multiplier;
          const newStamps = pass.stamps + stampsDelta;
          if (newStamps >= program.stamps_required) {
            rewardsDelta = Math.floor(newStamps / program.stamps_required);
            stampsDelta = (newStamps % program.stamps_required) - pass.stamps; // keep remainder
            message = `🎉 ${rewardsDelta > 1 ? rewardsDelta + ' récompenses débloquées' : 'Récompense débloquée'} !`;
          } else {
            const left = program.stamps_required - newStamps;
            message = `Merci ! Plus que ${left} tampon${left > 1 ? 's' : ''} avant votre récompense.`;
          }
        } else {
          const pts = Math.round(Number(amount || 0) * Number(program.points_per_unit || 1) * multiplier * 100) / 100;
          pointsDelta = pts;
          message = `Vous avez gagné ${pts} points. Merci !`;
        }
        break;
      }
      case 'add_stamp': stampsDelta = 1 * multiplier; message = `${stampsDelta} tampon(s) ajouté(s).`; break;
      case 'remove_stamp': {
        if (pass.stamps <= 0) throw new Error('Aucun tampon à retirer');
        stampsDelta = -1;
        message = 'Correction : un tampon retiré.';
        break;
      }
      case 'add_points': pointsDelta = Number(amount || 0) * multiplier; message = `${pointsDelta} points ajoutés.`; break;
      case 'remove_points': {
        const toRemove = Number(amount || 0);
        if (toRemove > Number(pass.points)) throw new Error('Points insuffisants pour le débit');
        pointsDelta = -toRemove;
        message = 'Points débités.';
        break;
      }
      case 'reward_redeemed': {
        if (program.type === 'points') {
          const cost = amount ? Number(amount) : program.points_for_reward;
          if (Number(pass.points) < cost) throw new Error('Points insuffisants');
          pointsDelta = -cost;
        } else {
          // Si on précise un montant (pour les multi-paliers, ex: -5 tampons)
          if (amount && Number(amount) > 0) {
            const cost = Number(amount);
            // On permet de consommer des tampons bruts au lieu des récompenses stockées, ou on déduit des récompenses si on a des restes
            if (pass.stamps + (pass.rewards_available * program.stamps_required) < cost) {
              throw new Error('Tampons insuffisants');
            }
            // Retirer des tampons
            stampsDelta = -cost;
          } else {
            // Mode classique (legacy)
            if (pass.rewards_available < 1) throw new Error('Aucune récompense disponible');
            rewardsDelta = -1;
          }
        }
        message = `Récompense utilisée. À bientôt !`;
        break;
      }
      case 'adjustment': stampsDelta = 0; pointsDelta = Number(amount || 0); message = 'Ajustement effectué sur votre carte.'; break;
      default: throw new Error(`Type de transaction inconnu : ${type}`);
    }

    // ── Gamification: Streak calculation ──
    let isStreakBonus = false;
    if (['purchase', 'add_stamp', 'add_points'].includes(type)) {
      const now = new Date();
      if (!pass.last_visit) {
        streakDelta = 1 - pass.current_streak; // set to 1
      } else {
        const daysDiff = (now - new Date(pass.last_visit)) / (1000 * 60 * 60 * 24);
        if (daysDiff > 0.5 && daysDiff <= 7) {
          streakDelta = 1; // +1 if returning within a week
        } else if (daysDiff > 7) {
          streakDelta = 1 - pass.current_streak; // reset to 1
        }
      }
      if ((pass.current_streak + streakDelta) % 3 === 0 && (pass.current_streak + streakDelta) > 0) {
        // Streak bonus every 3 weeks!
        isStreakBonus = true;
        if (program.type === 'stamps') stampsDelta += 1;
        else pointsDelta += 100;
        message = `🔥 Gamification: Bonus Streak (x${(pass.current_streak + streakDelta)/3}) ! ` + message;
      }
    }

    // ── Validate no negative balances ──
    let newStamps = pass.stamps + stampsDelta;
    let newPoints = Number(pass.points) + pointsDelta;
    let newRewards = pass.rewards_available + rewardsDelta;
    
    // Normalize stamps if negative (consume available rewards)
    if (program.type === 'stamps' && newStamps < 0) {
      while (newStamps < 0 && newRewards > 0) {
        newRewards--;
        newStamps += program.stamps_required;
        stampsDelta += program.stamps_required;
        rewardsDelta--;
      }
    }

    if (newStamps < 0) throw new Error('Le solde de tampons ne peut pas devenir négatif');
    if (newPoints < 0) throw new Error('Le solde de points ne peut pas devenir négatif');
    if (newRewards < 0) throw new Error('Le solde de récompenses ne peut pas devenir négatif');

    // ── Write transaction + update balance atomically ──
    const txRes = await client.query(
      `INSERT INTO transactions (tenant_id, pass_id, customer_id, program_id, location_id, user_id,
                                 type, amount, points_delta, stamps_delta, comment, source, client_tx_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
      [ctx.tenantId, passId, pass.customer_id, program.id, locationId || null, userId || null,
       type, amount || null, pointsDelta, stampsDelta, comment || null, source, client_tx_id || null]);
    const txId = txRes.rows[0].id;
    ctx.txId = txId;

    // ── Calculate VIP Tiers based on 90 days spend ──
    // Just a basic heuristic: if points sum > threshold, upgrade tag
    let tags = pass.tags || [];
    if (['purchase', 'add_points', 'add_stamp'].includes(type)) {
       const spendRes = await client.query(`SELECT sum(amount)::numeric as tot FROM transactions WHERE pass_id = $1 AND created_at > now() - interval '90 days'`, [passId]);
       const spend = Number(spendRes.rows[0].tot || 0) + Number(amount || 0);
       tags = tags.filter(t => !t.startsWith('VIP'));
       if (spend >= 500) tags.push('VIP Or');
       else if (spend >= 200) tags.push('VIP Argent');
       else if (spend >= 100) tags.push('VIP Bronze');
    }

    const { rows } = await client.query(
      `UPDATE customer_passes
       SET stamps = $2,
           points = $3,
           rewards_available = $4,
           last_updated = now(),
           current_streak = current_streak + $5,
           last_visit = CASE WHEN $6::boolean THEN now() ELSE last_visit END,
           tags = $7
       WHERE id = $1 RETURNING *`,
      [passId, newStamps, newPoints, newRewards, streakDelta, ['purchase','add_stamp','add_points'].includes(type), tags]);
    await client.query('COMMIT');
    ctx.pass = { ...ctx.pass, ...rows[0] };

    // ── Referral V2 Bonus ──
    // Si c'est le 1er achat du filleul, on crédite le parrain !
    if (['purchase', 'add_stamp', 'add_points'].includes(type)) {
       const txCountRes = await db.query(`SELECT count(*)::int as n FROM transactions WHERE pass_id = $1 AND type IN ('purchase','add_stamp','add_points')`, [passId]);
       if (txCountRes.rows[0].n === 1 && pass.source) {
           // It's the first real purchase. Find the referrer
           const ref = await db.query(`SELECT id, customer_id FROM customer_passes WHERE serial_number = $1 AND tenant_id = $2`, [pass.source, ctx.tenantId]);
           if (ref.rows[0] && ref.rows[0].customer_id !== pass.customer_id) {
              // Anti-farming: max 10 referrals per month
              const countRef = await db.query(`SELECT count(*)::int as n FROM transactions WHERE pass_id = $1 AND type IN ('add_stamp', 'add_points') AND source = 'referral' AND created_at > date_trunc('month', now())`, [ref.rows[0].id]);
              if (countRef.rows[0].n < 10) {
                 const pType = program.type;
                 const tType = pType === 'stamps' ? 'add_stamp' : 'add_points';
                 const amt = pType === 'points' ? (program.points_per_unit || 1) : 0;
                 await applyTransaction({ passId: ref.rows[0].id, type: tType, amount: amt, source: 'referral', comment: 'Bonus parrainage (1er achat du filleul)' });
              }
           }
       }
    }

    // Notification + rafraîchissement des wallets (best-effort, non bloquant, OUTSIDE the transaction)
    notifyAndRefresh(ctx, message, 'transactional').catch((e) => console.error('[wallet-update]', e.message));

    return { pass: ctx.pass, message, tx_id: ctx.txId };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

async function notifyAndRefresh(ctx, message, type = 'transactional', automationId = null) {
  // Met à jour le message affiché sur la carte avec une expiration de 24h
  await db.query(`UPDATE customer_passes SET announcement = $1, announcement_expires_at = now() + interval '24 hours', last_updated = now() WHERE id = $2`, [message, ctx.pass.id]);

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
    `INSERT INTO notifications (tenant_id, customer_id, pass_id, type, message, status, automation_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [ctx.tenantId, ctx.pass.customer_id, ctx.pass.id, type, message, status, automationId]);
}

module.exports = { loadPassContext, createPass, applyTransaction, notifyAndRefresh };
