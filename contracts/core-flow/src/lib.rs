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
}

#[contracttype]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u32)]
pub enum PaymentStatus {
    Pending = 0,
    ManagerApproved = 1,
    FinanceApproved = 2,
    Finalized = 3,
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
}

// ========== STORAGE KEYS ==========

#[contracttype]
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum DataKey {
    EscrowCount,
    Escrow(u32),
}

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
        };

        env.storage().instance().set(&DataKey::Escrow(escrow_id), &escrow);
        env.storage().instance().set(&DataKey::EscrowCount, &escrow_id);

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

        if (payment_id as u32) >= escrow.payments.len() {
            return Err(ContractError::InvalidPaymentId);
        }

        // Simple oracle signature validation (in production, use Ed25519 verify)
        // For this demo, we verify signature length
        if signature.len() < 64 {
            return Err(ContractError::InvalidOracleSignature);
        }

        // Update the payment schedule with hours logged
        let mut payment = escrow.payments.get(payment_id).unwrap();
        payment.hours_logged = hours_logged;

        let mut updated_payments = Vec::new(&env);
        for i in 0..escrow.payments.len() {
            if i == payment_id {
                updated_payments.push_back(payment.clone());
            } else {
                updated_payments.push_back(escrow.payments.get(i).unwrap());
            }
        }

        escrow.payments = updated_payments;
        env.storage().instance().set(&DataKey::Escrow(escrow_id), &escrow);

        Ok(())
    }

    /// Manager approval of payment(s)
    pub fn manager_approve(
        env: Env,
        escrow_id: u32,
    ) -> Result<(), ContractError> {
        let mut escrow: CoreFlowEscrow = env.storage().instance().get(&DataKey::Escrow(escrow_id))
            .ok_or(ContractError::InvalidPaymentId)?;

        escrow.manager.require_auth();

        if escrow.manager_approved {
            return Err(ContractError::AlreadyApproved);
        }

        escrow.manager_approved = true;
        env.storage().instance().set(&DataKey::Escrow(escrow_id), &escrow);

        Ok(())
    }

    /// Finance approval of payment(s)
    pub fn finance_approve(
        env: Env,
        escrow_id: u32,
    ) -> Result<(), ContractError> {
        let mut escrow: CoreFlowEscrow = env.storage().instance().get(&DataKey::Escrow(escrow_id))
            .ok_or(ContractError::InvalidPaymentId)?;

        escrow.finance_approver.require_auth();

        if escrow.finance_approved {
            return Err(ContractError::AlreadyApproved);
        }

        escrow.finance_approved = true;
        env.storage().instance().set(&DataKey::Escrow(escrow_id), &escrow);

        Ok(())
    }

    /// Finalize payment once both approvals are obtained
    pub fn finalize_payment(
        env: Env,
        escrow_id: u32,
    ) -> Result<Vec<PaymentSchedule>, ContractError> {
        let mut escrow: CoreFlowEscrow = env.storage().instance().get(&DataKey::Escrow(escrow_id))
            .ok_or(ContractError::InvalidPaymentId)?;

        escrow.manager.require_auth();

        if !escrow.manager_approved || !escrow.finance_approved {
            return Err(ContractError::InsufficientApprovals);
        }

        // Mark all payments as finalized
        let mut finalized_payments = Vec::new(&env);
        for i in 0..escrow.payments.len() {
            let mut p = escrow.payments.get(i).unwrap();
            p.status = PaymentStatus::Finalized;
            finalized_payments.push_back(p);
        }

        escrow.payments = finalized_payments.clone();
        env.storage().instance().set(&DataKey::Escrow(escrow_id), &escrow);

        Ok(finalized_payments)
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
