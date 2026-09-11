# CoreFlow Deployments

CoreFlow has **two distinct on-chain deployments**. They are different contracts
with different security properties, and this document exists so that distinction
is never blurred.

> **v2's security improvements are deployed on Testnet only.**
> They are **not** on Mainnet. Nothing in this repository should be read as
> claiming otherwise.

---

## CoreFlow v2 — Stellar **Testnet** (active, hardened)

| Field | Value |
|---|---|
| Network | **Stellar Testnet** |
| Network passphrase | `Test SDF Network ; September 2015` |
| Contract ID | `CDN4FIKLJ72WYNPBIKWYSDJWDZG22QNPLWI37VTUAE4EKKIBVAQRG5F4` |
| WASM SHA-256 | `d9f2d849d69b56aebcbdf585e8b2e0e8d81d9e5bf13f51534f27bf479d0e56da` |
| WASM size | 42,425 bytes |
| Attestation schema | `CFWP-v2` (198-byte domain-separated preimage) |
| Admin | `GAELEFW56FPEVOO57SJATCGEHX4ROQHULSUHEFMMPLEMACTA5A7PO2J2` |
| Admin pinned in WASM | **yes** — `COREFLOW_ADMIN` baked at build time |
| Oracle public key | `f42a48839e48d58e6628f5d096ee859e635b056be580bdcc68d620e2a2badae0` |
| Oracle key registered | yes |
| Paused | no |
| Explorer | https://stellar.expert/explorer/testnet/contract/CDN4FIKLJ72WYNPBIKWYSDJWDZG22QNPLWI37VTUAE4EKKIBVAQRG5F4 |

### Settlement asset (Testnet)

| Field | Value |
|---|---|
| Asset | Test `USDC` (**not** Circle USDC) |
| SAC contract | `CBW2ZKFBHLHNNVCZ7JP4AXHQOOC3S6NLAMORXOAIWQNWMKUVJS743Q5M` |
| Decimals | 7 |
| Explorer | https://stellar.expert/explorer/testnet/contract/CBW2ZKFBHLHNNVCZ7JP4AXHQOOC3S6NLAMORXOAIWQNWMKUVJS743Q5M |

### What v2 adds over v1

| Hardening | Effect |
|---|---|
| Domain-separated attestations (`CFWP-v2`) | A Testnet proof cannot be replayed on Mainnet, on another deployment, for another payee, asset, amount or period |
| `proof_preimage` read-only entry point | The contract is the single source of truth for what must be signed |
| Admin-managed oracle registry | A manager can no longer install their own oracle and attest to their own work |
| `hours × rate == amount` invariant | Verified work determines payment; `hours_logged` is no longer decorative |
| Build-time admin pin | `init_admin` front-running gains an attacker nothing |
| Two-step admin handover | A mistyped transfer cannot destroy admin control |
| `upgrade` requires pause first | No silent one-transaction replacement of the code holding custody |
| Permissionless `extend_escrow_ttl` | Anyone — including the worker awaiting payment — can keep a funded escrow's storage alive |
| Batch cap + pay-period validation | Bounds a DoS vector and a meaningless attested period |

---

## CoreFlow v1 — Stellar **Mainnet** (historical)

| Field | Value |
|---|---|
| Network | Stellar Mainnet (Public) |
| Contract ID | `CCTF5WBOQR7JP2KPLQT372X7JCGCINHDFRSAPF4YTYRKZXZ3J2XPRFFW` |
| Attestation schema | v1 (32-byte, **no domain separation**) |
| Explorer | https://stellar.expert/explorer/public/contract/CCTF5WBOQR7JP2KPLQT372X7JCGCINHDFRSAPF4YTYRKZXZ3J2XPRFFW |

**Status:** deployed and untouched. This pass did not modify, repoint, pause or
upgrade it. It does **not** carry any of the v2 hardening above.

Known limitations of v1, retained here for accuracy:

- Attestations lack domain separation — a proof is not bound to network,
  contract, payee, asset, amount or period.
- The manager supplies and may rotate the oracle key, so the proof-of-work gate
  is manager-attestable.
- `hours_logged` does not constrain the amount paid.
- `init_admin` is not pinned and is therefore front-runnable.

A controlled v1 → v2 Mainnet migration is future work and has not been scheduled.

---

## Reproducing the v2 deployment

```bash
# 1. Oracle keypair (server-side only; never commit the seed)
openssl rand -hex 32 > /dev/null   # generate, then store in your secret manager
ORACLE_SECRET_KEY=<seed> node scripts/oracle-cli.mjs pubkey

# 2. Deploy. Refuses to proceed unless the admin pin is present in the WASM.
ADMIN_IDENTITY=coreflow-v2-admin \
ORACLE_PUBKEY=<64 hex> \
  ./scripts/deploy-testnet.sh
```

The script builds with `COREFLOW_ADMIN` set, **greps the resulting binary to
confirm the pin is physically present** (building with the variable set is not
evidence the compiler used it — a cached unpinned artifact would look identical),
deploys, initializes, registers the oracle key, and then verifies every one of
those facts by reading them back from the chain.

## Environment

```
NEXT_PUBLIC_STELLAR_NETWORK=testnet
NEXT_PUBLIC_STELLAR_CONTRACT_ID=CDN4FIKLJ72WYNPBIKWYSDJWDZG22QNPLWI37VTUAE4EKKIBVAQRG5F4
NEXT_PUBLIC_STELLAR_TOKEN_ID=CBW2ZKFBHLHNNVCZ7JP4AXHQOOC3S6NLAMORXOAIWQNWMKUVJS743Q5M
NEXT_PUBLIC_STELLAR_READ_ADDRESS=GAELEFW56FPEVOO57SJATCGEHX4ROQHULSUHEFMMPLEMACTA5A7PO2J2
ORACLE_SECRET_KEY=<32-byte hex seed, server-side only>
```

An unset `NEXT_PUBLIC_STELLAR_CONTRACT_ID` is a hard error, not a fallback —
see `src/lib/config.ts`.
