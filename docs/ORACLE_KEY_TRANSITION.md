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

**Which key is the post-rotation one cannot be determined from the registry
alone.** The naming suggests an answer and the naming is not evidence. A cheaper
question may be decidable from evidence on disk — see the next section — but it
does not change who authorizes the transaction. If `f42a4883…` is the key
`prodenv.txt` exposed, then registering `3b9d395a…` is correct and revoking
`f42a4883…` is urgent. If the mapping is the other way round, registering
`3b9d395a…` would authorize a credential an attacker may hold to sign work
attestations — precisely the attack the admin-managed registry exists to prevent.

So this waits. A manager cannot install their own oracle; neither can an agent.

## A determination that may not need anyone's memory

The section above asks the wrong question. "Which key is *newer*" is a fact about
history, recoverable only from whoever performed the rotation. But the action does
not depend on age — it depends on **which key is exposed**, and that is a fact
about a file still sitting on disk.

`prodenv.txt` contains exactly one `ORACLE_SECRET_KEY` line, and the public half
is derived from it deterministically
([`src/lib/oracle/index.ts:74`](../src/lib/oracle/index.ts)). Deriving that public
key names the exposed key from evidence rather than from naming.

**The owner runs this, not an agent** — the secret would otherwise pass through an
agent's process, and the standing rule is that it does not. Load the
`ORACLE_SECRET_KEY` value from `prodenv.txt` into a shell variable, then derive
and print only the **public** key with `Keypair.fromRawEd25519Seed`, exactly as
`getOraclePublicKeyHex()` does. Nothing secret is displayed.

Read the single line it prints:

| Output | Meaning | Action |
|---|---|---|
| `f42a4883…` | The **registered** key is the exposed one. The local environment holds a different secret — a replacement was generated and never registered. | Register `3b9d395a…`, then revoke `f42a4883…`. The urgency is real: an exposed key is currently trusted. |
| `3b9d395a…` | The **local environment's** key is the exposed one. | Do **not** register `3b9d395a…`. Generate a fresh oracle secret, register its public key, revoke both. |
| neither | A third key is in production; this file settles nothing about the two candidates. | Still owner-gated. Treat both as suspect and prefer a fresh key. |

Note which way the risk falls. `prodenv.txt` is a **production** dump, and
production is Mainnet v1 while this blocker concerns the v2 Testnet contract, so
"neither" is a realistic outcome — the two deployments need not share an oracle.
That makes this a cheap check rather than a guaranteed answer: one command either
decides it or eliminates the file from consideration.

In every branch the decision stays the owner's, and in none of them does guessing
from key names become acceptable.

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
