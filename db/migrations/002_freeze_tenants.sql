-- Migration 002: Add is_frozen to tenants
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS is_frozen BOOLEAN NOT NULL DEFAULT false;
