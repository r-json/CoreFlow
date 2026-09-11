# Environments

CoreFlow runs in three environments. They differ in **which database** and
**which chain** they touch, and those two facts decide whether a mistake is
recoverable.

A development command must never silently inherit production configuration. On
2026-09-11 one did: a `vercel env pull` overwrote `.env` / `.env.local` with the
deployment's variables, repointing local development at the production database
and Mainnet v1. Every individual value was valid; only the combination was wrong.
[`scripts/check-env.mjs`](../scripts/check-env.mjs) now refuses that combination.

---

## The three environments

| | DEVELOPMENT | TESTNET VALIDATION | PRODUCTION |
|---|---|---|---|
| **Database** | Private local cluster, port 5440 | Dedicated hosted Postgres, disposable | Managed Postgres (`db.prisma.io`) |
| **Chain** | Stellar **Testnet** | Stellar **Testnet** | Stellar **Mainnet** |
| **Contract** | v2 `CDN4FIKL…VAQRG5F4` | v2 `CDN4FIKL…VAQRG5F4` | v1 `CCTF5WBO…J2XPRFFW` |
| **Settlement asset** | v2 testnet SAC `CBW2ZKFB…JS743Q5M` | same | v1 mainnet SAC |
| **Funds at risk** | None | None | **Real** |
| **Schema version** | v2 (10 migrations, applied & verified) | v2 (10 migrations) | **v1** — see below |
| **Who may reset it** | Anyone, freely | Anyone, deliberately | Nobody, ever, from a dev workflow |
| **Preflight verdict** | must pass | `COREFLOW_ALLOW_REMOTE_DB=1` | `COREFLOW_ALLOW_MAINNET=1` + out-of-band authorization |

### Production is still v1

No part of the v2 hardening is deployed. Production holds the 11-table v1 schema,
and its migration history diverges from this repository's. See
[PRODUCTION_DATABASE_REMEDIATION.md](PRODUCTION_DATABASE_REMEDIATION.md).

Do not describe v2's security properties as live on Mainnet. They are not.

### Which is the default

**DEVELOPMENT: local database + Testnet v2.** Every `npm` task that can write
runs the preflight first and refuses anything else:

```
predev  predev:http  predb:migrate  predb:deploy  predb:seed  →  npm run check:env
```

`build` and `vercel-build` deliberately do **not** run it. The production
deployment legitimately is Mainnet v1, and failing its build would take the live
site down.

---

## Setting up the development database

One command:

```bash
./scripts/dev-db.sh init
```

That creates a **private PostgreSQL cluster owned by your user**, in your home
directory, on a non-default port, and writes the connection URLs into `.env`.

### Why a separate cluster rather than a database in the system one

Creating a role in the system instance needs an existing superuser. On the machine
this was set up on, neither `postgres` peer authentication nor the old `coreflow`
password was available — the password was lost with the `.env.local` that a
`vercel env pull` overwrote.

`initdb` does not need root. A cluster you create is one you are legitimately the
superuser of, so no authentication is circumvented and the system instance is left
alone. It has a useful side effect: development cannot reach anything but its own
data.

| | |
|---|---|
| Data directory | `~/.local/share/coreflow/pgdata` (override with `COREFLOW_PGDATA`) |
| Port | `5440` (override with `COREFLOW_PGPORT`) |
| Listens on | `127.0.0.1` only |
| Databases | `coreflow_dev`, `coreflow_shadow` |
| Role | `coreflow`, no `CREATEDB`, no `SUPERUSER` |
| Password | generated locally, written only to `.env`, never printed |

Port 5440 rather than 5433: on this machine 5432 is the system PostgreSQL and 5433
was held by podman's `pasta` networking.

The **shadow** database is separate because Prisma **resets** it. Pointing
`SHADOW_DATABASE_URL` at a database holding anything you want to keep destroys it —
which is exactly how the original dev database was lost once already.

```bash
./scripts/dev-db.sh start     # after a reboot
./scripts/dev-db.sh stop
./scripts/dev-db.sh status
./scripts/dev-db.sh psql      # a shell on coreflow_dev
./scripts/dev-db.sh destroy   # delete the cluster and all its data
```

### Then migrate

```bash
npm run check:env       # must print "OK: local database + Testnet v2."
npm run db:deploy       # applies all 10 migrations from zero
npx prisma migrate status
npm run test:integration
```

---

## Which file holds what

This is the part that went wrong on 2026-09-11, so it is worth being exact.

| File | Written by | Read by | Holds |
|---|---|---|---|
| `.env` | **you**, and `scripts/dev-db.sh` | Next.js **and** Prisma CLI | local development configuration, including the database URLs |
| `.env.local` | **you** | Next.js only | personal overrides; **no database URLs** |
| `.env.vercel` | `vercel env pull --env=production` | nothing automatically | the deployment's configuration, for reference |
| `.env.example` | **you** | nobody | placeholders, committed |

**Database configuration lives in `.env`, not `.env.local`.** This is not a
preference: the **Prisma CLI reads only `.env`**, while Next.js reads both. Putting
the URLs in `.env.local` makes the app work and every `prisma migrate` fail with
*Environment variable not found: DIRECT_URL*.

### After a `vercel env pull`

**Never pull into `.env` or `.env.local`.** Pull into `.env.vercel`:

```bash
vercel env pull .env.vercel --env=production
```

A bare `vercel env pull` writes `.env.local` and will silently replace your local
database URLs and network settings with the deployment's. If it has already
happened, the production database URLs are still commented out in `.env` with a
note; the preflight will refuse to run until they are gone or local:

```bash
npm run check:env
```

Neither `.env`, `.env.local` nor `.env.vercel` is ever committed — `.gitignore`
denies every `.env` variant and re-admits only `.env.example`.

## Preflight reference

[`scripts/check-env.mjs`](../scripts/check-env.mjs) is fail-closed and judges
against explicit allowlists, not string patterns. It refuses when:

- `NEXT_PUBLIC_STELLAR_NETWORK` is `public` / `mainnet`
- `NEXT_PUBLIC_STELLAR_CONTRACT_ID` is the Mainnet v1 contract
- `NEXT_PUBLIC_STELLAR_CONTRACT_ID` is **absent from the deployment registry** —
  an unrecognized address is refused rather than assumed
- `NEXT_PUBLIC_STELLAR_TOKEN_ID` is not the SAC the v2 Testnet deployment was
  configured with (an escrow holds exactly one asset)
- any of `DATABASE_URL`, `DIRECT_URL`, `PRISMA_DATABASE_URL`, `POSTGRES_URL`
  resolves to a host outside the local allowlist

It prints hostnames and contract addresses only. It never reads a secret for its
value and never prints one.

### Overrides

Per-run and deliberate. Never set these as defaults, and never commit them:

| Variable | Meaning |
|---|---|
| `COREFLOW_ALLOW_MAINNET=1` | A deliberate Mainnet action |
| `COREFLOW_ALLOW_REMOTE_DB=1` | A deliberate action against a non-local database |
| `COREFLOW_ALLOW_UNKNOWN_CONTRACT=1` | A contract not in the registry, e.g. a scratch deployment |

Adding a deployment is meant to require editing `KNOWN_CONTRACTS` in the script
and [DEPLOYMENTS.md](DEPLOYMENTS.md). That friction is the feature.

---

## Secrets

Never committed: `.env`, `.env.local`, any `.env.*`, `*.pem`, `*.key`,
`prodenv.txt`, any `*env*.txt`. `.gitignore` denies every `.env` variant and
re-admits only `.env.example`, which holds placeholders and local-only values.

Never logged: oracle secret keys, `AUTH_SECRET`, `BOOTSTRAP_SECRET`,
`CRON_SECRET`, `INDEXER_SECRET`, database passwords, `VERCEL_OIDC_TOKEN`, session
tokens, wallet secrets.

A `vercel env pull` writes **live production secrets** to disk. Those files are
git-ignored, but they are still real credentials sitting in the working tree.

### Outstanding

🔴 **Secret rotation is still outstanding** for everything exposed by
`prodenv.txt`: the oracle signing key, `AUTH_SECRET`, `BOOTSTRAP_SECRET`, cron /
indexer secrets, and the database credential. Until each is rotated and the old
value proven unable to authenticate or sign, this environment is not
production-grade, regardless of what the test suite reports.
