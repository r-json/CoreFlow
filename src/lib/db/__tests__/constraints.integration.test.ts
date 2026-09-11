/**
 * What PostgreSQL itself enforces.
 *
 * CoreFlow puts part of its security model in the database: composite tenant
 * foreign keys, unique idempotency indexes, a partial unique index for run
 * locking, bigint money columns. None of that is provable in TypeScript — a test
 * double enforces whatever its author taught it, and the two drift silently.
 *
 * These tests therefore make the assertions that only a real database can settle,
 * including direct reproductions of two defects that survived the unit suite.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { PrismaClient, OrgRole, PaymentState, ApprovalDecision, RunStatus } from '@prisma/client';
import {
  assertLocalDatabase,
  resetDatabase,
  seedOrganization,
  payeeWallet,
  type SeededOrg,
} from './helpers';

assertLocalDatabase();

const prisma = new PrismaClient();

let orgA: SeededOrg;
let orgB: SeededOrg;

beforeAll(async () => {
  await prisma.$connect();
});

afterAll(async () => {
  await prisma.$disconnect();
});

beforeEach(async () => {
  await resetDatabase(prisma);
  orgA = await seedOrganization(prisma, 'orga');
  orgB = await seedOrganization(prisma, 'orgb');
});

/** A batch with one payment, in the given organization. */
async function seedBatchWithPayment(org: SeededOrg, reference: string) {
  const batch = await prisma.payrollBatch.create({
    data: { orgId: org.orgId, reference },
    select: { id: true },
  });
  const payment = await prisma.payment.create({
    data: {
      orgId: org.orgId,
      batchId: batch.id,
      recipientAddress: payeeWallet('payee' + reference),
      amountBaseUnits: 10_000_000_000n,
      rateBaseUnits: 250_000_000n,
      hours: 40n,
    },
    select: { id: true },
  });
  return { batchId: batch.id, paymentId: payment.id };
}

// ---------------------------------------------------------------------------
// Reproduction A — the defect the unit suite could not see
// ---------------------------------------------------------------------------

describe('A. Approval requires orgId (the composite-FK defect)', () => {
  it('rejects an approval created without orgId', async () => {
    const { paymentId } = await seedBatchWithPayment(orgA, 'CF-A1');

    // EXACTLY what src/lib/payments/actions.ts did before the fix. `db` is typed
    // `any` there, so TypeScript could not object, and the in-memory double did
    // not enforce required columns — so this shipped and passed.
    // Prisma reports the missing RELATION, not the missing column:
    //   PrismaClientValidationError: Argument `org` is missing.
    // Worth recording precisely, because "orgId" does not appear in the message —
    // so anyone grepping logs for the column name would not find this failure.
    await expect(
      (prisma.approval.create as any)({
        data: {
          paymentId,
          role: OrgRole.MANAGER,
          decision: ApprovalDecision.APPROVED,
          actorAddress: orgA.members.MANAGER.wallet,
        },
      }),
    ).rejects.toThrow(/Argument `org` is missing/);

    expect(await prisma.approval.count()).toBe(0);
  });

  it('accepts the same approval once orgId is supplied', async () => {
    const { paymentId } = await seedBatchWithPayment(orgA, 'CF-A2');
    const approval = await prisma.approval.create({
      data: {
        orgId: orgA.orgId,
        paymentId,
        role: OrgRole.MANAGER,
        decision: ApprovalDecision.APPROVED,
        actorAddress: orgA.members.MANAGER.wallet,
      },
    });
    expect(approval.orgId).toBe(orgA.orgId);
  });

  it('enforces one decision per role per payment', async () => {
    const { paymentId } = await seedBatchWithPayment(orgA, 'CF-A3');
    const base = {
      orgId: orgA.orgId,
      paymentId,
      role: OrgRole.MANAGER,
      decision: ApprovalDecision.APPROVED,
      actorAddress: orgA.members.MANAGER.wallet,
    };
    await prisma.approval.create({ data: base });
    // A second manager approval is a duplicate, not a new fact.
    await expect(prisma.approval.create({ data: base })).rejects.toMatchObject({
      code: 'P2002',
    });

    // The other half of the gate is a different row, and allowed.
    await prisma.approval.create({
      data: { ...base, role: OrgRole.FINANCE, actorAddress: orgA.members.FINANCE.wallet },
    });
    expect(await prisma.approval.count()).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Reproduction B — cross-tenant relations
// ---------------------------------------------------------------------------

describe('B. Composite foreign keys reject cross-tenant rows', () => {
  it('refuses a payment in org A attached to a batch in org B', async () => {
    const batchB = await prisma.payrollBatch.create({
      data: { orgId: orgB.orgId, reference: 'CF-B1' },
      select: { id: true },
    });

    // Only the DATABASE can refuse this. With a plain `batchId` foreign key the
    // row would be accepted, and tenant isolation would depend entirely on the
    // application remembering to check.
    await expect(
      prisma.payment.create({
        data: {
          orgId: orgA.orgId,
          batchId: batchB.id,
          recipientAddress: payeeWallet('x'),
          amountBaseUnits: 1n,
          rateBaseUnits: 1n,
          hours: 1n,
        },
      }),
    ).rejects.toMatchObject({ code: 'P2003' });

    expect(await prisma.payment.count()).toBe(0);
  });

  it('refuses an approval in org B against a payment in org A', async () => {
    const { paymentId } = await seedBatchWithPayment(orgA, 'CF-B2');
    await expect(
      prisma.approval.create({
        data: {
          orgId: orgB.orgId,
          paymentId,
          role: OrgRole.MANAGER,
          decision: ApprovalDecision.APPROVED,
          actorAddress: orgB.members.MANAGER.wallet,
        },
      }),
    ).rejects.toMatchObject({ code: 'P2003' });
  });

  it('refuses a payment pointing at another tenant project or worker', async () => {
    const projectB = await prisma.project.create({
      data: { orgId: orgB.orgId, code: 'PB', name: 'B project' },
      select: { id: true },
    });
    const batchA = await prisma.payrollBatch.create({
      data: { orgId: orgA.orgId, reference: 'CF-B3' },
      select: { id: true },
    });

    await expect(
      prisma.payment.create({
        data: {
          orgId: orgA.orgId,
          batchId: batchA.id,
          projectId: projectB.id,
          recipientAddress: payeeWallet('y'),
          amountBaseUnits: 1n,
          rateBaseUnits: 1n,
          hours: 1n,
        },
      }),
    ).rejects.toMatchObject({ code: 'P2003' });
  });

  it('refuses an audit event in org B referencing an org A batch', async () => {
    const { batchId } = await seedBatchWithPayment(orgA, 'CF-B4');
    await expect(
      prisma.auditEvent.create({
        data: { orgId: orgB.orgId, type: 'probe', batchId },
      }),
    ).rejects.toMatchObject({ code: 'P2003' });
  });

  it('allows the same wallet to be a worker in both organizations', async () => {
    const address = payeeWallet('shared');
    await prisma.worker.create({ data: { orgId: orgA.orgId, walletAddress: address } });
    // A contractor working for two clients is normal. Uniqueness is per tenant.
    await prisma.worker.create({ data: { orgId: orgB.orgId, walletAddress: address } });
    expect(await prisma.worker.count()).toBe(2);

    await expect(
      prisma.worker.create({ data: { orgId: orgA.orgId, walletAddress: address } }),
    ).rejects.toMatchObject({ code: 'P2002' });
  });
});

// ---------------------------------------------------------------------------
// Unique and partial indexes
// ---------------------------------------------------------------------------

describe('Unique indexes', () => {
  it('allows many batches with a NULL idempotency key', async () => {
    // Postgres treats NULLs as distinct in a unique index, which is what makes the
    // key optional without forcing every unkeyed batch to collide.
    for (let i = 0; i < 3; i++) {
      await prisma.payrollBatch.create({
        data: { orgId: orgA.orgId, reference: `CF-N${i}`, idempotencyKey: null },
      });
    }
    expect(await prisma.payrollBatch.count()).toBe(3);
  });

  it('permits one batch per (orgId, idempotencyKey) and no more', async () => {
    await prisma.payrollBatch.create({
      data: { orgId: orgA.orgId, reference: 'CF-K1', idempotencyKey: 'key-1' },
    });
    await expect(
      prisma.payrollBatch.create({
        data: { orgId: orgA.orgId, reference: 'CF-K2', idempotencyKey: 'key-1' },
      }),
    ).rejects.toMatchObject({ code: 'P2002' });

    // Scoped to the tenant: two organizations may reuse a key.
    const other = await prisma.payrollBatch.create({
      data: { orgId: orgB.orgId, reference: 'CF-K1', idempotencyKey: 'key-1' },
    });
    expect(other.orgId).toBe(orgB.orgId);
  });

  it('scopes batch references per organization', async () => {
    await prisma.payrollBatch.create({ data: { orgId: orgA.orgId, reference: 'CF-00001' } });
    await prisma.payrollBatch.create({ data: { orgId: orgB.orgId, reference: 'CF-00001' } });
    await expect(
      prisma.payrollBatch.create({ data: { orgId: orgA.orgId, reference: 'CF-00001' } }),
    ).rejects.toMatchObject({ code: 'P2002' });
  });

  it('allows one payment per on-chain slot and no more', async () => {
    const escrow = await prisma.escrow.create({
      data: {
        orgId: orgA.orgId,
        onChainId: 4242,
        contractId: 'CTEST',
        network: 'testnet',
        managerAddress: orgA.members.MANAGER.wallet,
        financeApproverAddress: orgA.members.FINANCE.wallet,
      },
      select: { id: true },
    });
    const batch = await prisma.payrollBatch.create({
      data: { orgId: orgA.orgId, reference: 'CF-S1' },
      select: { id: true },
    });
    const row = (index: number) => ({
      orgId: orgA.orgId,
      batchId: batch.id,
      escrowId: escrow.id,
      onChainPaymentIndex: index,
      recipientAddress: payeeWallet('slot' + index),
      amountBaseUnits: 1n,
      rateBaseUnits: 1n,
      hours: 1n,
    });

    await prisma.payment.create({ data: row(0) });
    await prisma.payment.create({ data: row(1) });
    // This is the constraint that makes re-indexing a three-payee settlement
    // idempotent however many times the events are replayed.
    await expect(prisma.payment.create({ data: row(0) })).rejects.toMatchObject({
      code: 'P2002',
    });
    expect(await prisma.payment.count()).toBe(2);
  });

  it('permits only one RUNNING reconciliation run per organization', async () => {
    await prisma.reconciliationRun.create({
      data: {
        orgId: orgA.orgId,
        correlationId: 'rec_1',
        status: RunStatus.RUNNING,
        scope: 'organization',
      },
    });

    // A partial unique index, so the lock is the database's job rather than a
    // check-then-insert in application code — which is a race by construction.
    await expect(
      prisma.reconciliationRun.create({
        data: {
          orgId: orgA.orgId,
          correlationId: 'rec_2',
          status: RunStatus.RUNNING,
          scope: 'organization',
        },
      }),
    ).rejects.toMatchObject({ code: 'P2002' });

    // Another organization reconciles concurrently, unaffected.
    await prisma.reconciliationRun.create({
      data: {
        orgId: orgB.orgId,
        correlationId: 'rec_3',
        status: RunStatus.RUNNING,
        scope: 'organization',
      },
    });

    // And once the first completes, the next run may start.
    await prisma.reconciliationRun.updateMany({
      where: { correlationId: 'rec_1' },
      data: { status: RunStatus.COMPLETED, completedAt: new Date() },
    });
    const next = await prisma.reconciliationRun.create({
      data: {
        orgId: orgA.orgId,
        correlationId: 'rec_4',
        status: RunStatus.RUNNING,
        scope: 'organization',
      },
    });
    expect(next.status).toBe(RunStatus.RUNNING);
  });
});

// ---------------------------------------------------------------------------
// Money
// ---------------------------------------------------------------------------

describe('Exact money through PostgreSQL', () => {
  it.each([
    ['250.50 USDC', 2_505_000_000n],
    ['1000 USDC', 10_000_000_000n],
    ['one base unit', 1n],
    ['a large payroll', 9_223_372_036_854_775_807n],
  ])('round-trips %s without loss', async (_label, units) => {
    const batch = await prisma.payrollBatch.create({
      data: { orgId: orgA.orgId, reference: `CF-M${units}` },
      select: { id: true },
    });
    const created = await prisma.payment.create({
      data: {
        orgId: orgA.orgId,
        batchId: batch.id,
        recipientAddress: payeeWallet('money'),
        amountBaseUnits: units,
        rateBaseUnits: 1n,
        hours: units,
      },
      select: { id: true, amountBaseUnits: true },
    });

    expect(created.amountBaseUnits).toBe(units);
    expect(typeof created.amountBaseUnits).toBe('bigint');

    // Re-read on a fresh query, not the create's return value.
    const reread = await prisma.payment.findUniqueOrThrow({
      where: { id: created.id },
      select: { amountBaseUnits: true, hours: true },
    });
    expect(reread.amountBaseUnits).toBe(units);
    expect(reread.hours).toBe(units);

    // And what the column actually holds, as text, bypassing the client entirely.
    const raw = await prisma.$queryRawUnsafe<{ amount: string }[]>(
      `SELECT "amountBaseUnits"::text AS amount FROM "Payment" WHERE id = $1`,
      created.id,
    );
    expect(raw[0].amount).toBe(units.toString());
  });

  it('stores bigint columns as int8, so no value is silently a float', async () => {
    const rows = await prisma.$queryRawUnsafe<{ column_name: string; data_type: string }[]>(
      `SELECT column_name, data_type FROM information_schema.columns
        WHERE table_name = 'Payment'
          AND column_name IN ('amountBaseUnits','rateBaseUnits','hours')`,
    );
    expect(rows).toHaveLength(3);
    for (const r of rows) expect(r.data_type).toBe('bigint');
  });

  it('refuses a value that would overflow, rather than wrapping it', async () => {
    const batch = await prisma.payrollBatch.create({
      data: { orgId: orgA.orgId, reference: 'CF-OVF' },
      select: { id: true },
    });
    await expect(
      prisma.payment.create({
        data: {
          orgId: orgA.orgId,
          batchId: batch.id,
          recipientAddress: payeeWallet('ovf'),
          amountBaseUnits: 9_223_372_036_854_775_808n, // int8 max + 1
          rateBaseUnits: 1n,
          hours: 1n,
        },
      }),
    ).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Required columns, cascades, transactions
// ---------------------------------------------------------------------------

describe('Nullability and required columns', () => {
  it('refuses a payment without its tenant or batch', async () => {
    await expect(
      (prisma.payment.create as any)({
        data: {
          recipientAddress: payeeWallet('z'),
          amountBaseUnits: 1n,
          rateBaseUnits: 1n,
          hours: 1n,
        },
      }),
    ).rejects.toThrow();
  });

  it('accepts the nullable provenance columns as absent', async () => {
    const batch = await prisma.payrollBatch.create({
      data: { orgId: orgA.orgId, reference: 'CF-NULL' },
      select: { sourceFilename: true, sourceChecksum: true, idempotencyFingerprint: true },
    });
    expect(batch.sourceFilename).toBeNull();
    expect(batch.sourceChecksum).toBeNull();
    expect(batch.idempotencyFingerprint).toBeNull();
  });
});

describe('Cascades and restrictions', () => {
  it('removes a batch payments when the batch is deleted', async () => {
    const { batchId } = await seedBatchWithPayment(orgA, 'CF-C1');
    await prisma.payrollBatch.delete({ where: { id: batchId } });
    expect(await prisma.payment.count()).toBe(0);
  });

  it('removes an organization entire payroll when the organization is deleted', async () => {
    await seedBatchWithPayment(orgA, 'CF-C2');
    await seedBatchWithPayment(orgB, 'CF-C3');

    await prisma.organization.delete({ where: { id: orgA.orgId } });

    // Org B is untouched. A cascade that reached across tenants would be a far
    // worse failure than a foreign-key error.
    expect(await prisma.payment.count()).toBe(1);
    const survivor = await prisma.payment.findFirstOrThrow({ select: { orgId: true } });
    expect(survivor.orgId).toBe(orgB.orgId);
  });

  it('refuses to delete an escrow that payments still reference', async () => {
    const escrow = await prisma.escrow.create({
      data: {
        orgId: orgA.orgId,
        onChainId: 77,
        contractId: 'CTEST',
        network: 'testnet',
        managerAddress: orgA.members.MANAGER.wallet,
        financeApproverAddress: orgA.members.FINANCE.wallet,
      },
      select: { id: true },
    });
    const batch = await prisma.payrollBatch.create({
      data: { orgId: orgA.orgId, reference: 'CF-C4' },
      select: { id: true },
    });
    const payment = await prisma.payment.create({
      data: {
        orgId: orgA.orgId,
        batchId: batch.id,
        escrowId: escrow.id,
        recipientAddress: payeeWallet('det'),
        amountBaseUnits: 5n,
        rateBaseUnits: 5n,
        hours: 1n,
      },
      select: { id: true },
    });

    // The relation was declared `onDelete: SetNull`, which CANNOT work on a
    // composite FK whose first column is NOT NULL — the delete failed with a
    // confusing "Null constraint violation on the fields: (orgId)". It is now
    // NoAction, so the delete is refused for the real reason.
    await expect(prisma.escrow.delete({ where: { id: escrow.id } })).rejects.toMatchObject({
      code: 'P2003',
    });

    // Refusing is how the record is preserved. Detaching a payment from its escrow
    // would destroy the evidence of what the money was for.
    const after = await prisma.payment.findUniqueOrThrow({
      where: { id: payment.id },
      select: { escrowId: true, amountBaseUnits: true },
    });
    expect(after.escrowId).toBe(escrow.id);
    expect(after.amountBaseUnits).toBe(5n);
  });

  it('still cascades a whole organization away in one statement', async () => {
    // NoAction is checked at the END of the statement, which is why this works
    // where RESTRICT might not: Organization -> Escrow and Organization -> Payment
    // are both Cascade, so parent and child disappear together.
    const escrow = await prisma.escrow.create({
      data: {
        orgId: orgA.orgId,
        onChainId: 78,
        contractId: 'CTEST',
        network: 'testnet',
        managerAddress: orgA.members.MANAGER.wallet,
        financeApproverAddress: orgA.members.FINANCE.wallet,
      },
      select: { id: true },
    });
    const batch = await prisma.payrollBatch.create({
      data: { orgId: orgA.orgId, reference: 'CF-C5' },
      select: { id: true },
    });
    await prisma.payment.create({
      data: {
        orgId: orgA.orgId,
        batchId: batch.id,
        escrowId: escrow.id,
        recipientAddress: payeeWallet('csc'),
        amountBaseUnits: 9n,
        rateBaseUnits: 9n,
        hours: 1n,
      },
    });

    await prisma.organization.delete({ where: { id: orgA.orgId } });

    expect(await prisma.payment.count({ where: { orgId: orgA.orgId } })).toBe(0);
    expect(await prisma.escrow.count({ where: { orgId: orgA.orgId } })).toBe(0);
  });
});

describe('Transaction isolation and rollback', () => {
  it('rolls back every write when a transaction throws', async () => {
    await expect(
      prisma.$transaction(async (tx) => {
        const batch = await tx.payrollBatch.create({
          data: { orgId: orgA.orgId, reference: 'CF-T1' },
          select: { id: true },
        });
        await tx.payment.create({
          data: {
            orgId: orgA.orgId,
            batchId: batch.id,
            recipientAddress: payeeWallet('t1'),
            amountBaseUnits: 1n,
            rateBaseUnits: 1n,
            hours: 1n,
          },
        });
        await tx.auditEvent.create({
          data: { orgId: orgA.orgId, type: 'payroll.batch.created', batchId: batch.id },
        });
        throw new Error('simulated failure after the last write');
      }),
    ).rejects.toThrow('simulated failure');

    // Zero partial financial records. A batch that looked complete while missing a
    // payment would quietly underpay someone.
    expect(await prisma.payrollBatch.count()).toBe(0);
    expect(await prisma.payment.count()).toBe(0);
    expect(await prisma.auditEvent.count()).toBe(0);
  });

  it('does not let one failing transaction undo another committed one', async () => {
    // The in-memory double originally failed this: it snapshotted every table and
    // restored the whole snapshot, so a rollback discarded a concurrent
    // transaction's committed writes. Real Postgres isolates per connection.
    await prisma.$transaction(async (tx) => {
      await tx.payrollBatch.create({ data: { orgId: orgA.orgId, reference: 'CF-KEEP' } });
    });

    await expect(
      prisma.$transaction(async (tx) => {
        await tx.payrollBatch.create({ data: { orgId: orgA.orgId, reference: 'CF-DROP' } });
        throw new Error('rollback');
      }),
    ).rejects.toThrow('rollback');

    const remaining = await prisma.payrollBatch.findMany({ select: { reference: true } });
    expect(remaining.map((b) => b.reference)).toEqual(['CF-KEEP']);
  });

  it('surfaces a constraint violation as a rollback, not a partial write', async () => {
    await prisma.payrollBatch.create({
      data: { orgId: orgA.orgId, reference: 'CF-DUP', idempotencyKey: 'dup-key' },
    });

    await expect(
      prisma.$transaction(async (tx) => {
        const batch = await tx.payrollBatch.create({
          data: { orgId: orgA.orgId, reference: 'CF-DUP2', idempotencyKey: 'dup-key' },
          select: { id: true },
        });
        await tx.payment.create({
          data: {
            orgId: orgA.orgId,
            batchId: batch.id,
            recipientAddress: payeeWallet('dup'),
            amountBaseUnits: 1n,
            rateBaseUnits: 1n,
            hours: 1n,
          },
        });
      }),
    ).rejects.toMatchObject({ code: 'P2002' });

    expect(await prisma.payrollBatch.count()).toBe(1);
    expect(await prisma.payment.count()).toBe(0);
  });
});

describe('Indexes supporting tenant-scoped queries', () => {
  it('indexes the columns every tenant query filters on', async () => {
    const rows = await prisma.$queryRawUnsafe<{ tablename: string; indexdef: string }[]>(
      `SELECT tablename, indexdef FROM pg_indexes
        WHERE schemaname = 'public' AND indexdef LIKE '%orgId%'`,
    );
    const tables = new Set(rows.map((r) => r.tablename));
    // Every table a tenant query filters by organization.
    for (const t of [
      'Payment',
      'PayrollBatch',
      'Escrow',
      'Worker',
      'Project',
      'Approval',
      'AuditEvent',
      'ReconciliationFinding',
      'ReconciliationRun',
      'OrgMember',
    ]) {
      expect(tables).toContain(t);
    }
  });

  it('has an index the planner can use for a tenant payment listing', async () => {
    const batch = await prisma.payrollBatch.create({
      data: { orgId: orgA.orgId, reference: 'CF-IDX' },
      select: { id: true },
    });
    for (let i = 0; i < 50; i++) {
      await prisma.payment.create({
        data: {
          orgId: orgA.orgId,
          batchId: batch.id,
          recipientAddress: payeeWallet('idx' + i),
          amountBaseUnits: BigInt(i + 1),
          rateBaseUnits: 1n,
          hours: BigInt(i + 1),
          state: i % 2 === 0 ? PaymentState.DRAFT : PaymentState.PAID,
        },
      });
    }
    await prisma.$executeRawUnsafe('ANALYZE "Payment"');

    // Asserting that the planner CHOOSES an index would be asserting a cost
    // decision: on a small table a sequential scan is genuinely cheaper, and
    // Postgres is right to pick it. What matters is that a usable index EXISTS, so
    // the query does not degrade to a full scan once a tenant has real volume.
    // Discouraging seqscan makes the planner reveal whether it has one.
    // Both statements must share one connection: SET LOCAL applies only inside a
    // transaction, and issued on its own it is silently discarded — which is why
    // the first attempt at this test still saw a sequential scan.
    const plan = await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL enable_seqscan = off');
      return tx.$queryRawUnsafe<{ 'QUERY PLAN': string }[]>(
        `EXPLAIN SELECT * FROM "Payment" WHERE "orgId" = $1 AND state = 'DRAFT'`,
        orgA.orgId,
      );
    });
    const text = plan.map((r) => r['QUERY PLAN']).join('\n');
    expect(text).toMatch(/Index Scan|Bitmap Index Scan|Bitmap Heap Scan/);
  });
});
