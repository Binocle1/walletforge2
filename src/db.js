const { Pool } = require('pg');
require('dotenv').config();

const connectionString = process.env.DATABASE_URL;
const isNeonOrProd = connectionString && (connectionString.includes('neon.tech') || process.env.NODE_ENV === 'production');

const pool = new Pool({ 
  connectionString,
  ssl: isNeonOrProd ? { rejectUnauthorized: false } : false
});

module.exports = {
  query: (text, params) => pool.query(text, params),
  pool,
};
