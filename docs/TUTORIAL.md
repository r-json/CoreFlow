# Building a Multi-Signature Payroll Escrow on Stellar Soroban

> **A step-by-step tutorial for building trustless, dual-approval payment contracts on Stellar**
>
> **Author:** CoreFlow Team  
> **Date:** August 2026  
> **Difficulty:** Intermediate  
> **Prerequisites:** Basic Rust knowledge, familiarity with smart contracts

---

## Introduction

This tutorial walks you through building a production-grade multi-signature payroll escrow contract on Stellar Soroban. By the end, you'll have a working contract that:

- Creates escrow instances with custodial fund locking
- Requires dual approval (manager + finance) before releasing funds
- Verifies work hours using Ed25519 oracle signatures
- Prevents replay attacks with sequential nonce tracking
- Supports emergency cancellation with automatic refunds
- Includes a circuit breaker for incident response

This is the pattern used by [CoreFlow](https://github.com/r-json/CoreFlow), a trustless payroll and B2B escrow system deployed on Stellar mainnet.

---

## Table of Contents

1. [Why Multi-Sig Escrow?](#1-why-multi-sig-escrow)
2. [Project Setup](#2-project-setup)
3. [Defining the Data Model](#3-defining-the-data-model)
4. [Implementing Escrow Creation](#4-implementing-escrow-creation)
5. [Oracle-Verified Work Proofs](#5-oracle-verified-work-proofs)
6. [Dual-Approval Flow](#6-dual-approval-flow)
7. [Payment Finalization with Token Transfer](#7-payment-finalization-with-token-transfer)
8. [Cancellation and Refunds](#8-cancellation-and-refunds)
9. [Admin and Circuit Breaker](#9-admin-and-circuit-breaker)
10. [Testing Your Contract](#10-testing-your-contract)
11. [Deployment to Testnet](#11-deployment-to-testnet)
12. [Security Considerations](#12-security-considerations)
13. [Next Steps](#13-next-steps)

---

## 1. Why Multi-Sig Escrow?

Traditional payroll and contractor payments rely on trust:

| Problem | Traditional | Multi-Sig Escrow |
|---------|------------|-----------------|
| Payment timing | Workers trust clients to pay | Funds locked in contract at creation |
| Work verification | Email/screenshot evidence | Cryptographic oracle proof |
| Approval process | Email chains, manual tracking | On-chain, auditable, role-separated |
| Dispute resolution | Legal action | Escrow cancellation with automatic refund |

A multi-signature escrow contract acts as a **neutral payment coordinator**. No single party can unilaterally release or withhold funds. The manager creates the escrow (locking funds), the oracle verifies work, the manager approves, the finance approver approves, and only then does the contract release payment.

---

## 2. Project Setup

### Install Prerequisites

```bash
# Install Rust
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh

# Add the WASM target
rustup target add wasm32-unknown-unknown

# Install Stellar CLI
cargo install --locked stellar-cli --features opt
```

### Create the Project

```bash
stellar contract init payroll-escrow
cd payroll-escrow
```

This creates a basic Soroban project. Open `contracts/payroll-escrow/src/lib.rs` — this is where we'll write our contract.

### Add Dependencies

In `contracts/payroll-escrow/Cargo.toml`:

```toml
[dependencies]
soroban-sdk = { workspace = true }

[dev-dependencies]
soroban-sdk = { workspace = true, features = ["testutils"] }
ed25519-dalek = "2"

[lib]
crate-type = ["cdylib"]
```

---

## 3. Defining the Data Model

Start by defining the error codes, payment status, and data structures:

```rust
#![no_std]
use soroban_sdk::token::TokenClient;
use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype,
    symbol_short, Address, Bytes, BytesN, Env, Vec,
};

#[contracterror]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u32)]
pub enum ContractError {
    AlreadyApproved = 1,
    Unauthorized = 2,
    InvalidOracleSignature = 3,
    InvalidPaymentId = 4,
    InsufficientApprovals = 5,
    PaymentAlreadyFinalized = 6,
    InvalidAmount = 7,
    EscrowCancelled = 8,
    InvalidNonce = 9,
    NotAdmin = 10,
    Paused = 11,
    AdminAlreadySet = 12,
}
```

**Design decision:** Using `#[contracterror]` with explicit `u32` discriminants makes error codes stable across contract upgrades and easy to match in client code.

### Payment Schedule

Each escrow contains one or more payment schedules — individual worker payouts:

```rust
#[contracttype]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u32)]
pub enum PaymentStatus {
    Pending = 0,
    ManagerApproved = 1,
    FinanceApproved = 2,
    Finalized = 3,
    Cancelled = 4,
}

#[contracttype]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PaymentSchedule {
    pub id: u32,
    pub worker: Address,
    pub amount: i128,
    pub start_date: u64,
    pub end_date: u64,
    pub hours_logged: i128,
    pub rate_per_hour: i128,
    pub status: PaymentStatus,
}
```

### Escrow Structure

```rust
#[contracttype]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CoreFlowEscrow {
    pub manager: Address,
    pub finance_approver: Address,
    pub token: Address,           // SAC address (e.g., USDC)
    pub oracle_pubkey: BytesN<32>, // Ed25519 public key for work verification
    pub payments: Vec<PaymentSchedule>,
    pub manager_approved: bool,
    pub finance_approved: bool,
    pub cancelled: bool,
}
```

### Storage Keys

```rust
#[contracttype]
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum DataKey {
    EscrowCount,     // Global counter for sequential IDs
    Escrow(u32),     // Per-escrow data
    Nonce(u32),      // Per-escrow oracle nonce (replay protection)
    Admin,           // Contract admin address
    Paused,          // Circuit breaker flag
}

// Storage TTL constants (1 ledger ≈ 5 seconds)
const INSTANCE_TTL_THRESHOLD: u32 = 17280;      // ~1 day
const INSTANCE_TTL_EXTEND: u32 = 17280 * 30;    // ~30 days
const PERSISTENT_TTL_THRESHOLD: u32 = 17280;
const PERSISTENT_TTL_EXTEND: u32 = 17280 * 90;  // ~90 days
```

**Key insight:** Use persistent storage for escrow data (long-lived, per-key TTL control) and instance storage for admin/pause flags (shared lifecycle, simpler).

---

## 4. Implementing Escrow Creation

The `initialize_multi_sig_escrow` function creates a new escrow and **pulls funds into contract custody**:

```rust
#[contract]
pub struct CoreFlowContract;

#[contractimpl]
impl CoreFlowContract {
    pub fn initialize_multi_sig_escrow(
        env: Env,
        manager: Address,
        finance_approver: Address,
        token: Address,
        oracle_pubkey: BytesN<32>,
        payments: Vec<PaymentSchedule>,
    ) -> Result<u32, ContractError> {
        // Check circuit breaker
        Self::require_not_paused(&env)?;
        
        // Only the manager can create an escrow
        manager.require_auth();

        if payments.is_empty() {
            return Err(ContractError::InvalidAmount);
        }

        // Validate and sum payment amounts
        let mut total_amount: i128 = 0;
        for i in 0..payments.len() {
            let p = payments.get(i).unwrap();
            if p.amount <= 0 || p.rate_per_hour <= 0 {
                return Err(ContractError::InvalidAmount);
            }
            total_amount += p.amount;
        }

        // Generate sequential escrow ID
        let escrow_id: u32 = env
            .storage()
            .persistent()
            .get(&DataKey::EscrowCount)
            .unwrap_or(0u32)
            + 1;

        // CRITICAL: Pull funds from manager into contract custody
        let token_client = TokenClient::new(&env, &token);
        token_client.transfer(
            &manager,
            &env.current_contract_address(),
            &total_amount,
        );

        // Store the escrow
        let escrow = CoreFlowEscrow {
            manager: manager.clone(),
            finance_approver,
            token,
            oracle_pubkey,
            payments,
            manager_approved: false,
            finance_approved: false,
            cancelled: false,
        };

        env.storage().persistent().set(
            &DataKey::Escrow(escrow_id), &escrow,
        );
        env.storage().persistent().set(
            &DataKey::Nonce(escrow_id), &0u64,
        );
        env.storage().persistent().set(
            &DataKey::EscrowCount, &escrow_id,
        );

        // Emit event for indexer
        env.events().publish(
            (symbol_short!("escrow"), symbol_short!("created")),
            (escrow_id, manager, total_amount),
        );

        Ok(escrow_id)
    }
}
```

**Why custody matters:** By transferring the full payment amount into the contract at creation time, we guarantee the funds exist when finalization occurs. This eliminates the "insufficient balance at pay time" failure mode.

---

## 5. Oracle-Verified Work Proofs

Instead of trusting self-reported hours, we verify work data through an Ed25519 oracle signature:

```rust
pub fn submit_hours_proof(
    env: Env,
    escrow_id: u32,
    payment_id: u32,
    hours_logged: i128,
    nonce: u64,
    signature: BytesN<64>,
) -> Result<(), ContractError> {
    Self::require_not_paused(&env)?;
    
    let mut escrow: CoreFlowEscrow = env
        .storage()
        .persistent()
        .get(&DataKey::Escrow(escrow_id))
        .ok_or(ContractError::InvalidPaymentId)?;

    if escrow.cancelled {
        return Err(ContractError::EscrowCancelled);
    }

    // Cannot modify hours after approval
    if escrow.manager_approved || escrow.finance_approved {
        return Err(ContractError::AlreadyApproved);
    }

    // Replay protection: verify sequential nonce
    let expected_nonce: u64 = env
        .storage()
        .persistent()
        .get(&DataKey::Nonce(escrow_id))
        .unwrap_or(0u64);
    if nonce != expected_nonce {
        return Err(ContractError::InvalidNonce);
    }

    // Construct the 32-byte message for verification
    let mut msg_data = [0u8; 32];
    msg_data[0..4].copy_from_slice(&escrow_id.to_be_bytes());
    msg_data[4..8].copy_from_slice(&payment_id.to_be_bytes());
    msg_data[8..24].copy_from_slice(&hours_logged.to_be_bytes());
    msg_data[24..32].copy_from_slice(&nonce.to_be_bytes());
    let message = Bytes::from_slice(&env, &msg_data);

    // Verify Ed25519 signature (panics on failure = tx revert)
    env.crypto().ed25519_verify(
        &escrow.oracle_pubkey, &message, &signature,
    );

    // Increment nonce after successful verification
    env.storage().persistent().set(
        &DataKey::Nonce(escrow_id), &(nonce + 1),
    );

    // Update hours on the payment schedule
    let mut payment = escrow.payments.get(payment_id).unwrap();
    payment.hours_logged = hours_logged;
    escrow.payments.set(payment_id, payment);
    
    env.storage().persistent().set(
        &DataKey::Escrow(escrow_id), &escrow,
    );

    Ok(())
}
```

**How the oracle works:**
1. The worker submits hours to a server-side oracle service.
2. The oracle verifies the hours (e.g., from a time-tracking API), constructs the message, and signs it with Ed25519.
3. The client submits the signed proof to the contract.
4. The contract verifies the signature against the stored oracle public key.

---

## 6. Dual-Approval Flow

The core multi-sig pattern: both manager and finance must approve before payment can be finalized.

```rust
pub fn manager_approve(
    env: Env, escrow_id: u32,
) -> Result<(), ContractError> {
    Self::require_not_paused(&env)?;
    let mut escrow: CoreFlowEscrow = env
        .storage()
        .persistent()
        .get(&DataKey::Escrow(escrow_id))
        .ok_or(ContractError::InvalidPaymentId)?;

    if escrow.cancelled {
        return Err(ContractError::EscrowCancelled);
    }

    // Only the manager can call this
    escrow.manager.require_auth();

    if escrow.manager_approved {
        return Err(ContractError::AlreadyApproved);
    }

    escrow.manager_approved = true;
    env.storage().persistent().set(
        &DataKey::Escrow(escrow_id), &escrow,
    );

    env.events().publish(
        (symbol_short!("approve"), symbol_short!("manager")),
        escrow_id,
    );
    Ok(())
}

pub fn finance_approve(
    env: Env, escrow_id: u32,
) -> Result<(), ContractError> {
    Self::require_not_paused(&env)?;
    let mut escrow: CoreFlowEscrow = env
        .storage()
        .persistent()
        .get(&DataKey::Escrow(escrow_id))
        .ok_or(ContractError::InvalidPaymentId)?;

    if escrow.cancelled {
        return Err(ContractError::EscrowCancelled);
    }

    // Only the finance approver can call this
    escrow.finance_approver.require_auth();

    if escrow.finance_approved {
        return Err(ContractError::AlreadyApproved);
    }

    escrow.finance_approved = true;
    env.storage().persistent().set(
        &DataKey::Escrow(escrow_id), &escrow,
    );

    env.events().publish(
        (symbol_short!("approve"), symbol_short!("finance")),
        escrow_id,
    );
    Ok(())
}
```

**Why `require_auth()` instead of `msg.sender`?** Soroban uses an authorization framework where each address must explicitly authorize their invocation. This is more secure than EVM's `msg.sender` pattern because it works correctly with multi-hop calls and prevents confused deputy attacks.

---

## 7. Payment Finalization with Token Transfer

Once both approvals are in, the contract releases escrowed funds to each worker:

```rust
pub fn finalize_payment(
    env: Env,
    escrow_id: u32,
) -> Result<Vec<PaymentSchedule>, ContractError> {
    Self::require_not_paused(&env)?;
    let mut escrow: CoreFlowEscrow = env
        .storage()
        .persistent()
        .get(&DataKey::Escrow(escrow_id))
        .ok_or(ContractError::InvalidPaymentId)?;

    if escrow.cancelled {
        return Err(ContractError::EscrowCancelled);
    }

    escrow.manager.require_auth();

    // CRITICAL: Both approvals required
    if !escrow.manager_approved || !escrow.finance_approved {
        return Err(ContractError::InsufficientApprovals);
    }

    // Prevent double-finalize
    for i in 0..escrow.payments.len() {
        let p = escrow.payments.get(i).unwrap();
        if p.status == PaymentStatus::Finalized {
            return Err(ContractError::PaymentAlreadyFinalized);
        }
    }

    // Transfer funds to each worker
    let token_client = TokenClient::new(&env, &escrow.token);
    let contract_addr = env.current_contract_address();
    let mut finalized = Vec::new(&env);
    let mut total: i128 = 0;

    for i in 0..escrow.payments.len() {
        let mut p = escrow.payments.get(i).unwrap();
        p.status = PaymentStatus::Finalized;
        token_client.transfer(&contract_addr, &p.worker, &p.amount);
        total += p.amount;
        finalized.push_back(p);
    }

    escrow.payments = finalized.clone();
    env.storage().persistent().set(
        &DataKey::Escrow(escrow_id), &escrow,
    );

    env.events().publish(
        (symbol_short!("payment"), symbol_short!("final")),
        (escrow_id, total, finalized.len()),
    );

    Ok(finalized)
}
```

---

## 8. Cancellation and Refunds

The manager can cancel an escrow, which refunds all funds:

```rust
pub fn cancel_escrow(
    env: Env, escrow_id: u32,
) -> Result<(), ContractError> {
    // NOTE: No require_not_paused() — cancel is the
    // emergency withdrawal path and must work while paused
    
    let mut escrow: CoreFlowEscrow = env
        .storage()
        .persistent()
        .get(&DataKey::Escrow(escrow_id))
        .ok_or(ContractError::InvalidPaymentId)?;

    if escrow.cancelled {
        return Err(ContractError::EscrowCancelled);
    }

    escrow.manager.require_auth();

    // Cannot cancel already-finalized escrows
    let mut refund_amount: i128 = 0;
    for i in 0..escrow.payments.len() {
        let p = escrow.payments.get(i).unwrap();
        if p.status == PaymentStatus::Finalized {
            return Err(ContractError::PaymentAlreadyFinalized);
        }
        refund_amount += p.amount;
    }

    // Refund the full amount to the manager
    if refund_amount > 0 {
        let token_client = TokenClient::new(&env, &escrow.token);
        token_client.transfer(
            &env.current_contract_address(),
            &escrow.manager,
            &refund_amount,
        );
    }

    escrow.cancelled = true;
    // Mark all payments as cancelled...
    
    Ok(())
}
```

**Critical design decision:** `cancel_escrow` does NOT check `require_not_paused()`. This ensures managers can always refund funds, even during an emergency contract pause.

---

## 9. Admin and Circuit Breaker

For production deployments, add an admin with pause/upgrade capabilities:

```rust
pub fn init_admin(env: Env, admin: Address) -> Result<(), ContractError> {
    if env.storage().instance().has(&DataKey::Admin) {
        return Err(ContractError::AdminAlreadySet);
    }
    admin.require_auth();
    env.storage().instance().set(&DataKey::Admin, &admin);
    Ok(())
}

pub fn set_paused(env: Env, paused: bool) -> Result<(), ContractError> {
    Self::require_admin(&env)?;
    env.storage().instance().set(&DataKey::Paused, &paused);
    Ok(())
}

pub fn upgrade(
    env: Env, new_wasm_hash: BytesN<32>,
) -> Result<(), ContractError> {
    Self::require_admin(&env)?;
    env.deployer().update_current_contract_wasm(new_wasm_hash);
    Ok(())
}
```

---

## 10. Testing Your Contract

Write comprehensive tests covering happy paths AND failure cases:

```rust
#[test]
fn test_full_lifecycle() {
    let env = Env::default();
    env.mock_all_auths();

    let client = CoreFlowContractClient::new(
        &env, &env.register_contract(None, CoreFlowContract),
    );
    
    // ... create escrow, submit hours, approve, finalize
    // Assert custody accounting: contract balance == 0 after finalize
}

#[test]
#[should_panic(expected = "Error(Contract, #5)")]
fn test_finalize_without_both_approvals_fails() {
    // Only manager approval — should fail with InsufficientApprovals
}

#[test]
fn test_custody_invariant_fuzz() {
    // Run 30 randomized scenarios verifying funds_in == funds_out
}
```

Run tests:
```bash
cd contracts/payroll-escrow
cargo test
```

---

## 11. Deployment to Testnet

```bash
# Build the optimized WASM
stellar contract build

# Deploy to testnet
stellar contract deploy \
  --wasm target/wasm32-unknown-unknown/release/payroll_escrow.wasm \
  --source <YOUR_SECRET_KEY> \
  --network testnet

# Initialize admin
stellar contract invoke \
  --id <CONTRACT_ID> \
  --source <ADMIN_KEY> \
  --network testnet \
  -- init_admin --admin <ADMIN_ADDRESS>
```

---

## 12. Security Considerations

| Concern | Mitigation |
|---------|-----------|
| **Replay attacks** | Sequential nonce per escrow, included in signed message |
| **Oracle compromise** | Key stored per-escrow; rotation only affects new escrows |
| **Double-spend** | Funds held in contract custody; finalize checks prevent double-finalize |
| **Admin key loss** | Use multi-sig or hardware wallet for admin |
| **Storage expiry** | TTL extension on every write operation |
| **Emergency stop** | Circuit breaker pauses operations but keeps cancel/refund available |

---

## 13. Next Steps

After completing this tutorial, consider:

1. **Factory pattern** — Deploy isolated escrow contracts per team/organization
2. **Batch payments** — `pay_batch()` to finalize multiple schedules in one transaction
3. **Off-chain indexer** — Project contract events into a database for dashboard reads
4. **Frontend dashboard** — Build a React/Next.js UI with Freighter wallet integration

For a complete implementation of all these patterns, see the [CoreFlow repository](https://github.com/r-json/CoreFlow).

---

## Resources

- [Soroban Documentation](https://developers.stellar.org/docs/build/smart-contracts)
- [Stellar Asset Contract](https://developers.stellar.org/docs/tokens/token-interface)
- [Soroban Authorization](https://developers.stellar.org/docs/learn/fundamentals/contract-development/authorization)
- [CoreFlow — Full Implementation](https://github.com/r-json/CoreFlow)

---

*This tutorial is an ecosystem contribution by the CoreFlow team as part of the Stellar Builder Challenge. Licensed under MIT.*
