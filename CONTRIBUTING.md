# Contributing to CoreFlow Kit

Thanks for helping. Issues and pull requests are welcome, from typo fixes to new
checks. CoreFlow Kit is alpha, unaudited and Testnet-only, so careful review
matters more than speed.

## What lives where

| Path | What it is | Contributions |
|---|---|---|
| `packages/attest` | `coreflow-attest`, the Rust crate contracts call | Welcome |
| `packages/sdk` | `@coreflow/sdk`, the TypeScript SDK | Welcome |
| `packages/test-vectors` | Shared vectors from an independent implementation | Welcome; see "Changing the claim format" |
| `apps/workbench` | The browser Workbench | Welcome |
| `examples/` | Example contracts built with the kit | Welcome |
| `docs/kit` | Spec, security model, key rotation, evidence, roadmap | Welcome |
| `src/`, `contracts/core-flow`, other `docs/` | The CoreFlow payroll reference app | Fixes only; it does not use the kit |

## Set up

You need Node.js 20 or later (CI uses 22) and, for the Rust packages, Rust
1.97.1 with the `wasm32v1-none` target. `packages/attest/rust-toolchain.toml`
pins the toolchain. stellar-cli 27 is only needed for the Testnet example script.

```bash
git clone https://github.com/r-json/CoreFlow.git && cd CoreFlow
```

## Run the checks CI runs

```bash
(cd packages/attest && cargo fmt --check && cargo clippy --all-targets --all-features -- -D warnings && cargo test --all-features && bash scripts/mutation-check.sh)
(cd examples/marketplace-hold/contracts/marketplace-hold && cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test)
(cd examples/marketplace-hold && bash scripts/mutation-check.sh)
(cd packages/sdk && npm ci && npm run typecheck && npm test && npm run build && npm run mutation)
(cd packages/test-vectors && npm ci && npm run check && npm test)
(cd apps/workbench && npm run setup && npm run typecheck && npm run format:check && npm test && npm run build && npm run e2e)
```

The Workbench's browser tests use an installed Google Chrome. Set
`PW_CHANNEL=chromium` after `npx playwright install chromium` to use Playwright's
own build, as CI does.

## Tests that fail when a check is removed

Every verification check has a test that fails if the check is deleted, and the
mutation scripts prove it: they remove each check in turn and require the suite
to fail. If you add a check, add its mutant to the script. Use exact auth mocks,
never `mock_all_auths`, so that a missing `require_auth` is caught.

## Changing the claim format

The 256-byte claim layout is a specification, not an implementation detail. A
change needs, in the same pull request:

1. An update to [`docs/kit/claim-format.md`](docs/kit/claim-format.md).
2. Regenerated vectors: `npm run generate` in `packages/test-vectors`.
3. Passing tests in both Rust and TypeScript.
4. The `claim-format` label.

## Pull requests

- Keep each pull request to one concern, and describe how you tested it.
- Use the commit style in the history: `feat(sdk): …`, `fix(attest): …`, `docs: …`, `chore: …`.
- CI must pass. Kit CI runs on pull requests to `main` and on `kit/**` branches.
- Use test keys only. Never commit secret keys, production issuer keys, personal data or `.env` files.

## Security

Report vulnerabilities privately from the repository's **Security** tab, as
described in [SECURITY.md](SECURITY.md). Do not open a public issue for them.

## Conduct and licence

Everyone taking part follows the [code of conduct](CODE_OF_CONDUCT.md).
Contributions are accepted under the [Apache License 2.0](LICENSE), the
project's licence.
