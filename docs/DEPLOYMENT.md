# CoreFlow — Deployment & Operations

> Living document. Each milestone appends its operational notes here.

## Environment matrix

| Variable | Scope | Local | Vercel (prod) | Notes |
|---|---|---|---|---|
| `DATABASE_URL` | server | direct local PG | **pooled** url (PgBouncer/Neon/Supabase) | app runtime connection |
| `DIRECT_URL` | server | = `DATABASE_URL` | **unpooled** url | used by `prisma migrate` only |
| `AUTH_SECRET` | server | 32+ char hex | 32+ char hex (secret) | HS256 JWT signing |
| `NEXT_PUBLIC_STELLAR_NETWORK` | client | `testnet` | `testnet`/`public` | |
| `NEXT_PUBLIC_STELLAR_CONTRACT_ID` | client | deployed id | deployed id | |
| `NEXT_PUBLIC_STELLAR_READ_ADDRESS` | client | valid G… key | valid G… key | read-only simulations |
| `NEXT_PUBLIC_FREIGHTER_TIMEOUT` | client | `5000` | `5000` | |

Generate a secret: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`

## Local development

```bash
docker compose up -d                 # Postgres on :5432
cp .env.example .env                 # then fill AUTH_SECRET
npm install                          # postinstall runs `prisma generate`
npm run db:migrate                   # applies migrations to local DB
npm run dev
```

No Docker? Point `DATABASE_URL`/`DIRECT_URL` at any reachable Postgres 14+.

## Database

- Engine: **PostgreSQL** (was SQLite — SQLite cannot persist on Vercel's
  read-only/ephemeral serverless filesystem, so the backend could never run in
  production on it).
- Migrations live in `prisma/migrations/` and are applied with
  `prisma migrate deploy` (idempotent, forward-only).
- Pooling: serverless functions exhaust direct Postgres connections quickly.
  Use a pooled `DATABASE_URL` (transaction mode) for the app and a direct
  `DIRECT_URL` for migrations.

## Vercel deployment

1. Provision Postgres (Neon/Supabase/Vercel Postgres). Copy the **pooled** and
   **direct** connection strings.
2. Set the env vars from the matrix above in the Vercel project (all
   environments). Mark `DATABASE_URL`/`DIRECT_URL`/`AUTH_SECRET` as secrets.
3. Build command is pinned in `vercel.json`:
   `prisma generate && prisma migrate deploy && next build`
   — so every deploy regenerates the client and applies pending migrations.

## M2 — Custodial escrow (token transfers)

The contract now holds and moves real funds:
- `initialize_multi_sig_escrow(manager, finance, token, oracle_pubkey, payments)`
  pulls the total amount from the manager into contract custody.
- `finalize_payment` transfers each payment to its worker.
- `cancel_escrow` refunds the full balance to the manager.

Operational steps:
1. The escrow ABI changed (new `token` arg + struct field) — **deploy a new
   contract version**. Deploy to **testnet first**.
2. Set `NEXT_PUBLIC_STELLAR_CONTRACT_ID` to the new contract and
   `NEXT_PUBLIC_STELLAR_TOKEN_ID` to the USDC SAC address for that network.
3. Apply the `add_escrow_token` DB migration (automatic via `migrate deploy`).

Rollback: point `NEXT_PUBLIC_STELLAR_CONTRACT_ID` back to the previous
(non-custodial) contract id and redeploy the previous frontend build. Funds are
per-escrow and never pooled, so no fund migration is required. The
`tokenAddress` column is nullable and additive — safe to leave in place.

## M3 — Oracle attestation service

Hours proofs are now signed by a server-side oracle instead of a dummy
signature (which always trapped on-chain).

- `ORACLE_SECRET_KEY` (32-byte hex Ed25519 seed) lives only on the server.
- `GET /api/oracle/pubkey` exposes the public key; escrow creation stores it as
  the escrow's `oracle_pubkey`.
- `POST /api/oracle/attest` (authenticated) signs `(escrow, payment, hours,
  nonce)` after the client reads the on-chain nonce via `get_nonce`.
- `OracleAttestation` rows make signing idempotent per `(escrow, payment,
  nonce)` — a retried submit reuses the same signature.

Operational steps:
1. Generate and store `ORACLE_SECRET_KEY` as a Vercel secret. Rotate by
   deploying a new key; existing escrows keep verifying against the
   `oracle_pubkey` captured at creation, so rotation only affects new escrows.
2. Apply the `add_oracle_attestation` migration (automatic via `migrate deploy`).

Rollback: the oracle routes are additive. Reverting the frontend to the
previous build disables the attest flow; no schema rollback needed (table is
additive). Treat `ORACLE_SECRET_KEY` like any signing key — compromise requires
rotation + re-creation of affected escrows.

## M4 — Authorization & roles

Closes the role gap (previously every user was a permanent `viewer`, so the
write endpoints were unreachable).

- Roles: `admin | manager | finance | worker | viewer`. `admin` passes every check.
- Bootstrap: `ADMIN_WALLETS` (comma-separated) promotes wallets to `admin` on login.
- Grants: `GET/POST /api/admin/roles` (admin only) lists users and sets roles;
  upserts so roles can be pre-assigned before first login.
- Role is read from the **DB on every request** (`getSession`), so grants take
  effect immediately — the JWT role claim is no longer trusted for authz.
- UI gates manager/finance/create actions by role (live mode only; mock demo
  stays fully interactive). Enforcement is server/chain-side regardless.

No DB migration — `role` is an existing string column; `admin` is a new value.

Operational steps:
1. Set `ADMIN_WALLETS` to your admin wallet(s) as a Vercel env var.
2. Sign in with that wallet, then grant teammates roles via the admin endpoint.

Rollback: revert the frontend/API; existing `role` values remain valid. To
remove an admin, set `ADMIN_WALLETS=""` and downgrade via the endpoint (or DB).

## M5 — Chain-event indexer

The DB is now an authoritative projection of chain state instead of relying on
fire-and-forget client writes that could silently drift.

- `GET /api/indexer/run` (cron/secret-guarded) reads contract events from
  Soroban RPC since the stored cursor and applies them idempotently.
- `IndexerCursor` tracks the last processed ledger; `ChainEvent` dedupes by RPC
  paging token. `applyEvent` uses upsert/updateMany so repeats and ordering are
  safe.
- Vercel Cron runs it every 5 min (`vercel.json`).
- The client write-throughs remain as **optimistic UX only** — the indexer
  reconciles the DB to chain regardless, so a failed/missed client write no
  longer causes permanent drift. (Removing the optimistic writes entirely is a
  safe follow-up once the indexer is validated on testnet.)

Operational steps:
1. Set `CRON_SECRET` (Vercel injects it as the cron `Authorization` header) or
   `INDEXER_SECRET`, plus `NEXT_PUBLIC_STELLAR_READ_ADDRESS` (the indexer reads
   full escrow detail on `created`).
2. Apply `add_indexer_tables` (automatic via `migrate deploy`).
3. Confirm the cron is firing (Vercel → Cron logs) and the cursor advances.

Rollback: remove the cron entry; the indexer is additive (own tables) and the
optimistic write-throughs keep the UI functioning. No schema rollback needed.

## M6 — Security hardening

- **Validation:** every mutating route validates its body with zod
  (`src/lib/validation/schemas.ts`) and returns a consistent 400. The escrow
  `onChainId` is now schema-enforced positive-or-absent (no 0-collision path).
- **Rate limiting:** `src/lib/ratelimit.ts` (fixed window) brakes
  `auth/challenge` (20/min/IP), `auth/verify` (10/min/IP), `oracle/attest`
  (30/min/wallet). In-memory + per-instance — for multi-instance scale swap the
  Map for Upstash Redis / Vercel KV behind the same interface.
- **Security headers:** `next.config.js` sends HSTS, X-Frame-Options=DENY,
  X-Content-Type-Options=nosniff, Referrer-Policy, Permissions-Policy, and a
  **Report-Only** CSP (connect-src allows the Stellar RPC). Promote CSP to
  enforcing after validating reports.
- **Audit log:** `AuditLog` table + `audit()` records `role.grant`,
  `escrow.create`, `auth.logout` (best-effort; never blocks the action).

Operational steps:
1. Apply `add_audit_log` (automatic via `migrate deploy`).
2. After deploy, watch CSP report-only violations; once clean, switch the header
   key to `Content-Security-Policy`.
3. For >1 instance, point the rate limiter at a shared store.

Rollback: all additive. Revert code; the `AuditLog` table can remain unused.

## M7 — Test & quality gates

- **Unit/integration:** vitest covers oracle signing, authz, the indexer,
  validation/rate-limit, and API route handlers (escrows, admin roles) via
  mocked auth/prisma. `npm run test:coverage` enforces floors (lines ≥35%,
  ratchet up over time).
- **Contract:** `cargo test` includes a deterministic fuzz test asserting the
  custody sum invariant across randomized scenarios.
- **E2E:** Playwright smoke specs in `e2e/` run against the built app
  (`npm run e2e`). CI installs Chromium and runs them as a separate job.
- **CI gates:** lint → typecheck (`tsc --noEmit`) → coverage → build, plus the
  Rust build/test/clippy/fmt jobs and the E2E job.

Local: `npm run typecheck`, `npm run test:coverage`, then
`npx playwright install chromium && npm run e2e`.

## M8 — Observability & ops

- **Structured logging:** `src/lib/logger.ts` emits one JSON line per event
  (queryable in any log drain). Prod keeps error/warn (info/debug stripped).
- **Error tracking seam:** `captureError()` (`src/lib/observability.ts`)
  normalizes + logs any throwable; wire `@sentry/nextjs` behind `SENTRY_DSN`
  without touching call sites.
- **Health probes:** `GET /api/health` (liveness) and `GET /api/health/ready`
  (DB check → 503 when down). Point uptime monitors / load balancer at these.
- **Error boundaries:** `app/error.tsx` + `app/global-error.tsx` render a
  recoverable fallback and POST to `/api/observability/report`
  (rate-limited) so client crashes surface server-side.

Operational steps:
1. Configure an uptime check against `/api/health/ready`.
2. (Optional) set `SENTRY_DSN` and wire the SDK in `observability.ts`.

Rollback: all additive; revert code with no schema impact.

## Rollback (M1)

- The backend is not yet on `main`/production; M1 ships on the
  `feat/auth-offchain-index` branch via preview deploy first.
- To roll back a deploy: redeploy the previous Vercel build (instant).
- Migrations are forward-only; this milestone's `init` migration creates new
  tables only (no destructive change), so a rollback of code is safe — the
  tables simply go unused. If a migration must be undone, restore from the
  managed Postgres point-in-time backup.
