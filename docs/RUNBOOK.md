# CoreFlow — Operations Runbook

Incident response, key management, upgrades, and the mainnet/Demo-Day checklist.
Pairs with [DEPLOYMENT.md](./DEPLOYMENT.md).

## Contract admin model

After deploying the contract, call `init_admin(admin)` **once** with a
hardware-wallet / multi-sig address. The admin can:

- `set_paused(true|false)` — circuit breaker for state-changing ops.
- `upgrade(new_wasm_hash)` — ship a fix without changing the contract address
  or migrating escrow funds.

If `init_admin` is never called, the contract has no admin and can never be
paused or upgraded (acceptable for a pure demo; **not** for mainnet).

## 🔴 Incident: pause the contract

Symptoms: suspected exploit, oracle key compromise, bad upgrade, funds at risk.

```bash
stellar contract invoke --id $CONTRACT_ID --source $ADMIN --network public \
  -- set_paused --paused true
```

Effect: `initialize_multi_sig_escrow`, `submit_hours_proof`, `manager_approve`,
`finance_approve`, and `finalize_payment` revert with `Paused (#11)`.
`cancel_escrow` **stays enabled** so managers can refund held funds.

Resume after remediation:

```bash
stellar contract invoke --id $CONTRACT_ID --source $ADMIN --network public \
  -- set_paused --paused false
```

Also flip the app into read-only/demo posture if needed (toggle in the header /
unset `NEXT_PUBLIC_STELLAR_CONTRACT_ID`).

## 🔑 Key rotation

- **AUTH_SECRET (JWT):** rotate the Vercel env var. All sessions invalidate on
  next request (DB session rows remain but tokens fail verification). Users
  re-authenticate with their wallet.
- **ORACLE_SECRET_KEY:** generate a new keypair, set the env var. Existing
  escrows keep verifying against the `oracle_pubkey` captured at creation, so
  rotation only affects newly created escrows. Re-create affected escrows if a
  key is believed compromised.
- **INDEXER_SECRET / CRON_SECRET:** rotate the Vercel env var; update any manual
  callers.

## ⬆️ Contract upgrade

1. Build + optimize the new WASM, install it on-chain to get its hash:
   ```bash
   stellar contract install --wasm <new>.wasm --source $ADMIN --network public
   ```
2. `pause`, upgrade, smoke test, `unpause`:
   ```bash
   stellar contract invoke --id $CONTRACT_ID --source $ADMIN --network public \
     -- upgrade --new_wasm_hash <hash>
   ```
3. Storage layout must stay compatible (append-only `DataKey` variants — never
   reorder/remove). The M2/M3/M10 changes added variants at the end accordingly.

## ✅ Mainnet go-live checklist

- [ ] External security audit of `contracts/core-flow` completed; findings closed.
- [ ] `init_admin` set to a multi-sig / hardware wallet (not a hot key).
- [ ] `ORACLE_SECRET_KEY` in a managed secret store; rotation runbook rehearsed.
- [ ] Postgres is managed + backed up (PITR); `DIRECT_URL` is unpooled.
- [ ] Indexer cron verified advancing the cursor; reconciliation spot-checked.
- [ ] Rate limiter backed by a shared store (Upstash/KV) for >1 instance.
- [ ] CSP promoted from Report-Only to enforcing (after clean reports).
- [ ] Uptime check on `/api/health/ready`; error tracking (Sentry DSN) wired.
- [ ] Custody invariant (in == out) validated on testnet with ≥10 real users.
- [ ] Pause drill rehearsed; `cancel`/refund path validated while paused.

## 🎤 Demo-Day checklist

- [ ] Testnet contract deployed; `init_admin` set; oracle key configured.
- [ ] `.env` filled; `npm run db:deploy` applied; cron enabled.
- [ ] Happy path rehearsed: create → submit hours (oracle) → manager → finance →
      finalize → worker paid; plus a cancel→refund.
- [ ] Mock-demo toggle works for the no-wallet walkthrough.
- [ ] `/api/health/ready` green; logs clean.
