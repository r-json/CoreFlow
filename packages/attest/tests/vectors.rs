//! Cross-implementation conformance: every vector in
//! `packages/test-vectors/vectors/claim-v1.json` (produced by an independent
//! encoder) must behave identically here.

mod common;

use common::{outcome, Failure, Host, HostClient};
use coreflow_attest::{AttestError, Claim, ReplayMode};
use serde_json::Value;
use soroban_sdk::testutils::Ledger;
use soroban_sdk::{Address, BytesN, Env};
use std::path::PathBuf;

fn load() -> Value {
    let path =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../test-vectors/vectors/claim-v1.json");
    let text = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
    serde_json::from_str(&text).expect("vector file is valid JSON")
}

fn s<'a>(v: &'a Value, key: &str) -> &'a str {
    v[key]
        .as_str()
        .unwrap_or_else(|| panic!("missing string `{key}`"))
}

fn bytes32(env: &Env, v: &Value, key: &str) -> BytesN<32> {
    let raw = hex::decode(s(v, key)).unwrap();
    BytesN::from_array(env, &<[u8; 32]>::try_from(raw).expect("32 bytes"))
}

fn u64_of(v: &Value, key: &str) -> u64 {
    s(v, key).parse().unwrap()
}

fn claim_from(env: &Env, c: &Value) -> Claim {
    Claim {
        issuer: bytes32(env, c, "issuer_hex"),
        claim_type: bytes32(env, c, "claim_type_hex"),
        subject: bytes32(env, c, "subject_hex"),
        payload_hash: bytes32(env, c, "payload_hash_hex"),
        payload_encoding: c["payload_encoding"].as_u64().unwrap() as u32,
        replay_mode: match c["replay_mode"].as_u64().unwrap() {
            0 => ReplayMode::Sequence,
            1 => ReplayMode::UniqueId,
            other => panic!("unknown replay mode {other}"),
        },
        nonce: u64_of(c, "nonce"),
        claim_id: bytes32(env, c, "claim_id_hex"),
        issued_at: u64_of(c, "issued_at"),
        expires_at: u64_of(c, "expires_at"),
    }
}

/// Build the environment a vector is verified under: its network id, its
/// ledger time, and the host contract deployed at the vector's address.
fn setup(vector: &Value) -> (Env, Address) {
    let env = Env::default();
    let ctx = &vector["context"];
    let net: [u8; 32] = hex::decode(s(ctx, "network_id_hex"))
        .unwrap()
        .try_into()
        .unwrap();
    env.ledger().set_network_id(net);
    env.ledger().set_timestamp(u64_of(vector, "now"));
    let address = Address::from_str(&env, s(ctx, "contract_id"));
    env.register_at(&address, Host, ());
    (env, address)
}

fn signature(env: &Env, vector: &Value) -> BytesN<64> {
    let raw = hex::decode(s(vector, "signature_hex")).unwrap();
    BytesN::from_array(env, &<[u8; 64]>::try_from(raw).expect("64 bytes"))
}

fn attest_error(name: &str) -> AttestError {
    match name {
        "IssuerNotRegistered" => AttestError::IssuerNotRegistered,
        "InvalidWindow" => AttestError::InvalidWindow,
        "ClaimExpired" => AttestError::ClaimExpired,
        "InvalidReplayFields" => AttestError::InvalidReplayFields,
        "NonceMismatch" => AttestError::NonceMismatch,
        "ClaimAlreadyUsed" => AttestError::ClaimAlreadyUsed,
        "NonceOverflow" => AttestError::NonceOverflow,
        "IssuerAlreadyRegistered" => AttestError::IssuerAlreadyRegistered,
        "IssuerNotFound" => AttestError::IssuerNotFound,
        other => panic!("vector names an unknown error `{other}`"),
    }
}

#[test]
fn vector_file_has_the_expected_shape() {
    let doc = load();
    assert_eq!(doc["version"], 1);
    assert_eq!(doc["valid"].as_array().unwrap().len(), 6);
    assert_eq!(doc["invalid"].as_array().unwrap().len(), 10);
}

#[test]
fn valid_vectors_build_the_same_preimage_and_verify() {
    let doc = load();
    let mut checked = 0;
    for vector in doc["valid"].as_array().unwrap() {
        let name = s(vector, "name");
        let (env, address) = setup(vector);
        let client = HostClient::new(&env, &address);
        let claim = claim_from(&env, &vector["claim"]);
        client.register_issuer(&claim.issuer);

        // The preimage rebuilt on-chain is byte-identical to the encoder's.
        let expected = hex::decode(s(vector, "preimage_hex")).unwrap();
        assert_eq!(
            client.preimage(&claim).to_alloc_vec(),
            expected,
            "{name}: preimage"
        );

        let sig = signature(&env, vector);
        if claim.replay_mode == ReplayMode::Sequence && claim.nonce == u64::MAX {
            // A counter can reach u64::MAX (after nonce MAX-1 is accepted) but
            // a claim carrying it can never be consumed: step 7 refuses to
            // overflow. Reaching NonceOverflow proves steps 1-6, including the
            // signature, passed.
            client.force_nonce(
                &claim.issuer,
                &claim.claim_type,
                &claim.subject,
                &claim.nonce,
            );
            assert_eq!(
                outcome(client.try_verify(&claim, &sig)),
                Err(Failure::Attest(AttestError::NonceOverflow)),
                "{name}: signature accepted, counter exhausted"
            );
        } else {
            if claim.replay_mode == ReplayMode::Sequence && claim.nonce > 0 {
                client.force_nonce(
                    &claim.issuer,
                    &claim.claim_type,
                    &claim.subject,
                    &claim.nonce,
                );
            }
            assert_eq!(
                outcome(client.try_verify(&claim, &sig)),
                Ok(()),
                "{name}: verify"
            );
            // The same claim cannot be accepted twice.
            let replay = outcome(client.try_verify(&claim, &sig));
            let expected_error = match claim.replay_mode {
                ReplayMode::Sequence => AttestError::NonceMismatch,
                ReplayMode::UniqueId => AttestError::ClaimAlreadyUsed,
            };
            assert_eq!(
                replay,
                Err(Failure::Attest(expected_error)),
                "{name}: replay"
            );
        }
        checked += 1;
    }
    assert_eq!(checked, 6);
}

#[test]
fn invalid_vectors_fail_as_declared() {
    let doc = load();
    let mut checked = 0;
    for vector in doc["invalid"].as_array().unwrap() {
        let name = s(vector, "name");
        let (env, address) = setup(vector);
        let client = HostClient::new(&env, &address);
        let claim = claim_from(&env, &vector["claim"]);
        client.register_issuer(&claim.issuer);

        let result = outcome(client.try_verify(&claim, &signature(&env, vector)));
        match s(vector, "expected_error") {
            // `ed25519_verify` aborts the invocation; there is no error code.
            "InvalidSignature" => assert_eq!(result, Err(Failure::Trap), "{name}"),
            declared => assert_eq!(
                result,
                Err(Failure::Attest(attest_error(declared))),
                "{name}"
            ),
        }
        checked += 1;
    }
    assert_eq!(checked, 10);
}
