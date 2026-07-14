/**
 * Service Apple Wallet
 * - Génère les fichiers .pkpass signés (manifest SHA1 + signature PKCS#7 détachée)
 * - Envoie les push APNs (topic = passTypeId) pour déclencher la mise à jour des passes
 *
 * PRÉREQUIS (voir .env.example) : certificat Pass Type ID (pem), clé privée (pem),
 * certificat WWDR d'Apple (pem), et une clé APNs .p8 pour les mises à jour.
 * Sans ces fichiers, isConfigured() renvoie false et l'API répond proprement
 * "Apple Wallet non configuré" au lieu de planter.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const forge = require('node-forge');
const archiver = require('archiver');
const http2 = require('http2');
const jwt = require('jsonwebtoken');
const QRCode = require('qrcode');

const CERTS = {
  cert: process.env.APPLE_CERT_PATH,
  key: process.env.APPLE_KEY_PATH,
  wwdr: process.env.APPLE_WWDR_PATH,
};

function isConfigured() {
  return ['cert', 'key', 'wwdr'].every((k) => CERTS[k] && fs.existsSync(path.resolve(CERTS[k])));
}

function apnsConfigured() {
  return process.env.APNS_KEY_PATH && fs.existsSync(path.resolve(process.env.APNS_KEY_PATH));
}

// ---------- Construction du pass.json ----------
function buildPassJson(ctx) {
  const { pass, program, business, customer } = ctx;
  const design = program.card_design || {};
  const fields = [];

  if (program.type === 'stamps') {
    fields.push(
      { key: 'stamps', label: 'TAMPONS', value: `${pass.stamps} / ${program.stamps_required}` },
      { key: 'reward', label: 'RÉCOMPENSE', value: program.reward_label || 'Récompense' }
    );
  } else {
    fields.push(
      { key: 'points', label: 'POINTS', value: String(Number(pass.points)) },
      { key: 'reward', label: 'OBJECTIF', value: `${program.points_for_reward} pts → ${program.reward_label || 'récompense'}` }
    );
  }
  if (pass.rewards_available > 0) {
    fields.push({ key: 'avail', label: 'À UTILISER', value: `${pass.rewards_available} récompense(s)` });
  }

  const backFields = [
    { key: 'holder', label: 'Titulaire', value: `${customer.first_name} ${customer.last_name || ''}`.trim() },
    ...(business.back_links || []).map((l, i) => ({ key: `link${i}`, label: l.label, value: l.url })),
    { key: 'terms', label: 'Conditions', value: design.terms || 'Programme de fidélité — voir en boutique.' },
  ];

  const now = new Date();
  const annExpires = pass.announcement_expires_at ? new Date(pass.announcement_expires_at) : null;
  const isAnnouncementValid = pass.announcement && (!annExpires || annExpires > now);

  if (isAnnouncementValid) {
    backFields.push({
      key: 'announcement',
      label: 'Dernier Message',
      value: pass.announcement,
      changeMessage: "Message du magasin : %@"
    });
  }

  const passJson = {
    formatVersion: 1,
    passTypeIdentifier: process.env.APPLE_PASS_TYPE_ID,
    teamIdentifier: process.env.APPLE_TEAM_ID,
    serialNumber: pass.serial_number,
    organizationName: business.name,
    description: design.description || `Carte fidélité ${business.name}`,
    logoText: business.name,
    backgroundColor: hexToRgb(design.bg_color || business.brand_color || '#1a1a2e'),
    foregroundColor: hexToRgb(design.text_color || business.text_color || '#ffffff'),
    labelColor: hexToRgb(design.label_color || design.text_color || '#ffffff'),
    webServiceURL: `${process.env.BASE_URL}/api/apple`,
    authenticationToken: pass.auth_token,
    barcodes: [{
      format: program.barcode_type === 'code128' ? 'PKBarcodeFormatCode128' : 'PKBarcodeFormatQR',
      message: pass.serial_number,
      messageEncoding: 'iso-8859-1',
      altText: pass.serial_number.slice(0, 8).toUpperCase(),
    }],
    storeCard: {
      headerFields: [fields[0]],
      secondaryFields: fields.slice(1),
      backFields,
    },
  };

  if (ctx.locations && ctx.locations.length > 0) {
    passJson.locations = ctx.locations.map(l => ({
      latitude: l.latitude,
      longitude: l.longitude,
      relevantText: l.relevant_text || undefined
    }));
  }

  return passJson;
}

function hexToRgb(hex) {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex || '');
  if (!m) return 'rgb(26,26,46)';
  return `rgb(${parseInt(m[1], 16)},${parseInt(m[2], 16)},${parseInt(m[3], 16)})`;
}

// ---------- Images du pass ----------
// icon.png est OBLIGATOIRE. On génère un fallback minimal si le commerce n'a pas de logo.
async function passImages(business) {
  const images = {};
  
  if (business.logo_url && business.logo_url.startsWith('data:image/')) {
    try {
      const b64 = business.logo_url.split(',')[1];
      const buf = Buffer.from(b64, 'base64');
      images['icon.png'] = buf;
      images['icon@2x.png'] = buf;
      images['logo.png'] = buf;
      images['logo@2x.png'] = buf;
      return images;
    } catch(e) { console.error('[apple-wallet] logo parsing error', e); }
  }

  // fallback : QR "logo" 1x1 neutre — remplacé dès que le commerçant charge son logo
  const png = await QRCode.toBuffer(business.name || 'W', { width: 58, margin: 0 });
  images['icon.png'] = png;
  images['icon@2x.png'] = await QRCode.toBuffer(business.name || 'W', { width: 116, margin: 0 });
  return images;
}

// ---------- Manifest + signature PKCS#7 ----------
function sha1(buf) {
  return crypto.createHash('sha1').update(buf).digest('hex');
}

function signManifest(manifestBuffer) {
  const certPem = fs.readFileSync(path.resolve(CERTS.cert), 'utf8');
  const keyPem = fs.readFileSync(path.resolve(CERTS.key), 'utf8');
  const wwdrPem = fs.readFileSync(path.resolve(CERTS.wwdr), 'utf8');

  const cert = forge.pki.certificateFromPem(certPem);
  const wwdr = forge.pki.certificateFromPem(wwdrPem);
  const key = process.env.APPLE_KEY_PASSPHRASE
    ? forge.pki.decryptRsaPrivateKey(keyPem, process.env.APPLE_KEY_PASSPHRASE)
    : forge.pki.privateKeyFromPem(keyPem);

  const p7 = forge.pkcs7.createSignedData();
  p7.content = forge.util.createBuffer(manifestBuffer.toString('binary'));
  p7.addCertificate(wwdr);
  p7.addCertificate(cert);
  p7.addSigner({
    key,
    certificate: cert,
    digestAlgorithm: forge.pki.oids.sha256,
    authenticatedAttributes: [
      { type: forge.pki.oids.contentType, value: forge.pki.oids.data },
      { type: forge.pki.oids.messageDigest },
      { type: forge.pki.oids.signingTime, value: new Date() },
    ],
  });
  p7.sign({ detached: true });
  return Buffer.from(forge.asn1.toDer(p7.toAsn1()).getBytes(), 'binary');
}

// ---------- Génération du .pkpass (retourne un Buffer) ----------
async function generatePkpass(ctx) {
  if (!isConfigured()) {
    const e = new Error('APPLE_NOT_CONFIGURED');
    e.code = 'APPLE_NOT_CONFIGURED';
    throw e;
  }
  const passJson = Buffer.from(JSON.stringify(buildPassJson(ctx)), 'utf8');
  const images = await passImages(ctx.business);

  const files = { 'pass.json': passJson, ...images };
  const manifest = {};
  for (const [name, buf] of Object.entries(files)) manifest[name] = sha1(buf);
  const manifestBuf = Buffer.from(JSON.stringify(manifest), 'utf8');
  const signature = signManifest(manifestBuf);

  return new Promise((resolve, reject) => {
    const archive = archiver('zip', { zlib: { level: 9 } });
    const chunks = [];
    archive.on('data', (c) => chunks.push(c));
    archive.on('end', () => resolve(Buffer.concat(chunks)));
    archive.on('error', reject);
    for (const [name, buf] of Object.entries(files)) archive.append(buf, { name });
    archive.append(manifestBuf, { name: 'manifest.json' });
    archive.append(signature, { name: 'signature' });
    archive.finalize();
  });
}

// ---------- Push APNs : déclenche le rafraîchissement d'un pass sur les iPhones ----------
let apnsToken = null;
let apnsTokenAt = 0;
function getApnsJwt() {
  // Un token APNs est valable jusqu'à 60 min ; on le régénère toutes les 45 min
  if (apnsToken && Date.now() - apnsTokenAt < 45 * 60 * 1000) return apnsToken;
  const key = fs.readFileSync(path.resolve(process.env.APNS_KEY_PATH), 'utf8');
  apnsToken = jwt.sign({}, key, {
    algorithm: 'ES256',
    issuer: process.env.APPLE_TEAM_ID,
    header: { alg: 'ES256', kid: process.env.APNS_KEY_ID },
  });
  apnsTokenAt = Date.now();
  return apnsToken;
}

async function pushUpdate(pushTokens) {
  if (!apnsConfigured() || !pushTokens.length) return { sent: 0, simulated: true };
  const client = http2.connect('https://api.push.apple.com');
  let sent = 0;
  await Promise.all(pushTokens.map((token) => new Promise((resolve) => {
    const req = client.request({
      ':method': 'POST',
      ':path': `/3/device/${token}`,
      authorization: `bearer ${getApnsJwt()}`,
      'apns-topic': process.env.APPLE_PASS_TYPE_ID,
      'apns-push-type': 'background',
    });
    req.on('response', (h) => { if (h[':status'] === 200) sent += 1; });
    req.on('close', resolve);
    req.on('error', resolve);
    req.end(JSON.stringify({}));  // payload vide = "le pass a changé, viens le re-télécharger"
  })));
  client.close();
  return { sent, simulated: false };
}

module.exports = { isConfigured, apnsConfigured, generatePkpass, pushUpdate };
