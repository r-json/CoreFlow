// @vitest-environment node
/**
 * RBAC matrix tests.
 *
 * The whole permission model is enumerated, including the cells that must be
 * EMPTY. A permission table tested only on what it allows will happily allow a
 * MANAGER to exercise the finance approval.
 */
import { describe, it, expect } from 'vitest';
import { OrgRole } from '@prisma/client';
import {
  can, canAll, canAny, permissionsFor,
  canAssignRole, assignableRoles, isAdministrative,
  ALL_PERMISSIONS, ALL_ROLES, ADMINISTRATIVE_ROLES,
  type Permission,
} from '../rbac';

describe('matrix integrity', () => {
  it('defines a grant list for every role', () => {
    for (const role of ALL_ROLES) {
      expect(permissionsFor(role), role).toBeDefined();
    }
  });

  it('grants no permission that is not in the permission vocabulary', () => {
    for (const role of ALL_ROLES) {
      for (const p of permissionsFor(role)) {
        expect(ALL_PERMISSIONS, `${role} grants unknown ${p}`).toContain(p);
      }
    }
  });

  it('lists no duplicate permissions within a role', () => {
    for (const role of ALL_ROLES) {
      const list = permissionsFor(role);
      expect(new Set(list).size, role).toBe(list.length);
    }
  });

  it('has no permission that nobody holds', () => {
    // An unreachable permission is dead code guarding a real endpoint.
    for (const p of ALL_PERMISSIONS) {
      expect(ALL_ROLES.some((r) => can(r, p)), `nobody can ${p}`).toBe(true);
    }
  });
});

describe('separation of duties', () => {
  it('does not let a MANAGER exercise the finance approval', () => {
    // The product's central claim. A manager holding both halves would make the
    // dual-approval gate decorative, exactly as a single on-chain key would.
    expect(can(OrgRole.MANAGER, 'payment:approve:manager')).toBe(true);
    expect(can(OrgRole.MANAGER, 'payment:approve:finance')).toBe(false);
  });

  it('does not let FINANCE exercise the manager approval', () => {
    expect(can(OrgRole.FINANCE, 'payment:approve:finance')).toBe(true);
    expect(can(OrgRole.FINANCE, 'payment:approve:manager')).toBe(false);
  });

  it('does not let FINANCE create the payroll it approves', () => {
    // An approver who can also create what they approve is not an independent
    // check.
    expect(can(OrgRole.FINANCE, 'payroll:create')).toBe(false);
    expect(can(OrgRole.FINANCE, 'worker:create')).toBe(false);
    expect(can(OrgRole.FINANCE, 'escrow:create')).toBe(false);
  });
});

describe('VIEWER is read-only', () => {
  const MUTATIONS: Permission[] = ALL_PERMISSIONS.filter(
    (p) => !p.endsWith(':read')
  ) as Permission[];

  it.each(MUTATIONS)('refuses VIEWER %s', (p) => {
    expect(can(OrgRole.VIEWER, p)).toBe(false);
  });

  it('allows VIEWER the read permissions', () => {
    expect(can(OrgRole.VIEWER, 'payment:read')).toBe(true);
    expect(can(OrgRole.VIEWER, 'audit:read')).toBe(true);
  });
});

describe('WORKER is a payee, not an operator', () => {
  it.each(ALL_PERMISSIONS)('grants WORKER nothing: %s', (p) => {
    // Organization-wide payment:read would let any contractor enumerate the
    // whole payroll, including colleagues' rates. Self-scoped access is served
    // by paymentReadScope() instead.
    expect(can(OrgRole.WORKER, p)).toBe(false);
  });

  it('holds an empty grant list', () => {
    expect(permissionsFor(OrgRole.WORKER)).toHaveLength(0);
  });
});

describe('organization deletion', () => {
  it('is restricted to OWNER', () => {
    expect(can(OrgRole.OWNER, 'org:delete')).toBe(true);
    for (const role of ALL_ROLES.filter((r) => r !== OrgRole.OWNER)) {
      expect(can(role, 'org:delete'), role).toBe(false);
    }
  });
});

describe('role delegation', () => {
  it('lets an OWNER grant any role, including another OWNER', () => {
    // An organization with exactly one owner has no recovery path if that key is
    // lost, so owners must be able to create a peer.
    for (const role of ALL_ROLES) {
      expect(canAssignRole(OrgRole.OWNER, role), role).toBe(true);
    }
  });

  it('does NOT let an ADMIN mint an OWNER', () => {
    // Otherwise an admin can take the organization.
    expect(canAssignRole(OrgRole.ADMIN, OrgRole.OWNER)).toBe(false);
    expect(canAssignRole(OrgRole.ADMIN, OrgRole.ADMIN)).toBe(true);
  });

  it('does NOT let a MANAGER mint a FINANCE approver', () => {
    // Otherwise a manager manufactures the second approval they are forbidden
    // from giving.
    expect(canAssignRole(OrgRole.MANAGER, OrgRole.FINANCE)).toBe(false);
    expect(assignableRoles(OrgRole.MANAGER)).toHaveLength(0);
  });

  it.each([OrgRole.MANAGER, OrgRole.FINANCE, OrgRole.WORKER, OrgRole.VIEWER])(
    'gives %s no delegation authority at all',
    (role) => {
      expect(assignableRoles(role)).toHaveLength(0);
      for (const target of ALL_ROLES) {
        expect(canAssignRole(role, target), `${role} -> ${target}`).toBe(false);
      }
    }
  );

  it('requires the assign permission as well as delegation', () => {
    // Both are checked: holding member:role:assign does not imply every role is
    // within reach.
    expect(can(OrgRole.MANAGER, 'member:role:assign')).toBe(false);
    expect(can(OrgRole.ADMIN, 'member:role:assign')).toBe(true);
  });
});

describe('administrative roles', () => {
  it('counts exactly OWNER and ADMIN', () => {
    expect([...ADMINISTRATIVE_ROLES].sort()).toEqual([OrgRole.ADMIN, OrgRole.OWNER].sort());
    expect(isAdministrative(OrgRole.MANAGER)).toBe(false);
    expect(isAdministrative(OrgRole.OWNER)).toBe(true);
  });
});

describe('helpers', () => {
  it('canAll requires every permission', () => {
    expect(canAll(OrgRole.MANAGER, ['payment:read', 'payment:approve:manager'])).toBe(true);
    expect(canAll(OrgRole.MANAGER, ['payment:read', 'payment:approve:finance'])).toBe(false);
  });

  it('canAny requires one', () => {
    expect(canAny(OrgRole.FINANCE, ['payment:approve:manager', 'payment:approve:finance'])).toBe(true);
    expect(canAny(OrgRole.WORKER, ['payment:read', 'audit:read'])).toBe(false);
  });
});
