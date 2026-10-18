# Changelog

All notable changes to `coreflow-attest` are documented here. The format is
based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the
project follows [Semantic Versioning](https://semver.org/) (the 0.x series may
change the API between minor versions).

## [0.1.0-alpha] - 2026-10-18

### Added
- `Claim`, `ReplayMode` and `preimage`: the 256-byte, domain-separated signing
  preimage of wire format v1, bound to the network and the verifying contract.
- `verify_claim`: the seven-step verification order of the claim format spec
  (issuer registered, window, expiry, replay fields, replay, Ed25519 signature,
  consume).
- `registry` module: `register`, `revoke`, `rotate`, `is_registered`, with
  persistent storage, rent extension and contract events.
- `replay` module: sequence mode (`next_nonce`) and unique-id mode (`is_used`),
  both in persistent storage.
- `AttestError`: codes 1101-1109.
- `testutils` feature: `MockIssuer` (deterministic test keys that match the
  shared test vectors) and claim builders.
- Conformance tests against `packages/test-vectors` (all valid and invalid
  vectors), per-check behavior tests, and `scripts/mutation-check.sh`.
