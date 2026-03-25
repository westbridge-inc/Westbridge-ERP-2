-- Add composite indexes on (id, version) for optimistic locking queries
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_accounts_version ON accounts(id, version);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_users_version ON users(id, version);
