# Changelog

All notable changes to this example are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.1.0-alpha] - 2026-10-18

### Added
- `marketplace-hold` Soroban contract: `open_hold`, `release` (verified by a
  signed delivery claim via `coreflow-attest`), `refund`, issuer administration
  (`add_issuer`, `remove_issuer`, `rotate_issuer`) and the views `get_hold`,
  `is_issuer`, `next_nonce`.
- 23 contract tests on a real Stellar Asset Contract with per-call
  authorization mocks, and `scripts/mutation-check.sh` (12 mutants).
- `scripts/e2e-testnet.mjs`: deploy, hold, sign, relay and replay-refusal on
  Stellar Testnet, with executor-written evidence in `evidence/`.
