# Demo Video Checklist — 3-5 min, unlisted

Record 1920x1080. Zoom terminal to ~16pt. Timestamp each section in the description.

## 0:00-0:20 — Setup shot
- [ ] Repo + branch `instawards/pay-batch-sac` on screen
- [ ] `cargo test` → **40 passed, 0 failed**
- [ ] `npx vitest run` → **79 passed**
- [ ] State: contract live on Testnet, ID visible

## 0:20-0:50 — CSV upload (Bulk Pay)
- [ ] `/bulk-pay` page
- [ ] Drag CSV: columns `address,amount,token`
- [ ] Show ≥3 rows, **mixed assets** (some USDC, some XLM) — this is the D1 differentiator
- [ ] Parsed table renders; row count + per-asset totals
- [ ] Show one **invalid row rejected** (bad address / missing trustline)
- [ ] Trustline pre-flight indicator per payee

## 0:50-1:40 — Dual signing (Freighter)
- [ ] Freighter connected as **manager**; show address
- [ ] Click Approve → Freighter popup → sign
- [ ] Status flips to `Awaiting finance approval`
- [ ] **Switch Freighter account to finance** — show the address changing on screen
- [ ] Click Approve → second popup → sign
- [ ] Status flips to `Ready to settle`
- [ ] Say explicitly: two distinct keys, neither can settle alone

## 1:40-2:10 — Oracle attestation
- [ ] `node scripts/oracle-cli.mjs pubkey`
- [ ] `node scripts/oracle-cli.mjs sign batch.json` → one signature **per payee**
- [ ] Point out sequential nonces
- [ ] Submit proofs; contract accepts
- [ ] **Replay:** resubmit the same signature → `Error(Contract, #9) InvalidNonce`

## 2:10-2:50 — pay_batch execution
- [ ] Trigger settlement from the dashboard
- [ ] Show emitted events: one `transfer` per payee, **different asset strings**
- [ ] `payment/final` event with total + count
- [ ] Real-time status → `Confirmed`
- [ ] Payee balances before/after, side by side
- [ ] **Custody drains to 0 in both assets**

## 2:50-3:30 — Negative cases (highest reviewer value)
- [ ] `pay_batch` with manager approval only → `Error(Contract, #5)`
- [ ] `manager == finance` at creation → `Error(Contract, #15)`
- [ ] `rotate_oracle_key`, then old-key signature → `Error(Crypto, InvalidInput)`
- [ ] New key's signature accepted immediately after
- [ ] Note these are **simulation-rejected**, so no on-chain hash exists — reviewers
      reproduce them by re-running the commands

## 3:30-4:10 — Testnet verification
- [ ] Open `stellar.expert/explorer/testnet/tx/8f992395a01053b8354343d5048be1988f5c0b0422dd91861a0318c5366b8a42`
- [ ] Expand the `pay_batch` operation; show both SAC transfers in ONE transaction
- [ ] Open the contract page; show accumulated invocations
- [ ] Scroll `docs/evidence/all_50_hashes.txt` → ≥50 hashes
- [ ] Open `docs/evidence/TESTNET_VALIDATION.md`

## 4:10-4:40 — Close
- [ ] Merged PR diff
- [ ] Green CI run (Rust + TypeScript jobs both passing)
- [ ] Restate: no single party can move funds; payouts gated on oracle proof

## Do not claim on camera
- [ ] Do **not** say "deployed to Mainnet" — this sprint is Testnet-only per SOW §4
- [ ] Do **not** call the 20 Mainnet users new adoption; they predate this sprint
- [ ] Do **not** imply Clockify/Jira integration exists
- [ ] Use the test USDC issuer's real name — it is **not** Circle USDC

## Pre-record
- [ ] `ORACLE_SECRET_KEY` never on screen (`pubkey` is fine, seed is not)
- [ ] No `-mainnet` identities visible in `stellar keys ls`
- [ ] Wallet shows Testnet
- [ ] Dashboard on HTTPS (`npm run dev`) — Freighter requires it
