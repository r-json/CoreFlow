/**
 * Prisma seed script for CoreFlow.
 *
 * Seeds the first ADMIN user so the system can bootstrap role management.
 * Run with: npx prisma db seed
 *
 * To designate yourself as the first admin, either:
 *  1. Set the ADMIN_WALLET_ADDRESS environment variable to your Stellar public key, or
 *  2. Set the ADMIN_WALLETS env var in .env.local (used at runtime for auto-promotion), or
 *  3. Edit the PLACEHOLDER_ADMIN_ADDRESS constant below.
 */

import { PrismaClient, Role } from '@prisma/client';

const prisma = new PrismaClient();

// ─── Configuration ───────────────────────────────────────────────────────────
// Replace this with your actual Stellar public key, or set the
// ADMIN_WALLET_ADDRESS environment variable before running the seed.
const PLACEHOLDER_ADMIN_ADDRESS =
  process.env.ADMIN_WALLET_ADDRESS ||
  'GBPLBGLHRDLWGA4XXIQOHCQXP23EN4IPJBCOTZ7KRDJXM5Y7YKPIL3SG';

async function main() {
  console.log('🌱 CoreFlow database seed starting...\n');

  // ─── Check for existing admin ────────────────────────────────────────────
  const existingAdmin = await prisma.user.findFirst({
    where: { role: Role.ADMIN },
  });

  if (existingAdmin) {
    console.log(`✅ An ADMIN already exists:`);
    console.log(`   Wallet: ${existingAdmin.walletAddress}`);
    console.log(`   Role:   ${existingAdmin.role}`);
    console.log(`   Since:  ${existingAdmin.createdAt.toISOString()}\n`);
    console.log('No changes made. To add more admins, use the admin panel or the API.');
    return;
  }

  // ─── Create the first admin ──────────────────────────────────────────────
  console.log(`📌 No ADMIN found. Creating the first admin...\n`);
  console.log(`   Wallet: ${PLACEHOLDER_ADMIN_ADDRESS}`);
  console.log(`   Role:   ADMIN\n`);

  const admin = await prisma.user.upsert({
    where: { walletAddress: PLACEHOLDER_ADMIN_ADDRESS },
    create: {
      walletAddress: PLACEHOLDER_ADMIN_ADDRESS,
      role: Role.ADMIN,
    },
    update: {
      role: Role.ADMIN,
    },
  });

  console.log(`✅ Admin created successfully!`);
  console.log(`   ID:     ${admin.id}`);
  console.log(`   Wallet: ${admin.walletAddress}`);
  console.log(`   Role:   ${admin.role}\n`);

  // ─── Audit log ───────────────────────────────────────────────────────────
  await prisma.auditLog.create({
    data: {
      action: 'role.seed',
      actor: 'system',
      target: admin.walletAddress,
      metadata: JSON.stringify({ role: Role.ADMIN, source: 'prisma-seed' }),
    },
  });

  console.log('📝 Audit log entry created for seed operation.');
  console.log('\n🎉 Seed complete! You can now sign in with Freighter using this wallet.');
  console.log('   The wallet will automatically be recognized as ADMIN.\n');

  // ─── Summary table ──────────────────────────────────────────────────────
  const userCount = await prisma.user.count();
  const adminCount = await prisma.user.count({ where: { role: Role.ADMIN } });
  const employeeCount = await prisma.user.count({ where: { role: Role.EMPLOYEE } });

  console.log('┌─────────────────────────────────────┐');
  console.log('│ CoreFlow User Summary               │');
  console.log('├─────────────────────────────────────┤');
  console.log(`│ Total Users:   ${String(userCount).padStart(20, ' ')} │`);
  console.log(`│ Admins:        ${String(adminCount).padStart(20, ' ')} │`);
  console.log(`│ Employees:     ${String(employeeCount).padStart(20, ' ')} │`);
  console.log('└─────────────────────────────────────┘');
}

main()
  .catch((e) => {
    console.error('❌ Seed failed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
