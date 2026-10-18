# @coreflow/sdk

Encode, sign and verify signed claims for Soroban contracts.

A claim is a statement an **issuer** makes about a **subject** ("order 42 was delivered"), signed with the issuer's Ed25519 key so a contract can act on it. This package builds the 256-byte preimage, signs it on the issuer's backend, and pre-verifies it on the client before anything is submitted. It does not deploy, fund or release anything.

> **Status: 0.1.0-alpha — unaudited, testnet only.** The API may change between 0.x releases.

Wire format and error codes: [claim-format.md](../../docs/kit/claim-format.md) (normative).

## Install

```sh
npm install @coreflow/sdk
```

ESM only. Works in Node 20+ and in browsers (the package source uses no Node built-ins).

## Build a delivery claim

```ts
import { Networks } from '@stellar/stellar-base';
import { claimType, issuerPublicKey, randomClaimId, sha256, type Claim, type ClaimContext } from '@coreflow/sdk';

// Binds the claim to one network and one verifying contract.
const ctx: ClaimContext = {
  networkPassphrase: Networks.TESTNET,
  contractId: 'C...', // the contract that will verify the claim
};

const payload = new TextEncoder().encode(JSON.stringify({ orderId: 42, status: 'delivered' }));
const now = BigInt(Math.floor(Date.now() / 1000));

const claim: Claim = {
  issuer: issuerPublicKey(process.env.ISSUER_SECRET!), // 32-byte public key
  claimType: claimType('marketplace.delivery.v1'),
  subject: sha256('order:42'),
  payloadHash: sha256(payload), // the payload itself stays off-chain
  payloadEncoding: 'raw', // or 'xdr' for an XDR-encoded ScVal
  replay: { mode: 'unique-id', claimId: randomClaimId() }, // or { mode: 'sequence', nonce: 0n }
  issuedAt: now,
  expiresAt: now + 3600n, // must be later than issuedAt
};
```

Replay modes: `sequence` claims are ordered per (issuer, claim type, subject) and carry a `nonce`; `unique-id` claims carry a random `claimId` and may arrive in any order.

## Sign on the issuer backend

```ts
import { signClaim, toHex } from '@coreflow/sdk';

// issuerSecret: an S... secret key, a 32-byte seed, or a stellar-base Keypair.
const { preimage, signature } = signClaim(claim, ctx, process.env.ISSUER_SECRET!);

// Send these to whoever submits the claim.
console.log(toHex(preimage).length / 2); // 256
console.log(toHex(signature).length / 2); // 64
```

`signClaim` throws `ClaimError('IssuerMismatch')` if the secret does not belong to `claim.issuer`. Keep the secret on the server.

## Pre-verify on the client

```ts
import { ClaimError, verifyClaim } from '@coreflow/sdk';

try {
  verifyClaim(claim, ctx, signature); // optional: { now: 1790000060n }
} catch (e) {
  if (e instanceof ClaimError) {
    console.error(e.code, '-', e.nextStep); // e.g. ClaimExpired - Ask the issuer for a fresh claim.
  }
  throw e;
}
```

`verifyClaim` returns nothing on success and throws `ClaimError` on failure, checking in this order: `InvalidWindow`, `ClaimExpired`, `InvalidReplayFields`, `InvalidSignature`. A claim is valid while `now <= expiresAt`.

It cannot see chain state, so it does not check that the issuer is registered or that the nonce or claim id is unused. The contract enforces both.

## Map a contract error code

When a transaction fails with a contract error between 1101 and 1109, turn the number into a typed error:

```ts
import { fromContractErrorCode } from '@coreflow/sdk';

const err = fromContractErrorCode(1103);
if (err) {
  console.log(err.code); // 'ClaimExpired'
  console.log(err.nextStep); // 'Ask the issuer for a fresh claim.'
}
```

It returns `undefined` for any other number.

## API

| Export | Purpose |
|---|---|
| `encodeClaim(claim, ctx)` | The 256-byte preimage. |
| `signClaim(claim, ctx, issuerSecret)` | `{ preimage, signature }`. |
| `verifyClaim(claim, ctx, signature, opts?)` | Throws `ClaimError` on failure. |
| `ClaimError`, `fromContractErrorCode(code)` | Typed errors with a `code` and a `nextStep`. |
| `sha256`, `claimType`, `networkId`, `contractDigest` | Digests used in the preimage. |
| `issuerPublicKey`, `randomClaimId`, `toHex`, `fromHex` | Helpers. |
| `Claim`, `ClaimContext`, `ClaimErrorCode`, `IssuerSecret` | Types. |

Malformed arguments (wrong byte length, integers outside the u64 range, invalid strkeys) throw `ClaimError('InvalidInput')`.

## License

Apache-2.0
