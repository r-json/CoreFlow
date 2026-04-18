#[cfg(test)]
mod tests {
    use crate::{CoreFlowContract, CoreFlowContractClient, PaymentSchedule, PaymentStatus, ContractError};
    use soroban_sdk::{Address, Bytes, Env, Vec};
    use soroban_sdk::testutils::Address as _;

    fn create_test_payment(_env: &Env, worker: &Address) -> PaymentSchedule {
        PaymentSchedule {
            id: 1,
            worker: worker.clone(),
            amount: 10000,
            start_date: 1000,
            end_date: 2000,
            hours_logged: 40,
            rate_per_hour: 250,
            status: PaymentStatus::Pending,
        }
    }

    #[test]
    fn test_initialize_multi_sig_escrow_happy_path() {
        let env = Env::default();
        env.mock_all_auths();

        let client = CoreFlowContractClient::new(&env, &env.register_contract(None, CoreFlowContract));
        
        let manager = Address::generate(&env);
        let finance = Address::generate(&env);
        let worker = Address::generate(&env);

        let mut payments = Vec::new(&env);
        payments.push_back(create_test_payment(&env, &worker));

        let escrow_id = client.initialize_multi_sig_escrow(&manager, &finance, &payments);
        assert_eq!(escrow_id, 1);

        let retrieved = client.get_escrow(&escrow_id);
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
        payments.push_back(create_test_payment(&env, &worker));

        let escrow_id = client.initialize_multi_sig_escrow(&manager, &finance, &payments);

        // Manager approval
        client.manager_approve(&escrow_id);
        let mut escrow = client.get_escrow(&escrow_id);
        assert!(escrow.manager_approved);
        assert!(!escrow.finance_approved);

        // Finance approval
        client.finance_approve(&escrow_id);
        escrow = client.get_escrow(&escrow_id);
        assert!(escrow.manager_approved);
        assert!(escrow.finance_approved);

        // Finalize payment
        let finalized = client.finalize_payment(&escrow_id);
        assert_eq!(finalized.len(), 1);
        assert_eq!(finalized.get(0).unwrap().status, PaymentStatus::Finalized);
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #3)")]
    fn test_invalid_oracle_signature_rejection() {
        let env = Env::default();
        env.mock_all_auths();

        let client = CoreFlowContractClient::new(&env, &env.register_contract(None, CoreFlowContract));
        
        let manager = Address::generate(&env);
        let finance = Address::generate(&env);
        let worker = Address::generate(&env);

        let mut payments = Vec::new(&env);
        payments.push_back(create_test_payment(&env, &worker));

        let escrow_id = client.initialize_multi_sig_escrow(&manager, &finance, &payments);

        // Submit with invalid signature (too short - empty bytes)
        let invalid_sig = Bytes::new(&env);
        // This should panic with InvalidOracleSignature error
        client.submit_hours_proof(&escrow_id, &0, &40, &invalid_sig);
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #5)")]
    fn test_finalize_without_finance_approval_fails() {
        let env = Env::default();
        env.mock_all_auths();

        let client = CoreFlowContractClient::new(&env, &env.register_contract(None, CoreFlowContract));
        
        let manager = Address::generate(&env);
        let finance = Address::generate(&env);
        let worker = Address::generate(&env);

        let mut payments = Vec::new(&env);
        payments.push_back(create_test_payment(&env, &worker));

        let escrow_id = client.initialize_multi_sig_escrow(&manager, &finance, &payments);

        // Only manager approval, no finance approval
        client.manager_approve(&escrow_id);

        // Try to finalize without finance approval - should panic with InsufficientApprovals
        client.finalize_payment(&escrow_id);
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #1)")]
    fn test_double_approval_rejected() {
        let env = Env::default();
        env.mock_all_auths();

        let client = CoreFlowContractClient::new(&env, &env.register_contract(None, CoreFlowContract));
        
        let manager = Address::generate(&env);
        let finance = Address::generate(&env);
        let worker = Address::generate(&env);

        let mut payments = Vec::new(&env);
        payments.push_back(create_test_payment(&env, &worker));

        let escrow_id = client.initialize_multi_sig_escrow(&manager, &finance, &payments);

        // Manager approval twice should panic on second attempt with AlreadyApproved
        client.manager_approve(&escrow_id);
        client.manager_approve(&escrow_id);
    }
}
