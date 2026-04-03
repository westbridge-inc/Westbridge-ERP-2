-- AlterTable
ALTER TABLE "accounts" ADD COLUMN "trial_ends_at" TIMESTAMP(3);
ALTER TABLE "accounts" ADD COLUMN "trial_ai_limit" INTEGER NOT NULL DEFAULT 10;
