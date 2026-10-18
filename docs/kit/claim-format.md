# Signed claim format — v0.1 (wire version 1)

Status: **draft, 0.x**. The wire format may change before 1.0; any change bumps
the wire `version` field, so a verifier never misreads a claim built for a
different layout.

A **claim** is a statement an **issuer** makes about the world — "order 42 was
delivered", "this account passed KYC", "sensor 7 read 31 mm of rain" — signed
with the issuer's Ed25519 key so a Soroban contract can act on it. The issuer is
typically a backend service or a device that does not hold a Stellar account.

This document is normative for `coreflow-attest` (Rust) and `@coreflow/sdk`
(TypeScript). Both are tested against the shared vectors in
`packages/test-vectors/`.

## 1. Fields

| Field | Type | Meaning |
|---|---|---|
| `issuer` | 32 bytes | The issuer's Ed25519 public key. |
| `claim_type` | 32 bytes | `SHA-256(type string)`, e.g. `SHA-256("marketplace.delivery.v1")`. Separates claim kinds signed by the same key. |
| `subject` | 32 bytes | What the claim is about, chosen by the application (e.g. `SHA-256("order:42")`). |
| `payload_hash` | 32 bytes | `SHA-256(payload)`. The payload itself travels off-chain; the contract sees only its hash. |
| `payload_encoding` | u8 | How to interpret the payload: `0` = raw bytes (application-defined), `1` = XDR-encoded `ScVal`. Other values are reserved. |
| `replay_mode` | u8 | `0` = **sequence**, `1` = **unique-id**. See §4. |
| `nonce` | u64 | Sequence number in sequence mode. **Must be 0** in unique-id mode. |
| `claim_id` | 32 bytes | Unique identifier in unique-id mode. **Must be all zero** in sequence mode. |
| `issued_at` | u64 | Unix seconds when the issuer signed. |
| `expires_at` | u64 | Unix seconds after which the claim is invalid. Must be `> issued_at`. |

Two more values are **not fields** — the verifier supplies them from its own
environment, which is what binds a claim to one network and one contract:

| Context | Value |
|---|---|
| `network_id` | `SHA-256(network passphrase)` — on Soroban, `env.ledger().network_id()`. |
| `contract` | `SHA-256(XDR(ScVal::Address(verifying contract)))` — 40 bytes hashed: `SCV_ADDRESS` (`0x00000012`), `SC_ADDRESS_TYPE_CONTRACT` (`0x00000001`), 32-byte contract hash. |

## 2. Preimage (exactly 256 bytes)

All integers big-endian. Offsets in bytes.

| Offset | Size | Content |
|---|---|---|
| 0 | 4 | magic `"CFCL"` (`0x4346434C`) |
| 4 | 2 | wire version, u16 = `1` |
| 6 | 32 | `network_id` |
| 38 | 32 | `contract` |
| 70 | 32 | `issuer` |
| 102 | 32 | `claim_type` |
| 134 | 32 | `subject` |
| 166 | 32 | `payload_hash` |
| 198 | 1 | `payload_encoding` |
| 199 | 1 | `replay_mode` |
| 200 | 8 | `nonce` |
| 208 | 32 | `claim_id` |
| 240 | 8 | `issued_at` |
| 248 | 8 | `expires_at` |

The fixed width is deliberate: there is no length prefix, no optional field and
no serializer whose field order could drift between languages.

## 3. Signature

`signature = Ed25519-Sign(issuer_secret_key, preimage)` — 64 bytes, standard
RFC 8032 Ed25519 over the raw 256-byte preimage (no prehash, no prefix, no
wallet "signed message" envelope).

## 4. Replay protection

The issuer chooses the mode per claim; the verifier enforces it.

**Sequence** (`replay_mode = 0`). Claims form an ordered stream per
*scope* = (`issuer`, `claim_type`, `subject`). The verifier stores the next
expected nonce for the scope (initially 0) and accepts a claim only if
`nonce == expected`, then stores `nonce + 1`. Use it when one relayer submits
claims in order and you want gaps to be impossible.

**Unique-id** (`replay_mode = 1`). Each claim carries a random or
content-derived 32-byte `claim_id`. The verifier accepts a claim only if
(`issuer`, `claim_id`) has never been accepted, then records it. Use it when
several relayers submit concurrently, or claims may arrive out of order.

In both modes replay state lives in **persistent** storage. Persistent entries
whose rent lapses are archived, not deleted: an archived marker must be restored
before the contract can read it, so it cannot silently reset. Temporary storage
must never be used for replay state.

## 5. Verification order

A conforming on-chain verifier performs these checks, in this order, and fails
with the named error at the first one that does not hold:

1. **Issuer registered** — `issuer` is in the contract's issuer registry → `IssuerNotRegistered`.
2. **Window** — `expires_at > issued_at` → `InvalidWindow`.
3. **Not expired** — ledger timestamp `<= expires_at` → `ClaimExpired`.
4. **Replay fields and encoding** — sequence mode requires `claim_id` all zero; unique-id mode requires `nonce == 0`; `payload_encoding` must be 0 or 1 → `InvalidReplayFields`.
5. **Replay** — sequence: `nonce == expected` → `NonceMismatch`; unique-id: not previously used → `ClaimAlreadyUsed`.
6. **Signature** — Ed25519 over the preimage, rebuilt by the verifier with its own `network_id` and `contract`.
7. **Consume** — store `nonce + 1` (overflow → `NonceOverflow`) or record the `claim_id`.

Steps 1–5 are cheap and return named errors. Step 6 uses the host's
`ed25519_verify`, which **aborts the transaction** on a bad signature instead
of returning an error; because the transaction aborts, step 7 never persists for
an invalid claim. Clients should therefore verify the signature off-chain
before submitting (`verifyClaim` in `@coreflow/sdk`), so a bad claim fails fast
with a readable error rather than an opaque transaction failure.

Issued-in-the-future claims are not rejected in v0.1 (ledger and issuer clocks
differ); `expires_at` bounds every claim's lifetime.

## 6. Error codes

On-chain errors use a reserved range so they do not collide with the host
contract's own codes.

| Code | Name | Next step for the client |
|---|---|---|
| 1101 | `IssuerNotRegistered` | The signing key is not registered on this contract; register it or sign with a registered key. |
| 1102 | `InvalidWindow` | `expires_at` must be later than `issued_at`. |
| 1103 | `ClaimExpired` | Ask the issuer for a fresh claim. |
| 1104 | `InvalidReplayFields` | Sequence claims need a zero `claim_id`; unique-id claims need `nonce = 0`; `payload_encoding` must be 0 or 1. (Off-chain, `@coreflow/sdk` reports an out-of-range encoding as `InvalidInput`, since its typed API cannot express one.) |
| 1105 | `NonceMismatch` | Read the expected nonce for this scope and sign with it. |
| 1106 | `ClaimAlreadyUsed` | This claim was already accepted; it cannot be submitted twice. |
| 1107 | `NonceOverflow` | The sequence for this scope is exhausted; use a new subject. |
| 1108 | `IssuerAlreadyRegistered` | Nothing to do — the key is already registered. |
| 1109 | `IssuerNotFound` | The key to revoke or rotate is not registered. |

## 7. Issuer registry and rotation

The verifying contract keeps a registry of issuer public keys. Who may change
it is the host contract's decision (typically an admin `require_auth`); the
library performs the change. Three operations:

- **register(key)** — key becomes trusted.
- **revoke(key)** — key stops being trusted immediately, including for claims it already signed that have not yet been submitted.
- **rotate(old, new)** — registers `new` and revokes `old` in one call.

Planned rotation should use register-then-revoke with an overlap window;
compromise response should use `rotate` (or `revoke`) for an immediate cut-off.
See [key-rotation.md](key-rotation.md).

## 8. Reference API (non-normative)

Rust (`coreflow-attest`, used inside your own contract):

```rust
use coreflow_attest::{Claim, ReplayMode, AttestError, verify_claim, registry};

registry::register(&env, &issuer_key)?;            // after your own admin auth
verify_claim(&env, &claim, &signature)?;          // checks 1–7
registry::rotate(&env, &old_key, &new_key)?;
let next = coreflow_attest::replay::next_nonce(&env, &issuer, &claim_type, &subject);
```

TypeScript (`@coreflow/sdk`, issuer and client side):

```ts
import { claimType, sha256, encodeClaim, signClaim, verifyClaim } from '@coreflow/sdk';

const ctx = { networkPassphrase: Networks.TESTNET, contractId: 'C…' };
const { signature } = signClaim(claim, ctx, issuerSecret);
verifyClaim(claim, ctx, signature, { now });        // off-chain pre-check
```

## 9. Versioning

- Wire `version` 1 is this document. A layout change increments it; verifiers reject unknown versions by construction (a different preimage never verifies).
- Packages follow semver; the 0.x series may change the API between minor versions.
