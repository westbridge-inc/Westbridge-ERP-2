-- AlterTable accounts: add currency, country, timezone, version, deleted_at
ALTER TABLE "accounts" ADD COLUMN "currency" TEXT NOT NULL DEFAULT 'GYD';
ALTER TABLE "accounts" ADD COLUMN "country" TEXT NOT NULL DEFAULT 'GY';
ALTER TABLE "accounts" ADD COLUMN "timezone" TEXT NOT NULL DEFAULT 'America/Guyana';
ALTER TABLE "accounts" ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "accounts" ADD COLUMN "deleted_at" TIMESTAMP(3);

-- CreateIndex accounts: created_at, deleted_at
CREATE INDEX "accounts_created_at_idx" ON "accounts"("created_at");
CREATE INDEX "accounts_deleted_at_idx" ON "accounts"("deleted_at");

-- AlterTable users: add version, deleted_at
ALTER TABLE "users" ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "users" ADD COLUMN "deleted_at" TIMESTAMP(3);

-- CreateIndex users: account_id+deleted_at, account_id+created_at
CREATE INDEX "users_account_id_deleted_at_idx" ON "users"("account_id", "deleted_at");
CREATE INDEX "users_account_id_created_at_idx" ON "users"("account_id", "created_at");
