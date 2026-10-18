# Changelog

All notable changes to this package are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the package follows
[Semantic Versioning](https://semver.org/).

## [0.1.0-alpha] - 2026-10-18

### Added

- `encodeClaim`: the 256-byte claim preimage (wire version 1).
- `signClaim`: Ed25519 signing from an `S...` secret, a 32-byte seed or a `Keypair`, with an issuer-match check.
- `verifyClaim`: off-chain pre-verification of window, expiry, replay fields and signature; throws `ClaimError`.
- `ClaimError` and `fromContractErrorCode` for contract error codes 1101-1109.
- Helpers: `sha256`, `claimType`, `networkId`, `contractDigest`, `issuerPublicKey`, `randomClaimId`, `toHex`, `fromHex`.
- Tests against the shared vectors in `packages/test-vectors`, and a mutation check for every verification and binding step.
