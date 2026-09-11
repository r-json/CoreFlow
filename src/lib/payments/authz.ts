/**
 * Payment-domain view of the tenant boundary.
 *
 * ── This module no longer implements isolation ───────────────────────────────
 * It delegates to `src/lib/tenancy/`, which is the single boundary every
 * tenant-scoped request passes through. Two implementations of "is this record
 * mine" is one more than a security boundary can afford: they drift, and the
 * weaker one becomes the way in.
 *
 * What remains here is the payment domain's vocabulary — a `Membership` alias and
 * helpers that turn a tenant context into a state-machine actor — so the payment
 * service does not need to know how tenancy is resolved.
 */

import { OrgRole } from '@prisma/client';
import { can } from '@/lib/tenancy/rbac';
import {
  resolveTenant,
  findPayment as findPaymentScoped,
  findBatch as findBatchScoped,
  type TenantContext,
  type Result,
} from '@/lib/tenancy/resolve';
import type { Actor } from './state-machine';

/** A resolved, active membership. Named for the payment domain's call sites. */
export type Membership = TenantContext;

export type AuthzResult<T> = Result<T>;

/** Roles that may read an organization's payment data. Derived, not duplicated. */
export const READ_ROLES: readonly OrgRole[] = Object.values(OrgRole).filter((r) =>
  can(r, 'payment:read')
);

export async function resolveMembership(
  db: any,
  userId: string | undefined,
  orgId: string
): Promise<Result<Membership>> {
  return resolveTenant(db, userId, orgId);
}

export async function findPaymentForMember(
  db: any,
  membership: Membership,
  paymentId: string,
  include?: Record<string, unknown>
): Promise<Result<any>> {
  return findPaymentScoped(db, membership, paymentId, include);
}

export async function findBatchForMember(
  db: any,
  membership: Membership,
  batchId: string,
  include?: Record<string, unknown>
): Promise<Result<any>> {
  return findBatchScoped(db, membership, batchId, include);
}

/** True if the role may read payment data organization-wide. */
export function canRead(role: OrgRole): boolean {
  return can(role, 'payment:read');
}

/** Build a state-machine actor from a resolved membership. */
export function actorFromMembership(m: Membership): Actor {
  return { kind: 'user', role: m.role, address: m.walletAddress };
}
