-- Migrate billing fields from 2Checkout to PowerTranz
-- This migration renames the payment-related columns to be provider-agnostic.

-- Account table: rename 2Checkout columns to PowerTranz equivalents
ALTER TABLE "accounts" RENAME COLUMN "twoco_order_id" TO "payment_transaction_id";
ALTER TABLE "accounts" RENAME COLUMN "twoco_customer_id" TO "payment_rrn";

-- Subscription table: rename 2Checkout subscription ID
ALTER TABLE "subscriptions" RENAME COLUMN "twoco_subscription_id" TO "payment_subscription_id";

-- Update index on subscriptions (drop old, create new)
DROP INDEX IF EXISTS "subscriptions_twoco_subscription_id_idx";
CREATE INDEX "subscriptions_payment_subscription_id_idx" ON "subscriptions"("payment_subscription_id");
