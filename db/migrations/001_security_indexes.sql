-- Migration 001: Security fixes, constraints, and missing indexes
-- Run this against your production database

-- 1. Add CHECK constraints to prevent negative balances
ALTER TABLE customer_passes ADD CONSTRAINT chk_stamps_positive CHECK (stamps >= 0);
ALTER TABLE customer_passes ADD CONSTRAINT chk_points_positive CHECK (points >= 0);
ALTER TABLE customer_passes ADD CONSTRAINT chk_rewards_positive CHECK (rewards_available >= 0);

-- 2. Missing indexes for performance
CREATE INDEX IF NOT EXISTS idx_notifications_pass_automation ON notifications (pass_id, automation_id);
CREATE INDEX IF NOT EXISTS idx_customers_tenant ON customers (tenant_id);
CREATE INDEX IF NOT EXISTS idx_customer_passes_tenant ON customer_passes (tenant_id);
CREATE INDEX IF NOT EXISTS idx_tx_pass_type_date ON transactions (pass_id, type, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_users_tenant ON users (tenant_id);

-- 3. Add client_tx_id for offline idempotency
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS client_tx_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_tx_client_tx_id ON transactions (client_tx_id) WHERE client_tx_id IS NOT NULL;

-- 4. Hash reset tokens (for existing rows, invalidate them)
-- Future tokens will be stored hashed via crypto.createHash('sha256')

-- 5. Make email unique per tenant instead of globally
-- WARNING: This requires dropping the existing unique constraint first.
-- Run manually after verifying no cross-tenant email conflicts:
-- ALTER TABLE users DROP CONSTRAINT IF EXISTS users_email_key;
-- CREATE UNIQUE INDEX IF NOT EXISTS idx_users_tenant_email ON users (tenant_id, email);
