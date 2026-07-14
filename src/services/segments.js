/**
 * Ciblage des campagnes.
 * Une seule source de vérité pour "qui reçoit quoi" — utilisée par
 * l'estimation d'audience (avant envoi), l'envoi réel et le cron.
 *
 * Toutes les requêtes filtrent DÉJÀ sur :
 *   - le tenant (isolation multi-commerce)
 *   - marketing_consent = true (RGPD : pas de push marketing sans opt-in)
 *   - anonymized = false
 */

const SEGMENTS = {
  all:            { label: 'Tous les clients opt-in',            where: 'TRUE' },
  recent_7:       { label: 'Actifs (7 derniers jours)',          where: `EXISTS (SELECT 1 FROM transactions t WHERE t.customer_id = c.id AND t.created_at >= now() - interval '7 days')` },
  recent_30:      { label: 'Actifs (30 derniers jours)',         where: `EXISTS (SELECT 1 FROM transactions t WHERE t.customer_id = c.id AND t.created_at >= now() - interval '30 days')` },
  inactive_30:    { label: 'Endormis (aucune visite 30 j)',      where: `NOT EXISTS (SELECT 1 FROM transactions t WHERE t.customer_id = c.id AND t.created_at >= now() - interval '30 days')
                                                                          AND EXISTS (SELECT 1 FROM transactions t WHERE t.customer_id = c.id)` },
  inactive_60:    { label: 'Perdus (aucune visite 60 j)',        where: `NOT EXISTS (SELECT 1 FROM transactions t WHERE t.customer_id = c.id AND t.created_at >= now() - interval '60 days')
                                                                          AND EXISTS (SELECT 1 FROM transactions t WHERE t.customer_id = c.id)` },
  zero_visits:    { label: 'Inscrits jamais venus',              where: `NOT EXISTS (SELECT 1 FROM transactions t WHERE t.customer_id = c.id AND t.type = 'purchase')` },
  has_reward:     { label: 'Récompense en attente (à consommer)',where: `p.rewards_available > 0` },
  near_reward:    { label: 'À 2 tampons de la récompense',       where: `pr.type = 'stamps' AND pr.stamps_required IS NOT NULL
                                                                          AND p.stamps >= pr.stamps_required - 2 AND p.stamps < pr.stamps_required` },
  vip:            { label: 'VIP (Argent & Or)',                  where: `(p.tags && ARRAY['VIP Argent','VIP Or']::text[])` },
  birthday_month: { label: 'Anniversaire ce mois-ci',            where: `c.birthday IS NOT NULL AND to_char(c.birthday, 'MM') = to_char(now(), 'MM')` },
  wallet_none:    { label: "N'ont pas installé la carte",        where: `p.wallet_status = 'none'` },
};

/**
 * Construit la requête d'audience.
 * @returns {{ text: string, values: any[] }}
 */
function audienceQuery(segment, tenantId, programId = null, select = 'p.id AS pass_id, p.customer_id, p.wallet_status') {
  const seg = SEGMENTS[segment];
  if (!seg) throw new Error(`Segment inconnu : ${segment}`);

  const values = [tenantId];
  let sql = `
    SELECT ${select}
    FROM customer_passes p
    JOIN customers c        ON c.id = p.customer_id
    JOIN loyalty_programs pr ON pr.id = p.program_id
    WHERE p.tenant_id = $1
      AND c.marketing_consent = true
      AND c.anonymized = false
      AND pr.active = true
      AND (${seg.where})`;

  if (programId) {
    values.push(programId);
    sql += ` AND p.program_id = $${values.length}`;
  }
  return { text: sql, values };
}

async function countAudience(db, segment, tenantId, programId = null) {
  const q = audienceQuery(segment, tenantId, programId, 'p.id');
  const { rows } = await db.query(`SELECT count(*)::int AS n FROM (${q.text}) s`, q.values);
  return rows[0].n;
}

const list = () => Object.entries(SEGMENTS).map(([key, v]) => ({ key, label: v.label }));

module.exports = { SEGMENTS, audienceQuery, countAudience, list };
