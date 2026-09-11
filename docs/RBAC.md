# CoreFlow RBAC

**6 roles · 35 permissions.** Generated from `src/lib/tenancy/rbac.ts`, which is
the single source of truth. If this document disagrees with the code, the code is
right and this is stale.

---

## 1. Where roles sit in the security boundary

```
AUTHENTICATION       who are you              wallet signature, session
MEMBERSHIP           which organizations      OrgMember, status = ACTIVE
ROLE                 what may you do          ← this document
RESOURCE OWNERSHIP   is this record in scope  tenancy/resolve.ts + composite FKs
BUSINESS RULE        is the action valid now   payments/state-machine.ts
BLOCKCHAIN           did it actually happen    contract + indexer
```

These do not collapse into each other. Holding a role does not imply owning a
record; owning a record does not imply the action is valid right now; and none of
them imply money moved.

**Permissions are organization-scoped.** A role is held *within* one organization
and grants nothing anywhere else. There is no cross-tenant or platform-wide
authority over payment data — the legacy platform `Role` (ADMIN/EMPLOYEE) governs
only sign-in and the admin bootstrap path.

---

## 2. The roles

| Role | Purpose |
|---|---|
| **OWNER** | Full authority, including deleting the organization. |
| **ADMIN** | Operational authority. Cannot delete the organization or mint an OWNER. |
| **MANAGER** | Prepares payroll and holds the MANAGER half of the approval gate. |
| **FINANCE** | Holds the FINANCE half. Cannot create the payroll it approves. |
| **WORKER** | A payee, not an operator. Holds **no** permissions. |
| **VIEWER** | Read-only. |

### Separation of duties

MANAGER and FINANCE are separate and neither implies the other. This is the
product's central claim, and the contract enforces the same property on-chain with
`SignersNotDistinct`.

Three consequences, each tested:

- A MANAGER cannot hold `payment:approve:finance`, and vice versa.
- FINANCE cannot hold `payroll:create`, `worker:create` or `escrow:create` — an
  approver who can also create what they approve is not an independent check.
- Even an OWNER cannot supply both halves of one payment: `approvePayment` refuses
  a second approval from a wallet that already recorded the first.

### WORKER holds nothing

A worker sees their own payments through a self-scoped query
(`paymentReadScope`) that filters on their wallet address — not through
`payment:read`. Granting organization-wide read would let any contractor enumerate
the entire payroll, including colleagues' rates.

---

## 3. Permission matrix

| Permission | OWNER | ADMIN | MANAGER | FINANCE | WORKER | VIEWER |
|---|---|---|---|---|---|---|
| `audit:read` | ✅ | ✅ | ✅ | ✅ | — | ✅ |
| `escrow:cancel` | ✅ | ✅ | — | — | — | — |
| `escrow:create` | ✅ | ✅ | ✅ | — | — | — |
| `escrow:read` | ✅ | ✅ | ✅ | ✅ | — | ✅ |
| `member:invite` | ✅ | ✅ | — | — | — | — |
| `member:read` | ✅ | ✅ | ✅ | ✅ | — | ✅ |
| `member:remove` | ✅ | ✅ | — | — | — | — |
| `member:role:assign` | ✅ | ✅ | — | — | — | — |
| `member:suspend` | ✅ | ✅ | — | — | — | — |
| `oracle:attest:request` | ✅ | ✅ | ✅ | — | — | — |
| `org:delete` | ✅ | — | — | — | — | — |
| `org:read` | ✅ | ✅ | ✅ | ✅ | — | ✅ |
| `org:update` | ✅ | ✅ | — | — | — | — |
| `payment:approve:finance` | ✅ | ✅ | — | ✅ | — | — |
| `payment:approve:manager` | ✅ | ✅ | ✅ | — | — | — |
| `payment:cancel` | ✅ | ✅ | ✅ | ✅ | — | — |
| `payment:read` | ✅ | ✅ | ✅ | ✅ | — | ✅ |
| `payment:reject` | ✅ | ✅ | ✅ | ✅ | — | — |
| `payment:retry` | ✅ | ✅ | ✅ | ✅ | — | — |
| `payment:submit` | ✅ | ✅ | ✅ | ✅ | — | — |
| `payroll:create` | ✅ | ✅ | ✅ | — | — | — |
| `payroll:delete` | ✅ | ✅ | — | — | — | — |
| `payroll:read` | ✅ | ✅ | ✅ | ✅ | — | ✅ |
| `payroll:update` | ✅ | ✅ | ✅ | — | — | — |
| `project:archive` | ✅ | ✅ | — | — | — | — |
| `project:create` | ✅ | ✅ | — | — | — | — |
| `project:read` | ✅ | ✅ | ✅ | ✅ | — | ✅ |
| `project:update` | ✅ | ✅ | — | — | — | — |
| `reconciliation:read` | ✅ | ✅ | ✅ | ✅ | — | ✅ |
| `reconciliation:resolve` | ✅ | ✅ | — | — | — | — |
| `treasury:read` | ✅ | ✅ | ✅ | ✅ | — | ✅ |
| `worker:archive` | ✅ | ✅ | — | — | — | — |
| `worker:create` | ✅ | ✅ | ✅ | — | — | — |
| `worker:read` | ✅ | ✅ | ✅ | ✅ | — | ✅ |
| `worker:update` | ✅ | ✅ | ✅ | — | — | — |

---

## 4. Role delegation

Who may grant which role. Strictly at or below the granter's own level, with one
deliberate exception: an OWNER may create another OWNER, because an organization
with exactly one owner has no recovery path if that key is lost.

| Role | May grant |
|---|---|
| OWNER | OWNER, ADMIN, MANAGER, FINANCE, WORKER, VIEWER |
| ADMIN | ADMIN, MANAGER, FINANCE, WORKER, VIEWER |
| MANAGER | *(none)* |
| FINANCE | *(none)* |
| WORKER | *(none)* |
| VIEWER | *(none)* |

Two refusals worth naming, because both are plausible mistakes rather than exotic
attacks:

- **An ADMIN cannot mint an OWNER.** Otherwise an admin can take the organization.
- **A MANAGER cannot mint a FINANCE approver.** Otherwise a manager manufactures
  the second approval they are forbidden from giving.

Delegation is checked as a pair: the actor needs `member:role:assign` *and* the
specific target role must be within their delegation. Holding the permission does
not imply every role is in reach.

### Self-targeting

Nobody may change their own role or membership status — self-assignment is how a
limited role becomes an unlimited one. `checkNotSelf` returns 409.

### Last administrator

An action that would leave an organization with no ACTIVE administrator is refused
with 409 `LAST_ADMINISTRATOR`. This covers removal, suspension **and** demotion. A
SUSPENDED administrator does not count as cover: an organization whose only other
admin is suspended has nobody who can unsuspend them.

---

## 5. HTTP semantics

| Situation | Status | Why |
|---|---|---|
| Not signed in | **401** | |
| Resource outside the caller's organizations | **404** | A 403 confirms existence, turning id substitution into an enumeration oracle |
| Nonexistent resource | **404** | Identical response to the above, by design |
| Member, but role lacks the permission | **403** | The caller demonstrably belongs here, so there is nothing to conceal |
| Conflicts with organization state | **409** | e.g. last administrator, invalid membership transition |
| Caller belongs to several organizations, none named | **400** | Guessing could act in the wrong tenant's name |

---

## 6. Enforcement

Backend authorization is **authoritative**. UI visibility is a convenience, never a
control: `GET /api/organizations` returns each membership's permission list so the
client renders from the same data the server enforces, rather than re-deriving the
rules and drifting.

Every tenant-scoped route passes through `withTenant()`, which resolves
authentication → membership → permission before the handler runs. No route can
forget a layer because no route performs these checks itself.

---

## 7. Tests

`src/lib/tenancy/__tests__/rbac.test.ts` enumerates the whole matrix, including
the cells that must be **empty**: every permission is asserted against every role,
every non-read permission is refused for VIEWER, and all 35 are refused for
WORKER. A table tested only on what it allows would happily let a MANAGER approve
finance.
