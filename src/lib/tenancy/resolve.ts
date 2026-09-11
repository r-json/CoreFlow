/**
 * The tenant boundary. Every tenant-scoped request passes through here.
 *
 * ── The rule ─────────────────────────────────────────────────────────────────
 * Organization identity is derived from AUTHENTICATED MEMBERSHIP, read from the
 * database on every request. Nothing from the client is trusted: not an
 * `organizationId` field, not a role, not a project id, not a hidden form field,
 * and certainly not client-side route protection.
 *
 * A client may *name* which of its organizations it wants to act in. It may never
 * assert that it belongs to one, nor what it can do there.
 *
 * ── Why 404 and not 403 ──────────────────────────────────────────────────────
 * A 403 on a foreign resource confirms the resource exists. Repeated against a
 * range of ids that turns into an enumeration oracle: an attacker learns how many
 * payments another tenant has, and roughly what they are worth, without reading a
 * single record. Every cross-tenant miss therefore looks exactly like a genuine
 * miss. A 403 is reserved for resources the caller CAN see but may not act on.
 *
 * ── Why scoping is in the WHERE clause ───────────────────────────────────────
 * Resources are loaded with `orgId` as part of the query, never fetched by global
 * id and checked afterwards. A post-fetch check still performs the read, and any
 * logging, error path or timing difference around it can disclose existence. The
 * composite foreign keys in the schema back this up at the database level, so even
 * a query that forgot its filter cannot join across tenants.
 */

import { OrgRole, MembershipStatus } from '@prisma/client';
import { can, type Permission } from './rbac';

export type Denial = {
  ok: false;
  /**
   * 401 unauthenticated · 403 visible but not permitted · 404 outside scope
   * (see the note above) · 409 a real conflict with organization state, such as
   * removing the last administrator · 400 a malformed request.
   */
  status: 400 | 401 | 403 | 404 | 409;
  message: string;
  code?: string;
};
export type Allowed<T> = { ok: true; value: T };
export type Result<T> = Allowed<T> | Denial;

/** A resolved, ACTIVE membership. The basis of every authorization decision. */
export interface TenantContext {
  orgId: string;
  orgName: string;
  orgSlug: string;
  userId: string;
  walletAddress: string;
  role: OrgRole;
}

const NOT_FOUND = (what: string): Denial => ({
  ok: false,
  status: 404,
  message: `${what} not found.`,
});

/**
 * Resolve the caller's membership of `orgId`.
 *
 * Only an ACTIVE membership counts. INVITED has not accepted; SUSPENDED has had
 * access revoked; REMOVED is gone. All three are indistinguishable from
 * non-membership to the caller, so suspending someone does not tell them they
 * were ever a member.
 */
export async function resolveTenant(
  db: any,
  userId: string | undefined,
  orgId: string | undefined | null
): Promise<Result<TenantContext>> {
  if (!userId) {
    return { ok: false, status: 401, message: 'Authentication required.' };
  }
  if (!orgId) {
    return {
      ok: false,
      status: 400,
      message: 'An organization must be specified for this request.',
      code: 'ORGANIZATION_REQUIRED',
    };
  }

  const member = await db.orgMember.findUnique({
    where: { orgId_userId: { orgId, userId } },
    include: {
      org: { select: { id: true, name: true, slug: true } },
      user: { select: { walletAddress: true } },
    },
  });

  if (!member || member.status !== MembershipStatus.ACTIVE) {
    return NOT_FOUND('Organization');
  }

  return {
    ok: true,
    value: {
      orgId: member.orgId,
      orgName: member.org?.name ?? '',
      orgSlug: member.org?.slug ?? '',
      userId: member.userId,
      walletAddress: member.user?.walletAddress ?? '',
      role: member.role,
    },
  };
}

/** Every organization the caller is an ACTIVE member of. */
export async function listTenants(
  db: any,
  userId: string
): Promise<{ orgId: string; name: string; slug: string; role: OrgRole }[]> {
  const rows = await db.orgMember.findMany({
    where: { userId, status: MembershipStatus.ACTIVE },
    include: { org: { select: { id: true, name: true, slug: true } } },
    orderBy: { createdAt: 'asc' },
  });
  return rows.map((m: any) => ({
    orgId: m.orgId,
    name: m.org?.name ?? '',
    slug: m.org?.slug ?? '',
    role: m.role,
  }));
}

/**
 * Require a permission. Returns 403, not 404: the caller demonstrably belongs to
 * this organization, so there is nothing to conceal — telling them their role is
 * insufficient is useful, and reveals nothing they could not already see.
 */
export function requirePermission(
  ctx: TenantContext,
  permission: Permission
): Denial | null {
  if (can(ctx.role, permission)) return null;
  return {
    ok: false,
    status: 403,
    message: `Your role (${ctx.role}) cannot perform this action.`,
    code: 'PERMISSION_DENIED',
  };
}

/**
 * Require ANY ONE of several permissions.
 *
 * Dual approval needs this: a batch approval is legitimate from a manager
 * (`payment:approve:manager`) or from finance (`payment:approve:finance`), and
 * gating on either one alone would reject half the people entitled to act. The
 * caller's role still decides WHICH half they exercise — that is derived from
 * membership in `approvePayment`, never from the request.
 */
export function requireAnyPermission(
  ctx: TenantContext,
  permissions: readonly Permission[]
): Denial | null {
  if (permissions.some((p) => can(ctx.role, p))) return null;
  return {
    ok: false,
    status: 403,
    message: `Your role (${ctx.role}) cannot perform this action.`,
    code: 'PERMISSION_DENIED',
  };
}

// ── Resource resolution ──────────────────────────────────────────────────────
//
// One function per resource type. Each takes the resolved TenantContext and
// returns the record or a 404. Possession of an id never implies authorization,
// so there is no variant of these that skips the scope.

type Include = Record<string, unknown> | undefined;

async function scoped(
  db: any,
  model: string,
  label: string,
  ctx: TenantContext,
  id: string,
  include?: Include
): Promise<Result<any>> {
  const row = await db[model].findFirst({
    where: { id, orgId: ctx.orgId },
    ...(include ? { include } : {}),
  });
  return row ? { ok: true, value: row } : NOT_FOUND(label);
}

export const findPayment = (db: any, ctx: TenantContext, id: string, inc?: Include) =>
  scoped(db, 'payment', 'Payment', ctx, id, inc);

export const findBatch = (db: any, ctx: TenantContext, id: string, inc?: Include) =>
  scoped(db, 'payrollBatch', 'Batch', ctx, id, inc);

export const findEscrow = (db: any, ctx: TenantContext, id: string, inc?: Include) =>
  scoped(db, 'escrow', 'Escrow', ctx, id, inc);

export const findProject = (db: any, ctx: TenantContext, id: string, inc?: Include) =>
  scoped(db, 'project', 'Project', ctx, id, inc);

export const findWorker = (db: any, ctx: TenantContext, id: string, inc?: Include) =>
  scoped(db, 'worker', 'Worker', ctx, id, inc);

export const findTransaction = (db: any, ctx: TenantContext, id: string, inc?: Include) =>
  scoped(db, 'blockchainTransaction', 'Transaction', ctx, id, inc);

export const findAuditEvent = (db: any, ctx: TenantContext, id: string, inc?: Include) =>
  scoped(db, 'auditEvent', 'Audit event', ctx, id, inc);

export const findFinding = (db: any, ctx: TenantContext, id: string, inc?: Include) =>
  scoped(db, 'reconciliationFinding', 'Finding', ctx, id, inc);

export const findMember = (db: any, ctx: TenantContext, id: string, inc?: Include) =>
  scoped(db, 'orgMember', 'Member', ctx, id, inc);

/**
 * Resolve an escrow by its ON-CHAIN id within the caller's organization.
 *
 * `onChainId` is globally unique across the database but NOT per-tenant-safe on
 * its own: escrow ids are assigned by the contract, so org A and org B both have
 * an escrow "3" if they use different deployments. Resolving it without the
 * organization filter would hand one tenant another's escrow.
 */
export async function findEscrowByOnChainId(
  db: any,
  ctx: TenantContext,
  onChainId: number,
  include?: Include
): Promise<Result<any>> {
  const row = await db.escrow.findFirst({
    where: { onChainId, orgId: ctx.orgId },
    ...(include ? { include } : {}),
  });
  return row ? { ok: true, value: row } : NOT_FOUND('Escrow');
}

/**
 * Confirm a project belongs to the caller's organization, for use when a project
 * is supplied as an INPUT rather than looked up.
 *
 * Without this, a create request could carry `projectId` from another tenant. The
 * composite foreign key would reject the write, but that surfaces as a 500 — this
 * turns it into an honest 404 before anything is attempted.
 */
export async function assertProjectInTenant(
  db: any,
  ctx: TenantContext,
  projectId: string | null | undefined
): Promise<Denial | null> {
  if (!projectId) return null;
  const found = await findProject(db, ctx, projectId);
  return found.ok ? null : (found as Denial);
}

/** A `where` fragment that scopes any tenant-owned query. */
export function tenantScope(ctx: TenantContext): { orgId: string } {
  return { orgId: ctx.orgId };
}

/**
 * Scope a payment query for a caller whose role has no organization-wide read.
 *
 * A WORKER is a payee, not an operator: they may see payments made to their own
 * wallet and nothing else. Granting them `payment:read` would let any contractor
 * enumerate the entire payroll, including colleagues' rates.
 */
export function paymentReadScope(ctx: TenantContext): Record<string, unknown> {
  if (can(ctx.role, 'payment:read')) return { orgId: ctx.orgId };
  return { orgId: ctx.orgId, recipientAddress: ctx.walletAddress };
}
