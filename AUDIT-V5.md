# WalletForge — Audit v5 : correctifs + Hub Notifications

## ⚡ À faire dans l'ordre

```bash
psql $DATABASE_URL -f db/migrations/005_notifications_hub.sql   # OBLIGATOIRE (colonnes manquantes)
npm install
npm start
```
Puis **vider le cache du scanner** sur les téléphones (le service worker sert encore l'ancienne page).

---

## 1. Le bug que tu as signalé (scanner → profil client)

**Reproduit et corrigé.** Message affiché au vendeur :
> `Cannot read properties of null (reading 'classList')`

**Cause** : en v4, le bloc `<div id="amountRow">` a été supprimé du HTML (remplacé par le numpad),
mais `renderProfile()` l'appelait encore :
```js
document.getElementById('amountRow').classList.remove('on');  // -> null
```
L'exception était levée **à l'intérieur du `try` de `openSerial()`**, donc attrapée par le `catch`
prévu pour les erreurs réseau → le vendeur voyait un message d'erreur et le profil ne s'ouvrait jamais.

**Correction** : ligne morte supprimée + `openSerial()` sépare désormais les erreurs **réseau**
(carte inconnue → on reste sur le scanner) des erreurs **d'affichage** (loguées distinctement).

---

## 2. Bugs bloquants trouvés juste derrière (tu les aurais pris en pleine face)

| Gravité | Bug | Correction |
|---|---|---|
| 🔴 | **Toute transaction plantait** : `loyalty.js` fait `UPDATE customer_passes SET ... tags = $7`, or la colonne `tags` **n'existe pas** (idem `source`). Erreur PG 42703. | Migration 005 : ajout de `tags`, `source`, `current_streak`, `last_visit` sur `customer_passes` + `schema.sql` synchronisé. |
| 🔴 | **Toute inscription client plantait** : `createPass()` insère dans `customer_passes(..., source)` → même colonne manquante. | idem migration 005. |
| 🔴 | **Les tampons ne débloquaient plus aucune récompense** (régression v4) : le `case 'purchase'` incrémentait les tampons sans jamais calculer `rewards_available`. Le bouton « Utiliser la récompense » restait grisé à vie. | Logique de palier restaurée (avec gestion du reste : 12 tampons sur 10 → 1 récompense + 2 tampons). |
| 🔴 | **VIP Argent cassait les cartes à tampons** : `stampsDelta = 1 * 1.5` → insertion d'un `1.5` dans une colonne `INT` → crash SQL. | `Math.round()` sur le multiplicateur. |
| 🔴 | **Le lien de désinscription était cassé** (risque RGPD) : `UPDATE customer_passes SET marketing_consent = false` — cette colonne est sur `customers`. | Requête corrigée + l'événement remonte maintenant dans les KPIs. |
| 🟠 | **Impossible de créer un programme** : `<form onsubmit="saveProgram()">` alors que la fonction s'appelle `createProgram()`. | Corrigé. |
| 🟠 | Le scanner n'affichait plus les badges VIP / streak : la route `/scan` renvoyait `c.tags` (tags CRM) au lieu de `p.tags` (paliers VIP) et ne renvoyait plus `current_streak`. | Corrigé. |

---

## 3. Le Hub Notifications (nouveau)

Tout est **centralisé dans un seul sous-menu**, avec 3 onglets.

### KPIs (30 jours), en haut
Envoyées · Délivrées · Clics · Revenus en boutique (+ CA généré) · Désinscriptions · Base opt-in.

### Onglet « Campagnes »
Créer une campagne : nom, **programme ciblé**, **segment** (avec l'audience calculée en direct
avant l'envoi), message (240 car.), **lien d'action tracké**, envoi immédiat / programmé / brouillon.
Le tableau montre par campagne : envoyées, délivrées, clics (+ %), conversions, **CA généré**.
Le bouton « Détail » ouvre la liste **destinataire par destinataire** : qui a reçu, qui a cliqué,
qui est revenu en boutique dans les 72 h et combien il a dépensé.

11 segments prêts à l'emploi (`src/services/segments.js`) : tous, actifs 7 j / 30 j, endormis 30 j / 60 j,
inscrits jamais venus, récompense en attente, **à 2 tampons du but**, VIP, anniversaire ce mois-ci,
carte non installée.

### Onglet « Automatisations »
Les 4 automatisations (bienvenue, anniversaire, relance, avis Google) de **tous** les programmes,
réglables au même endroit, avec le nombre d'envois sur 30 j. Elles ne se règlent plus depuis la
fiche programme (qui ne garde que les récompenses) → **un seul endroit, comme demandé**.

### Onglet « Journal »
Toutes les notifications (campagne + automatique + transactionnelle), filtrables par type, par statut
(délivrée / cliquée / convertie / échec) et par recherche libre. Chaque ligne affiche le **parcours**
complet : Envoyé → Délivré → Cliqué → Revenu.

### Ce qui est réellement traçable (important)
Il n'existe **pas** de taux d'ouverture sur Apple/Google Wallet — personne ne peut le mesurer.
Ce qu'on mesure vraiment, et qui vaut mieux :

| Étape | Comment |
|---|---|
| **Envoyé** | APNs / Google ont accepté le push |
| **Délivré** | l'iPhone a re-téléchargé le pass via le web service Apple → preuve d'arrivée sur l'appareil |
| **Cliqué** | le message contient un lien tracké `/n/:token` (jamais l'URL brute) → redirection 302 + horodatage |
| **Converti** | une transaction a eu lieu sur cette carte dans les **72 h** suivant l'envoi → CA attribué |
| **Désinscrit** | via le lien de la carte |

### Fichiers ajoutés
- `db/migrations/005_notifications_hub.sql` — colonnes manquantes + `notification_campaigns`, `notification_events`, tracking sur `notifications`
- `src/services/segments.js` — ciblage (source de vérité unique)
- `src/services/messaging.js` — envoi par lots (8 en parallèle), campagnes programmées, tracking clic
- `src/routes/notifications.js` — 10 endpoints du hub
- Modifiés : `src/services/loyalty.js`, `src/routes/{wallet,customers,transactions}.js`, `src/index.js` (route publique `/n/:token`), `src/cron.js`, `public/dashboard/index.html`, `public/scanner/index.html`, `db/schema.sql`

---

## 4. Ce qui reste à faire (par ordre de priorité)

1. **`/api/customers/notify_all` fait doublon** avec le hub → à supprimer et rediriger vers les campagnes (je l'ai laissé pour ne rien casser).
2. **Service worker** (`public/scanner/sw.js`) : toujours en cache-first sans purge → après chaque déploiement, les téléphones gardent l'ancienne version. À passer en network-first sur le HTML.
3. **L'annulation (undo) supprime la ligne de transaction** (`DELETE FROM transactions`) : un caissier peut effacer sa fraude, et la carte Wallet n'est pas rafraîchie après annulation. → écrire une contrepassation (type `cancel`) + `notifyAndRefresh`.
4. **Logo en base64 dans Postgres** : Google Wallet refuse les data-URI (ton fallback met une icône icons8 générique) et Apple exige du vrai PNG. → S3/R2 + `sharp`.
5. **File d'attente Redis** pour les pushs (aujourd'hui, si l'APNs tombe, la notif est perdue sans retry).
6. **Rate-limit / brute-force en mémoire** → ne tient pas sur plusieurs instances.

---

## 5. Idées de fonctionnalités (pour la suite)

- **Notification déclenchée par géolocalisation** : tu as déjà `locations.latitude/longitude` et le
  `relevantText` d'Apple. La carte remonte sur l'écran verrouillé quand le client passe devant la
  boutique. Aucun concurrent ne le fait bien, et c'est presque gratuit à implémenter.
- **A/B test de campagne** : deux messages, 50/50, on garde celui qui convertit. Le tracking est déjà en place.
- **Envoi au « meilleur moment »** : on connaît l'heure des transactions de chaque client → on pousse
  la relance à l'heure où il vient d'habitude.
- **Segments RFM automatiques** (Champions / À risque / Perdus) + campagne suggérée pour chacun.
- **Budget & plafond anti-spam** : max 1 notif marketing / client / semaine, forcé côté serveur.
  C'est ce qui protège ta base opt-in sur le long terme.
- **Notification « récompense sur le point d'expirer »** : le meilleur déclencheur de visite qui existe.
