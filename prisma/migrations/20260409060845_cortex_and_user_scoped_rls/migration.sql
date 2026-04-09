-- Tenant isolation hardening — Phase 2.
--
-- Brings every tenant-scoped table that was added AFTER the original RLS
-- migration (20260318_add_row_level_security) under the same tenant
-- isolation policy. The original migration covers 10 tables; this one
-- adds the 6 Cortex tables (added in 20260408225632 and 20260409013931)
-- plus notification_preferences, totp_secrets, and password_reset_tokens,
-- which are user-scoped and inherit their tenant via users.account_id.
--
-- Failure mode this fixes: even if Failure A (DATABASE_URL connecting as
-- the postgres superuser, which bypasses RLS) is fixed by switching the
-- runtime role to westbridge_app, the nine tables touched here would
-- still be wide open because they have no policy. Adding the policies is
-- a NO-OP under the current superuser role, so this migration is safe to
-- deploy ahead of the role switch.
--
-- Column convention: snake_case at the database layer (Prisma maps to
-- camelCase in the generated client). Verify against \d <table> if you
-- regenerate this file.

-- ─── Idempotent role creation ──────────────────────────────────────────────
-- Mirrors the DO $$ block in 20260318_add_row_level_security/migration.sql.
-- Repeated here so this migration is self-contained: if a database has had
-- the schema bootstrapped via `prisma db push` instead of `migrate deploy`,
-- the original DO $$ block was skipped and the role does not yet exist.
-- The role itself is NOLOGIN at this stage — actual login + grants are
-- provisioned in Phase 3 by scripts/provision-rls-role.sh against staging
-- and production.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'westbridge_app') THEN
    CREATE ROLE westbridge_app;
  END IF;
END
$$;

-- ─── Cortex tables (account-scoped via account_id FK) ──────────────────────

ALTER TABLE cortex_events                ENABLE ROW LEVEL SECURITY;
ALTER TABLE cortex_conversations         ENABLE ROW LEVEL SECURITY;
ALTER TABLE cortex_execution_logs        ENABLE ROW LEVEL SECURITY;
ALTER TABLE cortex_approval_requests     ENABLE ROW LEVEL SECURITY;
ALTER TABLE cortex_memory                ENABLE ROW LEVEL SECURITY;
ALTER TABLE cortex_feedback              ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation_cortex_events ON cortex_events
  FOR ALL TO westbridge_app
  USING (account_id = current_setting('app.current_account_id', true));

CREATE POLICY tenant_isolation_cortex_conversations ON cortex_conversations
  FOR ALL TO westbridge_app
  USING (account_id = current_setting('app.current_account_id', true));

CREATE POLICY tenant_isolation_cortex_execution_logs ON cortex_execution_logs
  FOR ALL TO westbridge_app
  USING (account_id = current_setting('app.current_account_id', true));

CREATE POLICY tenant_isolation_cortex_approval_requests ON cortex_approval_requests
  FOR ALL TO westbridge_app
  USING (account_id = current_setting('app.current_account_id', true));

CREATE POLICY tenant_isolation_cortex_memory ON cortex_memory
  FOR ALL TO westbridge_app
  USING (account_id = current_setting('app.current_account_id', true));

CREATE POLICY tenant_isolation_cortex_feedback ON cortex_feedback
  FOR ALL TO westbridge_app
  USING (account_id = current_setting('app.current_account_id', true));

-- ─── User-scoped tables (tenant via users.account_id) ──────────────────────
--
-- These tables don't have a direct account_id column — they FK to users.
-- Mirror the existing sessions policy by joining through users so that a
-- row is visible only when its owning user belongs to the current tenant.
-- Subquery is in the USING clause so it's evaluated per-row at policy
-- check time; performance is fine because users.account_id is indexed.

ALTER TABLE notification_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE totp_secrets             ENABLE ROW LEVEL SECURITY;
ALTER TABLE password_reset_tokens    ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation_notification_preferences ON notification_preferences
  FOR ALL TO westbridge_app
  USING (user_id IN (
    SELECT id FROM users
    WHERE account_id = current_setting('app.current_account_id', true)
  ));

CREATE POLICY tenant_isolation_totp_secrets ON totp_secrets
  FOR ALL TO westbridge_app
  USING (user_id IN (
    SELECT id FROM users
    WHERE account_id = current_setting('app.current_account_id', true)
  ));

CREATE POLICY tenant_isolation_password_reset_tokens ON password_reset_tokens
  FOR ALL TO westbridge_app
  USING (user_id IN (
    SELECT id FROM users
    WHERE account_id = current_setting('app.current_account_id', true)
  ));

-- Note: this migration is a NO-OP for the postgres superuser. Policies are
-- only consulted for the westbridge_app role. To enforce, see Phase 3 of
-- the tenant isolation hardening spec.
