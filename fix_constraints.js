require('dotenv').config();
const db = require('./src/db');
(async () => {
  try {
    // Supprimer l'ancienne contrainte globale si elle existe
    await db.query('ALTER TABLE users DROP CONSTRAINT IF EXISTS users_username_key');
    console.log('Dropped old users_username_key');
    
    // Ajouter la nouvelle contrainte combinée tenant_id + username
    await db.query('ALTER TABLE users ADD CONSTRAINT users_tenant_id_username_key UNIQUE (tenant_id, username)');
    console.log('Added new users_tenant_id_username_key');
    
    // Rendre `email` nullable (si besoin, bien que la table ait users_email_not_null)
    // Wait, the test above showed users_email_not_null exists! 
    // BUT in auth.js we set email to `sub_123_test@...` so it's not null anyway.
  } catch (e) {
    console.error('Error:', e);
  } finally {
    process.exit(0);
  }
})();
