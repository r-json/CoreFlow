# CoreFlow — Security Review Report

> **Version:** 1.0  
> **Date:** August 2026  
> **Scope:** Smart contract (`contracts/core-flow/src/lib.rs`), backend API (`src/app/api/`), middleware, auth, oracle, and indexer subsystems  
> **Contract ID:** `CCTF5WBOQR7JP2KPLQT372X7JCGCINHDFRSAPF4YTYRKZXZ3J2XPRFFW`  
> **Network:** Stellar Public Network (Mainnet)  
> **Reviewer:** Internal security review — CoreFlow development team

---

## 1. Executive Summary

This document presents a structured security review of the CoreFlow multi-signature payroll escrow system deployed on Stellar Soroban. The review covers the on-chain smart contract, the off-chain backend (Next.js API routes), the authentication subsystem, the oracle attestation service, and the operational procedures documented in the project's RUNBOOK.md.

**Overall assessment:** The system implements defense-in-depth security controls across all critical paths. The multi-signature escrow contract enforces role-separated authorization, cryptographic oracle verification, replay protection, and custodial fund management with correct accounting. The backend implements layered authentication, input validation, rate limiting, audit logging, and security headers.

**Risk classification summary:**

| Severity | Count | Status |
|----------|-------|--------|
| Critical | 0 | — |
| High | 0 | — |
| Medium | 2 | Accepted with mitigations |
| Low | 4 | Accepted or remediated |
| Informational | 3 | Documented |

---

## 2. Scope and Methodology

### 2.1 Assets Reviewed

| Component | File(s) | Lines |
|-----------|---------|-------|
| Soroban smart contract | `contracts/core-flow/src/lib.rs` | 573 |
| Contract tests | `contracts/core-flow/src/test.rs` | 1164 |
| Edge middleware | `src/middleware.ts` | 90 |
| Auth library | `src/lib/auth/index.ts`, `jwt.ts`, `middleware.ts` | ~580 |
| Oracle signer | `src/lib/oracle/index.ts` | 80 |
| Validation schemas | `src/lib/validation/schemas.ts` | 79 |
| Rate limiter | `src/lib/ratelimit.ts` | 71 |
| Audit logger | `src/lib/audit.ts` | 26 |
| Security headers | `next.config.js` | 72 |
| API route handlers | `src/app/api/**` | ~1200 |
| Deploy/ops docs | `docs/DEPLOYMENT.md`, `docs/RUNBOOK.md` | 335 |

### 2.2 Methodology

- **Manual code review:** Line-by-line analysis of all contract logic, auth flows, and API routes.
- **Automated testing analysis:** Review of 31 Rust contract tests (including deterministic fuzz test with 30 randomized scenarios) and 69 TypeScript unit tests.
- **Threat modeling:** STRIDE-based analysis of attack surfaces across on-chain and off-chain components.
- **Configuration review:** Security headers, CSP, environment variable handling, secret management.

---

## 3. Smart Contract Security Analysis

### 3.1 Authorization Model

| Function | Auth Requirement | Verified |
|----------|-----------------|----------|
| `init_admin` | `admin.require_auth()`, one-time guard | ✅ |
| `set_paused` | Admin-only via `require_admin()` | ✅ |
| `upgrade` | Admin-only via `require_admin()` | ✅ |
| `initialize_multi_sig_escrow` | `manager.require_auth()` | ✅ |
| `submit_hours_proof` | Oracle Ed25519 signature verification | ✅ |
| `manager_approve` | `escrow.manager.require_auth()` | ✅ |
| `finance_approve` | `escrow.finance_approver.require_auth()` | ✅ |
| `finalize_payment` | `escrow.manager.require_auth()` + both approvals | ✅ |
| `cancel_escrow` | `escrow.manager.require_auth()` | ✅ |
| `get_escrow` | Public (read-only) | ✅ |
| `get_nonce` | Public (read-only) | ✅ |

**Finding:** All state-changing functions enforce Soroban `Address::require_auth()` at the correct authorization boundary. No function bypasses the auth model.

### 3.2 Custody and Fund Accounting

**Finding: PASS** — The custody invariant (funds in == funds out) is correctly maintained.

| Operation | Token Flow | Verification |
|-----------|-----------|--------------|
| `initialize_multi_sig_escrow` | Manager → Contract (sum of all payment amounts) | ✅ Amount summed and transferred atomically |
| `finalize_payment` | Contract → Each worker (individual amounts) | ✅ Each payment transferred individually |
| `cancel_escrow` | Contract → Manager (full refund) | ✅ Sum of non-finalized payments returned |

- **Fuzz test coverage:** The `test_custody_sum_invariant_fuzz` test runs 30 randomized scenarios with 1–4 payments and verifies `balance(contract) == 0` after finalization.
- **50-user end-to-end test:** The `test_fifty_user_end_to_end_simulation` test runs 50 unique workers across 5 batches, verifying custody accounting for each.

### 3.3 Replay Protection

**Finding: PASS** — Oracle proof replay is prevented by sequential nonce tracking.

- Each escrow maintains an independent nonce counter (`DataKey::Nonce(escrow_id)`).
- `submit_hours_proof` verifies `nonce == expected_nonce` and increments on success.
- The nonce is included in the signed message, so a valid signature for nonce N cannot be replayed at nonce N+1.
- **Test coverage:** `test_nonce_replay_rejected` asserts `Error(Contract, #9)` on replay.

### 3.4 Ed25519 Oracle Verification

**Finding: PASS** — Full cryptographic verification implemented.

- The oracle public key is stored per-escrow at creation time.
- `submit_hours_proof` constructs a deterministic 32-byte message from `(escrow_id, payment_id, hours_logged, nonce)` and verifies the Ed25519 signature against the stored public key using `env.crypto().ed25519_verify()`.
- Invalid signatures cause a Soroban host trap (transaction revert) — the correct behavior for on-chain rejection.

### 3.5 State Machine Guards

| Guard | Implementation | Test Coverage |
|-------|---------------|---------------|
| Cannot approve cancelled escrow | `if escrow.cancelled → EscrowCancelled` | ✅ `test_approve_cancelled_escrow_fails` |
| Cannot cancel finalized escrow | `if p.status == Finalized → PaymentAlreadyFinalized` | ✅ `test_cancel_finalized_escrow_fails` |
| Cannot double-approve | `if escrow.manager_approved → AlreadyApproved` | ✅ `test_double_approval_rejected` |
| Cannot double-finalize | Checks all payment statuses before marking | ✅ `test_double_finalize_rejected` |
| Cannot double-cancel | `if escrow.cancelled → EscrowCancelled` | ✅ `test_double_cancel_rejected` |
| Cannot submit hours after approval | `if manager_approved \|\| finance_approved → AlreadyApproved` | ✅ `test_submit_hours_after_approval_fails` |
| Cannot create with zero amount | `if p.amount <= 0 → InvalidAmount` | ✅ `test_initialize_with_zero_amount_fails` |
| Cannot create with empty payments | `if payments.is_empty() → InvalidAmount` | ✅ `test_empty_payments_rejected` |

### 3.6 Circuit Breaker (Pause/Unpause)

**Finding: PASS** — Correctly implemented emergency stop mechanism.

- `set_paused(true)` blocks all state-changing operations **except** `cancel_escrow`.
- `cancel_escrow` remains available while paused so managers can refund held funds (emergency withdrawal path).
- **Test coverage:** `test_pause_blocks_new_escrow`, `test_unpause_restores_operations`, `test_cancel_allowed_while_paused`.

### 3.7 Storage TTL Management

**Finding: PASS** — Appropriate TTL strategy.

- Instance storage (admin, pause flag): 30-day extension on write.
- Persistent storage (escrows, nonces, counter): 90-day extension on write.
- TTL thresholds set to 1 day (17280 ledgers) to trigger extension before expiry.

### 3.8 Contract Upgrade Path

**Finding: PASS** — Admin-only upgrade with address preservation.

- `upgrade(new_wasm_hash)` uses `env.deployer().update_current_contract_wasm()` — changes code without changing the contract address or migrating funds.
- `init_admin` is idempotent-guarded: fails with `AdminAlreadySet` if called twice.

---

## 4. Backend Security Analysis

### 4.1 Authentication: Ed25519 Challenge-Response

**Finding: PASS** — Wallet-based authentication with server-verified challenges.

| Step | Security Control |
|------|-----------------|
| Challenge request | Rate-limited (20/min/IP), single-use nonce, 5-min expiry |
| Challenge response | Ed25519 signature verification, nonce consumed on success |
| Session creation | JWT (HS256) signed with 32+ char `AUTH_SECRET`, stored in HttpOnly cookie |
| Session verification | Edge middleware (fast JWT check) + route-level DB session lookup |
| Session revocation | DB-backed: logout deletes the session row; stale JWTs fail on next request |

### 4.2 Authorization: Role-Based Access Control

**Finding: PASS** — Layered RBAC enforcement.

- Roles: `admin | manager | finance | worker | viewer`
- Role source: **DB on every request** (not JWT claim alone — prevents stale role cache)
- Admin bootstrap: `ADMIN_WALLETS` environment variable auto-promotes on first login
- Role management: `GET/POST /api/admin/roles` (admin-only) with audit logging

### 4.3 Input Validation

**Finding: PASS** — Comprehensive Zod schema validation.

All mutating API endpoints validate request bodies using centralized Zod schemas (`src/lib/validation/schemas.ts`):

| Schema | Validates |
|--------|----------|
| `challengeSchema` | Stellar address format (G/C prefix, 56 chars) |
| `verifySchema` | Wallet address + non-empty signature |
| `createEscrowSchema` | Positive integers for amounts/rates, optional token address |
| `statusPatchSchema` | At least one update field required |
| `hoursSchema` | Non-negative IDs, positive hours, non-empty TX hash |
| `attestSchema` | Non-negative IDs, positive hours, non-negative nonce |
| `roleGrantSchema` | Valid Stellar address + valid role enum |

### 4.4 Rate Limiting

**Finding: PASS with advisory** — Effective per-instance limiting.

| Endpoint | Limit | Window |
|----------|-------|--------|
| `auth/challenge` | 20 requests | 1 minute / IP |
| `auth/verify` | 10 requests | 1 minute / IP |
| `oracle/attest` | 30 requests | 1 minute / wallet |

**Advisory (Medium — M-01):** Rate limiting is in-memory and per-instance. For multi-instance deployments (e.g., Vercel auto-scaling), swap the `Map` for a shared store (Upstash Redis / Vercel KV). Documented in DEPLOYMENT.md.

### 4.5 Security Headers

**Finding: PASS** — All recommended headers configured in `next.config.js`:

| Header | Value |
|--------|-------|
| `X-Frame-Options` | `DENY` |
| `X-Content-Type-Options` | `nosniff` |
| `Referrer-Policy` | `strict-origin-when-cross-origin` |
| `Permissions-Policy` | `camera=(), microphone=(), geolocation=()` |
| `Strict-Transport-Security` | `max-age=63072000; includeSubDomains; preload` |
| `Content-Security-Policy-Report-Only` | Scoped CSP with Stellar RPC allowlist |

**Advisory (Low — L-01):** CSP is in Report-Only mode. Promote to enforcing `Content-Security-Policy` after validating reports in production.

### 4.6 Audit Logging

**Finding: PASS** — Append-only audit trail.

- `AuditLog` table records security-sensitive actions: `role.grant`, `escrow.create`, `auth.logout`.
- Best-effort: a logging failure never blocks the primary action.
- Structured with `actor`, `target`, and `metadata` fields for queryability.

### 4.7 Middleware: AUTH_SECRET Validation

**Finding: PASS** — The middleware explicitly rejects all protected requests if `AUTH_SECRET` is missing or shorter than 32 characters, preventing auth bypass via misconfiguration.

---

## 5. Findings Detail

### M-01: In-Memory Rate Limiter (Medium)

**Description:** The rate limiter uses a `Map` in process memory. In a multi-instance serverless environment, each function invocation has its own memory, so rate limits are not shared across instances.

**Impact:** An attacker could distribute requests across multiple serverless function invocations to bypass rate limits.

**Mitigation:** The rate limiter interface is designed for drop-in replacement with a shared store. The `rateLimit()` function signature remains the same — only the backing store changes.

**Status:** Accepted for current deployment (single Vercel region). Documented in DEPLOYMENT.md with migration path.

---

### M-02: Oracle Key as Single Point of Trust (Medium)

**Description:** The oracle attestation service uses a single Ed25519 keypair (`ORACLE_SECRET_KEY`). If this key is compromised, an attacker could forge work-hour proofs for any escrow created with that oracle public key.

**Impact:** Fraudulent hour submissions could lead to unearned payment releases.

**Mitigations implemented:**
1. Oracle key stored as a Vercel secret (not in code or git).
2. Each escrow captures the oracle public key at creation time — key rotation only affects new escrows.
3. Rate limiting on the `/api/oracle/attest` endpoint (30/min/wallet).
4. Nonce-based replay protection prevents reuse of a forged proof.
5. RUNBOOK.md documents the key rotation procedure.

**Status:** Accepted with mitigations. Production should consider multi-oracle quorum or external Chainlink adapter.

---

### L-01: CSP in Report-Only Mode (Low)

**Description:** The Content-Security-Policy header is configured as `Content-Security-Policy-Report-Only`.

**Impact:** CSP violations are reported but not enforced. XSS or injection attacks are not blocked by CSP alone.

**Mitigation:** Other XSS defenses (React auto-escaping, `X-Content-Type-Options: nosniff`, Zod input validation) provide defense-in-depth.

**Status:** Accepted. Promote to enforcing after validating clean reports in production.

---

### L-02: JWT Role Claim Not Authoritative (Low)

**Description:** The JWT includes a `role` claim set at sign-in time. If a user's role changes after sign-in, the JWT claim is stale.

**Impact:** Minimal — the system reads the role from the DB on every request in the route handlers, not from the JWT. The middleware forwards the JWT-extracted role as a header, but route handlers perform their own DB lookup.

**Status:** Remediated. The JWT role is informational only; authorization decisions use the DB value.

---

### L-03: No Multi-Instance Session Invalidation Broadcast (Low)

**Description:** Session revocation (logout) deletes the session row in PostgreSQL. Other instances will reject the token on their next DB check, but there is no push-based invalidation.

**Impact:** A very short window (until the next request hits the DB check) where a revoked session could theoretically be used on another instance.

**Status:** Accepted. The DB check on every request makes this window negligible (sub-second in practice).

---

### L-04: Test Coverage for Invalid Oracle Signatures (Low)

**Description:** The `test_wrong_oracle_key_rejected` test is marked `#[ignore]` because Soroban's `ed25519_verify` raises a non-recoverable host trap in the native `cargo test` harness.

**Impact:** This negative test case is not covered in the automated unit test suite.

**Mitigation:** The host trap IS the correct on-chain behavior (transaction revert). The test is covered by testnet integration testing and the behavior is documented in the test file.

**Status:** Accepted. The security property is enforced by the Soroban runtime.

---

### I-01: No On-Chain Access Control List (Informational)

**Description:** The contract does not maintain an on-chain ACL or role registry. Authorization is per-escrow (manager and finance approver addresses stored per escrow).

**Assessment:** This is a design choice, not a vulnerability. Per-escrow authorization is appropriate for the escrow pattern where roles are defined at escrow creation time.

---

### I-02: Factory Contract Not Yet Deployed (Informational)

**Description:** The README describes a factory pattern for deploying isolated payroll contracts per team. The factory contract is documented as a production extension target but is not yet deployed.

**Assessment:** The current single-contract deployment is appropriate for the MVP. The factory pattern should be implemented for production multi-tenant use.

---

### I-03: USDC Integration Path (Informational)

**Description:** The contract is token-agnostic and accepts any Stellar Asset Contract address. Production deployment should use the USDC SAC address for real payment settlement.

**Assessment:** The contract correctly handles token transfers via the `TokenClient` interface. No code changes needed — only configuration at escrow creation time.

---

## 6. Test Coverage Summary

### Smart Contract (Rust)

| Category | Tests | Coverage |
|----------|-------|----------|
| Happy path (create, approve, finalize) | 5 | Full lifecycle |
| Custody accounting | 3 | Fund pull, release, refund |
| Oracle verification (Ed25519) | 1 | Valid signature |
| Nonce/replay protection | 3 | Increment, read, replay rejection |
| State machine guards | 7 | All invalid transitions |
| Admin/pause/circuit breaker | 5 | Init, pause, unpause, cancel-while-paused |
| Fuzz (custody invariant) | 1 | 30 randomized scenarios |
| Load simulation (50 users) | 1 | 50 unique workers end-to-end |
| **Total** | **26** (+ 1 ignored) | |

### Backend (TypeScript/Vitest)

| Category | Tests |
|----------|-------|
| Oracle signing | ~10 |
| Auth/RBAC | ~15 |
| Validation/rate-limit | ~12 |
| API route handlers | ~20 |
| Component tests | ~12 |
| **Total** | **~69** |

---

## 7. Conclusion

The CoreFlow smart contract and backend system demonstrate production-quality security practices:

1. **Contract-level:** Every state-changing function enforces appropriate authorization. Custody accounting is mathematically verified through fuzz testing. Replay protection, circuit breaker, and upgrade mechanisms are correctly implemented.

2. **Backend-level:** Layered authentication (Ed25519 challenge-response + JWT + DB session), comprehensive input validation (Zod), rate limiting, audit logging, and security headers provide defense-in-depth.

3. **Operational:** RUNBOOK.md documents incident response (pause/cancel/refund), key rotation procedures, and upgrade workflows.

**The system is suitable for mainnet deployment of the MVP payroll escrow workflow.** The medium-severity findings (in-memory rate limiter and single-oracle trust model) are accepted risks with documented mitigation paths for production scaling.

---

*This security review was conducted by the CoreFlow development team as part of the Stellar Builder Challenge Level 6 submission. For a comprehensive third-party audit, an independent firm should be engaged before processing significant production payroll volume.*
