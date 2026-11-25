# CoreFlow Multi-Tenancy

Tenant isolation is treated as a **security boundary**, not a UI filter. This
document states the model, where it is enforced, and what it does not yet cover.

---

## 1. The ownership graph

```
Organization
├── OrgMember ──────── User            (role + lifecycle status)
├── Project
├── Worker
├── Escrow ─────────── Project?
├── PayrollBatch ───── Project?
├── Payment ────────── PayrollBatch, Escrow?, Project?, Worker?
│   ├── Approval
│   ├── OracleAttestation
│   ├── BlockchainTransaction
│   └── ReconciliationFinding
└── AuditEvent
```

**Every tenant-owned record carries `orgId` directly.** Nothing relies on the
application "remembering" which tenant a record belongs to by walking a parent
chain. `Approval` and `OracleAttestation` gained an explicit `orgId` in this phase
precisely because they were previously reachable only by joining through `Payment`.

Records that are deliberately **not** tenant-owned:

| Model | Why |
|---|---|
| `User`, `Session`, `AuthChallenge` | Identity is global; a wallet may belong to several organizations |
| `ChainEvent`, `IndexerCursor` | Raw chain data, scoped by `(contractId, network)` rather than tenant |
| `AuditLog` (legacy) | Predates organizations; **not** exposed through any tenant-scoped endpoint |
| `TimeLog` (legacy) | Superseded by `Payment.hours` + `OracleAttestation` |

---

## 2. The database enforces the boundary

Every parent relation on a tenant-owned record is a **composite foreign key** on
`(orgId, id)`, not on `id` alone.

```prisma
batch PayrollBatch @relation(fields: [orgId, batchId], references: [orgId, id])
```

A plain `batchId` foreign key guarantees only that the batch *exists*. It says
nothing about whose batch it is, so a bug or a crafted request could produce a
payment in org A attached to a batch, escrow, project or worker in org B — with no
constraint objecting. Isolation would then rest entirely on every query
remembering to filter.

Verified directly against PostgreSQL:

```
org A payment → org A batch      INSERT 0 1                        ALLOWED
org A payment → org B batch      Payment_orgId_batchId_fkey        BLOCKED
org A payment → org B project    Payment_orgId_projectId_fkey      BLOCKED
org A payment → org B worker     Payment_orgId_workerId_fkey       BLOCKED
org B approval → org A payment   Approval_orgId_paymentId_fkey     BLOCKED
org B audit → org A payment      AuditEvent_orgId_paymentId_fkey   BLOCKED
org B escrow → org A project     Escrow_orgId_projectId_fkey       BLOCKED
```

Note the MATCH SIMPLE semantics: when the optional id is NULL the constraint is
satisfied, which is the intended behaviour for optional parents.

`@@unique([orgId, id])` on `Project`, `Worker`, `Escrow`, `PayrollBatch` and
`Payment` exists to make them valid composite-FK targets.

---

## 3. The application boundary

One module: `src/lib/tenancy/`.

| File | Responsibility |
|---|---|
| `rbac.ts` | Permission and delegation tables — see [`RBAC.md`](RBAC.md) |
| `resolve.ts` | Membership resolution and every scoped resource lookup |
| `membership.ts` | Membership lifecycle, invitations, escalation guards |
| `http.ts` | `withTenant()` — the wrapper every tenant-scoped route uses |

### Nothing from the client is trusted

A client may **name** which of its organizations to act in (`X-Organization-Id`,
`?orgId`, or a body field). It may never assert that it belongs to one, nor what it
may do there. Both come from `OrgMember`, read on every request.

Specifically untrusted: `organizationId` as a bearer of authority, role claims,
project ownership, hidden form fields, client-side route protection.

When the caller belongs to exactly one organization, that one is used. When they
belong to several, the request **must** say which — guessing could perform an
action in the wrong tenant's name, and a payment approved in the wrong
organization is not a recoverable mistake.

### Scoping lives in the WHERE clause

Resources are loaded with `orgId` as part of the query, never fetched by global id
and checked afterwards. A post-fetch check still performs the read, and any
logging, error path or timing difference around it can disclose existence.

### 404, not 403, for anything out of scope

A 403 on a foreign resource confirms it exists. Repeated across a range of ids that
becomes an enumeration oracle: an attacker learns how many payments another tenant
has, and roughly what they are worth, without reading one. Every cross-tenant miss
is therefore **byte-identical** to a genuine miss — same status, same message.

403 is reserved for resources the caller *can* see but may not act on.

The same applies to membership: `INVITED`, `SUSPENDED` and `REMOVED` are all
indistinguishable from non-membership, so suspending someone does not tell them
they were ever a member.

### On-chain ids are not tenant-safe

Escrow ids are assigned by the contract, so org A and org B can both hold an
"escrow 3" on different deployments. `findEscrowByOnChainId` always filters by
organization; resolving an on-chain id globally would hand one tenant another's
escrow.

---

## 4. Membership lifecycle

```
INVITED ──▶ ACTIVE ──▶ SUSPENDED ──▶ ACTIVE
   │           │            │
   └──────────▶└───────────▶└──────▶ REMOVED   (terminal)
```

Only **ACTIVE** grants authority. `SUSPENDED` is kept distinct from `REMOVED` so
access can be revoked without destroying the record of who held what — an audit
trail that says a role "never existed" after an incident is worse than none.

`REMOVED` is terminal. Re-admitting someone creates a **new** membership, so the
previous one's history stays attributable.

Guards, each tested: no self-targeting, no granting above your level, no removing
or suspending or demoting the last active administrator.

---

## 5. Invitations

| Property | Implementation |
|---|---|
| Unpredictable | 32 bytes of CSPRNG output, base64url |
| Stored hashed | Only `sha256(token)` is persisted — a database dump must not yield working invitations |
| Single-use | Conditional update on `usedAt IS NULL` inside a transaction, so two racing requests cannot mint two memberships |
| Expiring | 7 days |
| Org-scoped | `orgId` is **required**; an invitation that cannot name its organization is not acceptable |
| Role-scoped | `orgRole` validated against the inviter's delegation |
| Revocable | `revokedAt`, kept distinct from `usedAt` so "withdrawn" is never read as "accepted" |
| Returned once | The plaintext token appears only in the creation response |

**Email uniqueness is per organization**, not global. A global constraint meant
that once org A invited `alice@example.com`, org B could never invite her — and the
failure disclosed that some other tenant already had her. Contractors working for
several agencies is the normal case.

**Every rejection looks the same to the caller.** Expired, revoked, already-used
and never-existed all return one 404 body. Distinguishing them tells someone
probing tokens which of their guesses were real.

**Acceptance does not change an existing member's role**, in either direction — an
invitation must not be a promotion channel for someone who already belongs. A
`REMOVED` member cannot be re-admitted by an old invitation.

---

## 6. Indexer tenancy mapping

**The chain knows nothing about CoreFlow organizations.** The only authoritative
mapping is an `Escrow` row the application itself wrote — created when a member
submitted the creation transaction, or when an operator explicitly claimed the
escrow.

```
chain event (escrow N, contract C, network W)
        │
        ▼
  Escrow WHERE onChainId=N AND contractId=C AND network=W
        │
   ┌────┴─────┐
found       not found
   │            │
   ▼            ▼
project    record with attributed=false, project NOTHING
under
that org
```

The indexer **never invents a tenant.** It previously auto-created one
organization per deployment and attached every discovered escrow to it; that is a
guess, and it would place one party's payroll, recipients and amounts inside
another's workspace. A data breach produced by a convenience default.

Consequences, stated plainly:

- Escrows created outside the app (CLI, validation scripts, another client) are
  **invisible until claimed**. That is the intended trade.
- `POST /api/organizations/:id/escrows/claim` attributes one, and requires the
  caller to prove against **live contract state** that their wallet is the escrow's
  on-chain manager. Without that, any organization could claim any escrow by naming
  its id.
- An escrow already claimed by another organization returns a deliberately vague
  409: confirming that another tenant holds it would disclose that tenant's
  existence.
- Unattributed events are **recorded, not dropped** (`ChainEvent.attributed =
  false`, with the decoded payload). After a claim, `replayUnattributed()` applies
  the backlog — the cursor has advanced past those ledgers, so without replay a
  claimed escrow would silently be missing all history predating its claim.

Protections: duplicate events are keyed by RPC paging token; duplicate payments are
impossible via `@@unique([escrowId, onChainPaymentIndex])`; conflicting mappings
are refused rather than reassigned; orphan and conflicting chain state becomes a
`ReconciliationFinding`.

---

## 7. Threat model

| Attack | Mitigation | Residual risk |
|---|---|---|
| Substitute another tenant's resource id | Scoped queries + composite FKs; 404 response | — |
| Enumerate ids to infer another tenant's volume | Identical response for foreign and nonexistent | Timing differences not measured |
| Claim another tenant's on-chain escrow | On-chain manager proof against live state | A compromised manager key can claim its own escrows into an attacker's org |
| Escalate via invitation | `orgRole` validated against inviter's delegation | — |
| Escalate via self-promotion | `checkNotSelf` | — |
| MANAGER manufactures the finance approval | Cannot grant FINANCE; cannot hold both halves; contract enforces `SignersNotDistinct` | — |
| Strand an organization with no admin | `checkNotLastAdministrator` on remove/suspend/demote | A single owner losing their key is unrecoverable without operator action |
| Steal an invitation from the database | Only the hash is stored | A leaked creation **response** yields a live token until expiry |
| Replay an invitation | Single-use conditional update | — |
| Platform admin reads every tenant's payroll | Legacy platform `Role` grants no payment authority; `/api/escrows` and audit logs are org-scoped | — |
| Indexer mis-assigns chain data | No tenant is invented; unattributed by default | — |
| Stale client shows org A data after switching | Server always re-resolves; client must refetch | **Frontend switcher not yet built** — see §8 |

---

## 8. What is NOT done

Stated explicitly rather than implied by omission.

| Gap | Status |
|---|---|
| **Organization UX** | No switcher, no onboarding wizard, no members/projects screens. The API exists and is enforced; the interface does not. Stale-client-state invalidation is therefore untested in a real UI. |
| **Project-level scoping** | Projects are tenant-scoped entities, but permissions are **organization-wide**: a role grants the same access to every project in the organization. Per-project membership is not implemented. This is deliberate — the simplest model that is secure — and is recorded as a product decision, not a completed feature. |
| **Worker identity across organizations** | The same wallet **may** be a worker in multiple organizations (`@@unique([orgId, walletAddress])`), and each is a separate `Worker` record with its own payment history. Whether that should be linkable to one human is undecided. |
| **Treasury** | `treasury:read` exists in the matrix; no treasury endpoint or view is implemented. |
| **Query performance under scoping** | Indexes exist on `(orgId, state)`, `(orgId, role)`, `(orgId, status)`, `(orgId, resolvedAt)` and the composite-FK targets. Not load-tested; no N+1 audit beyond the route handlers changed here. |
| **Reconciliation scheduling** | `reconcileOrganization` is implemented and tested but nothing invokes it on a timer. Reconciliation logic, not reconciliation operations. |
| **Approval granularity** | Per-escrow, not per-payment — a contract-level constraint. See `PAYMENT_STATE_MACHINE.md` §12. |
