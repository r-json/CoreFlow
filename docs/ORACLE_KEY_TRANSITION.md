# Oracle registry transition — runbook

> **Status: PREPARED, NOT EXECUTED.** Awaiting the owner's confirmation of which
> public key is the post-rotation one. No `register_oracle_key` or
> `revoke_oracle_key` transaction has been sent.

## Why this is blocked on a human

The live funding run stopped at simulation with `Error(Contract, #16)`
`OracleKeyNotRegistered`. The read-only facts:

| Key | Registered on `CDN4FIKL…VAQRG5F4` |
|---|---|
| `3b9d395a725ba0be4c476a0504540fb8dd70a278fac140a20e0d74cd7f41ae44` — in the local environment | **false** |
| `f42a48839e48d58e6628f5d096ee859e635b056be580bdcc68d620e2a2badae0` — recorded at deployment | **true** |

The contract trusts the deployment-time key and not the current environment's. That
is consistent with the oracle secret having been rotated locally without the new
public key being registered.

**Which key is the post-rotation one cannot be determined from here.** The naming
suggests an answer and the naming is not evidence. If `f42a4883…` is the key
`prodenv.txt` exposed, then registering `3b9d395a…` is correct and revoking
`f42a4883…` is urgent. If the mapping is the other way round, registering
`3b9d395a…` would authorize a credential an attacker may hold to sign work
attestations — precisely the attack the admin-managed registry exists to prevent.

So this waits. A manager cannot install their own oracle; neither can an agent.

## Order, and why

```
1. register(new)      ← first
2. verify(new) == true
3. revoke(old)        ← only after 2 succeeds
4. verify(old) == false
```

Registering first means there is never a window in which **no** key is registered.
Revoking first would leave the contract unable to accept any attestation, and would
strand every escrow awaiting one.

## Steps

Each step prints only public values: network, contract, admin address, the oracle
**public** key, and the operation. No secret is read or printed at any point.

### 0. Preflight

```bash
npm run check:env          # must report profile: LOCAL
stellar keys address coreflow-v2-admin
stellar contract invoke --id "$CONTRACT" --source coreflow-v2-admin \
  --network testnet --send=no -- get_admin
```

`get_admin` must equal the `coreflow-v2-admin` address. If it does not, stop: the
identity cannot perform this transition.

### 1. Register the new key

```bash
stellar contract invoke --id "$CONTRACT" --source coreflow-v2-admin \
  --network testnet -- register_oracle_key --pubkey "$NEW_PUBKEY"
```

Record the transaction hash.

### 2. Verify registration from chain state, not from the exit code

```bash
stellar contract invoke --id "$CONTRACT" --source coreflow-v2-admin \
  --network testnet --send=no -- is_oracle_key_registered --pubkey "$NEW_PUBKEY"
# must print: true
```

**If this is not `true`, STOP. Do not revoke the old key.** A failed registration
followed by a revocation leaves the contract with no usable oracle.

### 3. Revoke the old key

```bash
stellar contract invoke --id "$CONTRACT" --source coreflow-v2-admin \
  --network testnet -- revoke_oracle_key --pubkey "$OLD_PUBKEY"
```

Record the transaction hash.

### 4. Verify the final registry state

```bash
is_oracle_key_registered(NEW) == true
is_oracle_key_registered(OLD) == false
```

**If the post-state does not match, STOP and report the exact chain state.** Do not
attempt a corrective transaction without review.

### 5. Re-run the read-only preflight

```bash
npm run check:env
node scripts/validate-testnet-v2.mjs
```

## Out of scope for this transition

Not to be touched: the contract **admin**, the **pause** state, the **upgrade**
state, escrow data, and anything outside the oracle registry. Two invocations only.

## What this does and does not accomplish

It makes the contract trust the current oracle key and stop trusting the previous
one. It does **not** complete the 🔴 outstanding secret rotation: `AUTH_SECRET`,
`BOOTSTRAP_SECRET`, the cron/indexer secrets and the database credential are
separate, and remain the owner's to rotate. See [BACKLOG.md](BACKLOG.md).

## Execution

One reproducible pass, which emits the evidence record itself rather than relying on
a narrated summary afterwards:

```bash
# read-only checks only
node scripts/oracle-key-transition.mjs --new <NEW> --old <OLD> --confirm-mapping --dry-run

# execute
node scripts/oracle-key-transition.mjs --new <NEW> --old <OLD> --confirm-mapping
```

[`scripts/oracle-key-transition.mjs`](../scripts/oracle-key-transition.mjs) refuses
unless both keys are named AND `--confirm-mapping` is passed, so it cannot run by
accident. It verifies `get_admin` matches the signing identity, registers before
revoking, reads chain state after each step rather than trusting the CLI exit code,
and stops — writing the record — if the new key is not registered after registration
or if the final state is not `new=registered, old=not registered`.

**Verified:** it refuses without `--confirm-mapping` (exit 1) and refuses a
malformed key. The dry-run path is deliberately unexercised, because running it would
mean asserting a key mapping that has not been confirmed.

## Evidence to record on completion

Written to `docs/evidence/oracle-key-transition.json` by the script:

```
Network:   Stellar Testnet
Contract:  CDN4FIKL…VAQRG5F4
Admin:     <public address>

Old oracle:  f42a…
New oracle:  3b9d…

Registration TX:     <hash>
Post-registration:   new = registered
                     old = registered

Revocation TX:       <hash>
Post-revocation:     new = registered
                     old = not registered
```

Both post-states are read from the contract, so the record states what the chain
says rather than what the commands were asked to do. The intermediate
post-registration state is captured deliberately: it is the evidence that there was
never a window in which no oracle key was registered.
