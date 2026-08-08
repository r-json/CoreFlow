# CoreFlow 50-user simulation

## Scope

CoreFlow uses a multi-signature payroll escrow lifecycle. The repository simulation creates 50 unique worker addresses in a deterministic Soroban test environment and runs this sequence for each worker:

1. `initialize_multi_sig_escrow`
2. `submit_hours_proof` with a valid Ed25519 oracle signature
3. `manager_approve`
4. `finance_approve`
5. `finalize_payment`

The test also verifies that every worker receives the expected amount and that the contract custody balance returns to zero after all 50 payouts.

## Run the contract simulation

From the repository root:

```bash
cd contracts/core-flow
cargo test test_fifty_user_end_to_end_simulation
```

The test requires a configured Rust toolchain and the dependencies in `contracts/core-flow/Cargo.toml`.

## Generate reporting artifacts

```bash
node scripts/generate-50-user-report.mjs
```

Generated files:

- `docs/evidence/50-user-simulation.json`: machine-readable summary and per-user rows
- `docs/evidence/50-user-simulation.tsv`: spreadsheet-ready table
- `docs/evidence/50-user-analytics.svg`: analytics evidence for the deterministic fixture
- `docs/evidence/50-user-transaction-activity.svg`: lifecycle activity evidence for the deterministic fixture

These SVGs are report graphics generated from the local fixture. They are not screenshots of Stellar testnet transactions and contain no fabricated transaction hashes.

## Live Stellar testnet run

A live run needs a funded testnet manager, finance account, 50 worker accounts, a deployed CoreFlow contract, a Stellar Asset Contract address, and an oracle key that can produce the contract's 64-byte Ed25519 proofs. Do not use the local fixture artifacts as live-chain evidence.

Before publishing live results, record for every worker:

- worker wallet address
- escrow ID
- registration transaction hash
- hours-proof transaction hash
- manager approval transaction hash
- finance approval transaction hash
- finalization transaction hash
- Stellar Expert URL

The live report should replace the local evidence section with verified explorer links and screenshots captured from the testnet account and contract activity pages.

## Current execution note

The repository implementation is ready for the 50-user test. The current development machine must first configure Rust, for example with `rustup default stable`, before the contract test can run.
