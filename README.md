# WalletForge — Plateforme SaaS de fidélité digitale

Cartes de fidélité **Apple Wallet** et **Google Wallet** pour commerces locaux (cafés, restaurants, salons, boutiques…). Multi-tenant, prêt à commercialiser en abonnement.

## Ce qui est inclus (MVP — Phase 1)

| Module | Détail |
|---|---|
| Comptes commerçants | Inscription, connexion (JWT, anti-brute-force), rôles : owner / admin / manager / cashier |
| Programmes | Carte à tampons (X achetés → 1 offert) et Points/cashback (1 € = X pts), couleurs personnalisées |
| Acquisition | QR d'inscription imprimable + landing mobile publique `/join/:programId` avec consentements RGPD |
| Cartes Wallet | Génération .pkpass signée (Apple) + lien "Add to Google Wallet", mise à jour en temps réel après chaque transaction |
| Notifications | Push APNs (le pass se met à jour sur l'iPhone) + message sur la carte Google, historique en base |
| Scanner PWA | `/scanner` — caméra QR, recherche manuelle, achat/tampon/points/récompense, installable sur téléphone |
| Dashboard | `/dashboard` — stats, programmes, CRM clients, transactions, réglages commerce, abonnement |
| RGPD | Consentement horodaté, export JSON par client, anonymisation irréversible, audit log |
| Facturation | Stripe Checkout (3 plans + essai 14 j), portail client, webhooks (activation/limites/impayés) |

## Démarrage rapide (local)

```bash
# 1. Prérequis : Node.js 18+, PostgreSQL 14+
createdb walletforge
psql -d walletforge -f db/schema.sql

# 2. Config
cp .env.example .env    # puis édite DATABASE_URL, BASE_URL, JWT_SECRET

# 3. Lancer
npm install
npm start               # -> http://localhost:3000/dashboard
```

Au démarrage, le serveur affiche ce qui est configuré ou non (Apple / APNs / Google / Stripe). **Tout fonctionne sans eux** — les boutons wallet répondent proprement "pas encore activé" tant que les clés manquent.

## Déploiement production

Render / Railway / Fly.io / VPS — c'est un simple monolithe Node + Postgres :

1. Crée une base PostgreSQL managée, applique `db/schema.sql`.
2. Déploie le repo, définis les variables du `.env.example` (surtout `BASE_URL=https://ton-domaine.com` — **obligatoire en HTTPS** pour Apple Wallet et les QR).
3. Commande de démarrage : `npm start`. Le HTTPS est forcé automatiquement derrière un proxy.

## ⚠️ Activer Apple Wallet (dès que tu as ta licence — 99 $/an)

1. **developer.apple.com** → Certificates, Identifiers & Profiles → **Identifiers** → `+` → **Pass Type IDs** → crée par ex. `pass.com.tondomaine.loyalty`.
2. Toujours dans Identifiers → ton Pass Type ID → **Create Certificate** → suis la procédure (CSR via Trousseau d'accès sur Mac) → télécharge le `.cer`, importe-le dans le Trousseau, exporte-le en **`.p12`** (avec un mot de passe).
3. Convertis en PEM :
   ```bash
   openssl pkcs12 -in cert.p12 -clcerts -nokeys -out certs/apple-cert.pem -legacy
   openssl pkcs12 -in cert.p12 -nocerts -nodes  -out certs/apple-key.pem  -legacy
   ```
4. Télécharge le certificat **WWDR G4** d'Apple : https://www.apple.com/certificateauthority/ → convertis-le en PEM → `certs/apple-wwdr.pem`.
5. Pour les mises à jour en temps réel : developer.apple.com → **Keys** → `+` → coche **APNs** → télécharge la clé `.p8` → `certs/apns-key.p8`, note le **Key ID**.
6. Renseigne dans `.env` : `APPLE_PASS_TYPE_ID`, `APPLE_TEAM_ID` (en haut à droite du portail dev), les chemins des certifs, `APNS_KEY_ID`. Redémarre. C'est tout — la génération, la signature, le web service PassKit et les push sont déjà codés et testés.

## Activer Google Wallet (gratuit)

1. https://pay.google.com/business/console → crée un compte émetteur → note l'**Issuer ID**.
2. Google Cloud Console → crée un **service account**, ajoute-le dans la Wallet Console comme **Wallet Object Issuer**, télécharge sa clé JSON → `certs/google-service-account.json`.
3. `.env` : `GOOGLE_WALLET_ISSUER_ID` + chemin du JSON. (En mode démo, seuls les comptes testeurs peuvent ajouter les cartes tant que Google n'a pas approuvé le compte — demande la prod dans la console.)

## Activer Stripe

1. Dashboard Stripe → crée 3 produits récurrents (Start / Grow / Business) → copie les `price_...` dans `.env`.
2. Ajoute un webhook vers `https://ton-domaine.com/api/billing/webhook` avec les événements `customer.subscription.*` et `invoice.payment_failed` → copie le `whsec_...`.

## Architecture

```
src/
  index.js            serveur Express (sécurité, rate limit, routes, statiques)
  db.js  auth.js      Postgres + JWT/rôles/anti-brute-force
  services/
    appleWallet.js    .pkpass signé (PKCS#7) + push APNs (http2 natif)
    googleWallet.js   LoyaltyClass/Object + lien Save + PATCH temps réel
    loyalty.js        règles tampons/points, transactions atomiques, notifs
  routes/             auth, programs, customers (public+CRM), wallet
                      (+ web service PassKit /api/apple/v1), transactions, billing
public/
  dashboard/          SPA commerçant
  landing/            page d'inscription client (mobile-first)
  scanner/            PWA scanner (caméra QR, installable)
db/schema.sql         schéma multi-tenant complet
```

## Tests effectués

Parcours complet validé en local : inscription commerçant → création programme tampons → QR → inscription client publique → scan → 10 achats (récompense débloquée + compteur remis à zéro au palier) → utilisation récompense (et refus si aucune dispo) → stats. Génération .pkpass validée (zip conforme, manifest SHA1 vérifié, signature PKCS#7) avec des certificats de test, et web service PassKit testé (enregistrement device 201, mauvais token 401, liste des passes mis à jour, re-téléchargement 200).

## Phases suivantes (déjà prévues dans le schéma)

Phase 2 : coupons, multipass, memberships, cartes cadeaux, multi-emplacements, campagnes push marketing, segments. Phase 3 : automatisations (anniversaire, inactivité), API publique + clés par tenant (`plan_limits.api` déjà en base), white-label.
