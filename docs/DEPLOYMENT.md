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

## Rollback (M1)

- The backend is not yet on `main`/production; M1 ships on the
  `feat/auth-offchain-index` branch via preview deploy first.
- To roll back a deploy: redeploy the previous Vercel build (instant).
- Migrations are forward-only; this milestone's `init` migration creates new
  tables only (no destructive change), so a rollback of code is safe — the
  tables simply go unused. If a migration must be undone, restore from the
  managed Postgres point-in-time backup.
