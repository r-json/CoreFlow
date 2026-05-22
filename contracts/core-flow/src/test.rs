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

    fn create_multi_payments(env: &Env, worker1: &Address, worker2: &Address) -> Vec<PaymentSchedule> {
        let mut payments = Vec::new(env);
        payments.push_back(PaymentSchedule {
            id: 1,
            worker: worker1.clone(),
            amount: 5000,
            start_date: 1000,
            end_date: 2000,
            hours_logged: 20,
            rate_per_hour: 250,
            status: PaymentStatus::Pending,
        });
        payments.push_back(PaymentSchedule {
            id: 2,
            worker: worker2.clone(),
            amount: 8000,
            start_date: 1000,
            end_date: 2000,
            hours_logged: 32,
            rate_per_hour: 250,
            status: PaymentStatus::Pending,
        });
        payments
    }

    // ========== HAPPY PATH ==========

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
        assert!(!retrieved.cancelled);
    }

    #[test]
    fn test_full_approval_and_finalize_flow() {
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
    fn test_submit_hours_proof_with_valid_signature() {
        let env = Env::default();
        env.mock_all_auths();

        let client = CoreFlowContractClient::new(&env, &env.register_contract(None, CoreFlowContract));

        let manager = Address::generate(&env);
        let finance = Address::generate(&env);
        let worker = Address::generate(&env);

        let mut payments = Vec::new(&env);
        payments.push_back(create_test_payment(&env, &worker));

        let escrow_id = client.initialize_multi_sig_escrow(&manager, &finance, &payments);

        // Create a valid 64-byte signature
        let mut sig_bytes = [0u8; 64];
        for i in 0..64 { sig_bytes[i] = (i as u8) + 1; }
        let valid_sig = Bytes::from_slice(&env, &sig_bytes);

        client.submit_hours_proof(&escrow_id, &0, &80, &valid_sig);

        let escrow = client.get_escrow(&escrow_id);
        assert_eq!(escrow.payments.get(0).unwrap().hours_logged, 80);
    }

    #[test]
    fn test_multiple_payment_schedules() {
        let env = Env::default();
        env.mock_all_auths();

        let client = CoreFlowContractClient::new(&env, &env.register_contract(None, CoreFlowContract));

        let manager = Address::generate(&env);
        let finance = Address::generate(&env);
        let worker1 = Address::generate(&env);
        let worker2 = Address::generate(&env);

        let payments = create_multi_payments(&env, &worker1, &worker2);

        let escrow_id = client.initialize_multi_sig_escrow(&manager, &finance, &payments);
        let escrow = client.get_escrow(&escrow_id);
        assert_eq!(escrow.payments.len(), 2);
        assert_eq!(escrow.payments.get(0).unwrap().amount, 5000);
        assert_eq!(escrow.payments.get(1).unwrap().amount, 8000);

        // Full flow with multiple payments
        client.manager_approve(&escrow_id);
        client.finance_approve(&escrow_id);
        let finalized = client.finalize_payment(&escrow_id);
        assert_eq!(finalized.len(), 2);
        assert_eq!(finalized.get(0).unwrap().status, PaymentStatus::Finalized);
        assert_eq!(finalized.get(1).unwrap().status, PaymentStatus::Finalized);
    }

    #[test]
    fn test_multiple_escrows_sequential_ids() {
        let env = Env::default();
        env.mock_all_auths();

        let client = CoreFlowContractClient::new(&env, &env.register_contract(None, CoreFlowContract));

        let manager = Address::generate(&env);
        let finance = Address::generate(&env);
        let worker = Address::generate(&env);

        let mut payments = Vec::new(&env);
        payments.push_back(create_test_payment(&env, &worker));

        let id1 = client.initialize_multi_sig_escrow(&manager, &finance, &payments);
        let id2 = client.initialize_multi_sig_escrow(&manager, &finance, &payments);
        let id3 = client.initialize_multi_sig_escrow(&manager, &finance, &payments);

        assert_eq!(id1, 1);
        assert_eq!(id2, 2);
        assert_eq!(id3, 3);
    }

    // ========== CANCEL ESCROW ==========

    #[test]
    fn test_cancel_escrow() {
        let env = Env::default();
        env.mock_all_auths();

        let client = CoreFlowContractClient::new(&env, &env.register_contract(None, CoreFlowContract));

        let manager = Address::generate(&env);
        let finance = Address::generate(&env);
        let worker = Address::generate(&env);

        let mut payments = Vec::new(&env);
        payments.push_back(create_test_payment(&env, &worker));

        let escrow_id = client.initialize_multi_sig_escrow(&manager, &finance, &payments);
        client.cancel_escrow(&escrow_id);

        let escrow = client.get_escrow(&escrow_id);
        assert!(escrow.cancelled);
        assert_eq!(escrow.payments.get(0).unwrap().status, PaymentStatus::Cancelled);
    }

    // ========== FAILURE CASES ==========

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

    #[test]
    #[should_panic(expected = "Error(Contract, #6)")]
    fn test_double_finalize_rejected() {
        let env = Env::default();
        env.mock_all_auths();

        let client = CoreFlowContractClient::new(&env, &env.register_contract(None, CoreFlowContract));

        let manager = Address::generate(&env);
        let finance = Address::generate(&env);
        let worker = Address::generate(&env);

        let mut payments = Vec::new(&env);
        payments.push_back(create_test_payment(&env, &worker));

        let escrow_id = client.initialize_multi_sig_escrow(&manager, &finance, &payments);

        client.manager_approve(&escrow_id);
        client.finance_approve(&escrow_id);
        client.finalize_payment(&escrow_id);

        // Second finalize should panic with PaymentAlreadyFinalized
        client.finalize_payment(&escrow_id);
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #8)")]
    fn test_approve_cancelled_escrow_fails() {
        let env = Env::default();
        env.mock_all_auths();

        let client = CoreFlowContractClient::new(&env, &env.register_contract(None, CoreFlowContract));

        let manager = Address::generate(&env);
        let finance = Address::generate(&env);
        let worker = Address::generate(&env);

        let mut payments = Vec::new(&env);
        payments.push_back(create_test_payment(&env, &worker));

        let escrow_id = client.initialize_multi_sig_escrow(&manager, &finance, &payments);
        client.cancel_escrow(&escrow_id);

        // Trying to approve a cancelled escrow should fail
        client.manager_approve(&escrow_id);
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #6)")]
    fn test_cancel_finalized_escrow_fails() {
        let env = Env::default();
        env.mock_all_auths();

        let client = CoreFlowContractClient::new(&env, &env.register_contract(None, CoreFlowContract));

        let manager = Address::generate(&env);
        let finance = Address::generate(&env);
        let worker = Address::generate(&env);

        let mut payments = Vec::new(&env);
        payments.push_back(create_test_payment(&env, &worker));

        let escrow_id = client.initialize_multi_sig_escrow(&manager, &finance, &payments);

        client.manager_approve(&escrow_id);
        client.finance_approve(&escrow_id);
        client.finalize_payment(&escrow_id);

        // Trying to cancel a finalized escrow should fail
        client.cancel_escrow(&escrow_id);
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #4)")]
    fn test_get_nonexistent_escrow_fails() {
        let env = Env::default();
        env.mock_all_auths();

        let client = CoreFlowContractClient::new(&env, &env.register_contract(None, CoreFlowContract));

        // Should panic with InvalidPaymentId
        client.get_escrow(&999);
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #7)")]
    fn test_empty_payments_rejected() {
        let env = Env::default();
        env.mock_all_auths();

        let client = CoreFlowContractClient::new(&env, &env.register_contract(None, CoreFlowContract));

        let manager = Address::generate(&env);
        let finance = Address::generate(&env);

        let payments = Vec::new(&env);

        // Should panic with InvalidAmount
        client.initialize_multi_sig_escrow(&manager, &finance, &payments);
    }
}
