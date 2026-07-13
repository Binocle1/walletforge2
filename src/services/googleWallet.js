/**
 * Service Google Wallet
 * - Crée les LoyaltyClass (une par programme) et LoyaltyObject (une par carte client)
 * - Génère le lien "Add to Google Wallet" (JWT RS256 signé avec le service account)
 * - Met à jour les objets (PATCH) après chaque transaction — la carte se rafraîchit toute seule
 *
 * PRÉREQUIS : Issuer ID (Google Pay & Wallet Console) + clé JSON d'un service account
 * avec le rôle "Wallet Object Issuer". Voir .env.example.
 */
const fs = require('fs');
const path = require('path');
const jwt = require('jsonwebtoken');

const API = 'https://walletobjects.googleapis.com/walletobjects/v1';
const SCOPE = 'https://www.googleapis.com/auth/wallet_object.issuer';

let sa = null;
function serviceAccount() {
  if (sa) return sa;
  const p = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!p) return null;
  
  // Si c'est directement le contenu JSON en chaîne de caractères
  if (p.trim().startsWith('{')) {
    try {
      sa = JSON.parse(p);
      return sa;
    } catch (e) {
      console.error("Erreur de parsing de GOOGLE_SERVICE_ACCOUNT_JSON (string) :", e);
      return null;
    }
  }
  
  // Sinon, c'est un chemin vers le fichier local
  if (!fs.existsSync(path.resolve(p))) return null;
  sa = JSON.parse(fs.readFileSync(path.resolve(p), 'utf8'));
  return sa;
}

function isConfigured() {
  return Boolean(process.env.GOOGLE_WALLET_ISSUER_ID && serviceAccount());
}

// ---------- OAuth2 access token (JWT bearer flow, sans dépendance externe) ----------
let accessToken = null;
let accessTokenExp = 0;
async function getAccessToken() {
  if (accessToken && Date.now() < accessTokenExp - 60000) return accessToken;
  const s = serviceAccount();
  const now = Math.floor(Date.now() / 1000);
  const assertion = jwt.sign(
    { iss: s.client_email, scope: SCOPE, aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 },
    s.private_key,
    { algorithm: 'RS256' }
  );
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
  });
  const data = await res.json();
  accessToken = data.access_token;
  accessTokenExp = Date.now() + (data.expires_in || 3600) * 1000;
  return accessToken;
}

async function gApi(method, url, body) {
  const token = await getAccessToken();
  const res = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 404) return { notFound: true };
  const data = await res.json().catch(() => ({}));
  if (!res.ok && res.status !== 409) throw new Error(`Google Wallet ${res.status}: ${JSON.stringify(data.error || data)}`);
  return data;
}

const classId = (programId) => `${process.env.GOOGLE_WALLET_ISSUER_ID}.prog_${programId.replace(/-/g, '')}`;
const objectId = (serial) => `${process.env.GOOGLE_WALLET_ISSUER_ID}.card_${serial.replace(/-/g, '')}`;

// ---------- Classe (template du programme) ----------
async function ensureClass(ctx) {
  const { program, business, locations } = ctx;
  const id = classId(program.id);
  const cls = {
    id,
    issuerName: business.name,
    programName: program.name,
    programLogo: business.logo_url && business.logo_url.startsWith('http')
      ? { sourceUri: { uri: business.logo_url } } : undefined,
    hexBackgroundColor: (program.card_design && program.card_design.bg_color) || business.brand_color || '#1a1a2e',
    reviewStatus: 'UNDER_REVIEW',
    countryCode: business.country || 'FR',
  };
  
  if (locations && locations.length > 0) {
    cls.locations = locations.map(l => ({
      latitude: l.latitude,
      longitude: l.longitude
    }));
  }

  const existing = await gApi('GET', `${API}/loyaltyClass/${id}`);
  if (existing.notFound) await gApi('POST', `${API}/loyaltyClass`, cls);
  // Optional: update existing class with locations
  // else await gApi('PATCH', `${API}/loyaltyClass/${id}`, { locations: cls.locations });
  return id;
}

// ---------- Objet (carte du client) ----------
function buildObject(ctx) {
  const { pass, program, customer } = ctx;
  const isStamps = program.type === 'stamps';
  return {
    id: objectId(pass.serial_number),
    classId: classId(program.id),
    state: 'ACTIVE',
    accountId: customer.id,
    accountName: `${customer.first_name} ${customer.last_name || ''}`.trim(),
    loyaltyPoints: {
      label: isStamps ? 'Tampons' : 'Points',
      balance: isStamps ? { string: `${pass.stamps}/${program.stamps_required}` } : { string: String(Number(pass.points)) },
    },
    secondaryLoyaltyPoints: pass.rewards_available > 0
      ? { label: 'Récompenses à utiliser', balance: { string: String(pass.rewards_available) } }
      : undefined,
    barcode: {
      type: program.barcode_type === 'code128' ? 'CODE_128' : 'QR_CODE',
      value: pass.serial_number,
      alternateText: pass.serial_number.slice(0, 8).toUpperCase(),
    },
    textModulesData: [{
      header: 'Récompense',
      body: program.reward_label || 'Récompense fidélité',
      id: 'reward',
    }],
  };
}

// ---------- Lien "Add to Google Wallet" ----------
async function saveLink(ctx) {
  if (!isConfigured()) {
    const e = new Error('GOOGLE_NOT_CONFIGURED');
    e.code = 'GOOGLE_NOT_CONFIGURED';
    throw e;
  }
  await ensureClass(ctx);
  const obj = buildObject(ctx);
  const s = serviceAccount();
  const token = jwt.sign(
    {
      iss: s.client_email,
      aud: 'google',
      typ: 'savetowallet',
      origins: [process.env.BASE_URL],
      payload: { loyaltyObjects: [obj] },
    },
    s.private_key,
    { algorithm: 'RS256' }
  );
  return `https://pay.google.com/gp/v/save/${token}`;
}

// ---------- Mise à jour après transaction ----------
async function updateObject(ctx, message) {
  if (!isConfigured()) return { simulated: true };
  const obj = buildObject(ctx);
  const res = await gApi('PATCH', `${API}/loyaltyObject/${obj.id}`, obj);
  if (res.notFound) return { notFound: true }; // carte jamais ajoutée côté Google
  if (message) {
    await gApi('POST', `${API}/loyaltyObject/${obj.id}/addMessage`, {
      message: { header: ctx.business.name, body: message, messageType: 'TEXT' },
    }).catch(() => {});
  }
  return { updated: true };
}

module.exports = { isConfigured, saveLink, updateObject };
