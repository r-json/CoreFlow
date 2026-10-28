# CoreFlow Kit: evidence

What the kit can do today, where the evidence is, and how to check it. Unless
stated otherwise, results were produced on 28 October 2026 on a Linux machine
with Node.js 24.16, rustc/cargo 1.97.1 and stellar-cli 27.1.0.

**Status key:**

- **Verified**: re-run or re-checked on 28 Oct 2026.
- **Recorded**: written by a script when it ran, and checked on 28 Oct 2026 against archived or live data. Not re-run, because that would create new Testnet transactions.
- **None yet**: nothing exists, and nothing is claimed.

Planned work is in [roadmap.md](roadmap.md).

## Reproduce the main results

```bash
git clone https://github.com/r-json/CoreFlow && cd CoreFlow
(cd packages/attest && cargo test --all-features)
(cd packages/test-vectors && npm ci && npm run check && npm test)
(cd packages/sdk && npm ci && npm test)
(cd examples/marketplace-hold/contracts/marketplace-hold && cargo test)
```

The SDK suite has 221 tests, 82 of them for the decoding helpers that are
newer than the v0.1.0-alpha tag. The Workbench runs with:

```bash
cd apps/workbench && npm run setup && npm run dev     # tests: npm test && npm run e2e
```

## 1. Source implementation

| Claim | Where | Status |
|---|---|---|
| Rust verifier: `verify_claim`, issuer registry (register, revoke, rotate), sequence and unique-id replay in persistent storage | `packages/attest/src/` | Verified (tests below) |
| Network and contract binding are rebuilt by the verifier, not supplied by the caller | `packages/attest/src/claim.rs` (`preimage` uses `env.ledger().network_id()` and the current contract address) | Verified |
| TypeScript encoder, signer, pre-verifier, error mapping | `packages/sdk/src/` | Verified |
| JSON form, preimage decoder, preimage diff, signature-over-bytes check, network identification | `packages/sdk/src/json.ts`, `decode.ts`, `layout.ts`, `strkey.ts` | Verified |
| Independent reference implementation behind the vectors (own encoder, own strkey codec, `@noble/ed25519`) | `packages/test-vectors/src/index.mjs` | Verified |
| The Workbench uses the SDK for every computation and makes no network requests | `apps/workbench/src/lib/`; the Playwright test "recorded Testnet claims re-verify offline" fails on any request outside the local server | Verified |
| The Workbench never takes a secret key | `apps/workbench/src/pages/Compose.tsx` (throwaway or public test seeds only); page test "validates fields inline and never asks for a secret key" | Verified |
| The payroll app does not use the kit | `git grep -E '@coreflow/sdk\|coreflow-attest' -- src contracts` returns nothing; `contracts/core-flow` pins soroban-sdk 20.5.0 | Verified |

## 2. Tests

| Suite | Command | Result | Status |
|---|---|---|---|
| `coreflow-attest` format and lint | `cd packages/attest && cargo fmt --check && cargo clippy --all-targets --all-features -- -D warnings` | Clean | Verified |
| `coreflow-attest` tests | `cargo test --all-features` | 46 passed, plus 3 shared-vector tests | Verified |
| `coreflow-attest` builds for Soroban | `SOROBAN_SDK_BUILD_SYSTEM_SUPPORTS_SPEC_SHAKING_V2=1 cargo check --target wasm32v1-none --release` | Succeeds | Verified |
| marketplace-hold | `cd examples/marketplace-hold/contracts/marketplace-hold && cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test` | 23 passed | Verified |
| `@coreflow/sdk` | `cd packages/sdk && npm ci && npm run typecheck && npm test && npm run build` | 221 passed | Verified |
| `@coreflow/test-vectors` | `cd packages/test-vectors && npm ci && npm run check && npm test` | Vectors up to date (6 valid, 10 invalid); 3 passed | Verified |
| Workbench unit and page tests | `cd apps/workbench && npm test` | 52 passed | Verified |
| Workbench typecheck, format, build | `npm run typecheck && npm run format:check && npm run build` | Clean | Verified |
| Workbench in a real browser | `npm run e2e` (Chrome, desktop 1366×900 and mobile 390×844) | 11 passed, 1 skipped by design (keyboard test runs on desktop only) | Verified |
| Workbench from a clean copy | The files above copied without `node_modules` or `dist`, then `npm run setup`, typecheck, format check, tests, build, e2e | All passed | Verified |
| Payroll app, unaffected by the new `apps/` folder | `npm run typecheck && npx vitest run` at the repository root | Clean; 873 passed, 19 skipped; no Workbench tests collected | Verified |

## 3. Mutation checks

Each check removes one verification step and requires the test suite to fail.

| Package | Command | Result | Status |
|---|---|---|---|
| `@coreflow/sdk` | `npm run mutation` | 8 of 8 killed (window, expiry, replay fields, signature, network binding, contract binding, issuer match, preimage signature) | Verified |
| `coreflow-attest` | `bash scripts/mutation-check.sh` | 16 of 16 killed (registry, window, expiry, replay fields, payload encoding, signature, consume, sequence, unique-id, nonce overflow, four registry error paths, rotate-removes-old, TTL extension) | Verified |
| marketplace-hold | `bash scripts/mutation-check.sh` | 12 of 12 killed (buyer and admin auth, amount, same party, hold status, claim type, subject, refund deadline and status) | Verified |

## 4. Testnet runs

Three passing runs of `examples/marketplace-hold/scripts/e2e-testnet.mjs` on
18 October 2026. Each deployed a fresh contract, opened a 10 XLM hold, signed a
delivery claim with an in-memory issuer key, released the hold with it, then
tried the same claim on a second hold and got contract error 1106
(`ClaimAlreadyUsed`) in simulation.

| Run | Contract | Release transaction | Status |
|---|---|---|---|
| 20261018020314-5042 | `CBZZ4ATLYUNXXGQHIBYRJK7ZONFWXI5RDOYMXQGDPAHR6HGHFKKL7H6K` | `41b4813a0e2e5b6ecc479300a9c83d53758497f85d3f70c45da8db45c45eb072` (ledger 5253096) | Recorded |
| 20261018021549-c5e5 | `CD4UCEOB6JIAC4QRVXMBT4XLFMLB7YGIM7DW2WK2TKJRSV4JVFMZ63GC` | `ef512049af5f130f0cd9ddae1f74229289612b0f0dd027b4611ca4fe22129cef` (ledger 5253261) | Recorded |
| 20261018024823-a247 (from the `v0.1.0-alpha` tag) | `CARLTJXQAU7OWERKX6PDAW7QYOOFOQNHCN72267DND7CWLHBFBI2L6LB` | `121b14f7a37359256aa47271b3b79154641277cd9c979647b4819aa3ad07ed8d` (ledger 5253647) | Recorded |

How these were checked on 28 Oct 2026:

- **Live:** Testnet Horizon returns all three release transactions as `successful: true` at the ledgers above.
- **Archive:** `docs/evidence/testnet-archive/kit-e2e/manifest.json` and `.../v0.1.0-alpha/manifest.json` list 12 Horizon responses with a SHA-256 each. All 12 match.
- **Decoded:** the 12 archived envelopes are 3 contract deployments and 9 calls (`open_hold` ×6, `release` ×3). Every call targets its own run's contract, none touches another contract, and each deployment's derived contract ID equals the one its run recorded. All 12 are `successful`.
- **Offline:** the Workbench rebuilds each recorded claim's preimage byte for byte and verifies its signature for the recorded contract on Testnet. Unit test "re-verifies run … offline"; Evidence page.
- **Aborted attempts:** `examples/marketplace-hold/evidence/aborted-runs.json` records three attempts that stopped before completing, with their causes.

## 5. What is not claimed

| Topic | Fact |
|---|---|
| Developer usage | **None yet.** No developer outside the project has used the kit. The usability sessions in the [v0.2.0-alpha plan](roadmap.md) are the first test. |
| Security audit | **None.** The kit is labelled unaudited and Testnet-only throughout. `docs/SECURITY_AUDIT.md` is an internal review of the payroll app, not of the kit. |
| Mainnet | **No kit deployment.** The payroll app's earlier Mainnet contract is unrelated to the kit and is not cited. |
| Assets | The kit's Testnet runs moved **native XLM** through its Stellar Asset Contract. They did not use USDC. |
| Third-party contract activity | **None cited.** Every transaction listed above belongs to a CoreFlow Kit contract deployed by its own run. |
