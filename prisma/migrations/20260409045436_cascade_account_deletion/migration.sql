-- Cascade account deletion (Big-4 audit blockers B1 + B2)
--
-- The published Privacy Policy promises full erasure of customer data
-- within 30 days of account deletion (with backup purge within 90 days),
-- but the schema previously left several child tables with no FK relation
-- to their parent (notification_preferences, totp_secrets) so they would
-- orphan rather than cascade. AuditLog had ON DELETE RESTRICT for SOC 2 /
-- GRA retention (see migration 20260318_audit_log_restrict), which made
-- a hard delete of an account literally impossible.
--
-- Resolution:
--   1. Add FK + ON DELETE CASCADE to notification_preferences and
--      totp_secrets so they purge through users → accounts.
--   2. Switch audit_logs FK from RESTRICT to SET NULL and make
--      account_id nullable. The hard-delete worker (account-cleanup
--      service) anonymizes audit log rows in place — scrubbing PII
--      columns (ip_address, user_agent), nulling user_id, and clearing
--      metadata — *before* deleting the parent account. The SET NULL
--      then severs the FK link without dropping the row, so security
--      history survives for SOC 2 / GRA retention while the GDPR
--      Art. 17 right-to-erasure of customer data is honored.

-- ─── audit_logs: RESTRICT → SET NULL, account_id nullable ───────────────
ALTER TABLE "audit_logs" DROP CONSTRAINT IF EXISTS "audit_logs_account_id_fkey";
ALTER TABLE "audit_logs" ALTER COLUMN "account_id" DROP NOT NULL;
ALTER TABLE "audit_logs"
  ADD CONSTRAINT "audit_logs_account_id_fkey"
  FOREIGN KEY ("account_id") REFERENCES "accounts"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- ─── notification_preferences: add FK + cascade ─────────────────────────
ALTER TABLE "notification_preferences"
  ADD CONSTRAINT "notification_preferences_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- ─── totp_secrets: add FK + cascade ─────────────────────────────────────
ALTER TABLE "totp_secrets"
  ADD CONSTRAINT "totp_secrets_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
