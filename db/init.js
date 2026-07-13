const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
require('dotenv').config();

if (!process.env.DATABASE_URL) {
  console.error("Erreur : DATABASE_URL n'est pas définie dans le fichier .env");
  process.exit(1);
}

// Configuration du pool PG avec SSL requis pour Neon
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

async function main() {
  console.log("Connexion à la base de données et application du schéma SQL...");
  const schemaPath = path.join(__dirname, 'schema.sql');
  
  if (!fs.existsSync(schemaPath)) {
    console.error(`Erreur : Le fichier de schéma est introuvable à l'emplacement : ${schemaPath}`);
    process.exit(1);
  }

  const sql = fs.readFileSync(schemaPath, 'utf8');

  try {
    // Exécution du script SQL global
    await pool.query(sql);
    console.log("Base de données initialisée avec succès ! Toutes les tables ont été créées.");
  } catch (error) {
    console.error("Erreur lors de l'application du schéma SQL :", error);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main();
