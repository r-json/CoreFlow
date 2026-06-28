#![no_std]
use soroban_sdk::token::TokenClient;
use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, symbol_short, Address, Bytes, BytesN, Env,
    Vec,
};

// ========== ENUMS & ERRORS ==========

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

// ========== STRUCTS ==========

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

#[contracttype]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CoreFlowEscrow {
    pub manager: Address,
    pub finance_approver: Address,
    /// Stellar Asset Contract (SAC) address used for custody/settlement (e.g. USDC).
    pub token: Address,
    pub oracle_pubkey: BytesN<32>,
    pub payments: Vec<PaymentSchedule>,
    pub manager_approved: bool,
    pub finance_approved: bool,
    pub cancelled: bool,
}

// ========== STORAGE KEYS ==========

#[contracttype]
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum DataKey {
    EscrowCount,
    Escrow(u32),
    Nonce(u32),
    Admin,
    Paused,
}

// Storage TTL constants (in ledgers)
// ~1 ledger ≈ 5 seconds; 17280 ledgers ≈ 1 day
const INSTANCE_TTL_THRESHOLD: u32 = 17280; // Extend when below 1 day
const INSTANCE_TTL_EXTEND: u32 = 17280 * 30; // Extend to 30 days
const PERSISTENT_TTL_THRESHOLD: u32 = 17280; // Extend when below 1 day
const PERSISTENT_TTL_EXTEND: u32 = 17280 * 90; // Extend to 90 days

// ========== CONTRACT ==========

#[contract]
pub struct CoreFlowContract;

#[contractimpl]
impl CoreFlowContract {
    // ===== Admin / circuit breaker / upgrade =====

    /// Set the contract admin once, immediately after deploy. Idempotent-guard:
    /// fails if an admin is already configured. If never called, the contract
    /// simply has no admin and can never be paused or upgraded.
    pub fn init_admin(env: Env, admin: Address) -> Result<(), ContractError> {
        if env.storage().instance().has(&DataKey::Admin) {
            return Err(ContractError::AdminAlreadySet);
        }
        admin.require_auth();
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage()
            .instance()
            .extend_ttl(INSTANCE_TTL_THRESHOLD, INSTANCE_TTL_EXTEND);
        Ok(())
    }

    /// Pause or unpause state-changing operations (admin only). `cancel_escrow`
    /// stays available while paused so funds can always be refunded.
    pub fn set_paused(env: Env, paused: bool) -> Result<(), ContractError> {
        Self::require_admin(&env)?;
        env.storage().instance().set(&DataKey::Paused, &paused);
        env.storage()
            .instance()
            .extend_ttl(INSTANCE_TTL_THRESHOLD, INSTANCE_TTL_EXTEND);
        env.events()
            .publish((symbol_short!("admin"), symbol_short!("paused")), paused);
        Ok(())
    }

    pub fn is_paused(env: Env) -> bool {
        env.storage()
            .instance()
            .get(&DataKey::Paused)
            .unwrap_or(false)
    }

    /// Upgrade the contract WASM (admin only). Enables fixes without changing
    /// the contract address or migrating escrow funds.
    pub fn upgrade(env: Env, new_wasm_hash: BytesN<32>) -> Result<(), ContractError> {
        Self::require_admin(&env)?;
        env.deployer().update_current_contract_wasm(new_wasm_hash);
        Ok(())
    }

    fn require_admin(env: &Env) -> Result<Address, ContractError> {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(ContractError::NotAdmin)?;
        admin.require_auth();
        Ok(admin)
    }

    fn require_not_paused(env: &Env) -> Result<(), ContractError> {
        if env
            .storage()
            .instance()
            .get(&DataKey::Paused)
            .unwrap_or(false)
        {
            return Err(ContractError::Paused);
        }
        Ok(())
    }

    /// Initialize a multi-signature escrow with payment schedules and oracle public key.
    /// The oracle_pubkey is an Ed25519 public key used to verify work proof signatures.
    pub fn initialize_multi_sig_escrow(
        env: Env,
        manager: Address,
        finance_approver: Address,
        token: Address,
        oracle_pubkey: BytesN<32>,
        payments: Vec<PaymentSchedule>,
    ) -> Result<u32, ContractError> {
        Self::require_not_paused(&env)?;
        manager.require_auth();

        if payments.is_empty() {
            return Err(ContractError::InvalidAmount);
        }

        // Guard amounts/rates and sum the total to be escrowed.
        let mut total_amount: i128 = 0;
        for i in 0..payments.len() {
            let p = payments.get(i).unwrap();
            if p.amount <= 0 || p.rate_per_hour <= 0 {
                return Err(ContractError::InvalidAmount);
            }
            total_amount += p.amount;
        }

        // EscrowCount in persistent storage — must survive alongside escrow
        // data to prevent ID reuse if instance storage expires first.
        let escrow_id: u32 = env
            .storage()
            .persistent()
            .get(&DataKey::EscrowCount)
            .unwrap_or(0u32)
            + 1;

        // Pull the full escrow amount from the manager into contract custody.
        // Requires the manager's authorization for the token sub-invocation and
        // reverts (host trap) if the manager has insufficient balance.
        let token_client = TokenClient::new(&env, &token);
        token_client.transfer(&manager, &env.current_contract_address(), &total_amount);

        let escrow = CoreFlowEscrow {
            manager: manager.clone(),
            finance_approver: finance_approver.clone(),
            token: token.clone(),
            oracle_pubkey,
            payments: payments.clone(),
            manager_approved: false,
            finance_approved: false,
            cancelled: false,
        };

        // Store escrow in persistent storage (per-key TTL control)
        env.storage()
            .persistent()
            .set(&DataKey::Escrow(escrow_id), &escrow);
        env.storage().persistent().extend_ttl(
            &DataKey::Escrow(escrow_id),
            PERSISTENT_TTL_THRESHOLD,
            PERSISTENT_TTL_EXTEND,
        );

        // Initialize nonce for this escrow
        env.storage()
            .persistent()
            .set(&DataKey::Nonce(escrow_id), &0u64);
        env.storage().persistent().extend_ttl(
            &DataKey::Nonce(escrow_id),
            PERSISTENT_TTL_THRESHOLD,
            PERSISTENT_TTL_EXTEND,
        );

        // Counter in persistent storage with same TTL as escrow data
        env.storage()
            .persistent()
            .set(&DataKey::EscrowCount, &escrow_id);
        env.storage().persistent().extend_ttl(
            &DataKey::EscrowCount,
            PERSISTENT_TTL_THRESHOLD,
            PERSISTENT_TTL_EXTEND,
        );

        // Emit event: escrow_created (escrow_id, manager, total funded amount)
        env.events().publish(
            (symbol_short!("escrow"), symbol_short!("created")),
            (escrow_id, manager, total_amount),
        );

        Ok(escrow_id)
    }

    /// Submit hours proof verified by Ed25519 oracle signature.
    ///
    /// The oracle signs a 32-byte message:
    ///   escrow_id (4 bytes BE) || payment_id (4 bytes BE) ||
    ///   hours_logged (16 bytes BE) || nonce (8 bytes BE)
    ///
    /// The contract verifies the signature against the escrow's stored oracle public key
    /// and checks the nonce matches the expected value to prevent replay attacks.
    pub fn submit_hours_proof(
        env: Env,
        escrow_id: u32,
        payment_id: u32,
        hours_logged: i128,
        nonce: u64,
        signature: BytesN<64>,
    ) -> Result<(), ContractError> {
        Self::require_not_paused(&env)?;
        // Validate escrow exists (persistent storage)
        let mut escrow: CoreFlowEscrow = env
            .storage()
            .persistent()
            .get(&DataKey::Escrow(escrow_id))
            .ok_or(ContractError::InvalidPaymentId)?;

        // Guard: check if escrow is cancelled
        if escrow.cancelled {
            return Err(ContractError::EscrowCancelled);
        }

        // Guard: do not allow hours submission after manager or finance has approved
        if escrow.manager_approved || escrow.finance_approved {
            return Err(ContractError::AlreadyApproved);
        }

        if payment_id >= escrow.payments.len() {
            return Err(ContractError::InvalidPaymentId);
        }

        // Verify nonce matches expected value (replay protection)
        let expected_nonce: u64 = env
            .storage()
            .persistent()
            .get(&DataKey::Nonce(escrow_id))
            .unwrap_or(0u64);
        if nonce != expected_nonce {
            return Err(ContractError::InvalidNonce);
        }

        // Construct the 32-byte message the oracle should have signed
        let mut msg_data = [0u8; 32];
        msg_data[0..4].copy_from_slice(&escrow_id.to_be_bytes());
        msg_data[4..8].copy_from_slice(&payment_id.to_be_bytes());
        msg_data[8..24].copy_from_slice(&hours_logged.to_be_bytes());
        msg_data[24..32].copy_from_slice(&nonce.to_be_bytes());
        let message = Bytes::from_slice(&env, &msg_data);

        // Ed25519 signature verification — panics on failure (host-level error)
        env.crypto()
            .ed25519_verify(&escrow.oracle_pubkey, &message, &signature);

        // Increment nonce after successful verification
        env.storage()
            .persistent()
            .set(&DataKey::Nonce(escrow_id), &(nonce + 1));
        env.storage().persistent().extend_ttl(
            &DataKey::Nonce(escrow_id),
            PERSISTENT_TTL_THRESHOLD,
            PERSISTENT_TTL_EXTEND,
        );

        // Update the payment schedule with hours logged
        let mut payment = escrow.payments.get(payment_id).unwrap();
        payment.hours_logged = hours_logged;

        escrow.payments.set(payment_id, payment);
        env.storage()
            .persistent()
            .set(&DataKey::Escrow(escrow_id), &escrow);
        env.storage().persistent().extend_ttl(
            &DataKey::Escrow(escrow_id),
            PERSISTENT_TTL_THRESHOLD,
            PERSISTENT_TTL_EXTEND,
        );

        // Emit event: hours_submitted
        env.events().publish(
            (symbol_short!("hours"), symbol_short!("submit")),
            (escrow_id, payment_id, hours_logged),
        );

        Ok(())
    }

    /// Manager approval of payment(s)
    pub fn manager_approve(env: Env, escrow_id: u32) -> Result<(), ContractError> {
        Self::require_not_paused(&env)?;
        let mut escrow: CoreFlowEscrow = env
            .storage()
            .persistent()
            .get(&DataKey::Escrow(escrow_id))
            .ok_or(ContractError::InvalidPaymentId)?;

        // Guard: check if escrow is cancelled
        if escrow.cancelled {
            return Err(ContractError::EscrowCancelled);
        }

        escrow.manager.require_auth();

        if escrow.manager_approved {
            return Err(ContractError::AlreadyApproved);
        }

        escrow.manager_approved = true;
        env.storage()
            .persistent()
            .set(&DataKey::Escrow(escrow_id), &escrow);
        env.storage().persistent().extend_ttl(
            &DataKey::Escrow(escrow_id),
            PERSISTENT_TTL_THRESHOLD,
            PERSISTENT_TTL_EXTEND,
        );

        // Emit event: manager_approved
        env.events().publish(
            (symbol_short!("approve"), symbol_short!("manager")),
            escrow_id,
        );

        Ok(())
    }

    /// Finance approval of payment(s)
    pub fn finance_approve(env: Env, escrow_id: u32) -> Result<(), ContractError> {
        Self::require_not_paused(&env)?;
        let mut escrow: CoreFlowEscrow = env
            .storage()
            .persistent()
            .get(&DataKey::Escrow(escrow_id))
            .ok_or(ContractError::InvalidPaymentId)?;

        // Guard: check if escrow is cancelled
        if escrow.cancelled {
            return Err(ContractError::EscrowCancelled);
        }

        escrow.finance_approver.require_auth();

        if escrow.finance_approved {
            return Err(ContractError::AlreadyApproved);
        }

        escrow.finance_approved = true;
        env.storage()
            .persistent()
            .set(&DataKey::Escrow(escrow_id), &escrow);
        env.storage().persistent().extend_ttl(
            &DataKey::Escrow(escrow_id),
            PERSISTENT_TTL_THRESHOLD,
            PERSISTENT_TTL_EXTEND,
        );

        // Emit event: finance_approved
        env.events().publish(
            (symbol_short!("approve"), symbol_short!("finance")),
            escrow_id,
        );

        Ok(())
    }

    /// Finalize payment once both approvals are obtained
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

        // Guard: check if escrow is cancelled
        if escrow.cancelled {
            return Err(ContractError::EscrowCancelled);
        }

        escrow.manager.require_auth();

        if !escrow.manager_approved || !escrow.finance_approved {
            return Err(ContractError::InsufficientApprovals);
        }

        // Guard: check if any payment is already finalized (double-finalize protection)
        for i in 0..escrow.payments.len() {
            let p = escrow.payments.get(i).unwrap();
            if p.status == PaymentStatus::Finalized {
                return Err(ContractError::PaymentAlreadyFinalized);
            }
        }

        // Mark all payments as finalized and release escrowed funds to workers.
        let token_client = TokenClient::new(&env, &escrow.token);
        let contract_addr = env.current_contract_address();
        let mut finalized_payments = Vec::new(&env);
        let mut total_amount: i128 = 0;
        for i in 0..escrow.payments.len() {
            let mut p = escrow.payments.get(i).unwrap();
            p.status = PaymentStatus::Finalized;
            // Transfer this payment's amount from contract custody to the worker.
            token_client.transfer(&contract_addr, &p.worker, &p.amount);
            total_amount += p.amount;
            finalized_payments.push_back(p);
        }

        escrow.payments = finalized_payments.clone();
        env.storage()
            .persistent()
            .set(&DataKey::Escrow(escrow_id), &escrow);

        // Extend storage TTL to preserve finalized records
        env.storage().persistent().extend_ttl(
            &DataKey::Escrow(escrow_id),
            PERSISTENT_TTL_THRESHOLD,
            PERSISTENT_TTL_EXTEND,
        );

        // Emit event: payment_finalized
        env.events().publish(
            (symbol_short!("payment"), symbol_short!("final")),
            (escrow_id, total_amount, finalized_payments.len()),
        );

        Ok(finalized_payments)
    }

    /// Cancel an escrow (dispute resolution — manager only).
    /// Allowed even while paused (emergency withdrawal path).
    pub fn cancel_escrow(env: Env, escrow_id: u32) -> Result<(), ContractError> {
        let mut escrow: CoreFlowEscrow = env
            .storage()
            .persistent()
            .get(&DataKey::Escrow(escrow_id))
            .ok_or(ContractError::InvalidPaymentId)?;

        // Guard: prevent double-cancel (would re-execute a zero-amount refund
        // transfer and emit a duplicate event).
        if escrow.cancelled {
            return Err(ContractError::EscrowCancelled);
        }

        escrow.manager.require_auth();

        // Cannot cancel already finalized escrows; total the refund owed.
        let mut refund_amount: i128 = 0;
        for i in 0..escrow.payments.len() {
            let p = escrow.payments.get(i).unwrap();
            if p.status == PaymentStatus::Finalized {
                return Err(ContractError::PaymentAlreadyFinalized);
            }
            refund_amount += p.amount;
        }

        // Refund the full escrowed amount back to the manager (nothing was
        // released since finalize settles all payments atomically).
        if refund_amount > 0 {
            let token_client = TokenClient::new(&env, &escrow.token);
            token_client.transfer(
                &env.current_contract_address(),
                &escrow.manager,
                &refund_amount,
            );
        }

        escrow.cancelled = true;

        // Mark all payments as cancelled
        let mut cancelled_payments = Vec::new(&env);
        for i in 0..escrow.payments.len() {
            let mut p = escrow.payments.get(i).unwrap();
            p.status = PaymentStatus::Cancelled;
            cancelled_payments.push_back(p);
        }
        escrow.payments = cancelled_payments;

        env.storage()
            .persistent()
            .set(&DataKey::Escrow(escrow_id), &escrow);

        // Emit event: escrow_cancelled
        env.events().publish(
            (symbol_short!("escrow"), symbol_short!("cancel")),
            escrow_id,
        );

        Ok(())
    }

    /// Retrieve escrow details
    pub fn get_escrow(env: Env, escrow_id: u32) -> Result<CoreFlowEscrow, ContractError> {
        env.storage()
            .persistent()
            .get(&DataKey::Escrow(escrow_id))
            .ok_or(ContractError::InvalidPaymentId)
    }

    /// Return the next expected oracle nonce for an escrow.
    /// The oracle must sign a proof using this exact value (replay protection).
    /// Returns 0 for an unknown/uninitialized escrow.
    pub fn get_nonce(env: Env, escrow_id: u32) -> u64 {
        env.storage()
            .persistent()
            .get(&DataKey::Nonce(escrow_id))
            .unwrap_or(0u64)
    }
}

#[cfg(test)]
mod test;
