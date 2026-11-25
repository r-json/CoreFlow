//! Host contract used by the integration tests. It stands in for a real
//! contract: it authorizes nothing (the crate under test never does) and simply
//! exposes the crate's functions so tests can call them through the client.
#![allow(dead_code)]

use coreflow_attest::{registry, replay, testutils, verify_claim, AttestError, Claim};
use soroban_sdk::{contract, contractimpl, Bytes, BytesN, Env};

#[contract]
pub struct Host;

#[contractimpl]
impl Host {
    pub fn register_issuer(env: Env, issuer: BytesN<32>) -> Result<(), AttestError> {
        registry::register(&env, &issuer)
    }

    pub fn revoke_issuer(env: Env, issuer: BytesN<32>) -> Result<(), AttestError> {
        registry::revoke(&env, &issuer)
    }

    pub fn rotate_issuer(env: Env, old: BytesN<32>, new: BytesN<32>) -> Result<(), AttestError> {
        registry::rotate(&env, &old, &new)
    }

    pub fn is_registered(env: Env, issuer: BytesN<32>) -> bool {
        registry::is_registered(&env, &issuer)
    }

    pub fn verify(env: Env, claim: Claim, signature: BytesN<64>) -> Result<(), AttestError> {
        verify_claim(&env, &claim, &signature)
    }

    pub fn preimage(env: Env, claim: Claim) -> Bytes {
        coreflow_attest::preimage(&env, &claim)
    }

    pub fn next_nonce(
        env: Env,
        issuer: BytesN<32>,
        claim_type: BytesN<32>,
        subject: BytesN<32>,
    ) -> u64 {
        replay::next_nonce(&env, &issuer, &claim_type, &subject)
    }

    pub fn is_used(env: Env, issuer: BytesN<32>, claim_id: BytesN<32>) -> bool {
        replay::is_used(&env, &issuer, &claim_id)
    }

    /// Test hook: force a scope's counter.
    pub fn force_nonce(
        env: Env,
        issuer: BytesN<32>,
        claim_type: BytesN<32>,
        subject: BytesN<32>,
        value: u64,
    ) {
        testutils::set_next_nonce(&env, &issuer, &claim_type, &subject, value);
    }
}

/// Outcome of a `try_*` call that is expected to fail: either the contract
/// returned an `AttestError`, or the invocation aborted (host trap).
#[derive(Debug, PartialEq, Eq)]
pub enum Failure {
    Attest(AttestError),
    Trap,
}

/// Collapse a generated-client `try_*` result for a `Result<(), AttestError>`
/// function into `Ok(())` or a [`Failure`].
pub fn outcome<E: core::fmt::Debug>(
    r: Result<Result<(), E>, Result<AttestError, soroban_sdk::InvokeError>>,
) -> Result<(), Failure> {
    match r {
        Ok(Ok(())) => Ok(()),
        Ok(Err(e)) => panic!("unexpected conversion error: {e:?}"),
        Err(Ok(e)) => Err(Failure::Attest(e)),
        Err(Err(_)) => Err(Failure::Trap),
    }
}
