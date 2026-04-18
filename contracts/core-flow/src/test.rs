#[cfg(test)]
mod tests {
    use crate::{CoreFlowContract, CoreFlowContractClient, PaymentSchedule, PaymentStatus, ContractError};
    use soroban_sdk::{Address, Bytes, Env, Vec, Symbol, symbol_short};

    #[test]
    fn test_initialize_multi_sig_escrow_happy_path() {
        let env = Env::default();
        env.mock_all_auths();

        let client = CoreFlowContractClient::new(&env, &env.register_contract(None, CoreFlowContract));
        
        let manager = Address::generate(&env);
        let finance = Address::generate(&env);
        let worker = Address::generate(&env);

        let mut payments = Vec::new(&env);
        let payment = PaymentSchedule {
            id: 1,
            worker: worker.clone(),
            amount: 10000,
            currency: symbol_short!("USDC"),
            start_date: 1000,
            end_date: 2000,
            hours_logged: 40,
            rate_per_hour: 250,
            status: PaymentStatus::Pending,
        };
        payments.push_back(payment);

        let escrow_id = client.initialize_multi_sig_escrow(&manager, &finance, &payments);
        assert_eq!(escrow_id, 1);

        let retrieved = client.get_escrow(&escrow_id).unwrap();
        assert_eq!(retrieved.manager, manager);
        assert_eq!(retrieved.finance_approver, finance);
        assert_eq!(retrieved.payments.len(), 1);
        assert!(!retrieved.manager_approved);
        assert!(!retrieved.finance_approved);
    }

    #[test]
    fn test_manager_and_finance_approval_flow() {
        let env = Env::default();
        env.mock_all_auths();

        let client = CoreFlowContractClient::new(&env, &env.register_contract(None, CoreFlowContract));
        
        let manager = Address::generate(&env);
        let finance = Address::generate(&env);
        let worker = Address::generate(&env);

        let mut payments = Vec::new(&env);
        let payment = PaymentSchedule {
            id: 1,
            worker: worker.clone(),
            amount: 10000,
            currency: symbol_short!("USDC"),
            start_date: 1000,
            end_date: 2000,
            hours_logged: 40,
            rate_per_hour: 250,
            status: PaymentStatus::Pending,
        };
        payments.push_back(payment);

        let escrow_id = client.initialize_multi_sig_escrow(&manager, &finance, &payments);

        // Manager approval
        client.manager_approve(&escrow_id).unwrap();
        let mut escrow = client.get_escrow(&escrow_id).unwrap();
        assert!(escrow.manager_approved);
        assert!(!escrow.finance_approved);

        // Finance approval
        client.finance_approve(&escrow_id).unwrap();
        escrow = client.get_escrow(&escrow_id).unwrap();
        assert!(escrow.manager_approved);
        assert!(escrow.finance_approved);

        // Finalize payment
        let finalized = client.finalize_payment(&escrow_id).unwrap();
        assert_eq!(finalized.len(), 1);
        assert_eq!(finalized.get(0).unwrap().status, PaymentStatus::Finalized);
    }

    #[test]
    #[should_panic]
    fn test_invalid_oracle_signature_rejection() {
        let env = Env::default();
        env.mock_all_auths();

        let client = CoreFlowContractClient::new(&env, &env.register_contract(None, CoreFlowContract));
        
        let manager = Address::generate(&env);
        let finance = Address::generate(&env);
        let worker = Address::generate(&env);

        let mut payments = Vec::new(&env);
        let payment = PaymentSchedule {
            id: 1,
            worker: worker.clone(),
            amount: 10000,
            currency: symbol_short!("USDC"),
            start_date: 1000,
            end_date: 2000,
            hours_logged: 40,
            rate_per_hour: 250,
            status: PaymentStatus::Pending,
        };
        payments.push_back(payment);

        let escrow_id = client.initialize_multi_sig_escrow(&manager, &finance, &payments);

        // Submit with invalid signature (too short)
        let invalid_sig = Bytes::new(&env);
        let result = client.submit_hours_proof(&escrow_id, 0, 40, &invalid_sig);
        
        // This should fail because signature is too short
        assert!(result.is_err());
    }

    #[test]
    #[should_panic]
    fn test_finalize_without_finance_approval_fails() {
        let env = Env::default();
        env.mock_all_auths();

        let client = CoreFlowContractClient::new(&env, &env.register_contract(None, CoreFlowContract));
        
        let manager = Address::generate(&env);
        let finance = Address::generate(&env);
        let worker = Address::generate(&env);

        let mut payments = Vec::new(&env);
        let payment = PaymentSchedule {
            id: 1,
            worker: worker.clone(),
            amount: 10000,
            currency: symbol_short!("USDC"),
            start_date: 1000,
            end_date: 2000,
            hours_logged: 40,
            rate_per_hour: 250,
            status: PaymentStatus::Pending,
        };
        payments.push_back(payment);

        let escrow_id = client.initialize_multi_sig_escrow(&manager, &finance, &payments);

        // Only manager approval, no finance approval
        client.manager_approve(&escrow_id).unwrap();

        // Try to finalize without finance approval - should fail
        let result = client.finalize_payment(&escrow_id);
        assert!(result.is_err());
    }

    #[test]
    #[should_panic]
    fn test_double_approval_rejected() {
        let env = Env::default();
        env.mock_all_auths();

        let client = CoreFlowContractClient::new(&env, &env.register_contract(None, CoreFlowContract));
        
        let manager = Address::generate(&env);
        let finance = Address::generate(&env);
        let worker = Address::generate(&env);

        let mut payments = Vec::new(&env);
        let payment = PaymentSchedule {
            id: 1,
            worker: worker.clone(),
            amount: 10000,
            currency: symbol_short!("USDC"),
            start_date: 1000,
            end_date: 2000,
            hours_logged: 40,
            rate_per_hour: 250,
            status: PaymentStatus::Pending,
        };
        payments.push_back(payment);

        let escrow_id = client.initialize_multi_sig_escrow(&manager, &finance, &payments);

        // Manager approval twice should fail on second attempt
        client.manager_approve(&escrow_id).unwrap();
        let result = client.manager_approve(&escrow_id); // Should error
        assert!(result.is_err());
    }
}
