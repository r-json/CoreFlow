# CoreFlow Kit v0.2.0-alpha: proposed plan

**Status: proposed, not started.**

**Outcome:** a Stellar developer can install CoreFlow Kit from public
registries, go from an empty folder to a claim verified by their own Testnet
contract, and debug that contract in the browser Workbench.

Today the kit works on Testnet, but using it means cloning this repository and
building tarballs. This increment closes that gap. It stays Testnet-only, and
the kit stays labelled unaudited.

## Deliverables

| # | Deliverable | Why it matters |
|---|---|---|
| D1 | `@coreflow/sdk`, `@coreflow/test-vectors` and `coreflow-attest` published from CI, with npm provenance | Install with `npm install` and `cargo add` instead of cloning |
| D2 | `@coreflow/cli`: `create` scaffolds a claim-gated Soroban contract with tests, a mutation check, an issuer script and a Testnet script; plus `sign`, `verify`, `inspect`, `diff`, `explain` and `doctor` | From nothing to a working, tested project in one command |
| D3 | Workbench Testnet mode: read a deployed contract's issuer registry and next nonce, and simulate a submission. Read-only; never signs or submits. | Shows the two checks only a contract can make: issuer registered and claim unused |
| D4 | Getting-started guide, CLI reference, Workbench guide and troubleshooting, with every command run in CI | A developer outside the project can finish without help |
| D5 | Usability sessions with developers, and fixes for what blocks them | Tests the workflow with people who did not build it |
| D6 | `v0.2.0-alpha` release, a Testnet evidence file from a scaffolded project, a short demo | One place to check every result |

## Milestones and acceptance checks

| Milestone | Accepted when |
|---|---|
| M1: Published packages | `npm view` finds `@coreflow/sdk@0.2.0-alpha` and `@coreflow/test-vectors@0.2.0-alpha` with provenance; `cargo search coreflow-attest` lists 0.2.0-alpha; a CI job installs all three into an empty project and passes the 16 shared vectors. |
| M2: CLI and scaffold | In CI, `npx @coreflow/cli create demo`, then `cargo test` and `npm test` inside `demo`, passes; the scaffold's mutation check kills every mutant; `coreflow verify` and `coreflow explain` match the Workbench on all 16 vectors; `coreflow doctor` reports installed against pinned toolchain versions. |
| M3: Workbench Testnet mode | For a given contract ID, the Workbench shows the issuer status, next nonce and simulated verdict; CI tests use recorded RPC responses; one live run is recorded by a script; Mainnet is refused; offline, the page says so and the local tools keep working. |
| M4: Docs, validation, release | The four guides exist and their commands run in CI; an anonymous validation report lists each session, its time to a first verified claim and every problem found; every blocking problem is closed by a merged fix; `v0.2.0-alpha` is tagged with a scaffold Testnet evidence file and a demo. |

## Usability sessions

Each participant gets one task: from an empty folder to a claim verified by
their own Testnet contract, using only the published guide. For each session,
the report records whether the task was completed, the time it took, where the
participant got stuck and what they said. Participants stay anonymous unless
they opt in. The report states the actual number of sessions and their results.

## Out of scope

Mainnet deployment or Mainnet guidance; a security audit; threshold (k-of-n)
claims; XDR payload helpers; a Scaffold Stellar template; any work on the
CoreFlow payroll app; hosting or other infrastructure.

What exists today and how to check it: [evidence.md](evidence.md).
