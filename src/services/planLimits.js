const db = require('../db');

/**
 * Check if a tenant has reached the limit for a given resource.
 * Throws an error if the limit is reached.
 * @param {string} tenantId - The tenant UUID
 * @param {string} resource - The resource key in plan_limits (e.g. 'programs', 'managers')
 * @param {string} table - The table to count rows from
 * @param {string} column - The column to filter by tenant_id (default: 'tenant_id')
 */
async function checkPlanLimit(tenantId, resource, table, column = 'tenant_id') {
  const t = await db.query('SELECT plan_limits FROM tenants WHERE id = $1', [tenantId]);
  const limits = t.rows[0]?.plan_limits || {};
  const max = limits[resource];
  if (max === undefined || max === null) return; // no limit
  const count = await db.query(`SELECT count(*)::int AS n FROM ${table} WHERE ${column} = $1`, [tenantId]);
  if (count.rows[0].n >= max) throw new Error(`Limite atteinte pour votre plan (${resource}: ${max} max)`);
}

module.exports = { checkPlanLimit };
