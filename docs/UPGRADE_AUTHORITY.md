# Upgrade, Admin and Pause Authority

`upgrade` replaces the code that holds every escrow's custody. It is the most
consequential entry point in the contract, so its conditions are specified and
tested here rather than demonstrated once by hand.

> **This document does not claim the mechanism is safe in the abstract.** An
> upgradeable contract is a trusted-admin contract. What follows is an exact
> statement of who is trusted, with what, and what that trust cannot be stopped
> from doing.

---

## 1. Answers to the direct questions

| Question | Answer |
|---|---|
| **Who can upgrade?** | Only the address stored as `Admin`, proven by `require_auth()`. |
| **Who can become admin?** | Only the address baked into the WASM at build time (`COREFLOW_ADMIN`). `init_admin` rejects any other with `AdminMismatch` (#20). |
| **What conditions are required?** | An admin signature **and** the contract already paused. Both, every time. |
| **Can an unauthorized actor upgrade?** | No. The call requires the admin's signature; a non-admin cannot produce it. |
| **Is pause mandatory?** | Yes. `upgrade` returns `NotPaused` (#22) otherwise, checked before anything is replaced. |
| **Is the upgrade observable?** | Yes. `admin/upgrade` carries the WASM hash, and the mandatory `admin/paused` precedes it — the full sequence is reconstructable from the event log. |
| **Can an admin brick the contract?** | Not by naming a wrong hash: the host refuses an unuploaded one and the transaction fails. An admin **can** upgrade to code that is itself broken — see §4. |
| **What happens to escrow state?** | Nothing. Custody, approvals, verified proofs, nonce watermarks, the admin and the oracle registry all survive. Verified in tests and on live Testnet. |
| **Can an admin-less contract be upgraded?** | No. With no `Admin` set there is no authority to satisfy, and `upgrade` returns `NotAdmin` (#10). Such a deployment is immutable. |

---

## 2. The required sequence

```
admin signs ──▶ set_paused(true)   ── emits admin/paused ──┐
                                                            │  observable gap
admin signs ──▶ upgrade(wasm_hash) ── emits admin/upgrade ──┤
                                                            │
admin signs ──▶ set_paused(false)  ── emits admin/paused ──┘
```

The pause requirement does not stop a malicious admin — nothing at this layer
can. What it removes is the **silent** path: code holding custody cannot be
replaced in one transaction while the system still looks healthy. Monitoring has
a pause event to alert on, and the gap between pause and upgrade is visible to
anyone reading the ledger.

**`cancel_escrow` stays callable while paused.** If an operator pauses and walks
away, managers can still recover their own custody. A pause window therefore
cannot trap funds.

---

## 3. Tests

`contracts/core-flow/src/test.rs`:

| Test | Asserts |
|---|---|
| `test_upgrade_requires_admin_authorization` | Exactly one signer, and it is the admin |
| `test_upgrade_impossible_without_an_admin` | `NotAdmin` when no admin is configured |
| `test_upgrade_requires_pause_first` | `NotPaused` when live |
| `test_upgrade_pause_is_mandatory_and_checked_first` | Still `NotPaused` after a pause/unpause cycle — no latent permission |
| `test_upgrade_emits_an_event_carrying_the_wasm_hash` | Upgrade and the preceding pause are both observable |
| `test_upgrade_preserves_escrow_state_and_custody` | Custody, approvals, proofs, nonce, admin and registry survive; the escrow still settles afterwards |
| `test_pause_for_upgrade_does_not_trap_funds` | `cancel_escrow` refunds while paused |
| `test_upgrade_to_an_unknown_wasm_hash_is_refused` | **Ignored** — the host's refusal is a non-unwinding trap that `#[should_panic]` cannot catch natively. Verified on live Testnet instead (below). |

Authorization is asserted via `env.auths()` rather than by calling unauthorized,
because a failed `require_auth` is a non-unwinding host trap in native
`cargo test`. Checking which signature the contract **demanded** proves the same
property and is catchable.

---

## 4. Live Testnet verification

Contract `CDN4FIKLJ72WYNPBIKWYSDJWDZG22QNPLWI37VTUAE4EKKIBVAQRG5F4`.

```
# Real upgrade, performed in place (this is how per-payment events shipped)
upgrade without pausing        → Error(Contract, #22)  NotPaused        REFUSED
set_paused(true) → upgrade → set_paused(false)                         SUCCEEDED
get_admin / expected_admin / oracle registry                           ALL SURVIVED
escrow 2: 3 payments, manager_approved=true                            STATE INTACT
extend_escrow_ttl (new entry point)                                    LIVE

# Non-admin attempting an admin-only action
source=coreflow-v2-manager, set_paused(true)
  → "Missing signing key for account GAELEFW56FPE…"                    REFUSED
  → is_paused still false                                             NO EFFECT

# Admin naming a WASM hash that was never uploaded
upgrade(0xabab…ab)            → HostError: Error(Storage, MissingValue) REFUSED
  → get_admin intact, escrow 5: 3 payments intact                     NO DAMAGE
```

The non-admin refusal is worth reading carefully: the CLI reports a *missing
signing key for the admin's address*, because the contract demands that specific
signature. The manager is not refused for lacking a role — they are refused
because they cannot produce the key the contract requires.

---

## 5. Residual risk, stated plainly

| Risk | Status |
|---|---|
| A compromised admin key can upgrade to code that drains all custody | **Not mitigated.** This is inherent to an upgradeable contract. The pause requirement makes it observable, not impossible. |
| An admin can upgrade to WASM that is valid but broken | **Not mitigated** by the contract. Mitigated operationally: CI builds and tests the WASM, and the deploy script verifies the admin pin is physically present in the binary. |
| The admin key is a single point of failure | **Not mitigated.** It is one Stellar account. A multisig account or a threshold scheme would reduce this and is not implemented. |
| No timelock between announcing and performing an upgrade | **Not implemented.** Pause-then-upgrade forces two transactions but provides no waiting period for anyone to react. |

Two-step admin handover (`propose_admin` / `accept_admin`) protects against
losing control to a mistyped address, but does nothing about a compromised one.

**Before any Mainnet migration**, these paths — upgrade, admin, oracle registry,
settlement — warrant independent external review. Strong internal testing is not
equivalent to an audited financial system, and this document should not be read
as claiming otherwise.
