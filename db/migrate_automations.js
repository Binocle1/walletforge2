const db = require('../src/db');

async function migrate() {
  console.log('Migration des automatisations...');
  try {
    await db.query(`ALTER TABLE loyalty_programs ADD COLUMN IF NOT EXISTS automations JSONB DEFAULT '{}'::jsonb;`);
    console.log('Migration réussie.');
    process.exit(0);
  } catch (err) {
    console.error('Erreur de migration', err);
    process.exit(1);
  }
}

migrate();
