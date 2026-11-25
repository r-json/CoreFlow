# Changelog

All notable changes to this package are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the package uses
[Semantic Versioning](https://semver.org/).

## [0.1.0-alpha] - 2026-10-18

### Added
- `vectors/claim-v1.json`: 6 valid and 10 invalid vectors for claim wire version 1.
- Independent reference encoder, strkey codec and `mockIssuer(index)` in `src/index.mjs`.
- `scripts/generate.mjs` with a `--check` mode that fails when the committed vectors are stale.
- Self-tests asserting each invalid vector isolates the check it targets.
