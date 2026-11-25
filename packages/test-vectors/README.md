# @coreflow/test-vectors

Shared test vectors and a mock issuer for the CoreFlow
[signed claim format](../../docs/kit/claim-format.md) (wire version 1).

> **Status: 0.1.0-alpha. TEST ONLY.** Every key in this package is derived
> from a public string, so anyone can recompute it. Never use these keys to
> protect real value.

## Why a separate implementation

`coreflow-attest` (Rust) and `@coreflow/sdk` (TypeScript) are both checked
against [`vectors/claim-v1.json`](vectors/claim-v1.json). The vectors are
produced by [`src/index.mjs`](src/index.mjs), which shares no code with either:
it has its own preimage encoder and strkey codec, and signs with
[`@noble/ed25519`](https://github.com/paulmillr/noble-ed25519). A vector can
only catch a bug if the code under test could not have produced it.

## What the vectors cover

| Kind | Cases |
|---|---|
| Valid (6) | sequence nonce 0 and 1, unique-id, XDR payload, u64 extremes, mainnet + second issuer + second contract |
| Invalid (10) | expired, empty window, sequence with a claim id, unique-id with a nonce, signed for another network, signed for another contract, tampered subject, tampered expiry, wrong issuer key, zero signature |

Every invalid vector except the `InvalidSignature` cases carries a **valid**
signature, so each one isolates exactly the check it targets. The package's own
tests assert this.

## Use in a TypeScript test suite

Not on the npm registry yet. From a clone of the tagged repository:

```bash
cd CoreFlow/packages/test-vectors && npm ci && npm pack
# then, in your project:
npm install --save-dev /path/to/CoreFlow/packages/test-vectors/coreflow-test-vectors-0.1.0-alpha.tgz
```

```js
import { loadVectors, mockIssuer, sha256, NETWORKS } from '@coreflow/test-vectors';

// 1. Run your encoder against the shared vectors.
for (const v of loadVectors().valid) {
  // compare your preimage with v.preimage_hex and your verify with v.signature_hex
}

// 2. Sign claims in tests without a real issuer.
const issuer = await mockIssuer(0);           // TEST ONLY key
const contractHash = sha256('my-test-contract'); // the verifying contract's 32-byte hash
const { signature } = await issuer.sign(
  {
    claimType: sha256('marketplace.delivery.v1'),
    subject: sha256('order:42'),
    payloadHash: sha256('delivered'),
    payloadEncoding: 0,
    replayMode: 1,                               // unique-id
    nonce: 0n,
    claimId: sha256('claim-0001'),
    issuedAt: 1_790_000_000n,
    expiresAt: 1_790_003_600n,
  },
  { networkPassphrase: NETWORKS.testnet, contractHash },
);
```

## Use from Rust

The Rust mock issuer lives in `coreflow-attest` behind the `testutils` feature
(`MockIssuer::test(index)`, same seed rule). To check vectors directly:

```rust
let json = std::fs::read_to_string("../test-vectors/vectors/claim-v1.json")?;
```

## Regenerating

```bash
npm run generate   # rewrite vectors/claim-v1.json
npm run check      # fail if the committed file differs (CI runs this)
npm test           # self-checks: preimages, signatures, strkeys
```

Output is deterministic: Ed25519 signatures are deterministic and every input
is fixed.

## License

Apache-2.0
