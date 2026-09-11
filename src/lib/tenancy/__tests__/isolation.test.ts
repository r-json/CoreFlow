// @vitest-environment node
/**
 * Cross-tenant isolation tests.
 *
 * These treat the organization boundary as a SECURITY boundary, so they are
 * written the way an attacker probes one: substitute an id, enumerate a range,
 * and watch what the differences in response reveal.
 *
 * The database enforces the same boundary independently via composite foreign
 * keys — verified directly against PostgreSQL, recorded in
 * docs/evidence/REVIEWER_EVIDENCE.md. These tests cover the application layer
 * that sits above it.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { OrgRole, MembershipStatus, PaymentState } from '@prisma/client';
import { createFakeDb, type FakeDb } from '@/lib/payments/__tests__/fake-db';
import {
  resolveTenant, listTenants, requirePermission,
  findPayment, findBatch, findEscrow, findProject, findWorker,
  findTransaction, findAuditEvent, findFinding, findMember,
  findEscrowByOnChainId, assertProjectInTenant,
  paymentReadScope, tenantScope,
  type TenantContext,
} from '../resolve';

const A = 'orgA';
const B = 'orgB';

let db: FakeDb;

/** Two fully-populated tenants with identical resource shapes. */
function seed() {
  for (const [id, slug] of [[A, 'org-a'], [B, 'org-b']] as const) {
    db.__tables.organization.rows.push({ id, name: id, slug });
  }

  const mk = (org: string, suffix: string) => {
    db.__tables.project.rows.push({ id: `proj_${suffix}`, orgId: org, name: 'P', code: 'P1' });
    db.__tables.worker.rows.push({ id: `wk_${suffix}`, orgId: org, walletAddress: `GW${suffix}` });
    db.__tables.payrollBatch.rows.push({ id: `bat_${suffix}`, orgId: org, reference: `CF-${suffix}` });
    db.__tables.escrow.rows.push({
      id: `esc_${suffix}`, orgId: org, onChainId: 7, contractId: 'C', network: 'testnet',
      managerAddress: 'GM', financeApproverAddress: 'GF', assetDecimals: 7,
    });
    db.__tables.payment.rows.push({
      id: `pay_${suffix}`, orgId: org, batchId: `bat_${suffix}`, escrowId: `esc_${suffix}`,
      projectId: `proj_${suffix}`, workerId: `wk_${suffix}`,
      recipientAddress: `GR${suffix}`, onChainPaymentIndex: 0,
      amountBaseUnits: 100n, rateBaseUnits: 1n, hours: 100n,
      assetDecimals: 7, assetCode: 'USDC', state: PaymentState.READY_TO_SETTLE,
      stateUpdatedAt: new Date(), createdAt: new Date(),
    });
    db.__tables.blockchainTransaction.rows.push({
      id: `btx_${suffix}`, orgId: org, paymentId: `pay_${suffix}`,
      kind: 'PAY_BATCH', status: 'PREPARING', idempotencyKey: `k_${suffix}`, attempt: 1,
    });
    db.__tables.auditEvent.rows.push({
      id: `aud_${suffix}`, orgId: org, type: 'payment.state.changed',
      paymentId: `pay_${suffix}`, createdAt: new Date(),
    });
    db.__tables.reconciliationFinding.rows.push({
      id: `fnd_${suffix}`, orgId: org, paymentId: `pay_${suffix}`,
      kind: 'AMOUNT_MISMATCH', detectedAt: new Date(),
    });
  };
  mk(A, 'a');
  mk(B, 'b');
}

function addMember(
  org: string, userId: string, role: OrgRole, wallet: string,
  status: MembershipStatus = MembershipStatus.ACTIVE
) {
  if (!db.__tables.user.rows.some((u) => u.id === userId)) {
    db.__tables.user.rows.push({ id: userId, walletAddress: wallet, role: 'EMPLOYEE' });
  }
  db.__tables.orgMember.rows.push({
    id: `ogm_${org}_${userId}`, orgId: org, userId, role, status,
    orgId_: org, // unused; keeps shape obvious
    createdAt: new Date(),
  });
}

async function ctxFor(userId: string, org: string): Promise<TenantContext> {
  const r = await resolveTenant(db, userId, org);
  if (!r.ok) throw new Error(`expected membership: ${r.message}`);
  return r.value;
}

beforeEach(() => {
  db = createFakeDb();
  seed();
  addMember(A, 'u_a_owner', OrgRole.OWNER, 'G' + 'A'.repeat(55));
  addMember(A, 'u_a_mgr', OrgRole.MANAGER, 'G' + 'M'.repeat(55));
  addMember(A, 'u_a_fin', OrgRole.FINANCE, 'G' + 'F'.repeat(55));
  addMember(A, 'u_a_view', OrgRole.VIEWER, 'G' + 'V'.repeat(55));
  addMember(A, 'u_a_work', OrgRole.WORKER, 'GRa');
  addMember(B, 'u_b_owner', OrgRole.OWNER, 'G' + 'B'.repeat(55));
});

describe('membership resolution', () => {
  it('resolves an active membership', async () => {
    const ctx = await ctxFor('u_a_owner', A);
    expect(ctx.orgId).toBe(A);
    expect(ctx.role).toBe(OrgRole.OWNER);
  });

  it('reports a foreign organization as NOT FOUND, never FORBIDDEN', async () => {
    // 403 would confirm org B exists, turning id substitution into an
    // enumeration oracle.
    const r = await resolveTenant(db, 'u_a_owner', B);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(404);
  });

  it('reports a nonexistent organization identically to a foreign one', async () => {
    // The two MUST be indistinguishable, or existence leaks.
    const foreign = await resolveTenant(db, 'u_a_owner', B);
    const missing = await resolveTenant(db, 'u_a_owner', 'org_does_not_exist');
    expect(foreign.ok).toBe(false);
    expect(missing.ok).toBe(false);
    if (!foreign.ok && !missing.ok) {
      expect(foreign.status).toBe(missing.status);
      expect(foreign.message).toBe(missing.message);
    }
  });

  it('401s an unauthenticated caller', async () => {
    const r = await resolveTenant(db, undefined, A);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(401);
  });

  it.each([MembershipStatus.INVITED, MembershipStatus.SUSPENDED, MembershipStatus.REMOVED])(
    'refuses a %s membership, indistinguishably from non-membership',
    async (status) => {
      addMember(A, `u_${status}`, OrgRole.ADMIN, 'GX', status);
      const r = await resolveTenant(db, `u_${status}`, A);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.status).toBe(404);
        // Suspending someone must not tell them they were ever a member.
        expect(r.message).toBe('Organization not found.');
      }
    }
  );

  it('lists only active memberships', async () => {
    addMember(B, 'u_a_owner', OrgRole.VIEWER, 'G' + 'A'.repeat(55), MembershipStatus.SUSPENDED);
    const orgs = await listTenants(db, 'u_a_owner');
    expect(orgs.map((o) => o.orgId)).toEqual([A]);
  });
});

describe('cross-tenant resource reads', () => {
  const RESOURCES = [
    ['payment', findPayment, 'pay_b'],
    ['batch', findBatch, 'bat_b'],
    ['escrow', findEscrow, 'esc_b'],
    ['project', findProject, 'proj_b'],
    ['worker', findWorker, 'wk_b'],
    ['transaction', findTransaction, 'btx_b'],
    ['audit event', findAuditEvent, 'aud_b'],
    ['finding', findFinding, 'fnd_b'],
    ['member', findMember, 'ogm_orgB_u_b_owner'],
  ] as const;

  it.each(RESOURCES)('refuses org A reading org B %s', async (_label, finder, foreignId) => {
    const ctx = await ctxFor('u_a_owner', A);
    const r = await finder(db, ctx, foreignId);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(404);
  });

  it.each(RESOURCES)('allows org A reading its OWN %s', async (_label, finder, foreignId) => {
    const ctx = await ctxFor('u_a_owner', A);
    const ownId = foreignId.replace(/_b$/, '_a').replace('orgB_u_b_owner', 'orgA_u_a_owner');
    const r = await finder(db, ctx, ownId);
    expect(r.ok, `${ownId} should resolve`).toBe(true);
  });

  it('refuses a foreign resource even for the highest role', async () => {
    // OWNER is the most privileged role in org A and still sees nothing in org B.
    // Privilege is scoped to a tenant; it does not accumulate across them.
    const ctx = await ctxFor('u_a_owner', A);
    expect((await findPayment(db, ctx, 'pay_b')).ok).toBe(false);
  });
});

describe('on-chain id collisions across tenants', () => {
  it('does not return another tenant’s escrow for the same onChainId', async () => {
    // Escrow ids are assigned by the contract, so org A and org B both have an
    // escrow 7. Resolving by onChainId alone would hand one tenant the other's.
    const ctxA = await ctxFor('u_a_owner', A);
    const ctxB = await ctxFor('u_b_owner', B);

    const a = await findEscrowByOnChainId(db, ctxA, 7);
    const b = await findEscrowByOnChainId(db, ctxB, 7);

    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) {
      expect(a.value.id).toBe('esc_a');
      expect(b.value.id).toBe('esc_b');
      expect(a.value.id).not.toBe(b.value.id);
    }
  });

  it('returns not-found for an onChainId that exists only in another tenant', async () => {
    db.__tables.escrow.rows.push({
      id: 'esc_b2', orgId: B, onChainId: 99, contractId: 'C', network: 'testnet',
      managerAddress: 'GM', financeApproverAddress: 'GF', assetDecimals: 7,
    });
    const ctxA = await ctxFor('u_a_owner', A);
    expect((await findEscrowByOnChainId(db, ctxA, 99)).ok).toBe(false);
  });
});

describe('id enumeration', () => {
  it('returns an identical response for foreign and nonexistent ids', async () => {
    const ctx = await ctxFor('u_a_owner', A);
    const foreign = await findPayment(db, ctx, 'pay_b');
    const absent = await findPayment(db, ctx, 'pay_totally_made_up');

    expect(foreign.ok).toBe(false);
    expect(absent.ok).toBe(false);
    if (!foreign.ok && !absent.ok) {
      // Any difference here is an existence oracle.
      expect(foreign.status).toBe(absent.status);
      expect(foreign.message).toBe(absent.message);
    }
  });

  it('leaks nothing when enumerating a range of ids', async () => {
    const ctx = await ctxFor('u_a_owner', A);
    for (let i = 0; i < 25; i++) {
      db.__tables.payment.rows.push({
        id: `pay_b_${i}`, orgId: B, batchId: 'bat_b', recipientAddress: 'GR',
        amountBaseUnits: BigInt(i), rateBaseUnits: 1n, hours: BigInt(i),
        assetDecimals: 7, assetCode: 'USDC', state: PaymentState.PAID,
        onChainPaymentIndex: i, stateUpdatedAt: new Date(), createdAt: new Date(),
      });
    }
    const results = [];
    for (let i = 0; i < 25; i++) results.push(await findPayment(db, ctx, `pay_b_${i}`));
    expect(results.every((r) => !r.ok && r.status === 404)).toBe(true);
  });
});

describe('supplied (not looked-up) tenant references', () => {
  it('refuses a projectId from another organization', async () => {
    // A create request could carry a foreign projectId. The composite FK would
    // reject the write, but that surfaces as a 500; this is an honest 404 first.
    const ctx = await ctxFor('u_a_owner', A);
    const denial = await assertProjectInTenant(db, ctx, 'proj_b');
    expect(denial).not.toBeNull();
    expect(denial?.status).toBe(404);
  });

  it('accepts the caller’s own projectId', async () => {
    const ctx = await ctxFor('u_a_owner', A);
    expect(await assertProjectInTenant(db, ctx, 'proj_a')).toBeNull();
  });

  it('accepts a null projectId', async () => {
    const ctx = await ctxFor('u_a_owner', A);
    expect(await assertProjectInTenant(db, ctx, null)).toBeNull();
  });
});

describe('query scoping helpers', () => {
  it('always carries the organization', async () => {
    const ctx = await ctxFor('u_a_owner', A);
    expect(tenantScope(ctx)).toEqual({ orgId: A });
  });

  it('scopes a WORKER to their own payments only', async () => {
    // Organization-wide read would let any contractor enumerate the whole
    // payroll, including colleagues' rates.
    const ctx = await ctxFor('u_a_work', A);
    expect(paymentReadScope(ctx)).toEqual({ orgId: A, recipientAddress: 'GRa' });
  });

  it('gives an operator the whole organization', async () => {
    const ctx = await ctxFor('u_a_fin', A);
    expect(paymentReadScope(ctx)).toEqual({ orgId: A });
  });
});

describe('permission enforcement returns 403, not 404', () => {
  it('tells a member their role is insufficient', async () => {
    // The caller demonstrably belongs here, so there is nothing to conceal —
    // and a 404 would be actively misleading.
    const ctx = await ctxFor('u_a_view', A);
    const denial = requirePermission(ctx, 'payment:approve:finance');
    expect(denial).not.toBeNull();
    expect(denial?.status).toBe(403);
    expect(denial?.code).toBe('PERMISSION_DENIED');
  });

  it('permits a role that holds the permission', async () => {
    const ctx = await ctxFor('u_a_fin', A);
    expect(requirePermission(ctx, 'payment:approve:finance')).toBeNull();
  });

  it('refuses a MANAGER the finance approval inside their own organization', async () => {
    const ctx = await ctxFor('u_a_mgr', A);
    expect(requirePermission(ctx, 'payment:approve:finance')?.status).toBe(403);
    expect(requirePermission(ctx, 'payment:approve:manager')).toBeNull();
  });
});
