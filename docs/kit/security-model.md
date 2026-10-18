# Security model

> **Audit status:** 0.1.0-alpha has not been audited. Use it on Testnet only. Do not use it to protect real value.

This page sets out what CoreFlow Kit protects against, what it leaves to you, and how to test your integration. It assumes you have read [claim-format.md](claim-format.md), which is normative. For the key runbook see [key-rotation.md](key-rotation.md). For cases where another tool fits better, see [when-not-to-use.md](when-not-to-use.md).

## What the kit guarantees

`verify_claim` returns `Ok` only if all of these hold:

1. **Registered issuer.** The claim is signed by a key that is in the contract's issuer registry at the moment of verification.
2. **Bound to this network and contract.** The verifier rebuilds the preimage with its own `network_id` and contract hash, so a claim signed for another network or contract does not verify.
3. **Within its window.** `expires_at > issued_at`, and the ledger timestamp is `<= expires_at`.
4. **Not replayed.** In sequence mode the claim carries the exact next nonce for its scope (`issuer`, `claim_type`, `subject`), so each claim is accepted once and in order. In unique-id mode (`issuer`, `claim_id`) has never been accepted before.

Every field in the 256-byte preimage is covered by the signature, including `claim_type`, `subject`, `payload_hash` and `payload_encoding`.

## What it does not guarantee

| Not guaranteed | Who owns it |
|---|---|
| The claim is **true**. The issuer is trusted for the fact. | The issuer |
| The issuer key is kept secret. | The issuer's key custody |
| Only the right party can change the registry. `registry::register`, `revoke` and `rotate` do no authorization of their own. | Your contract, e.g. admin `require_auth` before each call |
| An issuer only signs the claim types you expect. The registry is flat, so any registered issuer can sign any `claim_type`. | Your contract |
| The claim is the kind your entry point handles. `verify_claim` does not know which `claim_type`, `subject` or payload you expect. | Your contract |
| Liveness. A claim may never be submitted, or may arrive after it expires. | Your relayer and operations |
| Confidentiality. Fields are public once submitted, and a hash of a guessable value (`SHA-256("order:42")`) can be brute-forced. | Your choice of subject and payload |
| Correct funds logic. | Your contract |

## Assets and trust boundaries

| Party or asset | Trusted for | If compromised or malicious |
|---|---|---|
| Issuer key | Every fact it signs | Can sign arbitrary claims until it is revoked |
| Registry admin (your contract's auth) | Which keys are trusted | Can register any key, so it can effectively forge any claim |
| Relayer / submitter | Nothing | Can delay, reorder or withhold claims, but cannot alter them |
| Ledger timestamp | Expiry checks | Out of scope; it is the network's close time |
| Off-chain payload store | Holding the payload | A swapped payload fails the `payload_hash` comparison, as long as your code makes it |

**Anyone may submit a claim.** A claim must therefore not give the submitter anything. Take recipients, amounts and targets from the signed claim (subject or payload), never from the invoking address.

## Threats

| Threat | Mitigation | Residual risk |
|---|---|---|
| Forged claim | Ed25519 over the full preimage, issuer registered | A bad signature aborts the transaction instead of returning a named error |
| Replay, same contract | Exact next nonce, or a `claim_id` marker, in persistent storage | A re-issued claim with a fresh nonce or id is a new claim. If an effect must happen once per subject, enforce that in your own state |
| Replay, other contract | Contract hash in the preimage, supplied by the verifier | An in-place WASM upgrade keeps the address, so outstanding claims stay valid. Keep replay storage keys stable across upgrades |
| Replay, other network | `network_id` from `env.ledger().network_id()` | None identified |
| Cross-claim-type confusion | `claim_type` is signed | Your contract must compare `claim.claim_type` with what the entry point handles |
| Expired claim | Ledger timestamp `<= expires_at`, signed in the preimage, not a storage TTL | The issuer picks the lifetime. v0.1 sets no maximum |
| Compromised issuer key | `registry::revoke` or `registry::rotate` cuts it off immediately | Claims accepted before revocation stand. The attacker controls `issued_at` |
| Compromised registry admin | Your contract's auth (multisig account, timelock) | Total. The kit cannot detect it |
| Front-running submitter | The claim gives the submitter nothing | Timing is the submitter's choice |
| Out-of-order or concurrent relayers | Unique-id mode. Sequence mode fails with `NonceMismatch` | In sequence mode a lost claim blocks its scope until it is submitted or re-signed with the same nonce. Re-signing while the original is valid creates two competing claims, and the first to land wins |
| Storage archival | Replay state in persistent storage only | Restoring an archived entry costs fees and needs a simulated restore footprint. This affects liveness, not safety |
| Payload does not match `payload_hash` | `payload_hash` is signed | `verify_claim` never sees the payload. Hash what you act on and compare it. No kit error code exists for this, so define your own |
| Host clock vs issuer clock | Expiry uses the ledger timestamp | Claims close to expiry may fail. Future-dated claims are accepted in v0.1. Leave a margin |

## Implementation notes

**`ed25519_verify` aborts.** The host function traps on a bad signature. It does not return `false`, and no code after it can handle the failure. The whole transaction fails, including every other claim in a batch. Steps 1–5 of the verification order run before it, so cheap failures get named errors (1101–1107). Run `verifyClaim` off-chain before you submit, and never write a wrapper that "returns false" on a bad signature.

**Replay state lives in persistent storage only.** Expired temporary entries are deleted. A used marker would disappear and the claim would verify again inside its window. TTL extension is permissionless (anyone can pay to extend any entry), so a TTL is never used as an expiry. Expiry always comes from the signed `expires_at`.

**Sequence mode requires the exact next nonce.** If it accepted any nonce at or above the expected one, a later claim could silently skip, and so void, an earlier claim that had not been submitted yet. Exact matching makes gaps impossible and keeps the state to one counter per scope. The cost is strictly serial submission. Read the counter with `replay::next_nonce`.

**Unique-id markers survive archival.** An archived persistent entry is not read as absent. The transaction must restore it first, so a marker cannot reset to "unused". Markers accumulate, so budget for their rent.

**`payload_hash` binds the payload.** The signature covers `SHA-256(payload)` and `payload_encoding`, so an altered payload no longer matches. That only protects you if a consumer recomputes the hash.

**Sign the bytes you verify.** The preimage is fixed-width and identical in Rust and TypeScript. Never sign JSON or any other re-serialized form.

## Testing guidance

- **Mock auth precisely.** `mock_all_auths` approves every `require_auth`, even with the wrong arguments, so a test still passes after you delete your admin check. Use `env.mock_auths` with the exact address, function and arguments, or assert `env.auths()` after the call. Add negative tests in which a non-admin calls your register, revoke and rotate entry points.
- **Assert named errors** through the generated `try_` client methods. A bad signature shows up as a failed invocation, not a code. Map codes in TypeScript with `fromContractErrorCode`.
- **Mutation check.** The crate's suite has, for every verification check, a test that fails if that check is deleted. Apply the same rule to your own entry points: deleting your `claim_type` comparison, payload-hash comparison or admin auth should break a test. A mutation-testing tool such as `cargo-mutants` can automate this.
- **Shared vectors.** Run your TypeScript issuer and your Rust contract against `packages/test-vectors/`, and add vectors for your own claim types.

## Audit status

0.1.0-alpha has not been audited. Use it on Testnet only. Do not use it to protect real value.
