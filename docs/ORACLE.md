# CoreFlow Oracle Protocol

**Schema:** `CFWP-v2` · **Preimage:** 198 bytes, fixed width · **Signature:** Ed25519

The oracle is the component that turns "a payment row exists" into "the contract will
release funds for it". `pay_batch` refuses to settle any payment whose `proof_verified`
flag is false, so an oracle signature is the only thing standing between a funded escrow
and a paid worker. This document is the specification of that signature.

---

## 1. What the oracle attests to

> *This worker performed these hours in this period, and is owed exactly this amount,
> in this asset, under this escrow, on this contract, on this network — once.*

Every clause in that sentence is a field in the signed preimage. That is the whole design.

---

## 2. The preimage (198 bytes)

| Offset | Size | Field | Source |
|-------:|-----:|-------|--------|
| 0 | 4 | magic `"CFWP"` | constant |
| 4 | 2 | version `u16 BE` (= 2) | constant |
| 6 | 32 | `network_id` — sha256(network passphrase) | `env.ledger().network_id()` |
| 38 | 32 | contract digest | sha256(ScVal XDR of `current_contract_address`) |
| 70 | 32 | worker digest | sha256(ScVal XDR of the **stored** payment's worker) |
| 102 | 32 | token digest | sha256(ScVal XDR of the **stored** payment's asset) |
| 134 | 4 | `escrow_id` `u32 BE` | call argument |
| 138 | 4 | `payment_id` `u32 BE` | call argument |
| 142 | 16 | `amount` `i128 BE` | **stored** payment row |
| 158 | 16 | `hours` `i128 BE` | call argument |
| 174 | 8 | `start_date` `u64 BE` | **stored** payment row |
| 182 | 8 | `end_date` `u64 BE` | **stored** payment row |
| 190 | 8 | `nonce` `u64 BE` | call argument |

**Addresses are hashed, not embedded.** An account `ScAddress` and a contract `ScAddress`
serialize to different lengths, so hashing each to a fixed 32 bytes keeps the preimage
fixed-width and trivially reproducible off-chain.

**Fields marked *stored* are read from escrow state, never from call arguments.** This is
what stops a caller retargeting a signature onto a different payee, asset, amount or
period than the one the oracle actually saw.

---

## 3. What v1 got wrong

v1 signed 32 bytes: `escrow_id ‖ payment_id ‖ hours ‖ nonce`.

That message named no chain, no contract, no payee, no asset and no amount. The
consequences were concrete:

| Substitution | Possible under v1? | Closed by |
|---|---|---|
| Replay a Testnet attestation against Mainnet | **Yes** | `network_id` |
| Reuse a signature on a different deployment of the same contract | **Yes** | contract digest |
| Redirect a payment to a different worker | **Yes** | worker digest |
| Settle in a different asset than attested | **Yes** | token digest |
| Change the amount paid after attestation | **Yes** | `amount` |
| Reuse an attestation for a different pay period | **Yes** | period |
| Replay the same attestation twice | No — nonce watermark | `nonce` |

The Testnet→Mainnet case is the sharpest one: the same escrow id and payment id on two
networks is not a hypothetical, it is the *expected* outcome of testing before launch.

---

## 4. Replay protection

The contract keeps a **monotonic nonce watermark** per escrow, in persistent storage.
`submit_hours_proof` accepts a nonce only if it equals the current watermark, then
increments it.

This is stronger than a set of spent nonces, and cheaper: a `Vec` of consumed values grows
without bound, costs more rent on every call, and eventually makes its own escrow
unusable — while only ever rejecting *exact* duplicates. A watermark is O(1) forever and
rejects every nonce at or below it.

**Ordering matters.** The signature is verified **before** the nonce is consumed. Consuming
first would let an attacker burn an escrow's nonce sequence by submitting garbage
signatures.

---

## 5. Who may hold an oracle key

Oracle keys are held in an **admin-managed on-chain registry**:

```
register_oracle_key(pubkey)        // contract admin only
revoke_oracle_key(pubkey)          // contract admin only
is_oracle_key_registered(pubkey)   // read-only
```

`initialize_multi_sig_escrow` and `rotate_oracle_key` both refuse a key that is not
registered — so rotation cannot be used as a back door around the registry.

**Why this exists.** Previously the *manager* supplied the `oracle_pubkey` at escrow
creation and could rotate it at will. A manager could therefore install their own key and
sign their own "verified work" attestations, which made the proof-of-work gate procedural
rather than cryptographic. Economic damage was bounded — custody is the manager's own
funds — but the security property the product advertises did not hold.

**Revocation is deliberately not retroactive.** It stops a key being named by *new*
escrows and *new* rotations; it does not invalidate in-flight attestations, because doing
so would strand escrows that are already funded. To retire a key from a live escrow, the
manager calls `rotate_oracle_key`, which revokes that escrow's verified proofs and forces
re-attestation under the new key.

**Bootstrap exception.** A contract with no admin has no registry authority, so no key
could ever satisfy the check. Rather than bricking such a deployment, an admin-less
contract accepts any key — exactly the v1 trust model, and no weaker. The registry is
enforced from the moment `init_admin` runs.

---

## 6. Work must justify payment

The contract enforces:

```
hours × rate_per_hour == amount
```

Without it, `hours_logged` was decorative: the oracle could attest to any number of hours
while `amount` — fixed at creation and already funded into custody — paid out regardless.

Two corollaries:

- `initialize_multi_sig_escrow` rejects an `amount` that is not a whole multiple of
  `rate_per_hour`, so custody is never funded into an escrow that can never settle.
- `/api/submit-batch` **derives** hours from the on-chain payment row rather than trusting
  the upload, and refuses a CSV whose payees do not match the funded escrow.

**Known limitation.** This makes hours whole numbers. Fractional-hour payroll (e.g. 40.04 h)
needs a scaled-hours representation, which would be a v3 schema change. This is a real
product constraint, not an oversight — it is recorded here rather than hidden.

---

## 7. Keeping signer and verifier in agreement

Three implementations build this preimage:

| Implementation | File |
|---|---|
| Contract (the verifier) | `contracts/core-flow/src/lib.rs` → `build_proof_message` |
| Server signer | `src/lib/oracle/index.ts` → `buildProofMessage` |
| CLI | `scripts/oracle-cli.mjs` → `buildProofMessage` |

They are pinned to **one shared vector**, `docs/evidence/proof-vector-v2.json`, by a chain
of three assertions:

1. `test_proof_preimage_matches_cross_language_vector` (Rust) — the Rust layout equals the
   vector produced by the JS CLI.
2. `builds the exact preimage pinned by the cross-language vector` (vitest) — the TS
   signer equals the same vector.
3. `test_contract_preimage_matches_independent_implementation` (Rust) — the **contract's
   own** builder equals an independent reimplementation written out longhand in the test
   file.

Step 3 matters: the test-side builder is deliberately a *second* implementation rather
than a call into the contract's. Sharing the builder would make every signature test
tautological — it would prove only that one function agrees with itself, and a field
silently dropped from the preimage would still pass.

**Better still: don't reimplement it.** The contract exposes

```
proof_preimage(escrow_id, payment_id, hours, nonce) -> Bytes
```

as a read-only call. A signer can simulate it and sign the returned bytes verbatim,
eliminating drift by construction. `CoreFlowClient.getProofPreimage()` wraps it.

---

## 8. Using the CLI

```bash
# Print the oracle public key (hex) — this is what gets registered on-chain
ORACLE_SECRET_KEY=<64 hex chars> node scripts/oracle-cli.mjs pubkey

# Sign a batch
ORACLE_SECRET_KEY=... node scripts/oracle-cli.mjs sign batch.json

# Verify locally, and demonstrate replay + domain binding
ORACLE_SECRET_KEY=... node scripts/oracle-cli.mjs verify batch.json signed.json
```

`batch.json`:

```json
{
  "networkPassphrase": "Test SDF Network ; September 2015",
  "contractId": "C...",
  "escrowId": 1,
  "startNonce": 0,
  "payees": [
    { "paymentId": 0, "worker": "G...", "token": "C...",
      "amount": "10000", "hours": 40, "startDate": 1000, "endDate": 2000 }
  ]
}
```

`verify` prints, for the operator to see before broadcasting:

```
payment 0  nonce 0  VALID
replay protection: nonce IS bound into the signature
domain separation: network IS bound into the signature
```

The CLI requires `networkPassphrase` and `contractId` explicitly and refuses to default
them — guessing which chain an attestation is for is exactly the failure v2 exists to
prevent.

---

## 9. Key handling

- `ORACLE_SECRET_KEY` is a 32-byte hex seed. Generate with `openssl rand -hex 32`.
- It lives **only** on the server. It is never sent to the browser and never logged.
- Only the *public* half reaches clients, via `GET /api/oracle/pubkey`.
- Requesting an attestation requires a verified session **and** that the caller is the
  escrow's **on-chain manager**, read live from the contract rather than from the request.
- Rotating `ORACLE_SECRET_KEY` invalidates every escrow whose stored `oracle_pubkey` is
  the old key. Those escrows need `rotate_oracle_key` (to a registered replacement) or
  cancellation. Plan rotation accordingly.
