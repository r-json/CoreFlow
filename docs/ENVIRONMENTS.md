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
| **Database** | Local Postgres, on the developer's machine | Dedicated hosted Postgres, disposable | Managed Postgres (`db.prisma.io`) |
| **Chain** | Stellar **Testnet** | Stellar **Testnet** | Stellar **Mainnet** |
| **Contract** | v2 `CDN4FIKL…VAQRG5F4` | v2 `CDN4FIKL…VAQRG5F4` | v1 `CCTF5WBO…J2XPRFFW` |
| **Settlement asset** | v2 testnet SAC `CBW2ZKFB…JS743Q5M` | same | v1 mainnet SAC |
| **Funds at risk** | None | None | **Real** |
| **Schema version** | v2 (8 migrations) | v2 (8 migrations) | **v1** — see below |
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

### Current state on this machine

- A local Postgres **is** running and accepting connections on
  `/var/run/postgresql:5432`.
- A role named `coreflow` **exists**, but its password is not recoverable — it
  lived in the `.env.local` that the `vercel env pull` overwrote. (`psql` reports
  `password authentication failed`, not `role does not exist`.)
- The OS user has no Postgres role, and `postgres` peer authentication fails, so
  the database cannot be created without an administrator.

Credentials must not be guessed, and Postgres authentication must not be
circumvented. The steps below require a Postgres superuser and are for the
operator to run.

### 1. Generate a password

Generate it locally. **Do not paste it into a chat, a commit, a log or this
file.**

```bash
node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"
```

### 2. Create the role and databases

Two databases: the development database, and a **shadow** database Prisma uses to
verify migrations. They must be separate — Prisma **resets** the shadow database,
so pointing it at a database that holds anything you want to keep destroys it.

```bash
sudo -u postgres psql
```

```sql
-- Give the existing role a known password, or create a fresh one.
-- Pick ONE of these two:
ALTER ROLE coreflow WITH LOGIN PASSWORD 'PASTE_GENERATED_PASSWORD';
-- CREATE ROLE coreflow WITH LOGIN PASSWORD 'PASTE_GENERATED_PASSWORD';

-- Development and shadow databases, owned by that role.
CREATE DATABASE coreflow_dev    OWNER coreflow;
CREATE DATABASE coreflow_shadow OWNER coreflow;

-- No CREATEDB, no SUPERUSER: development needs neither.
\q
```

Confirm it works, and that it is empty:

```bash
psql "postgresql://coreflow:PASSWORD@localhost:5432/coreflow_dev" \
  -c "SELECT count(*) FROM information_schema.tables WHERE table_schema='public';"
# expect 0
```

### 3. Point the environment at it

In `.env.local` (git-ignored), set all four database variables to the **local**
database. The preflight checks every one of them, because a `vercel env pull`
writes all four and leaving one remote is enough to cause harm:

```ini
DATABASE_URL="postgresql://coreflow:PASSWORD@localhost:5432/coreflow_dev?schema=public"
DIRECT_URL="postgresql://coreflow:PASSWORD@localhost:5432/coreflow_dev?schema=public"
SHADOW_DATABASE_URL="postgresql://coreflow:PASSWORD@localhost:5432/coreflow_shadow?schema=public"
```

Delete the `PRISMA_DATABASE_URL`, `POSTGRES_URL` and `VERCEL_OIDC_TOKEN` lines
from `.env.local`. They are deployment artifacts; nothing local reads them, and
while they point at production the preflight will keep refusing.

Leave the Stellar keys as they are — they already name the v2 Testnet deployment:

```ini
NEXT_PUBLIC_STELLAR_NETWORK="testnet"
NEXT_PUBLIC_STELLAR_CONTRACT_ID="CDN4FIKLJ72WYNPBIKWYSDJWDZG22QNPLWI37VTUAE4EKKIBVAQRG5F4"
NEXT_PUBLIC_STELLAR_TOKEN_ID="CBW2ZKFBHLHNNVCZ7JP4AXHQOOC3S6NLAMORXOAIWQNWMKUVJS743Q5M"
```

### 4. Verify, then migrate

```bash
npm run check:env       # must print "OK: local database + Testnet v2."
npm run db:deploy       # applies all 8 migrations from zero
npx prisma migrate status
```

Then the full gate:

```bash
npm run typecheck
npm run test:ci
npm run build
```

### 5. After any `vercel env pull`

Assume it clobbered your local configuration, because it did:

```bash
npm run check:env
```

---

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
