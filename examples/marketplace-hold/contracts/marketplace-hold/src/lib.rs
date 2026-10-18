//! Marketplace payment hold released by an issuer-signed delivery claim.
//!
//! A buyer locks funds for an order. When the issuer (for example the
//! marketplace backend, which sees the carrier's delivery confirmation) signs a
//! delivery claim for that order, anyone can submit the claim and the funds go
//! to the seller. If no claim arrives before the deadline, the buyer takes the
//! funds back.
//!
//! The claim checks (issuer registry, expiry, replay protection, Ed25519
//! signature) are done by `coreflow-attest`. This contract adds what the claim
//! cannot know: which hold it applies to, and who is allowed to do what.
//!
//! Status: 0.1.0-alpha, unaudited, testnet only.
#![no_std]

use coreflow_attest::{registry, replay, verify_claim, AttestError, Claim};
use soroban_sdk::{
    contract, contracterror, contractevent, contractimpl, contracttype, token, Address, Bytes,
    BytesN, Env,
};

/// Claim type this contract accepts: `SHA-256("marketplace.delivery.v1")`.
const DELIVERY_CLAIM_TYPE: &[u8] = b"marketplace.delivery.v1";

const INSTANCE_TTL_THRESHOLD: u32 = 17_280;
const INSTANCE_TTL_EXTEND: u32 = 17_280 * 30;
const HOLD_TTL_THRESHOLD: u32 = 17_280;
const HOLD_TTL_EXTEND: u32 = 17_280 * 90;

/// Errors of this contract. Codes 1-7 are its own; 1101-1109 mirror
/// `coreflow_attest::AttestError` so clients see one set of numbers.
#[contracterror]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u32)]
pub enum HoldError {
    /// No hold with this id.
    HoldNotFound = 1,
    /// The hold was already released or refunded.
    HoldNotOpen = 2,
    /// The claim is not a `marketplace.delivery.v1` claim.
    WrongClaimType = 3,
    /// The claim's subject is not this hold's order.
    WrongSubject = 4,
    /// The refund deadline has not passed yet.
    TooEarly = 5,
    /// The amount is zero or negative.
    InvalidAmount = 6,
    /// Buyer and seller are the same address.
    SameParty = 7,

    IssuerNotRegistered = 1101,
    InvalidWindow = 1102,
    ClaimExpired = 1103,
    InvalidReplayFields = 1104,
    NonceMismatch = 1105,
    ClaimAlreadyUsed = 1106,
    NonceOverflow = 1107,
    IssuerAlreadyRegistered = 1108,
    IssuerNotFound = 1109,
}

impl From<AttestError> for HoldError {
    fn from(e: AttestError) -> Self {
        match e {
            AttestError::IssuerNotRegistered => HoldError::IssuerNotRegistered,
            AttestError::InvalidWindow => HoldError::InvalidWindow,
            AttestError::ClaimExpired => HoldError::ClaimExpired,
            AttestError::InvalidReplayFields => HoldError::InvalidReplayFields,
            AttestError::NonceMismatch => HoldError::NonceMismatch,
            AttestError::ClaimAlreadyUsed => HoldError::ClaimAlreadyUsed,
            AttestError::NonceOverflow => HoldError::NonceOverflow,
            AttestError::IssuerAlreadyRegistered => HoldError::IssuerAlreadyRegistered,
            AttestError::IssuerNotFound => HoldError::IssuerNotFound,
        }
    }
}

/// Lifecycle of a hold. Only `Open` holds can move.
#[contracttype]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u32)]
pub enum HoldStatus {
    Open = 0,
    Released = 1,
    Refunded = 2,
}

/// Funds locked for one order.
#[contracttype]
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Hold {
    pub buyer: Address,
    pub seller: Address,
    /// Stellar Asset Contract (SAC) address of the held asset.
    pub token: Address,
    pub amount: i128,
    /// What a delivery claim must name as its subject.
    pub order: BytesN<32>,
    /// Unix seconds; the buyer may refund once the ledger time is later.
    pub refund_after: u64,
    pub status: HoldStatus,
}

#[contracttype]
#[derive(Clone)]
enum DataKey {
    Admin,
    NextHoldId,
    Hold(u32),
}

#[contractevent]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HoldOpened {
    #[topic]
    pub hold_id: u32,
    pub buyer: Address,
    pub seller: Address,
    pub token: Address,
    pub amount: i128,
    pub order: BytesN<32>,
    pub refund_after: u64,
}

#[contractevent]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HoldReleased {
    #[topic]
    pub hold_id: u32,
    pub issuer: BytesN<32>,
    pub subject: BytesN<32>,
    pub amount: i128,
}

#[contractevent]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HoldRefunded {
    #[topic]
    pub hold_id: u32,
    pub buyer: Address,
    pub amount: i128,
}

#[contract]
pub struct MarketplaceHold;

#[contractimpl]
impl MarketplaceHold {
    /// Deploy-time setup: store the admin and trust the first issuer key.
    pub fn __constructor(env: Env, admin: Address, issuer: BytesN<32>) -> Result<(), HoldError> {
        env.storage().instance().set(&DataKey::Admin, &admin);
        registry::register(&env, &issuer)?;
        Ok(())
    }

    /// Lock `amount` of `token` from `buyer` for `order`. Returns the hold id.
    ///
    /// The buyer authorizes this call and, as a sub-invocation, the token
    /// transfer into the contract.
    pub fn open_hold(
        env: Env,
        buyer: Address,
        seller: Address,
        token: Address,
        amount: i128,
        order: BytesN<32>,
        refund_after: u64,
    ) -> Result<u32, HoldError> {
        // check:buyer-auth-open begin
        buyer.require_auth();
        // check:buyer-auth-open end
        // check:invalid-amount begin
        if amount <= 0 {
            return Err(HoldError::InvalidAmount);
        }
        // check:invalid-amount end
        // check:same-party begin
        if buyer == seller {
            return Err(HoldError::SameParty);
        }
        // check:same-party end

        Self::extend_instance(&env);
        let hold_id: u32 = env
            .storage()
            .instance()
            .get(&DataKey::NextHoldId)
            .unwrap_or(1u32);
        env.storage()
            .instance()
            .set(&DataKey::NextHoldId, &(hold_id + 1));

        let hold = Hold {
            buyer: buyer.clone(),
            seller: seller.clone(),
            token: token.clone(),
            amount,
            order: order.clone(),
            refund_after,
            status: HoldStatus::Open,
        };
        Self::save_hold(&env, hold_id, &hold);

        token::Client::new(&env, &token).transfer(&buyer, env.current_contract_address(), &amount);

        HoldOpened {
            hold_id,
            buyer,
            seller,
            token,
            amount,
            order,
            refund_after,
        }
        .publish(&env);
        Ok(hold_id)
    }

    /// Pay the seller once the issuer has signed a delivery claim for the
    /// hold's order. Callable by anyone: the submitter is a relayer.
    ///
    /// Why the submitter gains nothing: the recipient is the `seller` stored in
    /// the hold, never an argument. The claim and signature are fixed by the
    /// issuer: changing any field breaks the signature, and the claim is
    /// consumed on success, so it cannot be redirected or reused. The submitter
    /// only pays the fee for moving funds that belong to the seller.
    ///
    /// Order of operations: cheap checks first, then `verify_claim` (which
    /// consumes the claim), then the status write, then the token transfer. The
    /// hold is marked `Released` before funds move so no later call, including a
    /// re-entrant one from the token contract, can see it as `Open`.
    pub fn release(
        env: Env,
        hold_id: u32,
        claim: Claim,
        signature: BytesN<64>,
    ) -> Result<(), HoldError> {
        Self::extend_instance(&env);
        let mut hold = Self::load_hold(&env, hold_id)?;
        // check:hold-open-release begin
        if hold.status != HoldStatus::Open {
            return Err(HoldError::HoldNotOpen);
        }
        // check:hold-open-release end

        // check:claim-type begin
        if claim.claim_type != Self::delivery_claim_type(&env) {
            return Err(HoldError::WrongClaimType);
        }
        // check:claim-type end
        // check:subject begin
        if claim.subject != hold.order {
            return Err(HoldError::WrongSubject);
        }
        // check:subject end

        verify_claim(&env, &claim, &signature)?;

        // check:release-status begin
        hold.status = HoldStatus::Released;
        Self::save_hold(&env, hold_id, &hold);
        // check:release-status end

        token::Client::new(&env, &hold.token).transfer(
            &env.current_contract_address(),
            &hold.seller,
            &hold.amount,
        );

        HoldReleased {
            hold_id,
            issuer: claim.issuer,
            subject: claim.subject,
            amount: hold.amount,
        }
        .publish(&env);
        Ok(())
    }

    /// Return the funds to the buyer once `refund_after` has passed and no
    /// delivery claim released them.
    pub fn refund(env: Env, hold_id: u32) -> Result<(), HoldError> {
        Self::extend_instance(&env);
        let mut hold = Self::load_hold(&env, hold_id)?;
        // check:buyer-auth-refund begin
        hold.buyer.require_auth();
        // check:buyer-auth-refund end
        // check:hold-open-refund begin
        if hold.status != HoldStatus::Open {
            return Err(HoldError::HoldNotOpen);
        }
        // check:hold-open-refund end
        // check:refund-deadline begin
        if env.ledger().timestamp() <= hold.refund_after {
            return Err(HoldError::TooEarly);
        }
        // check:refund-deadline end

        // check:refund-status begin
        hold.status = HoldStatus::Refunded;
        Self::save_hold(&env, hold_id, &hold);
        // check:refund-status end

        token::Client::new(&env, &hold.token).transfer(
            &env.current_contract_address(),
            &hold.buyer,
            &hold.amount,
        );

        HoldRefunded {
            hold_id,
            buyer: hold.buyer,
            amount: hold.amount,
        }
        .publish(&env);
        Ok(())
    }

    /// Trust another issuer key (admin only).
    pub fn add_issuer(env: Env, issuer: BytesN<32>) -> Result<(), HoldError> {
        Self::require_admin(&env);
        registry::register(&env, &issuer)?;
        Ok(())
    }

    /// Stop trusting an issuer key immediately (admin only).
    pub fn remove_issuer(env: Env, issuer: BytesN<32>) -> Result<(), HoldError> {
        Self::require_admin(&env);
        registry::revoke(&env, &issuer)?;
        Ok(())
    }

    /// Replace one issuer key with another in a single call (admin only).
    pub fn rotate_issuer(env: Env, old: BytesN<32>, new: BytesN<32>) -> Result<(), HoldError> {
        Self::require_admin(&env);
        registry::rotate(&env, &old, &new)?;
        Ok(())
    }

    /// The hold with this id.
    pub fn get_hold(env: Env, hold_id: u32) -> Result<Hold, HoldError> {
        Self::load_hold(&env, hold_id)
    }

    /// True if `issuer` is a trusted issuer key.
    pub fn is_issuer(env: Env, issuer: BytesN<32>) -> bool {
        registry::is_registered(&env, &issuer)
    }

    /// The nonce the next sequence-mode claim must carry for this scope.
    pub fn next_nonce(
        env: Env,
        issuer: BytesN<32>,
        claim_type: BytesN<32>,
        subject: BytesN<32>,
    ) -> u64 {
        replay::next_nonce(&env, &issuer, &claim_type, &subject)
    }

    fn delivery_claim_type(env: &Env) -> BytesN<32> {
        env.crypto()
            .sha256(&Bytes::from_slice(env, DELIVERY_CLAIM_TYPE))
            .to_bytes()
    }

    /// Require authorization from the stored admin. `coreflow-attest` never
    /// authorizes, so every registry change goes through here first.
    fn require_admin(env: &Env) {
        // The constructor always stores the admin, so this cannot be absent.
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .expect("admin is set by the constructor");
        // check:admin-auth begin
        admin.require_auth();
        // check:admin-auth end
        Self::extend_instance(env);
    }

    fn extend_instance(env: &Env) {
        env.storage()
            .instance()
            .extend_ttl(INSTANCE_TTL_THRESHOLD, INSTANCE_TTL_EXTEND);
    }

    fn load_hold(env: &Env, hold_id: u32) -> Result<Hold, HoldError> {
        env.storage()
            .persistent()
            .get(&DataKey::Hold(hold_id))
            .ok_or(HoldError::HoldNotFound)
    }

    fn save_hold(env: &Env, hold_id: u32, hold: &Hold) {
        let key = DataKey::Hold(hold_id);
        env.storage().persistent().set(&key, hold);
        env.storage()
            .persistent()
            .extend_ttl(&key, HOLD_TTL_THRESHOLD, HOLD_TTL_EXTEND);
    }
}
