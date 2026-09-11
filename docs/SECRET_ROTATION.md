# Secret rotation — runbook

> **Status: PREPARED, NOT EXECUTED.** No secret has been rotated. No Vercel
> environment variable has been changed. `docs/evidence/secret-rotation.json`
> does not exist, which is the check for whether any of this has run.

Executor: [`scripts/rotate-secrets.mjs`](../scripts/rotate-secrets.mjs). It emits
its own evidence, because a rotation you cannot demonstrate is a rotation you
have not finished.

## What was exposed, and how far

`prodenv.txt` — a `vercel env pull` dump — sits in the working directory holding
live production values. Its contents were enumerated by variable **name** to
establish the real scope, because acting on an assumed scope is how a rotation
misses something or wastes effort on something it never touched:

| Variable in the dump | Classification |
|---|---|
| `ORACLE_SECRET_KEY` | secret — **on-chain coupled**, excluded below |
| `AUTH_SECRET` | secret — rotate |
| `BOOTSTRAP_SECRET` | secret — prefer removal |
| `DATABASE_URL`, `DIRECT_URL`, `PRISMA_DATABASE_URL`, `POSTGRES_URL` | credential — provider-side rotation |
| `VERCEL_OIDC_TOKEN` | short-lived, self-expiring — no action |
| `ADMIN_WALLETS`, `VERCEL_URL`, `NEXT_PUBLIC_*` | not secret |

**`CRON_SECRET` and `INDEXER_SECRET` are not in this dump** — `grep -ci
'cron|indexer'` returns 0. Earlier notes, including `BACKLOG.md` item 7, listed
them among the exposed values; that was wrong and is corrected here. They are
still worth rotating as hygiene, and the procedure below covers them, but they
are **not** part of this exposure and should not be treated as urgent on its
account. Overstating a breach misdirects the response as surely as understating
it does.

Containment, verified:

| Check | Result |
|---|---|
| Tracked in `HEAD` | no |
| Added in any reachable commit (`--all`) | no |
| Matched by `.gitignore` | yes — `.gitignore:73`, `*env*.txt` |

So the exposure is **local disk only**; it was never published through git. That
lowers the urgency but does not remove the requirement: a credential that has sat
in a plaintext file of unclear handling is a credential of unknown disclosure.

**Do not delete `prodenv.txt` yet.** It is the record of the values being
replaced, and you need it to confirm the old values are dead. Dispose of it in
the last step.

## What is NOT rotated here, and why

### `ORACLE_SECRET_KEY` — excluded, deliberately

The oracle public key is *derived* from this secret
([`src/lib/oracle/index.ts:74`](../src/lib/oracle/index.ts)) and stored as each
escrow's `oracle_pubkey`. The contract accepts attestations only from a key its
admin has registered. Rotating the secret is therefore **not an environment
change — it is an on-chain change**, and that registration is the action
currently blocked on the owner confirming the key mapping.

Rotating it now would be actively harmful. The open question is which of two
existing keys is post-rotation; minting a third candidate destroys the ability to
answer it. `scripts/rotate-secrets.mjs` refuses this secret outright.

See [ORACLE_KEY_TRANSITION.md](ORACLE_KEY_TRANSITION.md).

### The database credential — provider-side, not scriptable

It exists in the Postgres provider *and* in four environment variables. Changing
either half alone breaks the deployment. Procedure is at the end of this file.

## Order of operations

A Vercel environment change **does not affect the running deployment.** Nothing
cuts over until the next deployment. This is the single most useful fact here:
you can stage every change calmly, and the redeploy is the atomic moment.

```
1. rotate the env vars        ← no user-visible effect yet
2. redeploy                   ← the cutover
3. prove each OLD value dead  ← the step that makes it real
4. dispose of prodenv.txt     ← only after 3 passes
```

## 1. Cron and indexer secrets — hygiene, and rotate BOTH or neither

Not part of the `prodenv.txt` exposure (see above). Sequenced first only because
it is the lowest-risk change — no sessions break and no user notices.

Both guarded endpoints resolve the secret with a fallback:

```ts
// src/app/api/indexer/run/route.ts:16
const secret = process.env.INDEXER_SECRET || process.env.CRON_SECRET;
// src/app/api/reconciliation/run/route.ts:37
const expected = process.env.CRON_SECRET || process.env.INDEXER_SECRET || '';
```

Rotating one leaves the other accepted. **Rotating only `CRON_SECRET` rotates
nothing** — the exposed `INDEXER_SECRET` still authenticates.

```bash
node scripts/rotate-secrets.mjs --rotate CRON_SECRET
node scripts/rotate-secrets.mjs --rotate INDEXER_SECRET
```

Update the Vercel Cron configuration to the new `CRON_SECRET`, or scheduled
indexing and reconciliation stop silently at the next run.

## 2. `AUTH_SECRET` — a hard cutover

`src/lib/auth/jwt.ts` signs HS256 with a single secret and has no overlap
window, so rotation invalidates every issued session at redeploy. Every user is
logged out and signs in again with their wallet. With the current user count that
is acceptable; it is not a graceful rotation, and it should not be presented as
one.

```bash
node scripts/rotate-secrets.mjs --rotate AUTH_SECRET
```

## 3. `BOOTSTRAP_SECRET` — prefer removal

This guards `POST /api/admin/bootstrap`, which claims the **first** admin. Unset,
the endpoint answers 404 and no secret reaches it at all. If an admin already
exists in production, removal is strictly better than rotation — rotation keeps a
live door for a one-time operation that is already complete.

```bash
node scripts/rotate-secrets.mjs --remove BOOTSTRAP_SECRET
```

**This one cannot be verified by probing**, and the script refuses to try:

- On a secret match the route proceeds to `prisma.user.upsert`, defaulting the
  wallet to `ADMIN_WALLETS[0]`. A probe that *succeeded* would grant admin in
  production — the check would cause the thing it checks for.
- The endpoint returns 404 whether the secret is unset **or** merely wrong, so a
  404 proves nothing.

Verify from configuration instead:

```bash
vercel env ls production | grep BOOTSTRAP_SECRET   # expect no row
```

…then confirm a deployment was created after the removal.

## 4. Redeploy

Until this happens, nothing above has taken effect.

## 5. Prove the old values are dead

This is the step that distinguishes a rotation from an intention. The old secret
goes in on **stdin, never argv** — argv is world-readable via `ps`.

```bash
node scripts/rotate-secrets.mjs --verify-dead CRON_SECRET \
  --url https://coreflow-psi.vercel.app < old-cron-secret.txt

node scripts/rotate-secrets.mjs --verify-dead AUTH_SECRET \
  --url https://coreflow-psi.vercel.app < old-auth-secret.txt
```

- `CRON_SECRET` / `INDEXER_SECRET`: presents the old bearer to both guarded
  endpoints; expects rejection from each.
- `AUTH_SECRET`: mints an HS256 JWT signed with the **old** secret and presents
  it as a `cf_session` cookie to `/api/auth/me`. Acceptance would mean the old
  secret still validates sessions.

The script exits non-zero and records `old_value_rejected_everywhere: false` if
any old credential still works. Two guards keep that record honest: it refuses a
path with no `route.ts` in source (a mistyped path 404s, which would otherwise
read as a rejection), and it refuses a stdin value under 32 characters (so a
placeholder cannot manufacture a passing record).

Shred the temporary files afterwards: `shred -u old-*.txt`.

## 6. The database credential

Ordered, because the halves must not drift:

1. Change the password in the Postgres provider's console. Keep the old user
   alive for the moment if the provider allows it.
2. Update all four variables to the new credential — `DATABASE_URL`,
   `DIRECT_URL`, `PRISMA_DATABASE_URL`, `POSTGRES_URL`. `check-env.mjs` already
   knows all four; missing one leaves a path authenticating with the old value.
3. Redeploy, then confirm the app reads and writes.
4. Revoke the old credential provider-side, and confirm it can no longer connect.

Do **not** point local development at the rotated production database while
doing this. `npm run check:env` enforces that and should stay enforcing it.

## 7. Dispose of `prodenv.txt`

Only once every old value above is proven dead:

```bash
shred -u prodenv.txt
```

Then re-run `npm run check:env` to confirm the local environment is still
`profile: LOCAL`.

## Open finding — unequal guards on the same secret

`CRON_SECRET`/`INDEXER_SECRET` protect two endpoints, and the two do not defend
equally:

| | `reconciliation/run` | `indexer/run` |
|---|---|---|
| Comparison | `timingSafeEqual` over SHA-256 | `header === \`Bearer ${secret}\`` |
| Minimum length enforced | yes | no |
| Rate limited | yes | no |
| Response on failure | 404 | 401 |

An attacker attacks the weaker of the two. The timing channel is not practically
exploitable across a network against a 256-bit secret, so this is low severity —
but the missing minimum-length check means a short or placeholder secret would be
**accepted** by `indexer/run` while `reconciliation/run` correctly refuses to
expose itself at all. Not changed here: this runbook rotates secrets and does not
alter authentication code mid-rotation. Logged for a separate, reviewed change.
