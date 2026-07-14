-- ============================================================
-- Migration 005 — Colonnes manquantes (bugfix) + Hub Notifications
-- Idempotente : rejouable sans risque.
-- ============================================================

-- ------------------------------------------------------------
-- 1) BUGFIX : colonnes utilisées par le code mais absentes du schéma
--    (src/services/loyalty.js écrit tags/source/current_streak/last_visit,
--     ce qui faisait planter TOUTE transaction et TOUTE inscription)
-- ------------------------------------------------------------
ALTER TABLE customer_passes
  ADD COLUMN IF NOT EXISTS tags           TEXT[] NOT NULL DEFAULT '{}',   -- ['VIP Or'] etc.
  ADD COLUMN IF NOT EXISTS source         TEXT,                           -- serial du parrain
  ADD COLUMN IF NOT EXISTS current_streak INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_visit     TIMESTAMPTZ;

-- ------------------------------------------------------------
-- 2) Campagnes de notification (le "hub")
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS notification_campaigns (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  program_id      UUID REFERENCES loyalty_programs(id) ON DELETE CASCADE,  -- NULL = tous les programmes
  name            TEXT NOT NULL,
  kind            TEXT NOT NULL DEFAULT 'manual',   -- manual | automation | transactional
  automation_key  TEXT,                             -- welcome | birthday | winback | review
  segment         TEXT NOT NULL DEFAULT 'all',      -- cf. src/services/segments.js
  message         TEXT NOT NULL,
  cta_url         TEXT,                             -- lien tracké (bouton d'action)
  status          TEXT NOT NULL DEFAULT 'draft',    -- draft | scheduled | sending | sent | failed | canceled
  scheduled_at    TIMESTAMPTZ,
  sent_at         TIMESTAMPTZ,
  audience_count  INT NOT NULL DEFAULT 0,
  created_by      UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_campaigns_tenant ON notification_campaigns (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_campaigns_scheduled ON notification_campaigns (status, scheduled_at)
  WHERE status = 'scheduled';

-- ------------------------------------------------------------
-- 3) notifications = 1 ligne par envoi unitaire, enrichie du tracking
-- ------------------------------------------------------------
ALTER TABLE notifications
  ADD COLUMN IF NOT EXISTS campaign_id   UUID REFERENCES notification_campaigns(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS channel       TEXT NOT NULL DEFAULT 'wallet',  -- wallet | email (futur)
  ADD COLUMN IF NOT EXISTS cta_url       TEXT,
  ADD COLUMN IF NOT EXISTS click_token   TEXT,                            -- /n/:token -> redirection trackée
  ADD COLUMN IF NOT EXISTS delivered_at  TIMESTAMPTZ,                     -- le tel a bien retéléchargé le pass
  ADD COLUMN IF NOT EXISTS clicked_at    TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS converted_at  TIMESTAMPTZ,                     -- transaction dans les 72 h
  ADD COLUMN IF NOT EXISTS revenue       NUMERIC(12,2),                   -- CA attribué à la notif
  ADD COLUMN IF NOT EXISTS error         TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_notif_click_token ON notifications (click_token)
  WHERE click_token IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_notif_tenant_date ON notifications (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notif_campaign ON notifications (campaign_id);
CREATE INDEX IF NOT EXISTS idx_notif_pass_date ON notifications (pass_id, created_at DESC);

-- ------------------------------------------------------------
-- 4) Journal d'événements bruts (audit fin, un événement = une ligne)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS notification_events (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  notification_id UUID NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
  tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  type            TEXT NOT NULL,   -- queued|sent|failed|delivered|click|conversion|unsubscribe
  meta            JSONB NOT NULL DEFAULT '{}',
  ip              TEXT,
  user_agent      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_notif_events_notif ON notification_events (notification_id, created_at);
CREATE INDEX IF NOT EXISTS idx_notif_events_tenant ON notification_events (tenant_id, type, created_at DESC);
