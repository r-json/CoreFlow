# CoreFlow Kit v0.2.0-alpha: plan

**Status: proposed, not started.**

**Outcome:** a Stellar developer installs CoreFlow Kit from npm and crates.io,
generates a tested claim-gated Soroban contract with one command, and inspects
a deployed contract's issuer registry, replay state and storage TTL from the
terminal before paying a fee.

Today the kit works on Testnet, but using it means cloning this repository and
building tarballs. This increment closes that gap. It adds no claim-format
features, stays Testnet-only, and the kit stays labelled unaudited.

## Deliverables

| # | Deliverable | What ships |
|---|---|---|
| D1 | Registry release pipeline and property-based encoding tests | A tag-triggered `release.yml` that publishes `@coreflow/sdk`, `@coreflow/test-vectors` and `@coreflow/cli` to npm through trusted publishing (GitHub OIDC, provenance generated automatically) and `coreflow-attest` to crates.io through `rust-lang/crates-io-auth-action`. A clean-install matrix (Node.js 22 and 24, Linux and macOS) installs the published packages into an empty project and runs the 16 shared vectors in both languages. Property-based suites (`proptest` and `fast-check`) generate at least 10,000 claims per language on every CI run, check the 256-byte layout, field offsets and malformed-input rejection, and require byte equality between Rust and TypeScript on a shared seeded corpus. A seeded encoder fault must make the suite fail. |
| D2 | `@coreflow/cli` core | `sign` (issuer key from an environment variable or a file, never from arguments), `verify` (every off-chain check in the contract's order, error codes 1101–1109, non-zero exit on failure), `inspect`, `diff`, `explain` and `doctor` (Node.js, the Rust toolchain pinned in `rust-toolchain.toml`, `wasm32v1-none`, stellar-cli 30.0+). Every command has `--json` output and golden-file tests against the Workbench on all 16 vectors. |
| D3 | `coreflow create` scaffold | Generates a Cargo workspace and a TypeScript package with a claim-gated contract: `__constructor(admin)`, admin-gated `add_issuer`, `remove_issuer` and `rotate_issuer`, and `act(claim, signature)`, which checks `claim_type` and `subject` before `verify_claim`. Supports `--replay sequence` and `--replay unique-id`. Ships exact-auth and negative tests, a mutation check, TypeScript bindings generated with `npx @stellar/stellar-sdk generate`, an issuer script, a Testnet script and a SEP-55 (Draft) release workflow that builds and attests the WASM. |
| D4 | Stellar RPC inspection, Testnet evidence and release | `@coreflow/sdk/rpc` (`readIssuerStatus`, `readNextNonce`, `isClaimUsed`, `simulateAct`) and the `coreflow state` and `coreflow simulate` commands. `state` builds the kit's ledger keys and reads each entry's value, durability and `liveUntilLedgerSeq` with `getLedgerEntries`. `simulate` dry-runs `act` with `simulateTransaction` and reports success, a CoreFlow error, a host trap, or archived state, either restored automatically by the invocation (Protocol 23 and later) or flagged by a `restorePreamble`. Read-only; Mainnet is refused. Then two Testnet runs from a scaffolded project, guides whose commands run in CI, and the `v0.2.0-alpha` release. |

## Milestones and acceptance checks

| Milestone | Accepted when |
|---|---|
| M1: Release pipeline and CLI core (weeks 1–2) | The pipeline is proven by publishing 0.1.1 of `@coreflow/sdk`, `@coreflow/test-vectors` and `coreflow-attest` from the v0.1 code: `npm audit signatures` passes for both npm packages, `cargo search coreflow-attest` lists 0.1.1, and the four clean-install jobs pass all 16 vectors. Golden-file tests show `verify`, `inspect` and `explain` output identical to the Workbench on all 16 vectors. |
| M2: Project scaffold (weeks 2–3) | In CI, the CLI tarball runs `create demo`, then `cargo test`, `npm test` and `stellar contract build` pass for both `--replay sequence` and `--replay unique-id`. Negative tests cover non-admin add, remove and rotate, and the scaffold's mutation check kills every mutant. |
| M3: RPC inspection and property tests (week 3) | At least 12 recorded-RPC fixture cases pass, including an archived entry restored automatically and a `restorePreamble` case, plus a Mainnet-refusal test. The property suites run at least 10,000 generated claims per language with cross-language byte equality, and the seeded encoder fault makes them fail. |
| M4: Testnet evidence, guides and release (week 4) | Two scaffold Testnet runs, one from a fresh clone, each with an evidence file covering deployment, issuer registration, an accepted claim, a simulated replay refused with error 1106, `coreflow state` output with TTL, and a SHA-256 manifest of the Horizon responses. `gh attestation verify` passes for the deployed WASM, the docs job is green, and the `v0.2.0-alpha` tag publishes all four packages with release notes, the evidence page in [`docs/evidence/`](../evidence/) and a short terminal walkthrough. |

## Design notes

- **TTL.** Issuer and replay entries are persistent. Every write extends an
  entry's TTL when fewer than a configurable threshold of ledgers remain, up to
  the network maximum. Claim expiry always comes from the signed `expires_at`,
  never from a TTL.
- **Archival.** An archived persistent entry is never read as absent, so
  archival affects liveness, not replay safety. Since Protocol 23, simulation
  normally lists archived entries for automatic restore; `coreflow simulate`
  reports them before anything is submitted.
- **Keys and networks.** Testnet runs use throwaway keys generated per run. The
  RPC commands never sign or submit, and the Testnet script refuses the Mainnet
  passphrase.
- **Provenance.** Packages are published only from CI with short-lived OIDC
  credentials, and the scaffold's release workflow attests the WASM it builds so
  a deployed contract can be traced to its commit.

## Out of scope

Mainnet deployment or Mainnet guidance; a security audit; claim-format changes,
including threshold (k-of-n) claims and XDR payload helpers; any work on the
CoreFlow payroll app.

## After v0.2.0-alpha

- A Workbench Testnet mode on top of the new RPC module: read a deployed
  contract's issuer registry and next nonce, and simulate a submission in the
  browser. Read-only.
- `examples/work-payout`: a Testnet example that pays through a Stellar Asset
  Contract token when a signed work-approval claim verifies.
- An issuer-service template: a minimal Node service that signs claims with a
  key loaded from the environment or a file, with a key-rotation walkthrough.
- Usability sessions with developers who did not build the kit, and fixes for
  what blocks them.

What exists today and how to check it: [evidence.md](evidence.md).
