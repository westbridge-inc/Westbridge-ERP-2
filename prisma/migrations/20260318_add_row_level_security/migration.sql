-- P2: Row-Level Security for multi-tenant isolation (defense-in-depth)
-- Even if app code misses a WHERE clause, RLS prevents cross-tenant access

-- Create application role if not exists
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'westbridge_app') THEN
    CREATE ROLE westbridge_app;
  END IF;
END
$$;

-- Enable RLS on all tenant-scoped tables
ALTER TABLE accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE invite_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE sso_configs ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE webhook_endpoints ENABLE ROW LEVEL SECURITY;

-- Policies: filter by current_setting('app.current_account_id')
CREATE POLICY tenant_isolation_accounts ON accounts
  FOR ALL TO westbridge_app
  USING (id = current_setting('app.current_account_id', true));

CREATE POLICY tenant_isolation_users ON users
  FOR ALL TO westbridge_app
  USING (account_id = current_setting('app.current_account_id', true));

CREATE POLICY tenant_isolation_sessions ON sessions
  FOR ALL TO westbridge_app
  USING (user_id IN (SELECT id FROM users WHERE account_id = current_setting('app.current_account_id', true)));

CREATE POLICY tenant_isolation_subscriptions ON subscriptions
  FOR ALL TO westbridge_app
  USING (account_id = current_setting('app.current_account_id', true));

CREATE POLICY tenant_isolation_audit_logs ON audit_logs
  FOR ALL TO westbridge_app
  USING (account_id = current_setting('app.current_account_id', true));

CREATE POLICY tenant_isolation_api_keys ON api_keys
  FOR ALL TO westbridge_app
  USING (account_id = current_setting('app.current_account_id', true));

CREATE POLICY tenant_isolation_invite_tokens ON invite_tokens
  FOR ALL TO westbridge_app
  USING (account_id = current_setting('app.current_account_id', true));

CREATE POLICY tenant_isolation_sso_configs ON sso_configs
  FOR ALL TO westbridge_app
  USING (account_id = current_setting('app.current_account_id', true));

CREATE POLICY tenant_isolation_billing_invoices ON billing_invoices
  FOR ALL TO westbridge_app
  USING (account_id = current_setting('app.current_account_id', true));

CREATE POLICY tenant_isolation_webhook_endpoints ON webhook_endpoints
  FOR ALL TO westbridge_app
  USING (account_id = current_setting('app.current_account_id', true));

-- Note: RLS is enabled but only enforced for the 'westbridge_app' role.
-- The default superuser role bypasses RLS, so existing Prisma operations work unchanged.
-- To fully enforce, set the DATABASE_URL to use the westbridge_app role.
