const router = require('express').Router();
const db = require('../db');
const { required, roles } = require('../auth');

const stripe = process.env.STRIPE_SECRET_KEY ? require('stripe')(process.env.STRIPE_SECRET_KEY) : null;

const PLANS = {
  start:    { price: () => process.env.STRIPE_PRICE_START,    limits: { programs: 1,  locations: 1,  managers: 0,  api: false } },
  grow:     { price: () => process.env.STRIPE_PRICE_GROW,     limits: { programs: 3,  locations: 3,  managers: 10, api: false } },
  business: { price: () => process.env.STRIPE_PRICE_BUSINESS, limits: { programs: 10, locations: 10, managers: 50, api: true  } },
};

// POST /api/billing/checkout { plan: 'start'|'grow'|'business' }
router.post('/checkout', required, roles('owner'), async (req, res) => {
  if (!stripe) return res.status(503).json({ error: 'Stripe non configuré (STRIPE_SECRET_KEY manquant)' });
  const plan = PLANS[req.body.plan];
  if (!plan) return res.status(400).json({ error: 'Plan inconnu' });

  const t = await db.query('SELECT * FROM tenants WHERE id = $1', [req.auth.tid]);
  let customerId = t.rows[0].stripe_customer_id;
  if (!customerId) {
    const u = await db.query('SELECT email FROM users WHERE id = $1', [req.auth.uid]);
    const c = await stripe.customers.create({ email: u.rows[0].email, metadata: { tenant_id: req.auth.tid } });
    customerId = c.id;
    await db.query('UPDATE tenants SET stripe_customer_id = $2 WHERE id = $1', [req.auth.tid, customerId]);
  }
  const session = await stripe.checkout.sessions.create({
    customer: customerId,
    mode: 'subscription',
    line_items: [{ price: plan.price(), quantity: 1 }],
    subscription_data: { trial_period_days: 14, metadata: { tenant_id: req.auth.tid, plan: req.body.plan } },
    success_url: `${process.env.BASE_URL}/dashboard/?billing=success`,
    cancel_url: `${process.env.BASE_URL}/dashboard/?billing=cancel`,
  });
  res.json({ url: session.url });
});

// POST /api/billing/portal — portail client Stripe (factures, annulation, changement de plan)
router.post('/portal', required, roles('owner'), async (req, res) => {
  if (!stripe) return res.status(503).json({ error: 'Stripe non configuré' });
  const t = await db.query('SELECT stripe_customer_id FROM tenants WHERE id = $1', [req.auth.tid]);
  if (!t.rows[0].stripe_customer_id) return res.status(400).json({ error: 'Aucun abonnement actif' });
  const session = await stripe.billingPortal.sessions.create({
    customer: t.rows[0].stripe_customer_id,
    return_url: `${process.env.BASE_URL}/dashboard/`,
  });
  res.json({ url: session.url });
});

// Webhook Stripe — monté AVANT express.json() dans index.js (raw body requis)
async function webhook(req, res) {
  if (!stripe) return res.status(503).end();
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], process.env.STRIPE_WEBHOOK_SECRET);
  } catch (e) {
    return res.status(400).send(`Webhook signature invalide: ${e.message}`);
  }

  const sub = event.data.object;
  const tenantId = sub.metadata && sub.metadata.tenant_id;

  switch (event.type) {
    case 'customer.subscription.created':
    case 'customer.subscription.updated': {
      if (!tenantId) break;
      const planName = sub.metadata.plan || 'start';
      const limits = (PLANS[planName] || PLANS.start).limits;
      await db.query(
        `UPDATE tenants SET plan = $2, plan_limits = $3, stripe_subscription_id = $4, subscription_status = $5
         WHERE id = $1`,
        [tenantId, planName, JSON.stringify(limits), sub.id, sub.status]);
      break;
    }
    case 'customer.subscription.deleted': {
      if (!tenantId) break;
      await db.query(
        `UPDATE tenants SET subscription_status = 'canceled',
                plan_limits = '{"programs":1,"locations":1,"managers":0,"api":false}' WHERE id = $1`, [tenantId]);
      break;
    }
    case 'invoice.payment_failed': {
      const t = await db.query('SELECT id FROM tenants WHERE stripe_customer_id = $1', [sub.customer]);
      if (t.rows[0]) await db.query(`UPDATE tenants SET subscription_status = 'past_due' WHERE id = $1`, [t.rows[0].id]);
      break;
    }
  }
  await db.query(`INSERT INTO audit_logs (tenant_id, action, details) VALUES ($1,'stripe_webhook',$2)`,
    [tenantId || null, JSON.stringify({ type: event.type })]).catch(() => {});
  res.json({ received: true });
}

module.exports = { router, webhook };
