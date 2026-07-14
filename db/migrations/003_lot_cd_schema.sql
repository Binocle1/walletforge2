-- Migration 003: Lot C & D - Gamification, Anti-fraude et RFM

-- 1. Ajout des colonnes pour le Streak et les visites (Gamification)
ALTER TABLE customer_passes 
ADD COLUMN IF NOT EXISTS current_streak INT NOT NULL DEFAULT 0,
ADD COLUMN IF NOT EXISTS last_visit TIMESTAMPTZ;

-- 2. Table pour l'anti-fraude intelligent
CREATE TABLE IF NOT EXISTS alerts (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID REFERENCES tenants(id) ON DELETE CASCADE,
  pass_id       UUID REFERENCES customer_passes(id) ON DELETE CASCADE,
  type          TEXT NOT NULL, -- e.g. 'fraud_limit_exceeded', 'abnormal_amount'
  description   TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'new', -- new | resolved
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Index pour charger les alertes rapidement dans le dashboard
CREATE INDEX IF NOT EXISTS idx_alerts_tenant_status ON alerts(tenant_id, status);
