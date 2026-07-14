const db = require('./db');
const loyalty = require('./services/loyalty');
const messaging = require('./services/messaging');

async function runTasks() {
  try {
    // 0. Campagnes programmées arrivées à échéance
    await messaging.runScheduled().catch((e) => console.error('[cron-campaigns]', e.message));

    const { rows: programs } = await db.query(`SELECT id, tenant_id, automations FROM loyalty_programs WHERE active = true`);
    
    for (const prog of programs) {
      const auto = prog.automations || {};
      
      // -- A. Anniversaire (envoyé une seule fois par an) --
      if (auto.birthday?.active && auto.birthday?.msg) {
        const msg = auto.birthday.msg;
        const currentYear = new Date().getFullYear();
        const bdayId = `birthday_${currentYear}`;
        const bdayQuery = `
          SELECT p.id
          FROM customer_passes p
          JOIN customers c ON c.id = p.customer_id
          WHERE p.program_id = $1 
            AND c.marketing_consent = true AND c.anonymized = false
            AND c.birthday IS NOT NULL 
            AND to_char(c.birthday::date, 'MM-DD') = to_char(now(), 'MM-DD')
            AND NOT EXISTS (
              SELECT 1 FROM notifications n 
              WHERE n.pass_id = p.id AND n.automation_id = $2
            )
        `;
        const passes = await db.query(bdayQuery, [prog.id, bdayId]);
        for (const row of passes.rows) {
          const ctx = await loyalty.loadPassContext(row.id);
          if (ctx) await loyalty.notifyAndRefresh(ctx, msg, 'automation', bdayId).catch(e => console.error(e));
        }
      }
      
      // -- B. Winback (Inactif depuis > 30 jours, spam relance limité via id mois-année) --
      if (auto.winback?.active && auto.winback?.msg) {
        const msg = auto.winback.msg;
        const currentMonthId = `winback_${new Date().getFullYear()}_${new Date().getMonth()}`;
        const winbackQuery = `
          SELECT p.id
          FROM customer_passes p
          JOIN customers c ON c.id = p.customer_id
          WHERE p.program_id = $1
            AND c.marketing_consent = true AND c.anonymized = false
            AND (SELECT max(created_at) FROM transactions t WHERE t.customer_id = c.id) < now() - interval '30 days'
            AND NOT EXISTS (
              SELECT 1 FROM notifications n 
              WHERE n.pass_id = p.id AND n.automation_id = $2
            )
        `;
        const passes = await db.query(winbackQuery, [prog.id, currentMonthId]);
        for (const row of passes.rows) {
          const ctx = await loyalty.loadPassContext(row.id);
          if (ctx) await loyalty.notifyAndRefresh(ctx, msg, 'automation', currentMonthId).catch(e => console.error(e));
        }
      }

      // -- C. Avis Google (1h après 1er achat) --
      if (auto.review?.active && auto.review?.msg) {
        const msg = auto.review.msg;
        const reviewId = 'review_1h';
        const reviewQuery = `
          SELECT p.id
          FROM customer_passes p
          JOIN customers c ON c.id = p.customer_id
          WHERE p.program_id = $1
            AND c.marketing_consent = true AND c.anonymized = false
            AND (SELECT min(created_at) FROM transactions t WHERE t.customer_id = c.id AND t.type = 'purchase') <= now() - interval '1 hour'
            AND NOT EXISTS (
              SELECT 1 FROM notifications n 
              WHERE n.pass_id = p.id AND n.automation_id = $2
            )
        `;
        const passes = await db.query(reviewQuery, [prog.id, reviewId]);
        for (const row of passes.rows) {
          const ctx = await loyalty.loadPassContext(row.id);
          if (ctx) await loyalty.notifyAndRefresh(ctx, msg, 'automation', reviewId).catch(e => console.error(e));
        }
      }
    }
  } catch (e) {
    console.error('[cron] Erreur:', e);
  }
}

// Lancer toutes les 5 minutes
setInterval(runTasks, 5 * 60 * 1000);

// Lancer au démarrage (après un petit délai)
setTimeout(runTasks, 10000);

console.log('[cron] Worker démarré');
