require('dotenv').config();
const db = require('../src/db');

async function migrate() {
  console.log('Migrating loyalty_programs to tiers...');
  try {
    // Add column if it doesn't exist
    await db.query(`ALTER TABLE loyalty_programs ADD COLUMN IF NOT EXISTS tiers JSONB NOT NULL DEFAULT '[]'`);

    const { rows } = await db.query(`SELECT id, type, stamps_required, points_for_reward, reward_label, tiers FROM loyalty_programs`);
    let updated = 0;

    for (const p of rows) {
      if (p.tiers && p.tiers.length > 0) continue; // Already migrated
      
      const tiers = [];
      if (p.type === 'stamps' && p.stamps_required) {
        tiers.push({ threshold: p.stamps_required, name: p.reward_label || 'Récompense' });
      } else if (p.type === 'points' && p.points_for_reward) {
        tiers.push({ threshold: p.points_for_reward, name: p.reward_label || 'Récompense' });
      }

      if (tiers.length > 0) {
        await db.query(`UPDATE loyalty_programs SET tiers = $1 WHERE id = $2`, [JSON.stringify(tiers), p.id]);
        updated++;
      }
    }
    
    console.log(`Migration complete. Updated ${updated} programs.`);
  } catch (e) {
    console.error('Migration failed:', e);
  } finally {
    process.exit(0);
  }
}

migrate();
