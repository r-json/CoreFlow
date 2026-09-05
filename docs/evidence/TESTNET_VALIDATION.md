# Testnet Validation — Deliverables 1 & 2

Network: **Stellar Testnet**  ·  Contract: `CA47SB2NBTTVFPBDHPQHDAO4MGJNPCJFXKMNJ6XGFCVWXX5WEG7T4UW5`

## Deployed artifacts

| Artifact | ID |
|---|---|
| CoreFlow contract | `CA47SB2NBTTVFPBDHPQHDAO4MGJNPCJFXKMNJ6XGFCVWXX5WEG7T4UW5` |
| USDC SAC (test issuer) | `CCPQLQHJ2BS4XEDDQYR7IBU7KLNU2AULUSM6Y6BWFF5KX33X37ZFSRQU` |
| Native XLM SAC | `CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC` |
| USDC issuer | `GCA3GYVLKGK7UAN4E5MQRRSMADZ6E37JSYYQ3TTX676OI3KALQYC5X2L` |
| Manager / finance | `GA7AQACFZIL5ZODZD63D22EPTPODL5JALAAW32QP7LO3MZL6BS3R2UBT` |
| Payee (USDC) | `GBHJ76243G2QFUBQYIRD3KLY4TH5EKHTA647UU4H2XCSFTGQMZNZV4CT` |
| Payee (XLM) | `GDZ7NG3MMXYQC55YZUFYTR7LYLKYPOF7QCOMURES5WH33DPOMBMUUIVP` |

## Transaction hashes

| # | Step | Hash |
|---|---|---|
| 1 | Contract deploy | `a3aa9b83ac389df1388f16f3f3d6c9c77b02effb5291ba430df45d736d8e34dd` |
| 2 | `init_admin` | `f62026dbd5c4514f7d1b3c85070a250b34eeff34d6f4b2c8dbdd6d32a9e54eb4` |
| 3 | Trustline (manager, USDC) | `6023ae886ba47773e66f561b092b204a833a19eac88c38a3c58fea7b936cbf23` |
| 4 | Trustline (payee, USDC) | `ced0939ef2d6d58332fb95243965ddf0412736270a5e684349538b85e803b498` |
| 5 | `initialize_multi_sig_escrow` (multi-asset funding) | `6ff925ab412fbb8d553dde24d5175a8a1efd62603d79dc76e6bf43a4745a4bb3` |
| 6 | `submit_hours_proof` payment 0, nonce 0 | `b9aae0e127dac3f547cf3693b4c0174c32ca6e00db6f6e912271247b8c5647c3` |
| 7 | `submit_hours_proof` payment 1, nonce 1 | `b657d4c81b12f7e94e0a0aa7506133f506fc837cd649a32f7ca851eadadd0124` |
| 8 | `manager_approve` | `5c0efcb08671f0af54a22fa64b5ffe19034a1ef31fe60fdc64edc28ff3858614` |
| 9 | `finance_approve` | `0163c024d5aa6af14f68c0f7e03fcdd4de823c260c88d3bf215806552ba6acdb` |
| 10 | **`pay_batch`** (USDC + XLM in one tx) | `427d543e6f52a98ab241c13b93504ed022c5a600bc8b96f182669ac3fb81ee79` |

Stellar Expert: `https://stellar.expert/explorer/testnet/tx/<HASH>`

## Verified properties

**D1 — multi-asset settlement.** `initialize_multi_sig_escrow` emitted exactly two
custody transfers, one per distinct asset (500000000 USDC, 100000000 native), not one
per payee. `pay_batch` emitted two payout transfers in a **single transaction**, each in
that payee's own asset.

Post-settlement balances:

| Account | USDC | XLM |
|---|---|---|
| Payee (USDC) | `500000000` ✅ | unchanged ✅ |
| Payee (XLM) | — | `+100000000` ✅ |
| Contract custody | `0` ✅ | `0` ✅ |

**D2 — oracle verification.** Both proofs were signed by `scripts/oracle-cli.mjs` and
accepted by on-chain `ed25519_verify`. Signatures were produced off-chain by the CLI and
submitted verbatim.

**D2 — replay protection.** Resubmitting the byte-identical nonce-0 signature that had
already succeeded was rejected with `Error(Contract, #9)` = `InvalidNonce`. The nonce
watermark stayed at 2.

**Double-settle guard.** A second `pay_batch` on the settled escrow was rejected with
`Error(Contract, #6)` = `PaymentAlreadyFinalized`.

## Known gaps

- **Dual-signer separation is NOT demonstrated by this run.** `manager` and
  `finance_approver` were the same address, so both approvals came from one key. A
  two-key escrow is still required before the demo video.
- **Oracle key rotation is not yet exercised on Testnet.** `rotate_oracle_key` is unit
  tested, but retired-key rejection cannot be unit tested (non-unwinding host trap) and
  still needs a Testnet run.
- Transaction count is 10 of the required ≥50.

## Build requirement

The contract **must** be built for `wasm32v1-none`. `wasm32-unknown-unknown` under
rustc 1.85 emits reference-types, and upload fails with
`Error(WasmVm, InvalidAction)` — `"reference-types not enabled"`.
`RUSTFLAGS="-C target-feature=-reference-types"` does not suppress it.

---

# Dual-Signer Separation & Key Rotation (contract v2)

Contract: `CCVIQZLSJIPSCFH2QGPKN5IOAA5ZQ4DOD4HLBZFMYKXPRAMCIOZGFJDF`
Manager: `GA7AQACFZIL5ZODZD63D22EPTPODL5JALAAW32QP7LO3MZL6BS3R2UBT`
Finance: `GBW2ETJF24JNCFYMUAPJYSNMCZWXLL4JH7XPZUUCXY3HRB2FILCMZ5HY` (separate key)

| # | Scenario | Result | Hash |
|---|---|---|---|
| 11 | Contract v2 deploy | ✅ | `a3055a1edb0f58a170b1c86b899c41c40bd81f67351e446fc0db2492afd7457c` |
| 12 | `init_admin` | ✅ | `01d8026eb747da20e9e567c1b2bdd40d78ec7d56effc0d93e86bde3e6208e25c` |
| — | **manager == finance rejected** | ❌ `#15 SignersNotDistinct` | simulation-rejected (never submitted) |
| 13 | Escrow 1, distinct signers | ✅ | `(in scenario B chain)` |
| 14 | `submit_hours_proof` p0 | ✅ | `702012a57cd0ecd3d423f3b6277657f6888b6b289d1db648cd3f58378e3574c0` |
| 15 | `submit_hours_proof` p1 | ✅ | `bc5219bde74147cd92376a253564036daea2b74cf2812a87deebf26099be876b` |
| 16 | `manager_approve` (manager key) | ✅ | `d9175407f2e3ae0e04e5dae8a1b544c3521e8d9cca06b16daae9a262cf2b781e` |
| — | **`pay_batch` with manager only** | ❌ `#5 InsufficientApprovals` | simulation-rejected |
| 17 | `finance_approve` (**finance key**) | ✅ | `0ce36e486bf06579073d44cbb92814ebce120811743570537346b4864fa40106` |
| 18 | **`pay_batch` both approvals** | ✅ settled | `8f992395a01053b8354343d5048be1988f5c0b0422dd91861a0318c5366b8a42` |
| 19 | Escrow 2 created | ✅ | `3931b3c1234f6e115aecb9d8967801ff6a1940ceebae6945ef44e9ca5a208583` |
| 20 | `rotate_oracle_key` | ✅ | `d227618af44bf7f440bbf2651d2114728675f539698197346457add9f38d9aa2` |
| — | **old-key signature after rotation** | ❌ `Error(Crypto, InvalidInput)` | simulation-rejected |
| 21 | new-key signature accepted | ✅ | `877dc8b5b0d66021f2f652724dc1dd50b3b7aae44db9dcfa0a4d7397d018ec82` |

## Proof of dual control

The same escrow, same payments, same oracle proofs:

- `pay_batch` **with the manager's approval alone** → `Error(Contract, #5)`, no funds moved.
- `pay_batch` **after a second, independent key** (`GBW2ETJF…`) approved → settled
  `500000000` USDC + `100000000` XLM, custody drained to `0` in both assets.

Payee balances rose from `500000000`/`100100000000` to `1000000000`/`100200000000`,
confirming the second batch settled.

## Proof of key rotation

`rotate_oracle_key` emitted `oracle/rotate (escrow 2, rotations 1)`. A signature from the
**retired** key was then rejected by the host with
`Error(Crypto, InvalidInput)` — `"failed host function call: verify_sig_ed25519"`.
The **new** key's signature over the identical message was accepted.

This closes the gap noted above: retired-key rejection cannot be unit tested (the trap is
non-unwinding and aborts the test process), so Testnet is the only place it is provable.
