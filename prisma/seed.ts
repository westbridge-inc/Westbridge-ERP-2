/**
 * Prisma seed script — bootstraps a local dev environment with Caribbean defaults.
 *
 * Run: npx prisma db seed
 *
 * Creates:
 *  - A demo account (Westbridge Demo Co.) with GYD defaults
 *  - An owner user (admin@westbridge.local / password123)
 *  - A member user (member@westbridge.local / password123)
 *
 * Idempotent: safe to run multiple times (upserts by email).
 */

import { PrismaClient } from "@prisma/client";
import { createHash, randomBytes } from "node:crypto";

const prisma = new PrismaClient();

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** SHA-256 hash (matches the auth module's session token hashing) */
function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

/**
 * Hash password with bcrypt.
 * Falls back to SHA-256 if bcrypt is not installed (e.g., CI without native deps).
 */
async function hashPassword(plain: string): Promise<string> {
  try {
    const bcrypt = await import("bcrypt");
    return await bcrypt.hash(plain, 12);
  } catch {
    // bcrypt not available (no native deps) — use SHA-256 as fallback for dev seed
    return sha256(plain);
  }
}

// ─── Seed Data ────────────────────────────────────────────────────────────────

const SEED_PASSWORD = "password123";

const DEMO_ACCOUNT = {
  email: "admin@westbridge.local",
  companyName: "Westbridge Demo Co.",
  plan: "Business",
  status: "active",
  currency: "GYD",
  country: "GY",
  timezone: "America/Guyana",
  modulesSelected: [
    "invoicing",
    "crm",
    "inventory",
    "expenses",
    "hr",
    "procurement",
    "quotations",
    "accounting",
    "analytics",
  ],
};

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log("🌱 Seeding database with Caribbean defaults...\n");

  const passwordHash = await hashPassword(SEED_PASSWORD);

  // 1. Upsert demo account
  const account = await prisma.account.upsert({
    where: { email: DEMO_ACCOUNT.email },
    update: {
      companyName: DEMO_ACCOUNT.companyName,
      plan: DEMO_ACCOUNT.plan,
      status: DEMO_ACCOUNT.status,
      currency: DEMO_ACCOUNT.currency,
      country: DEMO_ACCOUNT.country,
      timezone: DEMO_ACCOUNT.timezone,
      modulesSelected: DEMO_ACCOUNT.modulesSelected,
    },
    create: DEMO_ACCOUNT,
  });

  console.log(`  ✓ Account: ${account.companyName} (${account.id})`);
  console.log(`    Currency: ${account.currency} | Country: ${account.country} | TZ: ${account.timezone}`);

  // 2. Upsert owner user
  const owner = await prisma.user.upsert({
    where: {
      accountId_email: {
        accountId: account.id,
        email: "admin@westbridge.local",
      },
    },
    update: {
      name: "Admin User",
      role: "owner",
      passwordHash,
      status: "active",
    },
    create: {
      accountId: account.id,
      email: "admin@westbridge.local",
      name: "Admin User",
      role: "owner",
      passwordHash,
      status: "active",
    },
  });

  console.log(`  ✓ Owner:   ${owner.name} <${owner.email}> (${owner.id})`);

  // 3. Upsert member user
  const member = await prisma.user.upsert({
    where: {
      accountId_email: {
        accountId: account.id,
        email: "member@westbridge.local",
      },
    },
    update: {
      name: "Team Member",
      role: "member",
      passwordHash,
      status: "active",
    },
    create: {
      accountId: account.id,
      email: "member@westbridge.local",
      name: "Team Member",
      role: "member",
      passwordHash,
      status: "active",
    },
  });

  console.log(`  ✓ Member:  ${member.name} <${member.email}> (${member.id})`);

  // 4. Create a demo session for the owner (useful for immediate API testing)
  const rawToken = randomBytes(32).toString("hex");
  const tokenHash = sha256(rawToken);

  await prisma.session.upsert({
    where: { token: tokenHash },
    update: {},
    create: {
      userId: owner.id,
      token: tokenHash,
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), // 30 days
      ipAddress: "127.0.0.1",
      userAgent: "seed-script",
    },
  });

  console.log(`  ✓ Session: dev token created (30-day expiry)`);

  // 5. Seed an initial audit log entry
  await prisma.auditLog.create({
    data: {
      accountId: account.id,
      userId: owner.id,
      action: "seed.complete",
      resource: "system",
      metadata: {
        seedVersion: "1.0.0",
        caribbeanDefaults: {
          currency: "GYD",
          vatRate: 0.14,
          nisEmployerRate: 0.088,
          nisEmployeeRate: 0.056,
          nisCeiling: 280_000,
          payeThreshold: 780_000,
        },
      },
      severity: "info",
      outcome: "success",
    },
  });

  console.log(`  ✓ Audit:   seed.complete logged`);

  console.log("\n─── Seed Summary ────────────────────────────────────────────");
  console.log(`  Account:  ${DEMO_ACCOUNT.companyName}`);
  console.log(`  Currency: GYD (Guyanese Dollar)`);
  console.log(`  Country:  GY (Guyana)`);
  console.log(`  Timezone: America/Guyana`);
  console.log(`  Modules:  ${DEMO_ACCOUNT.modulesSelected.length} enabled`);
  console.log(`  Users:    admin@westbridge.local / ${SEED_PASSWORD}`);
  console.log(`            member@westbridge.local / ${SEED_PASSWORD}`);
  console.log("─────────────────────────────────────────────────────────────\n");
}

main()
  .catch((e) => {
    console.error("❌ Seed failed:", e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
