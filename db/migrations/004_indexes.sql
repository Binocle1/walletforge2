-- Migration 004: Index de performances (Lot C)

CREATE INDEX IF NOT EXISTS idx_customer_passes_tenant_id ON customer_passes(tenant_id);
CREATE INDEX IF NOT EXISTS idx_transactions_created_at ON transactions(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_transactions_tenant_created ON transactions(tenant_id, created_at DESC);
