-- ============================================================
-- WalletForge — Schéma PostgreSQL multi-tenant (Phase 1 MVP)
-- Toutes les tables métier portent tenant_id pour la séparation
-- stricte des données entre commerçants (exigence 4.5 / RGPD).
-- ============================================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ---------- Tenants / comptes commerçants ----------
CREATE TABLE tenants (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          TEXT NOT NULL,
  plan          TEXT NOT NULL DEFAULT 'trial',          -- trial | start | grow | business
  plan_limits   JSONB NOT NULL DEFAULT '{"programs":1,"locations":1,"managers":0,"api":false}',
  stripe_customer_id     TEXT,
  stripe_subscription_id TEXT,
  subscription_status    TEXT DEFAULT 'trialing',        -- trialing | active | past_due | canceled
  is_frozen     BOOLEAN NOT NULL DEFAULT false,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- Commerce (profil business du tenant) ----------
CREATE TABLE businesses (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  business_type TEXT,
  country       TEXT,
  currency      TEXT NOT NULL DEFAULT 'EUR',
  phone         TEXT,
  website       TEXT,
  address       TEXT,
  logo_url      TEXT,
  brand_color   TEXT DEFAULT '#1a1a2e',
  text_color    TEXT DEFAULT '#ffffff',
  google_review_url TEXT,
  social_links  JSONB NOT NULL DEFAULT '{}',            -- {instagram, facebook, tiktok, whatsapp, ...}
  back_links    JSONB NOT NULL DEFAULT '[]',            -- liens verso de carte [{label,url}]
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- Emplacements ----------
CREATE TABLE locations (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  address     TEXT,
  latitude    DOUBLE PRECISION,
  longitude   DOUBLE PRECISION,
  relevant_text TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- Utilisateurs internes (owner/admin/manager/cashier) ----------
CREATE TABLE users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID REFERENCES tenants(id) ON DELETE CASCADE,  -- NULL = super admin plateforme
  email         TEXT,
  username      TEXT,
  password_hash TEXT NOT NULL,
  full_name     TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'owner',   -- superadmin | owner | admin | manager | cashier | readonly
  location_id   UUID REFERENCES locations(id) ON DELETE SET NULL,
  email_verified BOOLEAN NOT NULL DEFAULT false,
  reset_token   TEXT,
  reset_expires TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, username)
);
CREATE UNIQUE INDEX idx_users_tenant_email ON users (tenant_id, email);

-- ---------- Programmes de fidélité ----------
CREATE TABLE loyalty_programs (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  business_id   UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  type          TEXT NOT NULL,                   -- stamps | points  (MVP) — coupon|multipass|membership|giftcard en phase 2
  active        BOOLEAN NOT NULL DEFAULT true,
  -- règles (selon type)
  stamps_required   INT,                         -- stamps : nb de tampons pour la récompense
  reward_label      TEXT,                        -- ex "11e café offert"
  points_per_unit   NUMERIC(10,2),               -- points : 1 unité monnaie = X points
  points_for_reward INT,                         -- points nécessaires pour convertir
  -- design de la carte wallet
  card_design   JSONB NOT NULL DEFAULT '{}',     -- {bg_color, text_color, label_color, logo_url, strip_url, description, terms}
  barcode_type  TEXT NOT NULL DEFAULT 'qr',      -- qr | code128
  automations   JSONB NOT NULL DEFAULT '{}',     -- {welcome, birthday, winback, review}
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- Clients finaux ----------
CREATE TABLE customers (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  first_name    TEXT NOT NULL,
  last_name     TEXT,
  email         TEXT,
  phone         TEXT,
  birthday      DATE,
  source        TEXT DEFAULT 'qr',               -- qr | link | campaign | location | manual
  source_ref    TEXT,
  marketing_consent  BOOLEAN NOT NULL DEFAULT false,
  consent_history    JSONB NOT NULL DEFAULT '[]',
  tags          TEXT[] NOT NULL DEFAULT '{}',
  anonymized    BOOLEAN NOT NULL DEFAULT false,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, email)
);

-- ---------- Cartes clients (une par client x programme) ----------
CREATE TABLE customer_passes (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  customer_id   UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  program_id    UUID NOT NULL REFERENCES loyalty_programs(id) ON DELETE CASCADE,
  serial_number TEXT NOT NULL UNIQUE,            -- identifiant unique de la carte (QR)
  auth_token    TEXT NOT NULL,                   -- token web service Apple Wallet
  stamps        INT NOT NULL DEFAULT 0 CHECK (stamps >= 0),
  points        NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (points >= 0),
  rewards_available INT NOT NULL DEFAULT 0 CHECK (rewards_available >= 0),
  wallet_status TEXT NOT NULL DEFAULT 'none',    -- none | apple | google | both
  announcement  TEXT,
  announcement_expires_at TIMESTAMPTZ,
  last_updated  TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (customer_id, program_id)
);

-- ---------- Enregistrements devices Apple Wallet (web service) ----------
CREATE TABLE apple_registrations (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pass_id         UUID NOT NULL REFERENCES customer_passes(id) ON DELETE CASCADE,
  device_library_id TEXT NOT NULL,
  push_token      TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (pass_id, device_library_id)
);

-- ---------- Transactions ----------
CREATE TABLE transactions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  pass_id       UUID NOT NULL REFERENCES customer_passes(id) ON DELETE CASCADE,
  customer_id   UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  program_id    UUID NOT NULL REFERENCES loyalty_programs(id) ON DELETE CASCADE,
  location_id   UUID REFERENCES locations(id) ON DELETE SET NULL,
  user_id       UUID REFERENCES users(id) ON DELETE SET NULL,   -- vendeur
  type          TEXT NOT NULL,                   -- purchase | add_points | remove_points | add_stamp | remove_stamp | reward_redeemed | adjustment | cancel
  amount        NUMERIC(12,2),                   -- montant déclaré
  points_delta  NUMERIC(12,2) DEFAULT 0,
  stamps_delta  INT DEFAULT 0,
  comment       TEXT,
  source        TEXT NOT NULL DEFAULT 'scanner', -- scanner | dashboard | api
  client_tx_id  TEXT,                            -- idempotency key from offline scanner
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_tx_tenant_date ON transactions (tenant_id, created_at DESC);
CREATE INDEX idx_tx_customer ON transactions (customer_id, created_at DESC);
CREATE INDEX idx_tx_pass_type_date ON transactions (pass_id, type, created_at DESC);
CREATE UNIQUE INDEX idx_tx_client_tx_id ON transactions (client_tx_id) WHERE client_tx_id IS NOT NULL;

-- ---------- Notifications ----------
CREATE TABLE notifications (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  customer_id UUID REFERENCES customers(id) ON DELETE CASCADE,
  pass_id     UUID REFERENCES customer_passes(id) ON DELETE CASCADE,
  type        TEXT NOT NULL DEFAULT 'transactional',   -- transactional | marketing (phase 2)
  message     TEXT NOT NULL,
  automation_id TEXT,                                  -- ex: winback, birthday_2026 (pour dédoublonnage)
  status      TEXT NOT NULL DEFAULT 'queued',          -- queued | sent | failed | simulated
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_notifications_pass_automation ON notifications (pass_id, automation_id);
CREATE INDEX idx_customers_tenant ON customers (tenant_id);
CREATE INDEX idx_customer_passes_tenant ON customer_passes (tenant_id);
CREATE INDEX idx_users_tenant ON users (tenant_id);

-- ---------- Audit / logs ----------
CREATE TABLE audit_logs (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  UUID,
  user_id    UUID,
  action     TEXT NOT NULL,
  details    JSONB NOT NULL DEFAULT '{}',
  ip         TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- Vue stats simple ----------
CREATE VIEW v_tenant_stats AS
SELECT t.id AS tenant_id,
  (SELECT count(*) FROM customers c WHERE c.tenant_id = t.id AND NOT c.anonymized)              AS total_customers,
  (SELECT count(*) FROM customer_passes p WHERE p.tenant_id = t.id AND p.wallet_status IN ('apple','both')) AS apple_installs,
  (SELECT count(*) FROM customer_passes p WHERE p.tenant_id = t.id AND p.wallet_status IN ('google','both'))AS google_installs,
  (SELECT count(*) FROM customer_passes p WHERE p.tenant_id = t.id AND p.wallet_status = 'none')            AS not_installed,
  (SELECT count(*) FROM transactions x WHERE x.tenant_id = t.id)                               AS total_transactions,
  (SELECT coalesce(sum(x.amount),0) FROM transactions x WHERE x.tenant_id = t.id AND x.type='purchase') AS total_amount
FROM tenants t;
