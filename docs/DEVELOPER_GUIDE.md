# CoreFlow Developer Guide

Trustless multi-signature payroll escrow on Stellar Soroban.

## Prerequisites

| Tool | Version | Notes |
|---|---|---|
| Rust | **1.85.0 exactly** | pinned by `contracts/core-flow/rust-toolchain.toml` |
| wasm target | `wasm32v1-none` | provisioned by the toolchain file |
| Node.js | 18+ | 20 used in CI |
| Stellar CLI | 22+ | `cargo install stellar-cli` (verified on 27.1.0) |
| PostgreSQL | 14+ | dashboard only; SQLite works for local dev |

### Why Rust is pinned to exactly 1.85.0

`soroban-sdk 20.5.0` sits in a one-version window:

- **rustc ≥ 1.9x** — `core::num::TryFromIntError` became non-zero-sized, breaking
  `ethnum 1.5.0` with `E0512`. `ethnum` is pinned `="1.5.0"` inside
  `soroban-env-common 20.3.0`, so it cannot be bumped independently.
- **cargo < 1.85** — cannot parse the `edition2024` manifest shipped by
  `zeroize 1.9.0`, pulled in via `ed25519-dalek`.

### Why the target must be `wasm32v1-none`

rustc 1.85 emits **reference-types** into `wasm32-unknown-unknown`. The Soroban host
rejects the upload:

```
HostError: Error(WasmVm, InvalidAction)
"reference-types not enabled: zero byte expected"
```

`RUSTFLAGS="-C target-feature=-reference-types"` does **not** suppress this, even on a
clean rebuild. Use `wasm32v1-none`, which excludes post-MVP wasm features.

## 1. Clone and install

```bash
git clone https://github.com/r-json/CoreFlow.git
cd CoreFlow
npm ci
cp .env.example .env.local        # then fill in the values below
```

## 2. Build and test the contract

```bash
cd contracts/core-flow            # REQUIRED: rust-toolchain.toml is directory-scoped.
                                  # Building via --manifest-path from the repo root
                                  # silently uses stable rustc and produces a stale
                                  # or undeployable artifact.
cargo test                        # 40 passed
cargo build --release --target wasm32v1-none
cd ../..
```

Or via npm: `npm run contract:test && npm run contract:build`

## 3. Deploy to Testnet

```bash
# Identity (one-time)
stellar keys generate <MANAGER_KEY> --network testnet --fund
stellar keys generate <FINANCE_KEY> --network testnet --fund   # MUST differ from manager

# Deploy
stellar contract deploy \
  --wasm contracts/core-flow/target/wasm32v1-none/release/core_flow.wasm \
  --source <MANAGER_KEY> --network testnet
# -> CONTRACT_ID

stellar contract invoke --id <CONTRACT_ID> --source <MANAGER_KEY> --network testnet \
  -- init_admin --admin $(stellar keys address <MANAGER_KEY>)
```

Or scripted: `NETWORK=testnet SOURCE=<MANAGER_KEY> ADMIN=<G...> ./deploy.sh`

### Settlement assets

```bash
# Native XLM SAC (no trustline needed by payees)
stellar contract id asset --asset native --network testnet

# Test USDC: issuer + SAC + trustlines + mint
stellar keys generate <ISSUER_KEY> --network testnet --fund
stellar contract asset deploy --asset "USDC:$(stellar keys address <ISSUER_KEY>)" \
  --source <MANAGER_KEY> --network testnet
stellar tx new change-trust --source <MANAGER_KEY> --network testnet \
  --line "USDC:$(stellar keys address <ISSUER_KEY>)"
stellar tx new change-trust --source <PAYEE_KEY> --network testnet \
  --line "USDC:$(stellar keys address <ISSUER_KEY>)"
stellar contract invoke --id <USDC_SAC> --source <ISSUER_KEY> --network testnet \
  -- mint --to $(stellar keys address <MANAGER_KEY>) --amount 10000000000
```

**A payee with no trustline for the asset will trap the whole batch.** `pay_batch` is
atomic by design, so pre-flight every payee's trustline before signing.

## 4. Oracle CLI

```bash
export ORACLE_SECRET_KEY=$(openssl rand -hex 32)   # 32-byte hex seed
node scripts/oracle-cli.mjs pubkey                 # -> hex, use as --oracle_pubkey

cat > batch.json <<'EOF'
{ "escrowId": 1, "startNonce": 0,
  "payees": [ { "paymentId": 0, "hours": 40 }, { "paymentId": 1, "hours": 32 } ] }
EOF
node scripts/oracle-cli.mjs sign batch.json
```

The contract verifies a **32-byte message per payment**, not a batch blob:

```
escrow_id  u32   4 bytes BE
payment_id u32   4 bytes BE
hours      i128 16 bytes BE (two's complement)
nonce      u64   8 bytes BE
```

One signature per payee, nonces consumed **strictly in ascending order** — the contract
holds a monotonic watermark and accepts only the next expected value.

## 5. Full escrow lifecycle

```bash
C=<CONTRACT_ID>; MGR=$(stellar keys address <MANAGER_KEY>); FIN=$(stellar keys address <FINANCE_KEY>)

# Create (manager and finance MUST be distinct -> else Error #15)
stellar contract invoke --id $C --source <MANAGER_KEY> --network testnet \
  -- initialize_multi_sig_escrow --manager $MGR --finance_approver $FIN \
     --oracle_pubkey <ORACLE_PUBKEY_HEX> --payments "$(cat payments.json)"

# Oracle proof, once per payment (signature as hex)
stellar contract invoke --id $C --source <MANAGER_KEY> --network testnet \
  -- submit_hours_proof --escrow_id 1 --payment_id 0 \
     --hours_logged 40 --nonce 0 --signature <SIG_HEX>

# Dual approval — two distinct keys
stellar contract invoke --id $C --source <MANAGER_KEY> --network testnet -- manager_approve --escrow_id 1
stellar contract invoke --id $C --source <FINANCE_KEY> --network testnet -- finance_approve --escrow_id 1

# Settle: one transfer per payee, each in that payee's own asset
stellar contract invoke --id $C --source <MANAGER_KEY> --network testnet -- pay_batch --escrow_id 1

# Rotate the oracle key (revokes prior proofs; retired-key signatures stop verifying)
stellar contract invoke --id $C --source <MANAGER_KEY> --network testnet \
  -- rotate_oracle_key --escrow_id 2 --new_pubkey <NEW_PUBKEY_HEX>
```

`payments.json` — note `status` is the numeric discriminant, **not** `"Pending"`:

```json
[{"id":1,"worker":"<G_PAYEE>","token":"<SAC_ID>","amount":"500000000",
  "start_date":1,"end_date":2,"hours_logged":"0","rate_per_hour":"1",
  "proof_verified":false,"status":0}]
```

## 6. Run the dashboard

```bash
npx prisma generate && npx prisma migrate deploy
npm run dev:http          # http://localhost:3000
# npm run dev             # HTTPS; needs ./certs (required by Freighter)
```

`.env.local`:

```
DATABASE_URL=postgresql://...
NEXT_PUBLIC_STELLAR_NETWORK=testnet
NEXT_PUBLIC_STELLAR_CONTRACT_ID=<CONTRACT_ID>
NEXT_PUBLIC_STELLAR_TOKEN_ID=<DEFAULT_SAC_ID>
ORACLE_SECRET_KEY=<64 hex chars>
```

## 7. Bulk Testnet validation

```bash
export ORACLE_SECRET_KEY=<64 hex>
CONTRACT_ID=<CONTRACT_ID> MANAGER_KEY=<MANAGER_KEY> FINANCE_KEY=<FINANCE_KEY> \
TARGET_TOTAL=50 START_COUNT=0 \
  node scripts/generate-testnet-batches.mjs
```

Appends `<hash>\t<label>` to `docs/evidence/all_50_hashes.txt`.

## Contract error codes

| # | Error | Meaning |
|---|---|---|
| 5 | `InsufficientApprovals` | `pay_batch` before both approvals |
| 6 | `PaymentAlreadyFinalized` | double settlement |
| 9 | `InvalidNonce` | replayed or out-of-order oracle nonce |
| 11 | `Paused` | circuit breaker engaged |
| 13 | `ProofMissing` | a payment has no verified oracle attestation |
| 15 | `SignersNotDistinct` | manager and finance are the same address |

An invalid **signature** does not return a contract error — it traps the host with
`Error(Crypto, InvalidInput)` from `verify_sig_ed25519`. This is non-unwinding and cannot
be caught by `try_*` or `#[should_panic]`, so it is validated on Testnet, not in unit tests.

## Verifying a transaction

```bash
curl -s "https://horizon-testnet.stellar.org/transactions/<TX_HASH>" \
  | jq '{successful, ledger, source_account}'
# https://stellar.expert/explorer/testnet/tx/<TX_HASH>
```
