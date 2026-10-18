//! Replay protection (spec section 4). State lives in persistent storage only.

use soroban_sdk::{Bytes, BytesN, Env};

use crate::claim::{Claim, ReplayMode};
use crate::error::AttestError;
use crate::storage::{put, StorageKey};

/// Digest identifying one sequence scope: `SHA-256(issuer || claim_type || subject)`.
fn scope_key(
    env: &Env,
    issuer: &BytesN<32>,
    claim_type: &BytesN<32>,
    subject: &BytesN<32>,
) -> BytesN<32> {
    let mut m = Bytes::new(env);
    m.extend_from_array(&issuer.to_array());
    m.extend_from_array(&claim_type.to_array());
    m.extend_from_array(&subject.to_array());
    env.crypto().sha256(&m).to_bytes()
}

/// The nonce a sequence-mode claim must carry next for this scope (0 for a
/// scope that has never been used). Issuers read this to sign the next claim.
pub fn next_nonce(
    env: &Env,
    issuer: &BytesN<32>,
    claim_type: &BytesN<32>,
    subject: &BytesN<32>,
) -> u64 {
    env.storage()
        .persistent()
        .get(&StorageKey::CfaSeq(scope_key(
            env, issuer, claim_type, subject,
        )))
        .unwrap_or(0u64)
}

/// True if unique-id claim `claim_id` from `issuer` was already accepted.
pub fn is_used(env: &Env, issuer: &BytesN<32>, claim_id: &BytesN<32>) -> bool {
    env.storage()
        .persistent()
        .get(&StorageKey::CfaUsed(issuer.clone(), claim_id.clone()))
        .unwrap_or(false)
}

/// Spec step 5: reject a claim that replays. Read-only.
pub(crate) fn check(env: &Env, claim: &Claim) -> Result<(), AttestError> {
    match claim.replay_mode {
        ReplayMode::Sequence => {
            // check:sequence begin
            let expected = next_nonce(env, &claim.issuer, &claim.claim_type, &claim.subject);
            if claim.nonce != expected {
                return Err(AttestError::NonceMismatch);
            }
            // check:sequence end
        }
        ReplayMode::UniqueId => {
            // check:unique-id begin
            if is_used(env, &claim.issuer, &claim.claim_id) {
                return Err(AttestError::ClaimAlreadyUsed);
            }
            // check:unique-id end
        }
    }
    Ok(())
}

/// Spec step 7: record that the claim was accepted. Only called after every
/// other check, including the signature, has passed.
pub(crate) fn consume(env: &Env, claim: &Claim) -> Result<(), AttestError> {
    match claim.replay_mode {
        ReplayMode::Sequence => {
            // check:nonce-overflow begin
            if claim.nonce == u64::MAX {
                return Err(AttestError::NonceOverflow);
            }
            // check:nonce-overflow end
            let key = StorageKey::CfaSeq(scope_key(
                env,
                &claim.issuer,
                &claim.claim_type,
                &claim.subject,
            ));
            // Cannot saturate: `nonce == u64::MAX` returned above.
            put(env, &key, &claim.nonce.saturating_add(1));
        }
        ReplayMode::UniqueId => {
            let key = StorageKey::CfaUsed(claim.issuer.clone(), claim.claim_id.clone());
            put(env, &key, &true);
        }
    }
    Ok(())
}

/// Overwrite the stored next nonce for a scope. Test helper only.
#[cfg(any(test, feature = "testutils"))]
pub(crate) fn force_next_nonce(
    env: &Env,
    issuer: &BytesN<32>,
    claim_type: &BytesN<32>,
    subject: &BytesN<32>,
    value: u64,
) {
    let key = StorageKey::CfaSeq(scope_key(env, issuer, claim_type, subject));
    put(env, &key, &value);
}
