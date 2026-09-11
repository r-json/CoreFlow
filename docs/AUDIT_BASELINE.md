# CoreFlow — Engineering Baseline Audit

**Date:** 2026-09-10
**Branch audited:** `instawards/pay-batch-sac` @ `301145a`
**Method:** direct source inspection + executed test suites + deployed env inspection.
Documentation claims were *not* taken as evidence.

---

## 0. Executive summary

CoreFlow is in substantially better shape than a typical hackathon repo. The Soroban
contract is real: `pay_batch` performs genuine per-payee SAC transfers, escrow custody
is funded on creation, Ed25519 verification is wired to the host function, replay
protection uses a monotonic nonce watermark, and 40 Rust tests pass. This is not a mock
contract.

The problem is not the contract. **The problem is that the deployed product cannot reach it,
and the security model has a gap that makes its central claim untrue.**

Three findings dominate everything else:

1. **The live application performs no on-chain operations at all.** Production is
   misconfigured such that every contract call is guaranteed to fail (§F-1). What the
   public site demonstrates is the mock path.
2. **Oracle attestations were mintable by anyone on the internet** (§F-2) — fixed in this
   pass. The proof-of-work gate that `pay_batch` enforces was, until now, unguarded at
   the only place that issues proofs.
3. **Amounts are denominated in cents but settled as stroops** (§F-4), a silent
   100,000× under-payment on any batch that does reach the chain.

Test baseline as found: **40 Rust** (1 ignored), **79 TypeScript**, typecheck clean.
After this pass: **40 Rust**, **86 TypeScript**, typecheck clean.

---

## 1. Category A — Production-ready

| Component | Evidence |
|---|---|
| Soroban escrow core | `contracts/core-flow/src/lib.rs`; 40 passing tests incl. multi-asset settlement, custody-sum fuzz invariant, 50-payee E2E |
| Real SAC token settlement | `pay_batch` / `initialize_multi_sig_escrow` call `TokenClient::transfer`; verified by `test_pay_batch_settles_two_assets_in_one_call` |
| Ed25519 host verification | `env.crypto().ed25519_verify`; correctly returns `()` and traps rather than a bool that could only ever be `true` |
| Replay protection (nonce) | Monotonic watermark in persistent storage; O(1), rejects everything at/below watermark |
| Signature-before-nonce ordering | Prevents burning an escrow's nonce sequence with garbage signatures |
| Dual-control invariant | `SignersNotDistinct` rejects `manager == finance_approver` at creation *and* at settlement |
| Wallet auth (challenge/response) | SEP-53 prefix + SHA-256 + Ed25519; challenges are single-use via atomic `updateMany`, 5-min TTL |
| Session revocation | Role and wallet re-read from DB on every request — a stale JWT role claim is never trusted |
| Overflow safety (contract) | `overflow-checks = true` in release profile; arithmetic traps rather than wraps |
| Rust toolchain pin | `rust-toolchain.toml` documents a genuinely load-bearing 1.85.0 window |

## 2. Category B — Functional, needs hardening

- **Rate limiter** is in-memory per-instance (`src/lib/ratelimit.ts`). Correct interface, but
  on Vercel each lambda has its own Map, so effective limits are ~N× the configured value.
- **Indexer** has cursor + idempotency via `ChainEvent.id` (RPC paging token). Lacks
  reconciliation *reporting* — it projects chain→DB but never surfaces a mismatch.
- **Audit log** exists and is written on privileged actions, but nothing enforces
  append-only; any DB write path can mutate history.
- **`/api/admin/bootstrap`** has no rate limit and compares the secret with `!==`
  (non-constant-time). Brute-forcing `BOOTSTRAP_SECRET` grants ADMIN.
- **Error surfaces** are mostly generic strings, not the what/why/next-step model the
  product needs.

## 3. Category C — Partially implemented

- **Bulk Pay** (`src/app/bulk-pay/page.tsx`) is a real client against real contract
  methods, but is hardcoded to `const ESCROW_ID = 1` and its role selector is a
  cosmetic client-side dropdown. It is a demo harness, not a product workflow.
  (On-chain `require_auth` still enforces the real authorization, so this is a product
  gap rather than a security hole.)
- **Receipts** — `PaymentReceipt.tsx` renders, but takes a hardcoded PHP conversion and
  is not wired to settled on-chain state.
- **Observability** — logger + Sentry configs exist; no request IDs, no health-gated
  readiness signal for the indexer.

## 4. Category D — Documented but not implemented

- **`.env.example`** describes granting "manager/finance/worker" roles via
  `POST /api/admin/roles`. The Prisma enum has exactly two values: `ADMIN`, `EMPLOYEE`.
  The five-role RBAC model in the brief does not exist.
- **Multi-tenancy** — no `Organization` model exists. Every escrow row is global. There is
  no tenant boundary to test.
- **README traction claims** — the mainnet contract is genuinely deployed and the
  evidence TSVs contain real hashes. But those transactions were produced by
  `scripts/`, **not** by the deployed application, which (per §F-1) cannot transact.
  The README does not draw that distinction, and it needs to.

## 5. Category E — Missing

- Organizations / teams / tenant isolation
- Explicit payment state machine (`PREPARING → … → CONFIRMED` + failure states)
- DB↔chain reconciliation reporting
- Idempotency keys on financial mutation endpoints
- Structured request-ID correlation
- CSV staged-approval workflow (upload → preview → batch → approvals)

---

## 6. Category F — Dangerous

Ordered by severity. **[FIXED]** items were remediated in this pass; the rest are open.

### F-1 · Live production cannot execute any on-chain operation — **[FIXED IN CODE — needs redeploy]**
Production env has `NEXT_PUBLIC_STELLAR_CONTRACT_ID=""` and `NEXT_PUBLIC_STELLAR_NETWORK=""`.
Both are empty strings, which are falsy, so `src/lib/config.ts` falls back to:
- contract ID → hardcoded **mainnet** `CCTF5WBOQR7JP2KPLQT372X7JCGCINHDFRSAPF4YTYRKZXZ3J2XPRFFW`
- network → `'testnet'` → testnet RPC + testnet passphrase

Every read (`get_escrow`, `get_nonce`) targets a mainnet contract over testnet RPC and
fails. `NEXT_PUBLIC_STELLAR_TOKEN_ID` is also unset, so escrow creation throws
*"Settlement token not configured"* before building a transaction.

**Impact:** the public site demonstrates only the mock path. Any claim that the deployed
app settles on-chain is currently false.

**Fix (code):** `src/lib/config.ts` no longer falls back to a hard-coded mainnet address.
`requireContractId()` throws a clear error when unset; the network resolves to `testnet`
for any unrecognised value, so the app never silently selects a chain where funds are
real. `NetworkBadge` renders the active network persistently, styling Mainnet as a
warning and calling out an unconfigured contract instead of showing green.

**Still required from the operator:** set `NEXT_PUBLIC_STELLAR_CONTRACT_ID`,
`NEXT_PUBLIC_STELLAR_NETWORK` and `NEXT_PUBLIC_STELLAR_TOKEN_ID` in the deployment, then
redeploy. Until then the app correctly refuses on-chain actions rather than failing
opaquely.

### F-2 · Oracle attestations were mintable by anyone — **[FIXED]**
`POST /api/submit-batch` had **no authentication and no rate limit**, and was absent from
the middleware matcher. It signs the Ed25519 attestations that set `proof_verified`, which
is the sole gate `pay_batch` enforces before releasing funds.

Anyone on the internet could mint the proof-of-work half of the security model.

**Fix:** requires a verified session, **and** that the caller equals the escrow's
**on-chain manager** (read live from the contract, not from request content). Added
rate limiting and audit events. 7 regression tests in
`src/app/api/__tests__/submit-batch.route.test.ts`, including a signed-in worker and a
platform ADMIN who is not the manager — both rejected, with `signHoursProof` asserted
un-called.

### F-3 · Publicly-known JWT signing key fallback — **[FIXED]**
`src/lib/env.ts` defaulted `AUTH_SECRET` to the literal
`'default_super_secret_coreflow_jwt_key_32bytes'` — 44 chars, so it satisfied the
`min(32)` guard. Any deployment missing the variable would sign sessions with a key
published in the repo, allowing anyone to forge an ADMIN JWT.
**Fix:** default removed; a missing `AUTH_SECRET` is now a startup failure.

### F-4 · Money unit mismatch: cents settled as stroops — **[FIXED]**
`CreateEscrowModal` collects dollars → `Math.floor(parseFloat(x) * 100)` = **cents**.
`useDashboard.ts:563` passes that straight through as the on-chain amount:
`amount: BigInt(amountCents)`. Stellar assets use **7 decimals**.

`$250.50` → `25050` base units → **0.0025050 USDC** actually escrowed and paid, while the
dashboard renders `amountCents / 100` = "$250.50".

**Impact:** a 100,000× under-settlement that the UI reports as success. This is precisely
the "never show success unless the chain agrees" failure mode.

**Fix:** new `src/lib/money.ts` parses decimal *strings* into `bigint` base units — money
never touches a JS `number`, because `parseFloat('0.1') * 100` is `10.000000000000002`.
`CreateEscrowModal` emits base units and previews the exact on-chain figures;
`useDashboard` passes them through unchanged; the indexer stops casting on-chain `bigint`
through `Number` (lossy above 2^53−1). 21 tests in `src/lib/__tests__/money.test.ts`.

### F-5 · The dual-approval flow cannot execute — **[FIXED]**
`useDashboard.ts:575` calls
`submitInitializeEscrow(walletAddress, walletAddress, …)` — manager and finance are the
**same address**. The contract rejects exactly this with `SignersNotDistinct` (#15).

**Impact:** the primary escrow-creation path traps 100% of the time. Separation of duties —
the product's core value proposition — has no working code path in the app.

**Fix:** `CreateEscrowModal` now collects a distinct finance approver, and refuses one
equal to the manager (or to the worker being paid) before a transaction is built.
`useDashboard` passes it through instead of duplicating the manager.

### F-6 · Oracle message has no domain separation — **[FIXED]**
The signed message is 32 bytes: `escrow_id ‖ payment_id ‖ hours ‖ nonce`. It omits the
network passphrase, contract address, worker address, and amount.

**Consequences:** a signature valid on testnet is valid on **mainnet** for the same
`(escrow_id, payment_id, hours, nonce)`; a signature for contract A is valid on contract B.

**Fix — schema v2 (`CFWP`, 198 bytes):** magic, version, `network_id`, contract digest,
worker digest, token digest, escrow id, payment id, amount, hours, period start/end,
nonce. Every field except hours and nonce is read from **stored escrow state**, so a
caller cannot retarget a signature. The contract also exposes `proof_preimage`, making it
the single source of truth for what must be signed. See `docs/ORACLE.md`.

### F-7 · The manager controls the oracle key — **[FIXED]**
`initialize_multi_sig_escrow` accepts `oracle_pubkey` **from the manager**, and
`rotate_oracle_key` is manager-authorized. A manager can install their own key and sign
their own "verified work" attestations.

**Impact:** `proof_verified` is manager-attestable, so "funds only move against proof of
work" is procedural, not cryptographic. Economic damage is bounded (custody is the
manager's own funds), but the *stated security property* does not hold.
**Fix:** an admin-managed on-chain registry — `register_oracle_key`, `revoke_oracle_key`,
`is_oracle_key_registered`. `initialize_multi_sig_escrow` and `rotate_oracle_key` both
refuse a key that is not registered, so rotation cannot be used as a back door. An
admin-less deployment keeps the v1 trust model rather than bricking (no registry
authority exists, so no key could satisfy the check).

### F-8 · Attested "hours" are just the payment amount — **[FIXED]**
`src/app/api/submit-batch/route.ts`: `const hours = Math.max(1, Math.round(Number(payee.amount)))`.

The oracle attests to a number derived from the amount being paid, carrying zero
information about work performed. Separately, `submit_hours_proof` never validates
`amount` against `hours × rate_per_hour`, so verified hours have **no effect on the amount
paid**. The attestation is a rubber stamp on both ends.

**Fix:** the contract enforces `hours × rate_per_hour == amount` (`AmountHoursMismatch`,
#17), and rejects at creation any amount that no whole number of hours can reach — so
custody is never funded into an escrow that cannot settle. Server-side, hours are now
**derived from the on-chain payment row** rather than taken from the upload, and
`/api/submit-batch` refuses a CSV whose payees do not match the funded escrow.

**Known limitation:** this makes hours whole numbers. Fractional-hour payroll needs a
scaled-hours field, which would be a v3 schema change.

### F-9 · `init_admin` is front-runnable, and admin can drain everything — **OPEN, high**
`init_admin` is first-caller-wins. If it is not called in the same operational step as
deploy, anyone may claim admin, then call `upgrade()` to replace the contract WASM and
transfer out all escrow custody. Even when correctly claimed, `upgrade()` is an
unrestricted centralization risk that must be disclosed, not hidden.

### F-10 · 32-bit money column — **[FIXED]**
`Escrow.amountCents` was Prisma `Int` → PG `INTEGER`, overflowing at **$21,474,836.47**.

**Fix:** replaced with `amountBaseUnits BigInt`, `rateBaseUnits BigInt` and
`assetDecimals Int`, plus a `financeApprover` column. Migration
`20260910000000_money_base_units` scales existing cent values by 10^5 so displayed
figures stay stable. BigInt values are serialized as strings at the API boundary —
`JSON.stringify` throws on bigint outright, so an unconverted value is a 500, not a
silent rounding bug.

### F-11 · `BOOTSTRAP_SECRET` brute-forceable — **OPEN, medium**
`/api/admin/bootstrap` is deliberately exempt from session auth, has no rate limit, and
uses a non-constant-time `!==` comparison. Success grants ADMIN.

### F-12 · Live production secrets sat one `git add -A` from publication — **[FIXED]**
`prodenv.txt` (a `vercel env pull` dump containing live `ORACLE_SECRET_KEY`, `AUTH_SECRET`,
`BOOTSTRAP_SECRET`, and database credentials) was untracked but **not** covered by
`.gitignore`.
**Fix:** `.gitignore` now excludes `prodenv.txt` and `*env*.txt`.

> **⚠ These secrets must still be rotated.** Gitignoring the file does not undo the
> exposure — it has existed in plaintext in a working tree. Rotate `ORACLE_SECRET_KEY`,
> `AUTH_SECRET`, `BOOTSTRAP_SECRET`, and the database credentials.
> Note that rotating `ORACLE_SECRET_KEY` invalidates every escrow whose stored
> `oracle_pubkey` is the old key; those escrows need `rotate_oracle_key` or cancellation.

### F-13 · Storage TTL can strand funds — **OPEN, medium**
Escrow data lives in persistent storage with a 90-day extension applied **on write only**.
Reads do not extend TTL. An escrow left idle past the TTL loses its data while its custody
remains in the contract — permanently unrecoverable, since every entry point loads the
escrow first.

---

## 7. Changes made in this pass

| Change | Where | Verification |
|---|---|---|
| Gate oracle signing behind session + on-chain manager check | `src/app/api/submit-batch/route.ts`, `src/middleware.ts` | 10 route tests |
| Remove publicly-known `AUTH_SECRET` fallback | `src/lib/env.ts` | typecheck |
| Bulk Pay performs full challenge/verify sign-in | `src/app/bulk-pay/page.tsx` | typecheck, build |
| Exclude env dumps from git | `.gitignore` | `git check-ignore` |
| Oracle attestation schema v2 (domain separation) | `contracts/core-flow/src/lib.rs`, `src/lib/oracle/index.ts`, `scripts/oracle-cli.mjs` | cross-language vector, 16 TS + 5 Rust tests |
| `proof_preimage` — contract as source of truth for the message | `contracts/core-flow/src/lib.rs` | `test_contract_preimage_matches_independent_implementation` |
| Admin-managed oracle key registry | `contracts/core-flow/src/lib.rs` | 6 Rust tests |
| `hours × rate == amount` invariant | `contracts/core-flow/src/lib.rs` | 2 Rust tests |
| Batch cap + pay-period validation | `contracts/core-flow/src/lib.rs` | 2 Rust tests |
| Exact-decimal money module (base units, `bigint`) | `src/lib/money.ts` | 21 tests |
| Distinct finance approver in escrow creation | `src/components/modals/CreateEscrowModal.tsx`, `src/hooks/useDashboard.ts` | 11 modal tests |
| DB money → `BigInt` base units + `assetDecimals` | `prisma/schema.prisma`, migration | typecheck, route tests |
| Fail-closed network/contract config + visible network badge | `src/lib/config.ts`, `src/components/NetworkBadge.tsx` | build |

### Verification after this pass

| Check | Result |
|---|---|
| Rust contract tests | **54 passed**, 1 ignored (was 40) |
| TypeScript tests | **128 passed** (was 79) |
| `tsc --noEmit` | clean |
| `next build` | succeeds |
| `cargo build --target wasm32v1-none --release` | succeeds (38 KB) |

The single ignored Rust test is pre-existing and documented: `ed25519_verify` traps
non-catchably in native `cargo test`, so a bad-signature rejection cannot be asserted
with `#[should_panic]`. The same limitation is why oracle-registry authorization is
asserted via `env.auths()` rather than by calling unauthorized.

---

## 8. Recommended execution order

**P0 — done in this pass, except where noted**
1. ~~Rotate all exposed secrets (F-12).~~ **STILL REQUIRED — operator action.**
2. ~~Fail-closed network/contract config (F-1).~~ Code done; **needs env set + redeploy.**
3. ~~Fix the cents/stroops denomination end-to-end (F-4).~~
4. ~~Give escrow creation a real distinct finance approver (F-5).~~

**P1 — done in this pass, except where noted**
5. ~~Domain-separate the oracle payload (F-6).~~ Schema v2, cross-language pinned.
6. ~~Admin-managed oracle key allowlist (F-7).~~
7. ~~Bind attested hours to the amount (F-8).~~
8. Harden `init_admin` / disclose `upgrade` authority (F-9); rate-limit bootstrap (F-11).
   **Still open.**
9. Storage TTL can strand funds (F-13). **Still open.**

**P2 — product architecture**
9. `Organization` model + tenant isolation, with explicit isolation tests.
10. Five-role RBAC + endpoint permission matrix.
11. Payment state machine, idempotency keys, DB↔chain reconciliation reporting.

**P3 — product surface**
12. Bulk Pay as a real staged workflow (not `ESCROW_ID = 1`).
13. Dashboard, landing page, receipts, demo mode.
14. README rewritten to separate *deployed*, *testnet-validated*, and *script-generated*
    evidence from what the application itself does.

> Ordering rationale: every P1 item is a statement the product makes to investors about
> its security. Building UI on top of claims that are not yet true increases the surface
> that has to be walked back later.
