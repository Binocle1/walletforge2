require('dotenv').config();
const express = require('express');
const path = require('path');
const helmet = require('helmet');

const authRoutes = require('./routes/auth');
const programRoutes = require('./routes/programs');
const customerRoutes = require('./routes/customers');
const walletRoutes = require('./routes/wallet');
const txRoutes = require('./routes/transactions');
const uploadRoutes = require('./routes/upload');
const billing = require('./routes/billing');
const apple = require('./services/appleWallet');
const google = require('./services/googleWallet');
const { required } = require('./auth');
require('./cron'); // Lance le worker des tâches en arrière-plan

const app = express();
app.set('trust proxy', 1);

// ---------- Sécurité ----------
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "https://unpkg.com"],
      scriptSrcAttr: ["'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com"],
      imgSrc: ["'self'", "data:", "blob:", "https:"],
      connectSrc: ["'self'"],
      workerSrc: ["'self'", "blob:"],
    },
  },
  crossOriginEmbedderPolicy: false, // needed for external fonts/images
}));

app.use((req, res, next) => {
  // CORS explicite
  const origin = req.headers.origin;
  const ALLOWED = process.env.BASE_URL ? [process.env.BASE_URL] : [];
  if (origin && (ALLOWED.includes(origin) || process.env.NODE_ENV !== 'production')) {
    res.set('Access-Control-Allow-Origin', origin);
    res.set('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Content-Type,Authorization');
    res.set('Access-Control-Allow-Credentials', 'true');
    if (req.method === 'OPTIONS') return res.status(204).end();
  }
  // HTTPS forcé derrière un proxy (Render/Railway/nginx)
  if (process.env.NODE_ENV === 'production' && req.headers['x-forwarded-proto'] === 'http') {
    return res.redirect(301, `https://${req.headers.host}${req.url}`);
  }
  next();
});

// ---------- Rate limiting global (simple, en mémoire ; Redis en prod multi-instances) ----------
const hits = new Map();
setInterval(() => hits.clear(), 60000).unref();
app.use('/api', (req, res, next) => {
  const n = (hits.get(req.ip) || 0) + 1;
  hits.set(req.ip, n);
  if (n > 300) return res.status(429).json({ error: 'Trop de requêtes, ralentis un peu' });
  next();
});

// ---------- Webhook Stripe (raw body AVANT json parser) ----------
app.post('/api/billing/webhook', express.raw({ type: 'application/json' }), billing.webhook);

app.use(express.json({ limit: '2mb' }));

// ---------- API ----------
app.use('/api/auth', authRoutes);
app.use('/api/programs', programRoutes);
app.use('/api/customers', customerRoutes);
app.use('/api/wallet', walletRoutes);
app.use('/api/upload', uploadRoutes);
app.use('/api/apple', walletRoutes);          // web service Apple : /api/apple/v1/...
app.use('/api', txRoutes);
app.use('/api/billing', billing.router);
app.use('/api/admin', require('./routes/admin'));

// Statut de configuration (le dashboard l'affiche)
app.get('/api/status', required, (req, res) => {
  res.json({
    apple_wallet: apple.isConfigured(),
    apns: apple.apnsConfigured(),
    google_wallet: google.isConfigured(),
    stripe: Boolean(process.env.STRIPE_SECRET_KEY),
  });
});

// ---------- Frontends statiques ----------
app.use('/uploads', express.static(path.join(__dirname, '../public/uploads')));
app.use('/dashboard', express.static(path.join(__dirname, '../public/dashboard')));
app.use('/scanner', express.static(path.join(__dirname, '../public/scanner')));
app.use('/admin', express.static(path.join(__dirname, '../public/admin')));
app.use('/join-assets', express.static(path.join(__dirname, '../public/landing')));
app.get('/join/:programId', (req, res) => res.sendFile(path.join(__dirname, '../public/landing/index.html')));
app.get('/card/:serial', (req, res) => res.sendFile(path.join(__dirname, '../public/card.html')));
app.get('/', (req, res) => res.redirect('/dashboard/'));

// ---------- Erreurs ----------
app.use((err, req, res, next) => {
  console.error('[error]', err);
  res.status(500).json({ error: 'Erreur interne' });
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`WalletForge en ligne sur :${port}`);
  console.log(`  Apple Wallet  : ${apple.isConfigured() ? 'OK' : 'EN ATTENTE DES CERTIFICATS (voir .env.example)'}`);
  console.log(`  APNs          : ${apple.apnsConfigured() ? 'OK' : 'en attente de la clé .p8'}`);
  console.log(`  Google Wallet : ${google.isConfigured() ? 'OK' : 'en attente du service account'}`);
  console.log(`  Stripe        : ${process.env.STRIPE_SECRET_KEY ? 'OK' : 'en attente des clés'}`);
});
