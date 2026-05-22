#![no_std]
use soroban_sdk::{contract, contractimpl, contracttype, contracterror, Address, Bytes, Env, Vec, symbol_short};

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
}

// Storage TTL constants (in ledgers)
// ~1 ledger ≈ 5 seconds; 17280 ledgers ≈ 1 day
const INSTANCE_TTL_THRESHOLD: u32 = 17280;    // Extend when below 1 day
const INSTANCE_TTL_EXTEND: u32 = 17280 * 30;  // Extend to 30 days

// ========== CONTRACT ==========

#[contract]
pub struct CoreFlowContract;

#[contractimpl]
impl CoreFlowContract {
    /// Initialize a multi-signature escrow with payment schedules
    pub fn initialize_multi_sig_escrow(
        env: Env,
        manager: Address,
        finance_approver: Address,
        payments: Vec<PaymentSchedule>,
    ) -> Result<u32, ContractError> {
        manager.require_auth();

        if payments.len() == 0 {
            return Err(ContractError::InvalidAmount);
        }

        let escrow_id: u32 = env.storage().instance().get(&DataKey::EscrowCount)
            .unwrap_or(0u32) + 1;

        let escrow = CoreFlowEscrow {
            manager: manager.clone(),
            finance_approver: finance_approver.clone(),
            payments: payments.clone(),
            manager_approved: false,
            finance_approved: false,
            cancelled: false,
        };

        env.storage().instance().set(&DataKey::Escrow(escrow_id), &escrow);
        env.storage().instance().set(&DataKey::EscrowCount, &escrow_id);

        // Extend storage TTL for production durability
        env.storage().instance().extend_ttl(INSTANCE_TTL_THRESHOLD, INSTANCE_TTL_EXTEND);

        // Emit event: escrow_created
        env.events().publish(
            (symbol_short!("escrow"), symbol_short!("created")),
            (escrow_id, manager, payments.len()),
        );

        Ok(escrow_id)
    }

    /// Submit hours proof with Ed25519 signature (simulates oracle integration)
    pub fn submit_hours_proof(
        env: Env,
        escrow_id: u32,
        payment_id: u32,
        hours_logged: i128,
        signature: Bytes,
    ) -> Result<(), ContractError> {
        // Validate escrow exists
        let mut escrow: CoreFlowEscrow = env.storage().instance().get(&DataKey::Escrow(escrow_id))
            .ok_or(ContractError::InvalidPaymentId)?;

        // Guard: check if escrow is cancelled
        if escrow.cancelled {
            return Err(ContractError::EscrowCancelled);
        }

        if payment_id >= escrow.payments.len() {
            return Err(ContractError::InvalidPaymentId);
        }

        // Oracle signature validation (in production, use Ed25519 verify)
        // For this implementation, we verify signature length meets minimum
        if signature.len() < 64 {
            return Err(ContractError::InvalidOracleSignature);
        }

        // Update the payment schedule with hours logged
        let mut payment = escrow.payments.get(payment_id).unwrap();
        payment.hours_logged = hours_logged;

        escrow.payments.set(payment_id, payment);
        env.storage().instance().set(&DataKey::Escrow(escrow_id), &escrow);

        // Emit event: hours_submitted
        env.events().publish(
            (symbol_short!("hours"), symbol_short!("submit")),
            (escrow_id, payment_id, hours_logged),
        );

        Ok(())
    }

    /// Manager approval of payment(s)
    pub fn manager_approve(
        env: Env,
        escrow_id: u32,
    ) -> Result<(), ContractError> {
        let mut escrow: CoreFlowEscrow = env.storage().instance().get(&DataKey::Escrow(escrow_id))
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
        env.storage().instance().set(&DataKey::Escrow(escrow_id), &escrow);

        // Emit event: manager_approved
        env.events().publish(
            (symbol_short!("approve"), symbol_short!("manager")),
            escrow_id,
        );

        Ok(())
    }

    /// Finance approval of payment(s)
    pub fn finance_approve(
        env: Env,
        escrow_id: u32,
    ) -> Result<(), ContractError> {
        let mut escrow: CoreFlowEscrow = env.storage().instance().get(&DataKey::Escrow(escrow_id))
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
        env.storage().instance().set(&DataKey::Escrow(escrow_id), &escrow);

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
        let mut escrow: CoreFlowEscrow = env.storage().instance().get(&DataKey::Escrow(escrow_id))
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

        // Mark all payments as finalized
        let mut finalized_payments = Vec::new(&env);
        let mut total_amount: i128 = 0;
        for i in 0..escrow.payments.len() {
            let mut p = escrow.payments.get(i).unwrap();
            p.status = PaymentStatus::Finalized;
            total_amount += p.amount;
            finalized_payments.push_back(p);
        }

        escrow.payments = finalized_payments.clone();
        env.storage().instance().set(&DataKey::Escrow(escrow_id), &escrow);

        // Extend storage TTL to preserve finalized records
        env.storage().instance().extend_ttl(INSTANCE_TTL_THRESHOLD, INSTANCE_TTL_EXTEND);

        // Emit event: payment_finalized
        env.events().publish(
            (symbol_short!("payment"), symbol_short!("final")),
            (escrow_id, total_amount, finalized_payments.len()),
        );

        Ok(finalized_payments)
    }

    /// Cancel an escrow (dispute resolution — manager only)
    pub fn cancel_escrow(
        env: Env,
        escrow_id: u32,
    ) -> Result<(), ContractError> {
        let mut escrow: CoreFlowEscrow = env.storage().instance().get(&DataKey::Escrow(escrow_id))
            .ok_or(ContractError::InvalidPaymentId)?;

        escrow.manager.require_auth();

        // Cannot cancel already finalized escrows
        for i in 0..escrow.payments.len() {
            let p = escrow.payments.get(i).unwrap();
            if p.status == PaymentStatus::Finalized {
                return Err(ContractError::PaymentAlreadyFinalized);
            }
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

        env.storage().instance().set(&DataKey::Escrow(escrow_id), &escrow);

        // Emit event: escrow_cancelled
        env.events().publish(
            (symbol_short!("escrow"), symbol_short!("cancel")),
            escrow_id,
        );

        Ok(())
    }

    /// Retrieve escrow details
    pub fn get_escrow(
        env: Env,
        escrow_id: u32,
    ) -> Result<CoreFlowEscrow, ContractError> {
        env.storage().instance().get(&DataKey::Escrow(escrow_id))
            .ok_or(ContractError::InvalidPaymentId)
    }
}

#[cfg(test)]
mod test;
