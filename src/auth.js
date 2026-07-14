const jwt = require('jsonwebtoken');

const SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
if (process.env.NODE_ENV === 'production' && !process.env.JWT_SECRET) {
  console.warn('WARNING: JWT_SECRET is not set in production. Using insecure fallback.');
}

function sign(user) {
  return jwt.sign(
    { uid: user.id, tid: user.tenant_id, role: user.role, loc: user.location_id || null },
    SECRET,
    { expiresIn: '12h' }
  );
}

// Middleware : requiert un JWT valide. req.auth = {uid, tid, role, loc}
function required(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Authentification requise' });
  try {
    req.auth = jwt.verify(token, SECRET);
    next();
  } catch {
    return res.status(401).json({ error: 'Session expirée, reconnecte-toi' });
  }
}

// Middleware : restreint aux rôles listés
function roles(...allowed) {
  return (req, res, next) => {
    if (!req.auth || !allowed.includes(req.auth.role)) {
      return res.status(403).json({ error: 'Accès refusé pour ce rôle' });
    }
    next();
  };
}

// ---- Protection brute force (simple, en mémoire ; Redis en prod multi-instances) ----
const attempts = new Map();
function bruteForceGuard(req, res, next) {
  const key = (req.body.email || '') + '|' + req.ip;
  const rec = attempts.get(key) || { n: 0, until: 0 };
  if (Date.now() < rec.until) {
    return res.status(429).json({ error: 'Trop de tentatives, réessaie dans 15 minutes' });
  }
  req.loginFail = () => {
    rec.n += 1;
    if (rec.n >= 5) { rec.until = Date.now() + 15 * 60 * 1000; rec.n = 0; }
    attempts.set(key, rec);
  };
  req.loginOk = () => attempts.delete(key);
  next();
}

const db = require('./db');

async function checkPlanLimit(tenantId, resource, table, column = 'tenant_id') {
  const t = await db.query('SELECT plan_limits FROM tenants WHERE id = $1', [tenantId]);
  const limits = t.rows[0]?.plan_limits || {};
  const max = limits[resource];
  if (max === undefined || max === null) return; // no limit
  const count = await db.query(`SELECT count(*)::int AS n FROM ${table} WHERE ${column} = $1`, [tenantId]);
  if (count.rows[0].n >= max) {
    throw new Error(`Limite atteinte pour votre plan (${resource}: ${max} max)`);
  }
}

module.exports = { sign, required, roles, bruteForceGuard, checkPlanLimit };
