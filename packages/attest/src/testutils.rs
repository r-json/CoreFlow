//! Test helpers: a deterministic mock issuer and claim builders.
//!
//! TEST ONLY. Keys derived here are public (`MockIssuer::test(n)` derives its
//! seed from a published string). Never register them on a contract that holds
//! real value, and never enable the `testutils` feature in a contract build.

extern crate std;

use ed25519_dalek::{Signer, SigningKey};
use sha2::{Digest, Sha256};
use soroban_sdk::testutils::storage::Persistent as _;
use soroban_sdk::{BytesN, Env};

use crate::claim::{preimage, Claim, ReplayMode, PREIMAGE_LEN};

/// An Ed25519 issuer whose key is derived from a fixed seed. TEST ONLY.
pub struct MockIssuer {
    key: SigningKey,
}

impl MockIssuer {
    /// Issuer from an explicit 32-byte seed. TEST ONLY.
    pub fn from_seed(seed: &[u8; 32]) -> Self {
        Self {
            key: SigningKey::from_bytes(seed),
        }
    }

    /// Issuer number `index`, with seed `SHA-256("coreflow-test-issuer-<index>")`.
    /// Matches the issuers published in `packages/test-vectors`. TEST ONLY.
    pub fn test(index: u32) -> Self {
        let label = std::format!("coreflow-test-issuer-{index}");
        let seed: [u8; 32] = Sha256::digest(label.as_bytes()).into();
        Self::from_seed(&seed)
    }

    /// The issuer's public key, as registered in a contract.
    pub fn public_key(&self, env: &Env) -> BytesN<32> {
        BytesN::from_array(env, &self.key.verifying_key().to_bytes())
    }

    /// Sign `claim`'s preimage. The preimage depends on the verifying
    /// contract, so call this inside that contract's context, for example
    /// `env.as_contract(&contract_id, || issuer.sign(&env, &claim))`.
    pub fn sign(&self, env: &Env, claim: &Claim) -> BytesN<64> {
        let message = preimage(env, claim).to_buffer::<{ PREIMAGE_LEN as usize }>();
        BytesN::from_array(env, &self.key.sign(message.as_slice()).to_bytes())
    }

    /// A sequence-mode claim from this issuer with a raw (encoding 0) payload.
    /// All fields are public; adjust them after building to craft edge cases.
    pub fn sequence_claim(
        &self,
        env: &Env,
        claim_type: &BytesN<32>,
        subject: &BytesN<32>,
        nonce: u64,
        issued_at: u64,
        expires_at: u64,
    ) -> Claim {
        Claim {
            issuer: self.public_key(env),
            claim_type: claim_type.clone(),
            subject: subject.clone(),
            payload_hash: hash(env, b"payload"),
            payload_encoding: 0,
            replay_mode: ReplayMode::Sequence,
            nonce,
            claim_id: BytesN::from_array(env, &[0u8; 32]),
            issued_at,
            expires_at,
        }
    }

    /// A unique-id-mode claim from this issuer with a raw (encoding 0) payload.
    pub fn unique_id_claim(
        &self,
        env: &Env,
        claim_type: &BytesN<32>,
        subject: &BytesN<32>,
        claim_id: &BytesN<32>,
        issued_at: u64,
        expires_at: u64,
    ) -> Claim {
        Claim {
            issuer: self.public_key(env),
            claim_type: claim_type.clone(),
            subject: subject.clone(),
            payload_hash: hash(env, b"payload"),
            payload_encoding: 0,
            replay_mode: ReplayMode::UniqueId,
            nonce: 0,
            claim_id: claim_id.clone(),
            issued_at,
            expires_at,
        }
    }
}

/// `SHA-256(data)` as a `BytesN<32>`, for claim types, subjects and ids.
pub fn hash(env: &Env, data: &[u8]) -> BytesN<32> {
    BytesN::from_array(env, &Sha256::digest(data).into())
}

/// Overwrite the stored next nonce of a sequence scope. Call inside the
/// verifying contract's context. Lets a test reach states (such as a counter
/// at `u64::MAX`) that would otherwise take 2^64 claims.
pub fn set_next_nonce(
    env: &Env,
    issuer: &BytesN<32>,
    claim_type: &BytesN<32>,
    subject: &BytesN<32>,
    value: u64,
) {
    crate::replay::force_next_nonce(env, issuer, claim_type, subject, value);
}

/// Remaining rent (ledgers) of an issuer registry entry, or `None` if absent.
/// Call inside the verifying contract's context.
pub fn issuer_ttl(env: &Env, issuer: &BytesN<32>) -> Option<u32> {
    let key = crate::storage::StorageKey::CfaIssuer(issuer.clone());
    env.storage()
        .persistent()
        .has(&key)
        .then(|| env.storage().persistent().get_ttl(&key))
}

/// Remaining rent (ledgers) of a used-claim entry, or `None` if absent. Call
/// inside the verifying contract's context.
pub fn used_ttl(env: &Env, issuer: &BytesN<32>, claim_id: &BytesN<32>) -> Option<u32> {
    let key = crate::storage::StorageKey::CfaUsed(issuer.clone(), claim_id.clone());
    env.storage()
        .persistent()
        .has(&key)
        .then(|| env.storage().persistent().get_ttl(&key))
}

/// Rent granted to a freshly written entry, in ledgers.
pub const FRESH_TTL: u32 = crate::storage::PERSISTENT_TTL_EXTEND;
