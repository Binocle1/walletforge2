require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL.includes('localhost') ? false : { rejectUnauthorized: false },
});

async function migrate() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    
    // Add relevant_text to locations if it doesn't exist
    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='locations' AND column_name='relevant_text') THEN
          ALTER TABLE locations ADD COLUMN relevant_text TEXT;
        END IF;
      END
      $$;
    `);

    // Add announcement to customer_passes if it doesn't exist
    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='customer_passes' AND column_name='announcement') THEN
          ALTER TABLE customer_passes ADD COLUMN announcement TEXT;
        END IF;
      END
      $$;
    `);

    await client.query('COMMIT');
    console.log('Migration completed successfully.');
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('Migration failed:', e);
  } finally {
    client.release();
    pool.end();
  }
}

migrate();
