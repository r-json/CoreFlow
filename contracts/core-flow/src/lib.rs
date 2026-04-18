#![no_std]
use soroban_sdk::{contract, contractimpl, Address, Bytes, Env, Vec, Symbol, symbol_short};

// ========== ENUMS & ERRORS ==========

#[derive(Debug, Clone, Copy)]
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

#[derive(Debug, Clone, Copy)]
#[repr(u32)]
pub enum PaymentStatus {
    Pending = 0,
    ManagerApproved = 1,
    FinanceApproved = 2,
    Finalized = 3,
}

// ========== STRUCTS ==========

#[derive(Clone, Debug)]
pub struct PaymentSchedule {
    pub id: u32,
    pub worker: Address,
    pub amount: i128,
    pub currency: Symbol,
    pub start_date: u64,
    pub end_date: u64,
    pub hours_logged: i128,
    pub rate_per_hour: i128,
    pub status: PaymentStatus,
}

#[derive(Clone, Debug)]
pub struct CoreFlowEscrow {
    pub manager: Address,
    pub finance_approver: Address,
    pub payments: Vec<PaymentSchedule>,
    pub manager_approved: bool,
    pub finance_approved: bool,
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
    ) -> Result<u32, u32> {
        manager.require_auth();

        if payments.len() == 0 {
            return Err(ContractError::InvalidAmount as u32);
        }

        let escrow_id: u32 = env.storage().instance().get(&symbol_short!("escrow_cnt"))
            .unwrap_or(0u32) + 1;

        let escrow = CoreFlowEscrow {
            manager: manager.clone(),
            finance_approver: finance_approver.clone(),
            payments: payments.clone(),
            manager_approved: false,
            finance_approved: false,
        };

        let key = Symbol::new(&env, &format!("escrow_{}", escrow_id));
        env.storage().instance().set(&key, &escrow);
        env.storage().instance().set(&symbol_short!("escrow_cnt"), &escrow_id);

        Ok(escrow_id)
    }

    /// Submit hours proof with Ed25519 signature (simulates oracle integration)
    pub fn submit_hours_proof(
        env: Env,
        escrow_id: u32,
        payment_id: u32,
        hours_logged: i128,
        signature: Bytes,
    ) -> Result<(), u32> {
        // Validate payment_id bounds
        let key = Symbol::new(&env, &format!("escrow_{}", escrow_id));
        let mut escrow: CoreFlowEscrow = env.storage().instance().get(&key)
            .ok_or(ContractError::InvalidPaymentId as u32)?;

        if (payment_id as usize) >= escrow.payments.len() {
            return Err(ContractError::InvalidPaymentId as u32);
        }

        // Simple oracle signature validation (in production, use Ed25519 verify)
        // For this demo, we verify signature length
        if signature.len() < 64 {
            return Err(ContractError::InvalidOracleSignature as u32);
        }

        // Update the payment schedule with hours logged
        let mut payment = escrow.payments.get(payment_id as usize).unwrap();
        payment.hours_logged = hours_logged;

        let mut updated_payments = Vec::new(&env);
        for (i, p) in escrow.payments.iter().enumerate() {
            if i == payment_id as usize {
                updated_payments.push_back(payment.clone());
            } else {
                updated_payments.push_back(p);
            }
        }

        escrow.payments = updated_payments;
        env.storage().instance().set(&key, &escrow);

        Ok(())
    }

    /// Manager approval of payment(s)
    pub fn manager_approve(
        env: Env,
        escrow_id: u32,
    ) -> Result<(), u32> {
        let key = Symbol::new(&env, &format!("escrow_{}", escrow_id));
        let mut escrow: CoreFlowEscrow = env.storage().instance().get(&key)
            .ok_or(ContractError::InvalidPaymentId as u32)?;

        escrow.manager.require_auth();

        if escrow.manager_approved {
            return Err(ContractError::AlreadyApproved as u32);
        }

        escrow.manager_approved = true;
        env.storage().instance().set(&key, &escrow);

        Ok(())
    }

    /// Finance approval of payment(s)
    pub fn finance_approve(
        env: Env,
        escrow_id: u32,
    ) -> Result<(), u32> {
        let key = Symbol::new(&env, &format!("escrow_{}", escrow_id));
        let mut escrow: CoreFlowEscrow = env.storage().instance().get(&key)
            .ok_or(ContractError::InvalidPaymentId as u32)?;

        escrow.finance_approver.require_auth();

        if escrow.finance_approved {
            return Err(ContractError::AlreadyApproved as u32);
        }

        escrow.finance_approved = true;
        env.storage().instance().set(&key, &escrow);

        Ok(())
    }

    /// Finalize payment once both approvals are obtained
    pub fn finalize_payment(
        env: Env,
        escrow_id: u32,
    ) -> Result<Vec<PaymentSchedule>, u32> {
        let key = Symbol::new(&env, &format!("escrow_{}", escrow_id));
        let mut escrow: CoreFlowEscrow = env.storage().instance().get(&key)
            .ok_or(ContractError::InvalidPaymentId as u32)?;

        escrow.manager.require_auth();

        if !escrow.manager_approved || !escrow.finance_approved {
            return Err(ContractError::InsufficientApprovals as u32);
        }

        // Mark all payments as finalized
        let mut finalized_payments = Vec::new(&env);
        for payment in escrow.payments.iter() {
            let mut p = payment.clone();
            p.status = PaymentStatus::Finalized;
            finalized_payments.push_back(p);
        }

        escrow.payments = finalized_payments.clone();
        env.storage().instance().set(&key, &escrow);

        Ok(finalized_payments)
    }

    /// Retrieve escrow details
    pub fn get_escrow(
        env: Env,
        escrow_id: u32,
    ) -> Result<CoreFlowEscrow, u32> {
        let key = Symbol::new(&env, &format!("escrow_{}", escrow_id));
        env.storage().instance().get(&key)
            .ok_or(ContractError::InvalidPaymentId as u32)
    }
}
