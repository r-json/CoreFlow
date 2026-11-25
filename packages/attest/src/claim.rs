use soroban_sdk::xdr::ToXdr;
use soroban_sdk::{contracttype, Bytes, BytesN, Env};

/// Magic prefix of every preimage: ASCII `"CFCL"`.
pub const MAGIC: [u8; 4] = *b"CFCL";
/// Wire format version written into every preimage.
pub const WIRE_VERSION: u16 = 1;
/// Exact length of a preimage in bytes.
pub const PREIMAGE_LEN: u32 = 256;

/// How an issuer prevents a claim from being accepted twice.
#[contracttype]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u32)]
pub enum ReplayMode {
    /// Ordered stream per (issuer, claim_type, subject): `nonce` must equal the
    /// next expected value. `claim_id` must be all zero.
    Sequence = 0,
    /// Each (issuer, claim_id) is accepted at most once. `nonce` must be 0.
    UniqueId = 1,
}

/// A statement signed by an issuer, in the field layout of wire version 1.
///
/// The signature is passed to [`crate::verify_claim`] separately. The network
/// and verifying contract are not fields: the verifier takes them from its own
/// environment, which binds a claim to one network and one contract.
#[contracttype]
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Claim {
    /// The issuer's Ed25519 public key.
    pub issuer: BytesN<32>,
    /// `SHA-256(type string)`; separates claim kinds signed by one key.
    pub claim_type: BytesN<32>,
    /// What the claim is about, chosen by the application.
    pub subject: BytesN<32>,
    /// `SHA-256(payload)`; the payload itself travels off-chain.
    pub payload_hash: BytesN<32>,
    /// `0` = raw bytes, `1` = XDR `ScVal`. Other values are reserved and are
    /// rejected by `verify_claim` with `InvalidReplayFields`.
    pub payload_encoding: u32,
    /// Replay protection mode.
    pub replay_mode: ReplayMode,
    /// Sequence number (sequence mode); must be 0 in unique-id mode.
    pub nonce: u64,
    /// Unique identifier (unique-id mode); must be all zero in sequence mode.
    pub claim_id: BytesN<32>,
    /// Unix seconds when the issuer signed.
    pub issued_at: u64,
    /// Unix seconds after which the claim is invalid; must exceed `issued_at`.
    pub expires_at: u64,
}

/// `SHA-256` of the XDR encoding of an address.
///
/// Addresses serialize to a variable number of bytes, so hashing each to 32
/// bytes keeps the preimage fixed-width and reproducible off-chain. For a
/// contract address the hashed bytes are `0x00000012 || 0x00000001 || hash32`.
fn contract_digest(env: &Env) -> BytesN<32> {
    let xdr = env.current_contract_address().to_xdr(env);
    env.crypto().sha256(&xdr).to_bytes()
}

/// Build the 256-byte signing preimage for `claim` as seen by the contract
/// that is currently executing (spec `claim-format.md` section 2).
///
/// `network_id` comes from the ledger and `contract` from the current contract
/// address, so the result differs per network and per verifying contract. Must
/// be called from contract context.
///
/// `payload_encoding` is written as one byte. Values above 255 are written as
/// `0xFF` (reserved, never valid) rather than truncated, so they cannot alias a
/// valid encoding; `verify_claim` rejects every value other than 0 and 1.
pub fn preimage(env: &Env, claim: &Claim) -> Bytes {
    let encoding = u8::try_from(claim.payload_encoding).unwrap_or(u8::MAX);
    let mut m = Bytes::new(env);
    m.extend_from_array(&MAGIC);
    m.extend_from_array(&WIRE_VERSION.to_be_bytes());
    m.extend_from_array(&env.ledger().network_id().to_array());
    m.extend_from_array(&contract_digest(env).to_array());
    m.extend_from_array(&claim.issuer.to_array());
    m.extend_from_array(&claim.claim_type.to_array());
    m.extend_from_array(&claim.subject.to_array());
    m.extend_from_array(&claim.payload_hash.to_array());
    m.extend_from_array(&[encoding]);
    m.extend_from_array(&[claim.replay_mode as u8]);
    m.extend_from_array(&claim.nonce.to_be_bytes());
    m.extend_from_array(&claim.claim_id.to_array());
    m.extend_from_array(&claim.issued_at.to_be_bytes());
    m.extend_from_array(&claim.expires_at.to_be_bytes());
    debug_assert_eq!(m.len(), PREIMAGE_LEN);
    m
}
