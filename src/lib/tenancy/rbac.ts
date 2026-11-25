/**
 * CoreFlow role-based permissions.
 *
 * ── Why this is a table and not scattered `if` statements ────────────────────
 * A permission model spread across route handlers cannot be reviewed, cannot be
 * rendered as a matrix, and cannot be tested exhaustively. Every question an
 * auditor asks — "who can approve finance?", "can a VIEWER see treasury?" — has
 * to be answered by reading control flow. Declared as data, the whole model fits
 * on one screen and every cell is enumerable by a test.
 *
 * ── The boundary this sits inside ────────────────────────────────────────────
 *   AUTHENTICATION      who are you                 (wallet signature, session)
 *   MEMBERSHIP          which organizations         (OrgMember, status ACTIVE)
 *   ROLE                what may you do             ← THIS FILE
 *   RESOURCE OWNERSHIP  is this record in scope     (tenancy/resolve.ts + DB FKs)
 *   BUSINESS RULE       is the action valid now     (payments/state-machine.ts)
 *   BLOCKCHAIN          did it actually happen      (contract + indexer)
 *
 * These layers are deliberately separate. Holding a role does not imply owning a
 * record, and owning a record does not imply the action is valid right now.
 */

import { OrgRole } from '@prisma/client';

/**
 * Every distinct capability in the product.
 *
 * Named after what the actor is trying to DO, not after an endpoint, so the same
 * permission governs the API, the UI and any future surface.
 */
export type Permission =
  // Organization
  | 'org:read'
  | 'org:update'
  | 'org:delete'
  // Membership
  | 'member:read'
  | 'member:invite'
  | 'member:role:assign'
  | 'member:suspend'
  | 'member:remove'
  // Projects
  | 'project:read'
  | 'project:create'
  | 'project:update'
  | 'project:archive'
  // Workers
  | 'worker:read'
  | 'worker:create'
  | 'worker:update'
  | 'worker:archive'
  // Payroll
  | 'payroll:read'
  | 'payroll:create'
  | 'payroll:update'
  | 'payroll:delete'
  // Payments
  | 'payment:read'
  | 'payment:approve:manager'
  | 'payment:approve:finance'
  | 'payment:reject'
  | 'payment:cancel'
  | 'payment:submit'
  | 'payment:retry'
  // Escrow / chain
  | 'escrow:read'
  | 'escrow:create'
  | 'escrow:cancel'
  | 'oracle:attest:request'
  // Treasury
  | 'treasury:read'
  // Audit & reconciliation
  | 'audit:read'
  | 'reconciliation:read'
  | 'reconciliation:resolve';

/** Everything a role may do. Absence of a permission is a denial. */
const GRANTS: Record<OrgRole, readonly Permission[]> = {
  /**
   * OWNER — full authority, including destroying the organization.
   *
   * Note what this does NOT mean: an owner still cannot satisfy both halves of
   * the dual-approval gate. See `approvePayment`, which refuses a second
   * approval from a wallet that already recorded the first.
   */
  [OrgRole.OWNER]: [
    'org:read', 'org:update', 'org:delete',
    'member:read', 'member:invite', 'member:role:assign', 'member:suspend', 'member:remove',
    'project:read', 'project:create', 'project:update', 'project:archive',
    'worker:read', 'worker:create', 'worker:update', 'worker:archive',
    'payroll:read', 'payroll:create', 'payroll:update', 'payroll:delete',
    'payment:read', 'payment:approve:manager', 'payment:approve:finance',
    'payment:reject', 'payment:cancel', 'payment:submit', 'payment:retry',
    'escrow:read', 'escrow:create', 'escrow:cancel', 'oracle:attest:request',
    'treasury:read',
    'audit:read', 'reconciliation:read', 'reconciliation:resolve',
  ],

  /** ADMIN — operational authority, but cannot delete the organization. */
  [OrgRole.ADMIN]: [
    'org:read', 'org:update',
    'member:read', 'member:invite', 'member:role:assign', 'member:suspend', 'member:remove',
    'project:read', 'project:create', 'project:update', 'project:archive',
    'worker:read', 'worker:create', 'worker:update', 'worker:archive',
    'payroll:read', 'payroll:create', 'payroll:update', 'payroll:delete',
    'payment:read', 'payment:approve:manager', 'payment:approve:finance',
    'payment:reject', 'payment:cancel', 'payment:submit', 'payment:retry',
    'escrow:read', 'escrow:create', 'escrow:cancel', 'oracle:attest:request',
    'treasury:read',
    'audit:read', 'reconciliation:read', 'reconciliation:resolve',
  ],

  /**
   * MANAGER — prepares and authorizes work, holds the MANAGER half of the gate.
   *
   * Deliberately lacks `payment:approve:finance`. A manager who could exercise
   * the finance approval would collapse separation of duties, which is the
   * product's central claim and what the contract enforces on-chain with
   * SignersNotDistinct.
   */
  [OrgRole.MANAGER]: [
    'org:read',
    'member:read',
    'project:read',
    'worker:read', 'worker:create', 'worker:update',
    'payroll:read', 'payroll:create', 'payroll:update',
    'payment:read', 'payment:approve:manager', 'payment:reject', 'payment:cancel',
    'payment:submit', 'payment:retry',
    'escrow:read', 'escrow:create', 'oracle:attest:request',
    'treasury:read',
    'audit:read', 'reconciliation:read',
  ],

  /**
   * FINANCE — holds the FINANCE half of the gate and controls money leaving.
   *
   * Deliberately lacks `payment:approve:manager`, `payroll:create` and
   * `worker:create`: an approver who can also create the thing they approve is
   * not an independent check.
   */
  [OrgRole.FINANCE]: [
    'org:read',
    'member:read',
    'project:read',
    'worker:read',
    'payroll:read',
    'payment:read', 'payment:approve:finance', 'payment:reject', 'payment:cancel',
    'payment:submit', 'payment:retry',
    'escrow:read',
    'treasury:read',
    'audit:read', 'reconciliation:read',
  ],

  /**
   * WORKER — a payee, not an operator.
   *
   * Intentionally holds NO permissions here. A worker's own payment history is
   * served by a separate self-scoped path that filters on their wallet address,
   * not by organization-wide `payment:read` — granting that would let any payee
   * enumerate the whole payroll, including their colleagues' rates.
   */
  [OrgRole.WORKER]: [],

  /** VIEWER — read-only. No mutation, no approval, no treasury movement. */
  [OrgRole.VIEWER]: [
    'org:read',
    'member:read',
    'project:read',
    'worker:read',
    'payroll:read',
    'payment:read',
    'escrow:read',
    'treasury:read',
    'audit:read', 'reconciliation:read',
  ],
};

export function permissionsFor(role: OrgRole): readonly Permission[] {
  return GRANTS[role] ?? [];
}

/** True if `role` holds `permission`. The only way to ask this question. */
export function can(role: OrgRole, permission: Permission): boolean {
  return (GRANTS[role] ?? []).includes(permission);
}

export function canAll(role: OrgRole, permissions: readonly Permission[]): boolean {
  return permissions.every((p) => can(role, p));
}

export function canAny(role: OrgRole, permissions: readonly Permission[]): boolean {
  return permissions.some((p) => can(role, p));
}

/** Every permission in the model, for matrix generation and exhaustive tests. */
export const ALL_PERMISSIONS: readonly Permission[] = Array.from(
  new Set(Object.values(GRANTS).flat())
).sort() as Permission[];

export const ALL_ROLES: readonly OrgRole[] = Object.values(OrgRole);

// ── Role delegation ──────────────────────────────────────────────────────────

/**
 * Which roles a given role may grant.
 *
 * Strictly below the granter's own level, with one deliberate exception: an OWNER
 * may create another OWNER, because an organization with exactly one owner has no
 * recovery path if that key is lost.
 *
 * This is the main privilege-escalation surface in a multi-tenant product: an
 * ADMIN able to grant OWNER could take the organization, and a MANAGER able to
 * grant FINANCE could manufacture the second approval they are forbidden from
 * giving. Both are refused.
 */
const DELEGATABLE: Record<OrgRole, readonly OrgRole[]> = {
  [OrgRole.OWNER]: [
    OrgRole.OWNER, OrgRole.ADMIN, OrgRole.MANAGER,
    OrgRole.FINANCE, OrgRole.WORKER, OrgRole.VIEWER,
  ],
  // An ADMIN may staff the organization but may not create a peer owner.
  [OrgRole.ADMIN]: [
    OrgRole.ADMIN, OrgRole.MANAGER, OrgRole.FINANCE, OrgRole.WORKER, OrgRole.VIEWER,
  ],
  [OrgRole.MANAGER]: [],
  [OrgRole.FINANCE]: [],
  [OrgRole.WORKER]: [],
  [OrgRole.VIEWER]: [],
};

export function canAssignRole(actor: OrgRole, target: OrgRole): boolean {
  return (DELEGATABLE[actor] ?? []).includes(target);
}

export function assignableRoles(actor: OrgRole): readonly OrgRole[] {
  return DELEGATABLE[actor] ?? [];
}

/** Roles that keep an organization administrable. At least one must remain. */
export const ADMINISTRATIVE_ROLES: readonly OrgRole[] = [OrgRole.OWNER, OrgRole.ADMIN];

export function isAdministrative(role: OrgRole): boolean {
  return ADMINISTRATIVE_ROLES.includes(role);
}
