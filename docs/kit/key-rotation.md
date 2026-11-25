# Key rotation runbook

How to replace the key your issuer signs claims with, for a contract that uses
`coreflow-attest`. Two procedures: **planned** (no downtime) and **emergency**
(the old key may be compromised).

Background: [claim-format.md §7](claim-format.md#7-issuer-registry-and-rotation)
defines the registry operations; [security-model.md](security-model.md) explains
what a compromised issuer key can and cannot do.

## What changes when a key is replaced

| | Old key revoked | New key registered |
|---|---|---|
| Claims signed by it, not yet submitted | Fail with `IssuerNotRegistered` (1101) | Accepted |
| Claims already accepted | Stay accepted — revocation is not retroactive | — |
| Sequence-mode counters | Keyed by issuer, so the old key's counters are simply no longer used | Start at nonce 0 for every scope |
| Unique-id markers | Keyed by (issuer, `claim_id`) | Independent of the old key's markers |

Two consequences to plan for:

- **Revocation is immediate.** Any claim the old key signed but nobody has
  submitted yet is lost the moment the old key is revoked. The issuer must
  re-sign it with the new key.
- **The new key starts fresh sequences.** A client that tracks "next nonce" per
  scope must reset to `replay::next_nonce` for the new issuer (which returns 0),
  not continue the old key's numbering.

## Planned rotation

Use this for routine key hygiene, staff changes or moving the signer to new
infrastructure.

1. **Generate the new key offline**, on the machine or HSM that will hold it.
   It is a raw Ed25519 key, not a Stellar account; never reuse an account
   secret as an issuer key.
2. **Register the new key** through your contract's admin entry point (your
   contract performs the admin `require_auth`, then calls the library):
   ```rust
   pub fn add_issuer(env: Env, key: BytesN<32>) -> Result<(), MyError> {
       read_admin(&env).require_auth();
       coreflow_attest::registry::register(&env, &key)?;
       Ok(())
   }
   ```
   Both keys are now accepted. This overlap is what makes the rotation
   downtime-free.
3. **Switch the issuer** to sign every new claim with the new key.
4. **Drain the old key.** Wait until every claim the old key signed has either
   been submitted or passed its `expires_at`. The longest `expires_at` you
   issue is your maximum wait, which is one reason to keep claim lifetimes
   short.
5. **Revoke the old key:**
   ```rust
   pub fn remove_issuer(env: Env, key: BytesN<32>) -> Result<(), MyError> {
       read_admin(&env).require_auth();
       coreflow_attest::registry::revoke(&env, &key)?;
       Ok(())
   }
   ```
6. **Verify, on the deployed contract:**
   - a fresh claim signed by the **old** key fails with `IssuerNotRegistered` (1101);
   - a fresh claim signed by the **new** key is accepted;
   - `registry::is_registered` returns `false` for the old key and `true` for the new one (expose it as a read-only function if you want to check it without submitting a claim).
7. **Destroy or archive the old key** according to your key-custody policy.

## Emergency rotation (suspected compromise)

Assume the attacker can sign any claim the old key could. Speed matters more
than avoiding re-issuance.

1. **Cut the old key off immediately**, in one call if you have a replacement
   ready:
   ```rust
   pub fn rotate_issuer(env: Env, old: BytesN<32>, new: BytesN<32>) -> Result<(), MyError> {
       read_admin(&env).require_auth();
       coreflow_attest::registry::rotate(&env, &old, &new)?;
       Ok(())
   }
   ```
   `rotate` registers `new` and revokes `old` atomically. If no replacement key
   is ready, call `registry::revoke` now and register a new key later — a
   period with no valid issuer is safer than a period with a compromised one.
   If your contract has a pause switch, pausing before rotating closes the
   window further.
2. **Re-issue** every claim that was signed by the old key and not yet
   submitted. Those are gone by design.
3. **Review exposure.** List every claim accepted since the earliest moment the
   key may have leaked. Each one is a claim an attacker could have produced;
   decide per claim whether funds it released need follow-up off-chain. This
   review is only possible if your contract emits an event for each claim it
   acts on (issuer, subject, what was released) — add one now if it does not.
4. **Find the leak** before trusting the new key: how the old key was
   exposed decides whether the new one is any safer.
5. **Verify** exactly as in step 6 of the planned rotation.

## Key custody checklist

- [ ] Issuer keys never appear in a repository, a CI log, an `.env` dump or a ticket.
- [ ] Each environment (testnet, staging, production) has its own issuer key.
- [ ] Claim lifetimes are as short as the use case allows — they bound both the drain wait and the damage window.
- [ ] The registry admin key is held separately from the issuer key. Whoever holds both can mint trusted claims at will.
- [ ] You have rehearsed both procedures on Testnet, including the verification step.
- [ ] Someone other than the issuer operator can execute the emergency procedure.

## Testing rotation in your own suite

With the `testutils` feature, `MockIssuer::test(0)` and `MockIssuer::test(1)`
give you two deterministic keys. A minimal rotation test registers key 0,
accepts a claim signed by it, rotates to key 1, then asserts a claim from key 0
fails with `IssuerNotRegistered` and a claim from key 1 succeeds.
