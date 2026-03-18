-- P1: Database-level CHECK constraints for all enum-like String fields
-- Prevents invalid values from being stored even via raw SQL or migration bugs

-- Account constraints
ALTER TABLE accounts ADD CONSTRAINT chk_account_plan
  CHECK (plan IN ('Solo', 'Starter', 'Growth', 'Business', 'Enterprise'));
ALTER TABLE accounts ADD CONSTRAINT chk_account_status
  CHECK (status IN ('pending', 'active', 'past_due', 'canceled'));

-- User constraints
ALTER TABLE users ADD CONSTRAINT chk_user_role
  CHECK (role IN ('owner', 'admin', 'manager', 'member', 'viewer'));
ALTER TABLE users ADD CONSTRAINT chk_user_status
  CHECK (status IN ('active', 'suspended', 'invited'));

-- Subscription constraints
ALTER TABLE subscriptions ADD CONSTRAINT chk_subscription_status
  CHECK (status IN ('active', 'canceled', 'past_due', 'trialing'));

-- AuditLog constraints
ALTER TABLE audit_logs ADD CONSTRAINT chk_audit_severity
  CHECK (severity IN ('info', 'warn', 'critical'));
ALTER TABLE audit_logs ADD CONSTRAINT chk_audit_outcome
  CHECK (outcome IN ('success', 'failure', 'error'));

-- BillingInvoice constraints
ALTER TABLE billing_invoices ADD CONSTRAINT chk_invoice_status
  CHECK (status IN ('paid', 'pending', 'failed', 'refunded'));

-- Lead constraints
ALTER TABLE leads ADD CONSTRAINT chk_lead_type
  CHECK (type IN ('demo', 'newsletter'));

-- SSO constraints
ALTER TABLE sso_configs ADD CONSTRAINT chk_sso_provider
  CHECK (provider IN ('oidc', 'saml'));

-- InviteToken constraints
ALTER TABLE invite_tokens ADD CONSTRAINT chk_invite_role
  CHECK (role IN ('owner', 'admin', 'manager', 'member', 'viewer'));
