# marketplace-hold

A worked example of CoreFlow Kit: a payment hold that is released by a signed
delivery claim.

**Status: 0.1.0-alpha - unaudited, testnet only.**

## What it shows

1. A **buyer** locks funds in the contract for an order (`open_hold`).
2. The **issuer** (the marketplace backend, which learns of delivery from the
   carrier) signs a `marketplace.delivery.v1` claim for that order. The issuer
   is a plain Ed25519 key, not a Stellar account.
3. **Anyone** (here, the seller acting as relayer) submits the claim to
   `release`. The contract checks that the claim is a delivery claim for this
   hold's order, then `coreflow-attest` verifies the issuer, expiry, replay
   state and signature. The funds go to the seller stored in the hold.
4. If no claim arrives, the buyer calls `refund` after the deadline.

```
buyer ──open_hold──▶ [ hold: funds in contract ]
                              │
issuer ── signs claim ──▶ relayer ──release(hold, claim, sig)──▶ contract
                                                   │  claim_type, subject checks
                                                   │  coreflow_attest::verify_claim
                                                   ▼
                                              seller paid, claim consumed
buyer ──refund (after deadline, still open)──▶ buyer repaid
```

Why a relayer gains nothing: the recipient is the seller recorded in the hold,
never an argument. Changing any claim field breaks the signature, and a claim
is consumed on success, so it cannot be redirected or used on a second hold.

## Contract API

| Function | Who | Notes |
|---|---|---|
| `__constructor(admin, issuer)` | deployer | stores the admin, registers the first issuer key |
| `open_hold(buyer, seller, token, amount, order, refund_after) -> u32` | buyer | amount > 0, buyer != seller |
| `release(hold_id, claim, signature)` | anyone | hold must be open; claim verified |
| `refund(hold_id)` | buyer | open hold, ledger time > `refund_after` |
| `add_issuer` / `remove_issuer` / `rotate_issuer` | admin | `admin.require_auth()` then the `coreflow-attest` registry |
| `get_hold`, `is_issuer`, `next_nonce` | view | |

Errors: `HoldError` codes 1-7 are this contract's own (`HoldNotFound`,
`HoldNotOpen`, `WrongClaimType`, `WrongSubject`, `TooEarly`, `InvalidAmount`,
`SameParty`); 1101-1109 are the `coreflow-attest` errors with identical numbers
(see the [claim format](../../docs/kit/claim-format.md)). A bad signature aborts
the invocation instead of returning an error.

## Run the tests

```sh
cd contracts/marketplace-hold
cargo test                       # 23 tests, real token contract, precise auth mocks
cargo clippy --all-targets -- -D warnings
../../scripts/mutation-check.sh  # deletes each check in turn; every mutant must be killed
```

Requires Rust (the crate pins 1.97.1 in `rust-toolchain.toml`).

## Build the wasm

```sh
cd contracts/marketplace-hold
stellar contract build           # stellar-cli 27.x
# target/wasm32v1-none/release/marketplace_hold.wasm
```

Plain `cargo build --target wasm32v1-none` is refused by soroban-sdk 28 and
later; use `stellar contract build`. The release profile sets
`overflow-checks = true`, which the CLI requires.

## Run the Testnet end-to-end

```sh
npm --prefix ../../packages/sdk install && npm --prefix ../../packages/sdk run build
npm install
npm run e2e
```

The script (Testnet only) generates three funded throwaway identities with
`stellar keys generate --fund`, an in-memory issuer key that is never printed or
saved, deploys the contract, opens a 10 XLM hold, signs and pre-verifies a
delivery claim with `@coreflow/sdk`, has the seller submit `release`, then opens
a second hold for the same order and shows that the same claim is refused with
error 1106. It aborts on any unexpected result and writes
`evidence/testnet-e2e-<UTC timestamp>.json` with the transaction hashes,
explorer links, balances before and after, and the public claim fields. Friendbot
and RPC calls are retried with backoff up to three times.

The throwaway identities remain in your stellar-cli config under
`cfhold-<run>-*`; they hold only Testnet funds.

## How a real issuer backend signs

```ts
import { Networks } from '@stellar/stellar-base';
import { claimType, issuerPublicKey, randomClaimId, sha256, signClaim, verifyClaim } from '@coreflow/sdk';

const ctx = { networkPassphrase: Networks.TESTNET, contractId: process.env.HOLD_CONTRACT_ID! };
const secret = process.env.ISSUER_SECRET!; // from your secret manager; never ship to a browser

const now = BigInt(Math.floor(Date.now() / 1000));
const claim = {
  issuer: issuerPublicKey(secret),
  claimType: claimType('marketplace.delivery.v1'),
  subject: sha256(`order:${orderId}`),          // must equal the order the buyer locked
  payloadHash: sha256(payloadBytes),
  payloadEncoding: 'raw' as const,
  replay: { mode: 'unique-id' as const, claimId: randomClaimId() },
  issuedAt: now,
  expiresAt: now + 900n,
};
const { signature } = signClaim(claim, ctx, secret);
verifyClaim(claim, ctx, signature); // optional pre-check before handing it out
```

Hand the claim and signature to whoever relays it; they call `release`. Register
the issuer's public key with `add_issuer` (or the constructor), and rotate it
with `rotate_issuer`; see `docs/kit/key-rotation.md`.

## Layout

- `contracts/marketplace-hold/` - the contract and its tests
- `scripts/e2e-testnet.mjs` - Testnet end-to-end
- `scripts/mutation-check.sh` - mutation guard for the contract's checks
- `evidence/` - executor-written Testnet run records

## License

Apache-2.0.
