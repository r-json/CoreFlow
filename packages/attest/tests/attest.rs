//! Behavior tests for `coreflow-attest`, one positive and one negative case per
//! check in `verify_claim` plus the registry and replay state machines.

mod common;

use common::{outcome, Failure, Host, HostClient};
use coreflow_attest::testutils::{hash, issuer_ttl, used_ttl, MockIssuer, FRESH_TTL};
use coreflow_attest::{AttestError, Claim, ReplayMode};
use soroban_sdk::testutils::{Events, Ledger};
use soroban_sdk::{Address, BytesN, Env};

const T0: u64 = 1_790_000_000;
const TTL: u64 = 3_600;

/// A named in-place edit of a claim.
type Mutation<'a> = (&'static str, Box<dyn Fn(&mut Claim) + 'a>);

fn err(e: AttestError) -> Result<(), Failure> {
    Err(Failure::Attest(e))
}

struct Fx {
    env: Env,
    id: Address,
    issuer: MockIssuer,
    claim_type: BytesN<32>,
    subject: BytesN<32>,
}

impl Fx {
    /// Fresh environment, host contract, clock at `T0 + 60`. No issuer registered.
    fn bare() -> Self {
        let env = Env::default();
        env.ledger().set_timestamp(T0 + 60);
        let id = env.register(Host, ());
        let claim_type = hash(&env, b"marketplace.delivery.v1");
        let subject = hash(&env, b"order:42");
        Fx {
            env,
            id,
            issuer: MockIssuer::test(0),
            claim_type,
            subject,
        }
    }

    /// `bare()` plus issuer 0 registered.
    fn new() -> Self {
        let fx = Self::bare();
        fx.client().register_issuer(&fx.pk());
        fx
    }

    fn client(&self) -> HostClient<'_> {
        HostClient::new(&self.env, &self.id)
    }

    fn pk(&self) -> BytesN<32> {
        self.issuer.public_key(&self.env)
    }

    fn set_now(&self, t: u64) {
        self.env.ledger().set_timestamp(t);
    }

    /// Sign as `signer` inside the context of contract `at`.
    fn sign_with(&self, signer: &MockIssuer, at: &Address, claim: &Claim) -> BytesN<64> {
        self.env.as_contract(at, || signer.sign(&self.env, claim))
    }

    /// Sign with issuer 0 for the host under test.
    fn sign(&self, claim: &Claim) -> BytesN<64> {
        self.sign_with(&self.issuer, &self.id, claim)
    }

    fn seq(&self, nonce: u64) -> Claim {
        self.issuer.sequence_claim(
            &self.env,
            &self.claim_type,
            &self.subject,
            nonce,
            T0,
            T0 + TTL,
        )
    }

    fn uid(&self, label: &[u8]) -> Claim {
        self.issuer.unique_id_claim(
            &self.env,
            &self.claim_type,
            &self.subject,
            &hash(&self.env, label),
            T0,
            T0 + TTL,
        )
    }

    /// Sign with issuer 0 and verify.
    fn submit(&self, claim: &Claim) -> Result<(), Failure> {
        let sig = self.sign(claim);
        self.verify(claim, &sig)
    }

    fn verify(&self, claim: &Claim, sig: &BytesN<64>) -> Result<(), Failure> {
        outcome(self.client().try_verify(claim, sig))
    }

    fn next_nonce(&self) -> u64 {
        self.client()
            .next_nonce(&self.pk(), &self.claim_type, &self.subject)
    }
}

// ---------- registry ----------

#[test]
fn registered_issuer_is_accepted() {
    let fx = Fx::new();
    assert!(fx.client().is_registered(&fx.pk()));
    assert_eq!(fx.submit(&fx.seq(0)), Ok(()));
}

#[test]
fn unregistered_issuer_is_rejected() {
    let fx = Fx::bare();
    assert!(!fx.client().is_registered(&fx.pk()));
    assert_eq!(fx.submit(&fx.seq(0)), err(AttestError::IssuerNotRegistered));
}

#[test]
fn registering_twice_fails() {
    let fx = Fx::new();
    assert_eq!(
        outcome(fx.client().try_register_issuer(&fx.pk())),
        err(AttestError::IssuerAlreadyRegistered)
    );
}

#[test]
fn revoke_unknown_issuer_fails() {
    let fx = Fx::bare();
    assert_eq!(
        outcome(fx.client().try_revoke_issuer(&fx.pk())),
        err(AttestError::IssuerNotFound)
    );
}

#[test]
fn rotate_unknown_old_key_fails_and_changes_nothing() {
    let fx = Fx::bare();
    let new = MockIssuer::test(1).public_key(&fx.env);
    assert_eq!(
        outcome(fx.client().try_rotate_issuer(&fx.pk(), &new)),
        err(AttestError::IssuerNotFound)
    );
    assert!(!fx.client().is_registered(&new));
}

#[test]
fn rotate_to_registered_key_fails_and_changes_nothing() {
    let fx = Fx::new();
    let other = MockIssuer::test(1).public_key(&fx.env);
    fx.client().register_issuer(&other);
    assert_eq!(
        outcome(fx.client().try_rotate_issuer(&fx.pk(), &other)),
        err(AttestError::IssuerAlreadyRegistered)
    );
    assert!(fx.client().is_registered(&fx.pk()));
    // Rotating a key onto itself is the same conflict.
    assert_eq!(
        outcome(fx.client().try_rotate_issuer(&fx.pk(), &fx.pk())),
        err(AttestError::IssuerAlreadyRegistered)
    );
    assert!(fx.client().is_registered(&fx.pk()));
}

#[test]
fn revoked_issuer_is_rejected_even_for_a_claim_signed_earlier() {
    let fx = Fx::new();
    let claim = fx.seq(0);
    let sig = fx.sign(&claim);
    fx.client().revoke_issuer(&fx.pk());
    assert!(!fx.client().is_registered(&fx.pk()));
    assert_eq!(
        fx.verify(&claim, &sig),
        err(AttestError::IssuerNotRegistered)
    );
}

#[test]
fn revoked_issuer_can_be_registered_again() {
    let fx = Fx::new();
    fx.client().revoke_issuer(&fx.pk());
    fx.client().register_issuer(&fx.pk());
    assert_eq!(fx.submit(&fx.seq(0)), Ok(()));
}

#[test]
fn rotate_rejects_old_key_and_accepts_new_key() {
    let fx = Fx::new();
    let successor = MockIssuer::test(1);
    let new_pk = successor.public_key(&fx.env);

    let old_claim = fx.seq(0);
    let old_sig = fx.sign(&old_claim);
    fx.client().rotate_issuer(&fx.pk(), &new_pk);

    assert!(!fx.client().is_registered(&fx.pk()));
    assert!(fx.client().is_registered(&new_pk));
    assert_eq!(
        fx.verify(&old_claim, &old_sig),
        err(AttestError::IssuerNotRegistered)
    );

    let new_claim = successor.sequence_claim(&fx.env, &fx.claim_type, &fx.subject, 0, T0, T0 + TTL);
    let new_sig = fx.sign_with(&successor, &fx.id, &new_claim);
    assert_eq!(fx.verify(&new_claim, &new_sig), Ok(()));
}

#[test]
fn registry_operations_publish_events() {
    let fx = Fx::bare();
    let other = MockIssuer::test(1).public_key(&fx.env);
    fx.client().register_issuer(&fx.pk());
    assert_eq!(fx.env.events().all().events().len(), 1);
    fx.client().rotate_issuer(&fx.pk(), &other);
    assert_eq!(fx.env.events().all().events().len(), 1);
    fx.client().revoke_issuer(&other);
    assert_eq!(fx.env.events().all().events().len(), 1);
}

#[test]
fn registry_and_replay_entries_get_persistent_rent() {
    let fx = Fx::new();
    let claim = fx.uid(b"claim-1");
    fx.submit(&claim).unwrap();
    let (issuer_ttl, used_ttl) = fx.env.as_contract(&fx.id, || {
        (
            issuer_ttl(&fx.env, &claim.issuer),
            used_ttl(&fx.env, &claim.issuer, &claim.claim_id),
        )
    });
    assert_eq!(issuer_ttl, Some(FRESH_TTL));
    assert_eq!(used_ttl, Some(FRESH_TTL));
}

// ---------- window and expiry ----------

#[test]
fn window_must_be_positive() {
    let fx = Fx::new();
    let mut empty = fx.seq(0);
    empty.expires_at = empty.issued_at;
    assert_eq!(fx.submit(&empty), err(AttestError::InvalidWindow));

    let mut inverted = fx.seq(0);
    inverted.expires_at = inverted.issued_at - 1;
    assert_eq!(fx.submit(&inverted), err(AttestError::InvalidWindow));

    // One second is the smallest valid window.
    let mut one_second = fx.seq(0);
    one_second.expires_at = one_second.issued_at + 1;
    fx.set_now(one_second.issued_at);
    assert_eq!(fx.submit(&one_second), Ok(()));
}

#[test]
fn window_is_checked_before_expiry() {
    let fx = Fx::new();
    let mut claim = fx.seq(0);
    claim.expires_at = claim.issued_at;
    fx.set_now(claim.expires_at + 10);
    assert_eq!(fx.submit(&claim), err(AttestError::InvalidWindow));
}

#[test]
fn claim_at_exact_expiry_is_accepted() {
    let fx = Fx::new();
    let claim = fx.seq(0);
    fx.set_now(claim.expires_at);
    assert_eq!(fx.submit(&claim), Ok(()));
}

#[test]
fn claim_one_second_past_expiry_is_rejected() {
    let fx = Fx::new();
    let claim = fx.seq(0);
    fx.set_now(claim.expires_at + 1);
    assert_eq!(fx.submit(&claim), err(AttestError::ClaimExpired));
    assert_eq!(fx.next_nonce(), 0);
}

#[test]
fn claim_issued_in_the_future_is_not_rejected() {
    let fx = Fx::new();
    let claim = fx.seq(0);
    fx.set_now(claim.issued_at - 100);
    assert_eq!(fx.submit(&claim), Ok(()));
}

// ---------- replay fields ----------

#[test]
fn sequence_claim_with_claim_id_is_rejected() {
    let fx = Fx::new();
    let mut claim = fx.seq(0);
    claim.claim_id = hash(&fx.env, b"x");
    assert_eq!(fx.submit(&claim), err(AttestError::InvalidReplayFields));
}

#[test]
fn unique_id_claim_with_nonce_is_rejected() {
    let fx = Fx::new();
    let mut claim = fx.uid(b"claim-1");
    claim.nonce = 1;
    assert_eq!(fx.submit(&claim), err(AttestError::InvalidReplayFields));
}

#[test]
fn well_formed_claims_of_both_modes_are_accepted() {
    let fx = Fx::new();
    assert_eq!(fx.submit(&fx.seq(0)), Ok(()));
    assert_eq!(fx.submit(&fx.uid(b"claim-1")), Ok(()));
}

#[test]
fn reserved_payload_encodings_are_rejected() {
    let fx = Fx::new();
    for encoding in [2u32, 3, 255, 256, u32::MAX] {
        let mut claim = fx.seq(0);
        claim.payload_encoding = encoding;
        assert_eq!(
            fx.submit(&claim),
            err(AttestError::InvalidReplayFields),
            "encoding {encoding}"
        );
    }
    assert_eq!(fx.next_nonce(), 0);
}

#[test]
fn both_defined_payload_encodings_are_accepted() {
    let fx = Fx::new();
    let mut raw = fx.seq(0);
    raw.payload_encoding = 0;
    assert_eq!(fx.submit(&raw), Ok(()));
    let mut xdr = fx.seq(1);
    xdr.payload_encoding = 1;
    assert_eq!(fx.submit(&xdr), Ok(()));
}

// ---------- sequence mode ----------

#[test]
fn sequence_accepts_next_nonce_and_advances() {
    let fx = Fx::new();
    assert_eq!(fx.next_nonce(), 0);
    assert_eq!(fx.submit(&fx.seq(0)), Ok(()));
    assert_eq!(fx.next_nonce(), 1);
    assert_eq!(fx.submit(&fx.seq(1)), Ok(()));
    assert_eq!(fx.next_nonce(), 2);
}

#[test]
fn sequence_rejects_a_replayed_claim() {
    let fx = Fx::new();
    let claim = fx.seq(0);
    let sig = fx.sign(&claim);
    assert_eq!(fx.verify(&claim, &sig), Ok(()));
    assert_eq!(fx.verify(&claim, &sig), err(AttestError::NonceMismatch));
}

#[test]
fn sequence_rejects_a_skipped_nonce() {
    let fx = Fx::new();
    assert_eq!(fx.submit(&fx.seq(1)), err(AttestError::NonceMismatch));
    assert_eq!(fx.next_nonce(), 0);
    assert_eq!(fx.submit(&fx.seq(0)), Ok(()));
    assert_eq!(fx.submit(&fx.seq(2)), err(AttestError::NonceMismatch));
}

#[test]
fn sequence_scopes_are_independent() {
    let fx = Fx::new();
    assert_eq!(fx.submit(&fx.seq(0)), Ok(()));

    // Different subject.
    let mut other_subject = fx.seq(0);
    other_subject.subject = hash(&fx.env, b"order:43");
    assert_eq!(fx.submit(&other_subject), Ok(()));

    // Different claim type.
    let mut other_type = fx.seq(0);
    other_type.claim_type = hash(&fx.env, b"marketplace.refund.v1");
    assert_eq!(fx.submit(&other_type), Ok(()));

    // Different issuer.
    let second = MockIssuer::test(1);
    fx.client().register_issuer(&second.public_key(&fx.env));
    let other_issuer = second.sequence_claim(&fx.env, &fx.claim_type, &fx.subject, 0, T0, T0 + TTL);
    let sig = fx.sign_with(&second, &fx.id, &other_issuer);
    assert_eq!(fx.verify(&other_issuer, &sig), Ok(()));

    // The original scope advanced exactly once.
    assert_eq!(fx.next_nonce(), 1);
}

#[test]
fn sequence_counter_at_max_overflows_instead_of_wrapping() {
    let fx = Fx::new();
    fx.client()
        .force_nonce(&fx.pk(), &fx.claim_type, &fx.subject, &(u64::MAX - 1));
    assert_eq!(fx.submit(&fx.seq(u64::MAX - 1)), Ok(()));
    assert_eq!(fx.next_nonce(), u64::MAX);
    assert_eq!(
        fx.submit(&fx.seq(u64::MAX)),
        err(AttestError::NonceOverflow)
    );
    assert_eq!(fx.next_nonce(), u64::MAX);
}

// ---------- unique-id mode ----------

#[test]
fn unique_id_rejects_reuse() {
    let fx = Fx::new();
    let claim = fx.uid(b"claim-1");
    assert!(!fx.client().is_used(&claim.issuer, &claim.claim_id));
    assert_eq!(fx.submit(&claim), Ok(()));
    assert!(fx.client().is_used(&claim.issuer, &claim.claim_id));
    assert_eq!(fx.submit(&claim), err(AttestError::ClaimAlreadyUsed));
}

#[test]
fn unique_id_accepts_distinct_ids_in_any_order() {
    let fx = Fx::new();
    assert_eq!(fx.submit(&fx.uid(b"claim-b")), Ok(()));
    assert_eq!(fx.submit(&fx.uid(b"claim-a")), Ok(()));
    assert_eq!(fx.submit(&fx.uid(b"claim-c")), Ok(()));
}

#[test]
fn unique_id_is_scoped_per_issuer() {
    let fx = Fx::new();
    let second = MockIssuer::test(1);
    fx.client().register_issuer(&second.public_key(&fx.env));
    let id = hash(&fx.env, b"shared-id");

    let first_claim =
        fx.issuer
            .unique_id_claim(&fx.env, &fx.claim_type, &fx.subject, &id, T0, T0 + TTL);
    let second_claim =
        second.unique_id_claim(&fx.env, &fx.claim_type, &fx.subject, &id, T0, T0 + TTL);
    assert_eq!(fx.submit(&first_claim), Ok(()));
    let sig = fx.sign_with(&second, &fx.id, &second_claim);
    assert_eq!(fx.verify(&second_claim, &sig), Ok(()));
}

#[test]
fn unique_id_does_not_touch_the_sequence_counter() {
    let fx = Fx::new();
    assert_eq!(fx.submit(&fx.uid(b"claim-1")), Ok(()));
    assert_eq!(fx.next_nonce(), 0);
}

// ---------- signature ----------

#[test]
fn signature_from_the_wrong_key_traps() {
    let fx = Fx::new();
    let claim = fx.seq(0);
    let intruder = MockIssuer::test(1);
    let sig = fx.sign_with(&intruder, &fx.id, &claim);
    assert_eq!(fx.verify(&claim, &sig), Err(Failure::Trap));
}

#[test]
fn zero_signature_traps() {
    let fx = Fx::new();
    let sig = BytesN::from_array(&fx.env, &[0u8; 64]);
    assert_eq!(fx.verify(&fx.seq(0), &sig), Err(Failure::Trap));
}

#[test]
fn every_tampered_field_invalidates_the_signature() {
    let fx = Fx::new();
    let sig = fx.sign(&fx.seq(0));
    let other = hash(&fx.env, b"tampered");
    let mutations: [Mutation<'_>; 6] = [
        ("subject", Box::new(|c| c.subject = other.clone())),
        ("claim_type", Box::new(|c| c.claim_type = other.clone())),
        ("payload_hash", Box::new(|c| c.payload_hash = other.clone())),
        ("payload_encoding", Box::new(|c| c.payload_encoding = 1)),
        ("issued_at", Box::new(|c| c.issued_at += 1)),
        ("expires_at", Box::new(|c| c.expires_at += 1)),
    ];
    // A trapped call consumes nothing, so every tampered claim reaches the
    // signature check with a passing replay state and only the signature can
    // reject it.
    for (name, mutate) in mutations {
        let mut tampered = fx.seq(0);
        mutate(&mut tampered);
        assert_eq!(fx.verify(&tampered, &sig), Err(Failure::Trap), "{name}");
    }
    // The untampered claim still verifies with the same signature.
    assert_eq!(fx.verify(&fx.seq(0), &sig), Ok(()));
}

#[test]
fn tampered_replay_fields_invalidate_the_signature() {
    let fx = Fx::new();
    // Unique-id claim signed with one id, submitted with another.
    let signed = fx.uid(b"claim-1");
    let sig = fx.sign(&signed);
    let mut other_id = signed.clone();
    other_id.claim_id = hash(&fx.env, b"claim-2");
    assert_eq!(fx.verify(&other_id, &sig), Err(Failure::Trap));

    // Sequence claim signed for nonce 0, mode flipped to unique-id with a
    // fresh id so steps 1-5 pass.
    let seq = fx.seq(0);
    let seq_sig = fx.sign(&seq);
    let mut flipped = seq.clone();
    flipped.replay_mode = ReplayMode::UniqueId;
    flipped.claim_id = hash(&fx.env, b"claim-3");
    assert_eq!(fx.verify(&flipped, &seq_sig), Err(Failure::Trap));
}

#[test]
fn signature_for_another_contract_traps() {
    let fx = Fx::new();
    let other_contract = fx.env.register(Host, ());
    let claim = fx.seq(0);
    let sig = fx.sign_with(&fx.issuer, &other_contract, &claim);
    assert_eq!(fx.verify(&claim, &sig), Err(Failure::Trap));
    // The same signature is valid at the contract it was made for.
    let other_client = HostClient::new(&fx.env, &other_contract);
    other_client.register_issuer(&fx.pk());
    assert_eq!(outcome(other_client.try_verify(&claim, &sig)), Ok(()));
}

#[test]
fn signature_for_another_network_traps() {
    let fx = Fx::new();
    fx.env.ledger().set_network_id([1u8; 32]);
    let claim = fx.seq(0);
    let sig = fx.sign(&claim);
    assert_eq!(fx.verify(&claim, &sig), Ok(()));

    let claim_again = fx.seq(1);
    let sig_again = fx.sign(&claim_again);
    fx.env.ledger().set_network_id([2u8; 32]);
    assert_eq!(fx.verify(&claim_again, &sig_again), Err(Failure::Trap));
}

// ---------- failed verification leaves state unchanged ----------

#[test]
fn failed_verification_leaves_replay_state_unchanged() {
    let fx = Fx::new();
    let seq = fx.seq(0);
    let uid = fx.uid(b"claim-1");
    let bad = BytesN::from_array(&fx.env, &[7u8; 64]);

    assert_eq!(fx.verify(&seq, &bad), Err(Failure::Trap));
    assert_eq!(fx.verify(&uid, &bad), Err(Failure::Trap));
    assert_eq!(fx.next_nonce(), 0);
    assert!(!fx.client().is_used(&uid.issuer, &uid.claim_id));

    // Each claim is still acceptable with its real signature.
    assert_eq!(fx.submit(&seq), Ok(()));
    assert_eq!(fx.submit(&uid), Ok(()));
}

#[test]
fn rejected_claims_are_not_consumed() {
    let fx = Fx::new();
    let mut expired = fx.uid(b"claim-1");
    expired.expires_at = T0 + 10;
    assert_eq!(fx.submit(&expired), err(AttestError::ClaimExpired));
    assert!(!fx.client().is_used(&expired.issuer, &expired.claim_id));
    assert_eq!(fx.next_nonce(), 0);
}

// ---------- verification order ----------

#[test]
fn checks_run_in_spec_order() {
    let fx = Fx::bare();
    // Everything wrong at once: unregistered issuer wins.
    let mut claim = fx.seq(5);
    claim.expires_at = claim.issued_at;
    claim.claim_id = hash(&fx.env, b"x");
    claim.payload_encoding = 9;
    let junk = BytesN::from_array(&fx.env, &[0u8; 64]);
    assert_eq!(
        fx.verify(&claim, &junk),
        err(AttestError::IssuerNotRegistered)
    );

    fx.client().register_issuer(&fx.pk());
    assert_eq!(fx.verify(&claim, &junk), err(AttestError::InvalidWindow));

    claim.expires_at = claim.issued_at + 1; // already expired at now = T0 + 60
    assert_eq!(fx.verify(&claim, &junk), err(AttestError::ClaimExpired));

    claim.expires_at = T0 + TTL;
    assert_eq!(
        fx.verify(&claim, &junk),
        err(AttestError::InvalidReplayFields)
    );

    claim.claim_id = BytesN::from_array(&fx.env, &[0u8; 32]);
    assert_eq!(
        fx.verify(&claim, &junk),
        err(AttestError::InvalidReplayFields)
    );

    claim.payload_encoding = 0;
    assert_eq!(fx.verify(&claim, &junk), err(AttestError::NonceMismatch));

    claim.nonce = 0;
    assert_eq!(fx.verify(&claim, &junk), Err(Failure::Trap));
}

#[test]
fn unique_id_replay_is_checked_before_the_signature() {
    let fx = Fx::new();
    let claim = fx.uid(b"claim-1");
    assert_eq!(fx.submit(&claim), Ok(()));
    let junk = BytesN::from_array(&fx.env, &[0u8; 64]);
    assert_eq!(fx.verify(&claim, &junk), err(AttestError::ClaimAlreadyUsed));
}

// ---------- preimage layout ----------

#[test]
fn preimage_is_256_bytes_in_spec_layout() {
    let fx = Fx::new();
    let mut claim = fx.uid(b"claim-1");
    claim.payload_encoding = 1;
    claim.issued_at = 0x0102_0304_0506_0708;
    claim.expires_at = 0x1112_1314_1516_1718;
    let p = fx.client().preimage(&claim).to_alloc_vec();
    assert_eq!(p.len(), 256);
    assert_eq!(&p[0..4], b"CFCL");
    assert_eq!(&p[4..6], &[0, 1]);
    assert_eq!(&p[6..38], &fx.env.ledger().network_id().to_array());
    assert_eq!(&p[70..102], &claim.issuer.to_array());
    assert_eq!(&p[102..134], &claim.claim_type.to_array());
    assert_eq!(&p[134..166], &claim.subject.to_array());
    assert_eq!(&p[166..198], &claim.payload_hash.to_array());
    assert_eq!(p[198], 1);
    assert_eq!(p[199], 1);
    assert_eq!(&p[200..208], &[0u8; 8]);
    assert_eq!(&p[208..240], &claim.claim_id.to_array());
    assert_eq!(&p[240..248], &0x0102_0304_0506_0708u64.to_be_bytes());
    assert_eq!(&p[248..256], &0x1112_1314_1516_1718u64.to_be_bytes());
}

#[test]
fn preimage_binds_the_contract_and_the_network() {
    let fx = Fx::new();
    let other = fx.env.register(Host, ());
    let claim = fx.seq(0);
    let here = fx.client().preimage(&claim);
    let there = HostClient::new(&fx.env, &other).preimage(&claim);
    assert_ne!(here, there);
    assert_eq!(&here.to_alloc_vec()[6..38], &there.to_alloc_vec()[6..38]);
    assert_ne!(&here.to_alloc_vec()[38..70], &there.to_alloc_vec()[38..70]);

    fx.env.ledger().set_network_id([9u8; 32]);
    let elsewhere = fx.client().preimage(&claim);
    assert_ne!(here, elsewhere);
}

#[test]
fn oversized_payload_encoding_never_aliases_a_valid_one() {
    let fx = Fx::new();
    let mut zero = fx.seq(0);
    zero.payload_encoding = 0;
    let mut wrapped = fx.seq(0);
    wrapped.payload_encoding = 256;
    assert_ne!(
        fx.client().preimage(&zero).to_alloc_vec()[198],
        fx.client().preimage(&wrapped).to_alloc_vec()[198]
    );
}

// ---------- mock issuer ----------

#[test]
fn mock_issuer_matches_published_test_keys() {
    let env = Env::default();
    // seed = SHA-256("coreflow-test-issuer-0"), public key from the vectors.
    let pk = MockIssuer::test(0).public_key(&env).to_array();
    assert_eq!(
        pk,
        <[u8; 32]>::try_from(
            hex::decode("b35fe662038bcced74729876b2bf3cd3875594e93626e7890b2bc70821eef120")
                .unwrap()
        )
        .unwrap()
    );
    assert_ne!(pk, MockIssuer::test(1).public_key(&env).to_array());
    assert_eq!(
        MockIssuer::from_seed(&[5u8; 32]).public_key(&env),
        MockIssuer::from_seed(&[5u8; 32]).public_key(&env)
    );
}

// ---------- replay state across registry changes ----------

/// Revoking and re-registering a key must not reset its replay state: an
/// admin cycling a key would otherwise make every claim it ever signed valid
/// again.
#[test]
fn replay_state_survives_revoke_and_reregister() {
    let fx = Fx::new();
    let used = fx.uid(b"claim-reuse");
    assert_eq!(fx.submit(&fx.seq(0)), Ok(()));
    assert_eq!(fx.submit(&used), Ok(()));

    fx.client().revoke_issuer(&fx.pk());
    fx.client().register_issuer(&fx.pk());

    assert_eq!(fx.next_nonce(), 1);
    assert_eq!(fx.submit(&fx.seq(0)), err(AttestError::NonceMismatch));
    assert_eq!(fx.submit(&used), err(AttestError::ClaimAlreadyUsed));
    assert_eq!(fx.submit(&fx.seq(1)), Ok(()));
}

/// With an unknown `old` and an already-registered `new`, rotate reports the
/// missing key: that is the problem the caller has to fix first.
#[test]
fn rotate_reports_unknown_old_before_duplicate_new() {
    let fx = Fx::new();
    let unknown = MockIssuer::test(7).public_key(&fx.env);
    assert_eq!(
        outcome(fx.client().try_rotate_issuer(&unknown, &fx.pk())),
        err(AttestError::IssuerNotFound)
    );
}
