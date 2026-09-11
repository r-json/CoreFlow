/**
 * Shared fixtures for INTEGRATION tests, which run against real PostgreSQL.
 *
 * Not exported from any production path. Nothing here may be imported by a unit
 * test: the point of the split is that a unit suite can never be mistaken for
 * database validation.
 */

import { PrismaClient, OrgRole, MembershipStatus } from '@prisma/client';

/** Every table, child-first, so a TRUNCATE is unambiguous even without CASCADE. */
const TABLES = [
  'ReconciliationFinding',
  'ReconciliationRun',
  'AuditEvent',
  'BlockchainTransaction',
  'OracleAttestation',
  'Approval',
  'Payment',
  'PayrollBatch',
  'Escrow',
  'Worker',
  'Project',
  'Invitation',
  'OrgMember',
  'Organization',
  'ChainEvent',
  'IndexerCursor',
  'TimeLog',
  'AuditLog',
  'Session',
  'AuthChallenge',
  'User',
] as const;

/**
 * Empty every table.
 *
 * TRUNCATE rather than deleteMany: it is one statement, it resets nothing we rely
 * on, and it will not silently leave rows behind because of a cascade rule a test
 * author did not expect.
 */
export async function resetDatabase(prisma: PrismaClient): Promise<void> {
  const list = TABLES.map((t) => `"${t}"`).join(', ');
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`);
}

/**
 * Refuse to run against anything but a local database.
 *
 * The npm script runs `check-env` first, but a test invoked directly bypasses it.
 * These tests TRUNCATE every table, so this is the guard that matters most.
 */
export function assertLocalDatabase(): void {
  const url = process.env.DATABASE_URL ?? '';
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    throw new Error('DATABASE_URL is unset or unparseable; refusing to run.');
  }
  const LOCAL = new Set(['localhost', '127.0.0.1', '::1', 'host.docker.internal', 'postgres', 'db']);
  if (!LOCAL.has(host)) {
    throw new Error(
      `Refusing to run integration tests against non-local host "${host}". ` +
        'These tests TRUNCATE every table. See docs/ENVIRONMENTS.md.',
    );
  }
}

export interface SeededOrg {
  orgId: string;
  slug: string;
  members: Record<string, { userId: string; wallet: string; role: OrgRole }>;
}

function wallet(tag: string): string {
  return ('G' + tag.toUpperCase().replace(/[^A-Z2-7]/g, '')).padEnd(56, 'A');
}

/** An organization with one active member per role. */
export async function seedOrganization(
  prisma: PrismaClient,
  slug: string,
): Promise<SeededOrg> {
  const org = await prisma.organization.create({
    data: { name: slug, slug },
    select: { id: true },
  });

  const roles: OrgRole[] = [
    OrgRole.OWNER,
    OrgRole.ADMIN,
    OrgRole.MANAGER,
    OrgRole.FINANCE,
    OrgRole.WORKER,
    OrgRole.VIEWER,
  ];

  const members: SeededOrg['members'] = {};
  for (const role of roles) {
    const tag = `${slug}${role}`;
    const address = wallet(tag);
    const user = await prisma.user.create({
      data: { walletAddress: address },
      select: { id: true },
    });
    await prisma.orgMember.create({
      data: {
        orgId: org.id,
        userId: user.id,
        role,
        status: MembershipStatus.ACTIVE,
      },
    });
    members[role] = { userId: user.id, wallet: address, role };
  }

  return { orgId: org.id, slug, members };
}

/** A worker row, for testing the payee link. */
export async function seedWorker(
  prisma: PrismaClient,
  orgId: string,
  tag: string,
): Promise<{ id: string; walletAddress: string }> {
  return prisma.worker.create({
    data: { orgId, walletAddress: wallet(tag), displayName: tag },
    select: { id: true, walletAddress: true },
  });
}

export function payeeWallet(tag: string): string {
  return wallet(tag);
}

/** A CSV whose rows satisfy the contract's hours x rate == amount invariant. */
export function payrollCsv(
  rows: { tag: string; amount: string; hours: number; rate: string }[],
  period: { start: string; end: string } = { start: '2026-09-01', end: '2026-09-15' },
): string {
  return [
    'recipient,amount,asset,hours,rate,period_start,period_end',
    ...rows.map(
      (r) =>
        `${wallet(r.tag)},${r.amount},USDC,${r.hours},${r.rate},${period.start},${period.end}`,
    ),
  ].join('\n');
}
