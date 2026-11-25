# coreflow-attest

Verify issuer-signed off-chain claims inside a Soroban contract. An *issuer*
(a backend service, a device, anything with an Ed25519 key) signs a fixed-layout
claim; your contract rebuilds the signed bytes on-chain, checks the issuer
registry, expiry and replay state, verifies the signature, and records the claim
as used.

**Status: 0.1.0-alpha - unaudited, testnet only.** The API and wire format may
change before 1.0.

The wire format is specified in
[`docs/kit/claim-format.md`](../../docs/kit/claim-format.md). The TypeScript
counterpart that signs claims is `@coreflow/sdk`.

## Add the dependency

```toml
[dependencies]
coreflow-attest = { git = "https://github.com/r-json/CoreFlow", tag = "v0.1.0-alpha", package = "coreflow-attest" }
soroban-sdk = "=29.0.1"

[dev-dependencies]
coreflow-attest = { git = "https://github.com/r-json/CoreFlow", tag = "v0.1.0-alpha", package = "coreflow-attest", features = ["testutils"] }
soroban-sdk = { version = "=29.0.1", features = ["testutils"] }
```

Requires Rust 1.91 or newer (the repository pins 1.97.1 in
`rust-toolchain.toml`) and soroban-sdk 29.0.1. The crate is `#![no_std]`.

### Use it in your contract

Build contracts with `stellar contract build`; plain `cargo build` for
`wasm32v1-none` is refused by soroban-sdk 28 and later. The stellar CLI also
requires overflow checks in the **contract crate's** release profile (a
dependency's profile is ignored):

```toml
[profile.release]
opt-level = "z"
lto = true
codegen-units = 1
strip = true
overflow-checks = true
```

## Register an issuer (host admin function)

The crate **never authorizes**. Your contract must check who is calling before
it touches the registry.

```rust
use coreflow_attest::{registry, AttestError};
use soroban_sdk::{contract, contractimpl, Address, BytesN, Env};

#[contract]
pub struct Marketplace;

#[contractimpl]
impl Marketplace {
    pub fn __constructor(env: Env, admin: Address, issuer: BytesN<32>) -> Result<(), HostError> {
        env.storage().instance().set(&DataKey::Admin, &admin);
        registry::register(&env, &issuer)?; // `?` converts AttestError, see below
        Ok(())
    }

    pub fn add_issuer(env: Env, issuer: BytesN<32>) -> Result<(), HostError> {
        let admin: Address = env.storage().instance().get(&DataKey::Admin).unwrap();
        admin.require_auth(); // authorization is the host's job
        registry::register(&env, &issuer)?;
        Ok(())
    }
}
```

`registry::revoke(&env, &key)` and `registry::rotate(&env, &old, &new)` follow
the same rule: authorize first, then call.

## Verify a claim in a release function

```rust
use coreflow_attest::{verify_claim, Claim};

pub fn release(env: Env, claim: Claim, signature: BytesN<64>) -> Result<(), HostError> {
    // Anyone may submit the claim; the signature is the authorization.
    verify_claim(&env, &claim, &signature)?;
    // ...the claim is now consumed; act on it (transfer funds, flip a flag).
    Ok(())
}
```

Call `verify_claim` in the same function that acts on the claim, so the claim is
consumed atomically with the action. Check `claim.subject`, `claim.claim_type`
and `claim.payload_hash` against your own state before acting: the crate proves
the issuer signed the claim, not that the claim is about what your function
expects.

Sequence-mode issuers read the next nonce with
`coreflow_attest::replay::next_nonce(&env, &issuer, &claim_type, &subject)`.

## Map `AttestError` into your own errors

`AttestError` occupies codes 1101-1109. Give your contract's errors codes
outside that range and convert with `From`:

```rust
use coreflow_attest::AttestError;
use soroban_sdk::contracterror;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum HostError {
    NotFound = 1,
    // ...your own codes, below 1101...

    // Re-exported attest codes, same numbers, so clients see 1101-1109.
    IssuerNotRegistered = 1101,
    InvalidWindow = 1102,
    ClaimExpired = 1103,
    InvalidReplayFields = 1104,
    NonceMismatch = 1105,
    ClaimAlreadyUsed = 1106,
    NonceOverflow = 1107,
    IssuerAlreadyRegistered = 1108,
    IssuerNotFound = 1109,
}

impl From<AttestError> for HostError {
    fn from(e: AttestError) -> Self {
        match e {
            AttestError::IssuerNotRegistered => HostError::IssuerNotRegistered,
            AttestError::InvalidWindow => HostError::InvalidWindow,
            AttestError::ClaimExpired => HostError::ClaimExpired,
            AttestError::InvalidReplayFields => HostError::InvalidReplayFields,
            AttestError::NonceMismatch => HostError::NonceMismatch,
            AttestError::ClaimAlreadyUsed => HostError::ClaimAlreadyUsed,
            AttestError::NonceOverflow => HostError::NonceOverflow,
            AttestError::IssuerAlreadyRegistered => HostError::IssuerAlreadyRegistered,
            AttestError::IssuerNotFound => HostError::IssuerNotFound,
        }
    }
}
```

Alternatively, make your public functions return `Result<_, AttestError>`
directly if they have no errors of their own.

## Test with `MockIssuer`

```rust
use coreflow_attest::testutils::{hash, MockIssuer};

let env = Env::default();
env.ledger().set_timestamp(1_790_000_060);
let id = env.register(Marketplace, (admin, issuer_pk));

let issuer = MockIssuer::test(0);
let claim = issuer.sequence_claim(
    &env,
    &hash(&env, b"marketplace.delivery.v1"),
    &hash(&env, b"order:42"),
    0,               // nonce
    1_790_000_000,   // issued_at
    1_790_003_600,   // expires_at
);
// The preimage depends on the verifying contract: sign in its context.
let signature = env.as_contract(&id, || issuer.sign(&env, &claim));
```

`MockIssuer::test(n)` derives its key from `SHA-256("coreflow-test-issuer-<n>")`,
the same keys as `packages/test-vectors`. **TEST ONLY:** those keys are public.
Enable the `testutils` feature only in `[dev-dependencies]`.

## Verification order

`verify_claim` fails at the first check that does not hold:

1. issuer is registered
2. `expires_at > issued_at`
3. ledger time `<= expires_at` (equality is valid)
4. replay fields match the mode; `payload_encoding` is 0 or 1
5. replay check (sequence: `nonce == expected`; unique-id: not used before)
6. Ed25519 signature over the rebuilt 256-byte preimage
7. consume (store `nonce + 1`, or record the `claim_id`)

`payload_encoding` values other than 0 and 1 are reserved by the spec and are
rejected at step 4 with `InvalidReplayFields`.

An invalid signature does **not** return an error: Soroban's `ed25519_verify`
aborts the invocation. The transaction fails, nothing is stored, and a caller
using the generated client's `try_*` method sees a non-contract error. Verify
the signature off-chain first with `@coreflow/sdk`.

## Errors

| Code | Name | Meaning |
|---|---|---|
| 1101 | `IssuerNotRegistered` | The signing key is not in the registry. |
| 1102 | `InvalidWindow` | `expires_at` is not later than `issued_at`. |
| 1103 | `ClaimExpired` | Ledger time is past `expires_at`. |
| 1104 | `InvalidReplayFields` | Replay fields do not match the mode, or `payload_encoding` is not 0 or 1. |
| 1105 | `NonceMismatch` | Sequence mode: `nonce` is not the next expected value. |
| 1106 | `ClaimAlreadyUsed` | Unique-id mode: this `(issuer, claim_id)` was already accepted. |
| 1107 | `NonceOverflow` | Sequence counter cannot pass `u64::MAX`. |
| 1108 | `IssuerAlreadyRegistered` | `register` (or the new key of `rotate`) is already registered. |
| 1109 | `IssuerNotFound` | `revoke` (or the old key of `rotate`) is not registered. |

## Storage and rent

Registry and replay entries are written to **persistent** storage with their
rent extended to about 90 days on every write. Entries whose rent lapses are
archived, not deleted, and must be restored before use, so replay state cannot
silently reset. The registry entry is only extended when it is written: a host
that expects long gaps between registry changes should extend the TTL of its
issuer entries itself.

Storage keys carry a `Cfa` prefix (`CfaIssuer`, `CfaSeq`, `CfaUsed`) so they do
not collide with the host contract's own keys.

## Development

```sh
cargo test --all-features
cargo clippy --all-targets --all-features -- -D warnings
# proves no_std / wasm compatibility; the variable stands in for stellar-cli,
# which soroban-sdk requires for real wasm artifacts
SOROBAN_SDK_BUILD_SYSTEM_SUPPORTS_SPEC_SHAKING_V2=1 cargo check --target wasm32v1-none --release
scripts/mutation-check.sh
```

`scripts/mutation-check.sh` deletes each marked check (`// check:<name> begin`
... `// check:<name> end`) in a scratch copy and requires the tests to fail.

## License

Apache-2.0.
