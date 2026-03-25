-- P0: Change AuditLog FK from CASCADE to RESTRICT
-- Audit logs must survive account deletion for SOC 2 (1-year) and GRA (7-year) retention
ALTER TABLE audit_logs DROP CONSTRAINT IF EXISTS audit_logs_account_id_fkey;
ALTER TABLE audit_logs
  ADD CONSTRAINT audit_logs_account_id_fkey
  FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE RESTRICT ON UPDATE CASCADE;
