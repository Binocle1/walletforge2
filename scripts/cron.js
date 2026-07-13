require('dotenv').config();
const db = require('../src/db');

async function runCron() {
  console.log('--- Lancement du Cron d\'automatisations ---');
  
  try {
    // 1. Récupérer tous les programmes actifs avec des automatisations configurées
    const { rows: programs } = await db.query(`SELECT id, tenant_id, automations FROM loyalty_programs WHERE active = true`);
    
    for (const prog of programs) {
      const auto = prog.automations || {};
      
      // -- A. Anniversaire --
      if (auto.birthday?.active && auto.birthday?.msg) {
        const msg = auto.birthday.msg;
        // Trouver les clients du programme dont c'est l'anniversaire aujourd'hui
        // Note: l'anniversaire est stocké sous forme YYYY-MM-DD. On compare le jour et le mois.
        const bdayQuery = `
          SELECT p.id AS pass_id, c.id AS customer_id
          FROM customer_passes p
          JOIN customers c ON c.id = p.customer_id
          WHERE p.program_id = $1 
            AND c.birthday IS NOT NULL 
            AND to_char(c.birthday::date, 'MM-DD') = to_char(now(), 'MM-DD')
        `;
        const bdayPasses = await db.query(bdayQuery, [prog.id]);
        
        for (const pass of bdayPasses.rows) {
          // On évite d'envoyer 2 fois le même jour. Dans une vraie prod, on stockerait la date du dernier envoi.
          await db.query('UPDATE customer_passes SET announcement = $1, last_updated = now() WHERE id = $2', [msg, pass.pass_id]);
          await db.query(`INSERT INTO notifications (tenant_id, customer_id, pass_id, type, message, status) VALUES ($1,$2,$3,'automation',$4,'simulated')`, [prog.tenant_id, pass.customer_id, pass.pass_id, msg]);
        }
        if (bdayPasses.rows.length > 0) {
          console.log(`[Anniversaire] Envoyé à ${bdayPasses.rows.length} client(s) pour le programme ${prog.id}`);
        }
      }
      
      // -- B. Winback (Inactif depuis 30 jours) --
      if (auto.winback?.active && auto.winback?.msg) {
        const msg = auto.winback.msg;
        // Clients dont la DERNIERE transaction date d'exactement 30 jours
        // "Exactement" pour ne pas spammer tous les jours après 30j.
        const winbackQuery = `
          SELECT p.id AS pass_id, c.id AS customer_id
          FROM customer_passes p
          JOIN customers c ON c.id = p.customer_id
          WHERE p.program_id = $1
            AND (
              SELECT max(created_at) FROM transactions t WHERE t.customer_id = c.id
            ) >= now() - interval '31 days'
            AND (
              SELECT max(created_at) FROM transactions t WHERE t.customer_id = c.id
            ) < now() - interval '30 days'
        `;
        const winbackPasses = await db.query(winbackQuery, [prog.id]);
        
        for (const pass of winbackPasses.rows) {
          await db.query('UPDATE customer_passes SET announcement = $1, last_updated = now() WHERE id = $2', [msg, pass.pass_id]);
          await db.query(`INSERT INTO notifications (tenant_id, customer_id, pass_id, type, message, status) VALUES ($1,$2,$3,'automation',$4,'simulated')`, [prog.tenant_id, pass.customer_id, pass.pass_id, msg]);
        }
        if (winbackPasses.rows.length > 0) {
          console.log(`[Winback] Envoyé à ${winbackPasses.rows.length} client(s) pour le programme ${prog.id}`);
        }
      }
    }
    
    console.log('--- Fin du Cron ---');
    process.exit(0);
  } catch (err) {
    console.error('Erreur lors du Cron', err);
    process.exit(1);
  }
}

runCron();
