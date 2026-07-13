const db = require('./db');

async function runTasks() {
  try {
    const { rows: programs } = await db.query(`SELECT id, tenant_id, automations FROM loyalty_programs WHERE active = true`);
    
    for (const prog of programs) {
      const auto = prog.automations || {};
      
      // -- A. Anniversaire (envoyé une seule fois par jour) --
      if (auto.birthday?.active && auto.birthday?.msg) {
        const msg = auto.birthday.msg;
        const bdayQuery = `
          SELECT p.id AS pass_id, c.id AS customer_id
          FROM customer_passes p
          JOIN customers c ON c.id = p.customer_id
          WHERE p.program_id = $1 
            AND c.birthday IS NOT NULL 
            AND to_char(c.birthday::date, 'MM-DD') = to_char(now(), 'MM-DD')
            AND NOT EXISTS (
              SELECT 1 FROM notifications n 
              WHERE n.pass_id = p.id AND n.message = $2 AND n.created_at >= now() - interval '24 hours'
            )
        `;
        const bdayPasses = await db.query(bdayQuery, [prog.id, msg]);
        for (const pass of bdayPasses.rows) {
          await db.query('UPDATE customer_passes SET announcement = $1, last_updated = now() WHERE id = $2', [msg, pass.pass_id]);
          await db.query(`INSERT INTO notifications (tenant_id, customer_id, pass_id, type, message, status) VALUES ($1,$2,$3,'automation',$4,'simulated')`, [prog.tenant_id, pass.customer_id, pass.pass_id, msg]);
        }
      }
      
      // -- B. Winback (Inactif depuis > 30 jours) --
      if (auto.winback?.active && auto.winback?.msg) {
        const msg = auto.winback.msg;
        const winbackQuery = `
          SELECT p.id AS pass_id, c.id AS customer_id
          FROM customer_passes p
          JOIN customers c ON c.id = p.customer_id
          WHERE p.program_id = $1
            AND (SELECT max(created_at) FROM transactions t WHERE t.customer_id = c.id) < now() - interval '30 days'
            AND NOT EXISTS (
              SELECT 1 FROM notifications n 
              WHERE n.pass_id = p.id AND n.message = $2 AND n.created_at >= now() - interval '30 days'
            )
        `;
        const winbackPasses = await db.query(winbackQuery, [prog.id, msg]);
        for (const pass of winbackPasses.rows) {
          await db.query('UPDATE customer_passes SET announcement = $1, last_updated = now() WHERE id = $2', [msg, pass.pass_id]);
          await db.query(`INSERT INTO notifications (tenant_id, customer_id, pass_id, type, message, status) VALUES ($1,$2,$3,'automation',$4,'simulated')`, [prog.tenant_id, pass.customer_id, pass.pass_id, msg]);
        }
      }

      // -- C. Avis Google (1h après 1er achat) --
      if (auto.review?.active && auto.review?.msg) {
        const msg = auto.review.msg;
        // Clients dont le premier achat date d'entre 1h et 1h30 (pour être sûr de ne pas le rater et pas le renvoyer)
        // et qui n'ont pas encore reçu ce message
        const reviewQuery = `
          SELECT p.id AS pass_id, c.id AS customer_id
          FROM customer_passes p
          JOIN customers c ON c.id = p.customer_id
          WHERE p.program_id = $1
            AND (SELECT count(*) FROM transactions t WHERE t.customer_id = c.id AND t.type = 'purchase') = 1
            AND (SELECT min(created_at) FROM transactions t WHERE t.customer_id = c.id AND t.type = 'purchase') <= now() - interval '1 hour'
            AND NOT EXISTS (
              SELECT 1 FROM notifications n 
              WHERE n.pass_id = p.id AND n.message = $2
            )
        `;
        const reviewPasses = await db.query(reviewQuery, [prog.id, msg]);
        for (const pass of reviewPasses.rows) {
          await db.query('UPDATE customer_passes SET announcement = $1, last_updated = now() WHERE id = $2', [msg, pass.pass_id]);
          await db.query(`INSERT INTO notifications (tenant_id, customer_id, pass_id, type, message, status) VALUES ($1,$2,$3,'automation',$4,'simulated')`, [prog.tenant_id, pass.customer_id, pass.pass_id, msg]);
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
