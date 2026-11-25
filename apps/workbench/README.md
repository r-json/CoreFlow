# CoreFlow Kit Workbench

A browser tool for the signed claims that [`coreflow-attest`](../../packages/attest)
verifies inside Soroban contracts. Compose and sign a claim, see exactly which
bytes are signed, find where a signer and a contract disagree, and run the
shared test vectors, all without installing Rust or deploying anything.

> **Status: 0.1.0-alpha.** Everything runs in the browser tab. The Workbench
> makes no network requests and never asks for a secret key. CoreFlow Kit is
> unaudited and supports Testnet only.

## Run it

Requires Node.js 20 or later.

```bash
cd apps/workbench
npm run setup   # builds packages/sdk, then installs the Workbench
npm run dev     # http://localhost:5173
```

`npm run setup` runs `npm ci` and `npm run build` in `packages/sdk`, because
the Workbench uses the SDK from this repository rather than from npm.

To serve the production build instead:

```bash
npm run build
npm run preview   # http://localhost:4173
```

The build in `dist/` is static files with relative paths. It works from any
folder or static file host.

## What each page does

| Page             | What you can do                                                                                                                                                                                                                                                     | Runs                               |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| Compose & sign   | Fill in a claim; sign it with a throwaway key or a public test key; copy the claim JSON, signature, preimage, a `stellar contract invoke` command and TypeScript for an issuer backend. Or enter your own issuer's public key and paste a signature made elsewhere. | Locally                            |
| Verify           | Check a claim JSON and signature against a network and contract at a chosen time. Each step of the spec's verification order shows passed, failed, not reached, or contract-only, with the on-chain error number and the next step.                                 | Locally                            |
| Inspect & diff   | Decode a 256-byte preimage field by field, check a signature against exactly those bytes, compare the network and contract digests with what you expect, and diff two preimages.                                                                                    | Locally                            |
| Test vectors     | Run all 16 shared vectors through `@coreflow/sdk`, and check another implementation's preimage and signature against a vector.                                                                                                                                      | Locally                            |
| Error codes      | Paste `stellar-cli` or RPC output and get the error's meaning and next step: kit codes 1101–1109, the host's bad-signature abort, and the example contract's own codes.                                                                                             | Locally                            |
| Testnet evidence | The three recorded Testnet runs of `examples/marketplace-hold`: each transaction, and an offline re-verification of the recorded claim and preimage.                                                                                                                | Recorded data, re-verified locally |

## What it does not do

- **It does not contact Stellar.** It cannot tell whether an issuer is
  registered on your contract or whether a nonce or claim id was already used.
  The Verify page marks those steps "contract only".
- **It does not submit transactions.** The `stellar contract invoke` command it
  generates is for you to run.
- **It never handles a real secret key.** Throwaway keys are random, kept in
  memory and discarded with the tab. The public test issuers' seeds are derived
  from public strings. To check a real issuer, sign on your backend and paste
  the signature.
- **Testnet evidence is historical.** Explorer links stop working after a
  Testnet reset; the Horizon responses are archived in
  [`docs/evidence/testnet-archive/kit-e2e`](../../docs/evidence/testnet-archive/kit-e2e/manifest.json).

## Data sources

The Workbench imports the committed files directly, so it cannot drift from them:

- `packages/test-vectors/vectors/claim-v1.json`
- `examples/marketplace-hold/evidence/testnet-e2e-*.json`

## Tests

```bash
npm run typecheck
npm run format:check
npm test          # 52 tests: logic in Node, pages in happy-dom
npm run e2e       # Playwright against the production build, desktop and mobile
```

`npm run e2e` uses an installed Google Chrome by default. Without Chrome, run
`npx playwright install chromium` and set `PW_CHANNEL=chromium`.

The unit suite includes a test that compiles and runs the generated TypeScript
issuer snippet and checks that it reproduces the claim. The end-to-end suite
checks that no page logs a console error, scrolls sideways on a phone, or
makes a network request on the Evidence page.

## Bundle size

The production JavaScript is about 810 kB (225 kB gzipped). Most of it is
React plus the browser build of `@stellar/stellar-base`, which every page
needs for hashing, strkeys and Ed25519.

## License

Apache-2.0
