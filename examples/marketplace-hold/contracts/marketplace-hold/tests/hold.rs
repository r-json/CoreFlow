//! Contract tests. A real Stellar Asset Contract holds the funds, and every
//! call that needs authorization runs under a precise `mock_auths` entry for
//! exactly the signer and arguments under test; `mock_all_auths` is never used.

use coreflow_attest::testutils::{hash, MockIssuer};
use coreflow_attest::{Claim, ReplayMode};
use marketplace_hold::{Hold, HoldError, HoldStatus, MarketplaceHold, MarketplaceHoldClient};
use soroban_sdk::testutils::{Address as _, Ledger, MockAuth, MockAuthInvoke};
use soroban_sdk::token::{Client as TokenClient, StellarAssetClient};
use soroban_sdk::{Address, BytesN, Env, IntoVal, InvokeError, Val, Vec};

const T0: u64 = 1_790_000_000;
const AMOUNT: i128 = 100_000_000; // 10 units of a 7-decimal asset
const REFUND_AFTER: u64 = T0 + 3_600;
const CLAIM_LIFETIME: u64 = 900;

#[derive(Debug, PartialEq, Eq)]
enum Fail {
    Hold(HoldError),
    /// The invocation aborted: a failed authorization or a bad signature.
    Trap,
}

fn outcome<T: core::fmt::Debug, E: core::fmt::Debug>(
    r: Result<Result<T, E>, Result<HoldError, InvokeError>>,
) -> Result<T, Fail> {
    match r {
        Ok(Ok(v)) => Ok(v),
        Ok(Err(e)) => panic!("unexpected conversion error: {e:?}"),
        Err(Ok(e)) => Err(Fail::Hold(e)),
        Err(Err(_)) => Err(Fail::Trap),
    }
}

fn hold_err(e: HoldError) -> Fail {
    Fail::Hold(e)
}

struct Fx {
    env: Env,
    hold: Address,
    token: Address,
    admin: Address,
    buyer: Address,
    seller: Address,
    attacker: Address,
    issuer: MockIssuer,
    order: BytesN<32>,
}

impl Fx {
    /// Contract deployed with issuer 0 registered, buyer funded with 3x AMOUNT.
    fn new() -> Self {
        let env = Env::default();
        env.ledger().set_timestamp(T0 + 60);
        let admin = Address::generate(&env);
        let buyer = Address::generate(&env);
        let seller = Address::generate(&env);
        let attacker = Address::generate(&env);
        let token_admin = Address::generate(&env);
        let token = env
            .register_stellar_asset_contract_v2(token_admin.clone())
            .address();
        let issuer = MockIssuer::test(0);
        let hold = env.register(MarketplaceHold, (admin.clone(), issuer.public_key(&env)));
        let order = hash(&env, b"order:42");

        let fx = Fx {
            env,
            hold,
            token,
            admin,
            buyer,
            seller,
            attacker,
            issuer,
            order,
        };
        // Mint under the token admin's own authorization only.
        let mint = 3 * AMOUNT;
        StellarAssetClient::new(&fx.env, &fx.token)
            .mock_auths(&[MockAuth {
                address: &token_admin,
                invoke: &MockAuthInvoke {
                    contract: &fx.token,
                    fn_name: "mint",
                    args: (fx.buyer.clone(), mint).into_val(&fx.env),
                    sub_invokes: &[],
                },
            }])
            .mint(&fx.buyer, &mint);
        fx
    }

    fn client(&self) -> MarketplaceHoldClient<'_> {
        MarketplaceHoldClient::new(&self.env, &self.hold)
    }

    fn balance(&self, who: &Address) -> i128 {
        TokenClient::new(&self.env, &self.token).balance(who)
    }

    fn delivery_type(&self) -> BytesN<32> {
        hash(&self.env, b"marketplace.delivery.v1")
    }

    fn set_now(&self, t: u64) {
        self.env.ledger().set_timestamp(t);
    }

    // ----- auth builders -----

    fn auth<'a>(
        &'a self,
        signer: &'a Address,
        fn_name: &'static str,
        args: Vec<Val>,
        sub_invokes: &'a [MockAuthInvoke<'a>],
    ) -> MockAuth<'a> {
        MockAuth {
            address: signer,
            invoke: self.invoke(fn_name, args, sub_invokes),
        }
    }

    fn invoke<'a>(
        &'a self,
        fn_name: &'static str,
        args: Vec<Val>,
        sub_invokes: &'a [MockAuthInvoke<'a>],
    ) -> &'a MockAuthInvoke<'a> {
        // Leaked per call: tests are short-lived and this keeps lifetimes simple.
        std::boxed::Box::leak(std::boxed::Box::new(MockAuthInvoke {
            contract: &self.hold,
            fn_name,
            args,
            sub_invokes,
        }))
    }

    // ----- actions -----

    /// `open_hold` for `buyer`, authorized by `signer` (the buyer in a valid call).
    fn open_as(
        &self,
        signer: &Address,
        seller: &Address,
        amount: i128,
        order: &BytesN<32>,
    ) -> Result<u32, Fail> {
        let transfer = [MockAuthInvoke {
            contract: &self.token,
            fn_name: "transfer",
            args: (self.buyer.clone(), self.hold.clone(), amount).into_val(&self.env),
            sub_invokes: &[],
        }];
        let args = (
            self.buyer.clone(),
            seller.clone(),
            self.token.clone(),
            amount,
            order.clone(),
            REFUND_AFTER,
        )
            .into_val(&self.env);
        outcome(
            self.client()
                .mock_auths(&[self.auth(signer, "open_hold", args, &transfer)])
                .try_open_hold(
                    &self.buyer,
                    seller,
                    &self.token,
                    &amount,
                    order,
                    &REFUND_AFTER,
                ),
        )
    }

    fn open(&self) -> u32 {
        self.open_as(&self.buyer, &self.seller, AMOUNT, &self.order)
            .expect("open_hold by the buyer succeeds")
    }

    fn refund_as(&self, signer: &Address, hold_id: u32) -> Result<(), Fail> {
        let args = (hold_id,).into_val(&self.env);
        outcome(
            self.client()
                .mock_auths(&[self.auth(signer, "refund", args, &[])])
                .try_refund(&hold_id),
        )
    }

    fn add_issuer_as(&self, signer: &Address, key: &BytesN<32>) -> Result<(), Fail> {
        let args = (key.clone(),).into_val(&self.env);
        outcome(
            self.client()
                .mock_auths(&[self.auth(signer, "add_issuer", args, &[])])
                .try_add_issuer(key),
        )
    }

    fn remove_issuer_as(&self, signer: &Address, key: &BytesN<32>) -> Result<(), Fail> {
        let args = (key.clone(),).into_val(&self.env);
        outcome(
            self.client()
                .mock_auths(&[self.auth(signer, "remove_issuer", args, &[])])
                .try_remove_issuer(key),
        )
    }

    fn rotate_as(&self, signer: &Address, old: &BytesN<32>, new: &BytesN<32>) -> Result<(), Fail> {
        let args = (old.clone(), new.clone()).into_val(&self.env);
        outcome(
            self.client()
                .mock_auths(&[self.auth(signer, "rotate_issuer", args, &[])])
                .try_rotate_issuer(old, new),
        )
    }

    // ----- claims -----

    fn claim_for(&self, order: &BytesN<32>, id_label: &[u8]) -> Claim {
        self.issuer.unique_id_claim(
            &self.env,
            &self.delivery_type(),
            order,
            &hash(&self.env, id_label),
            T0,
            T0 + CLAIM_LIFETIME,
        )
    }

    fn sign_with(&self, who: &MockIssuer, claim: &Claim) -> BytesN<64> {
        self.env
            .as_contract(&self.hold, || who.sign(&self.env, claim))
    }

    fn delivery_claim(&self) -> (Claim, BytesN<64>) {
        let claim = self.claim_for(&self.order, b"claim-1");
        let sig = self.sign_with(&self.issuer, &claim);
        (claim, sig)
    }

    fn release(&self, hold_id: u32, claim: &Claim, sig: &BytesN<64>) -> Result<(), Fail> {
        // No authorization: anyone may relay a claim.
        outcome(self.client().try_release(&hold_id, claim, sig))
    }
}

// ---------- open_hold ----------

#[test]
fn open_hold_locks_funds_and_stores_the_hold() {
    let fx = Fx::new();
    let id = fx.open();
    assert_eq!(id, 1);
    assert_eq!(fx.balance(&fx.buyer), 2 * AMOUNT);
    assert_eq!(fx.balance(&fx.hold), AMOUNT);
    assert_eq!(
        fx.client().get_hold(&id),
        Hold {
            buyer: fx.buyer.clone(),
            seller: fx.seller.clone(),
            token: fx.token.clone(),
            amount: AMOUNT,
            order: fx.order.clone(),
            refund_after: REFUND_AFTER,
            status: HoldStatus::Open,
        }
    );
    // Ids are sequential.
    let second = fx
        .open_as(&fx.buyer, &fx.seller, AMOUNT, &hash(&fx.env, b"order:43"))
        .unwrap();
    assert_eq!(second, 2);
}

#[test]
fn open_hold_refused_without_the_buyers_authorization() {
    let fx = Fx::new();
    // Someone else signs for the buyer's call.
    assert_eq!(
        fx.open_as(&fx.attacker, &fx.seller, AMOUNT, &fx.order),
        Err(Fail::Trap)
    );
    assert_eq!(fx.balance(&fx.buyer), 3 * AMOUNT);
    assert_eq!(fx.balance(&fx.hold), 0);
}

#[test]
fn open_hold_needs_the_buyers_authorization_of_the_hold_call_itself() {
    let fx = Fx::new();
    // The buyer authorized only the token transfer, rooted at the token
    // contract, and not `open_hold`.
    let transfer = MockAuthInvoke {
        contract: &fx.token,
        fn_name: "transfer",
        args: (fx.buyer.clone(), fx.hold.clone(), AMOUNT).into_val(&fx.env),
        sub_invokes: &[],
    };
    let result = outcome(
        fx.client()
            .mock_auths(&[MockAuth {
                address: &fx.buyer,
                invoke: &transfer,
            }])
            .try_open_hold(
                &fx.buyer,
                &fx.seller,
                &fx.token,
                &AMOUNT,
                &fx.order,
                &REFUND_AFTER,
            ),
    );
    assert_eq!(result, Err(Fail::Trap));
    assert_eq!(fx.balance(&fx.hold), 0);
}

#[test]
fn open_hold_rejects_non_positive_amounts_and_same_party() {
    let fx = Fx::new();
    assert_eq!(
        fx.open_as(&fx.buyer, &fx.seller, 0, &fx.order),
        Err(hold_err(HoldError::InvalidAmount))
    );
    assert_eq!(
        fx.open_as(&fx.buyer, &fx.seller, -5, &fx.order),
        Err(hold_err(HoldError::InvalidAmount))
    );
    let buyer = fx.buyer.clone();
    assert_eq!(
        fx.open_as(&fx.buyer, &buyer, AMOUNT, &fx.order),
        Err(hold_err(HoldError::SameParty))
    );
    assert_eq!(fx.balance(&fx.hold), 0);
}

// ---------- release ----------

#[test]
fn release_pays_the_seller_exactly_and_closes_the_hold() {
    let fx = Fx::new();
    let id = fx.open();
    let (claim, sig) = fx.delivery_claim();
    let (buyer_before, seller_before) = (fx.balance(&fx.buyer), fx.balance(&fx.seller));
    assert_eq!(seller_before, 0);

    assert_eq!(fx.release(id, &claim, &sig), Ok(()));

    assert_eq!(fx.balance(&fx.seller), seller_before + AMOUNT);
    assert_eq!(fx.balance(&fx.hold), 0);
    assert_eq!(fx.balance(&fx.buyer), buyer_before);
    assert_eq!(fx.client().get_hold(&id).status, HoldStatus::Released);
}

#[test]
fn release_works_for_sequence_mode_claims_and_advances_the_counter() {
    let fx = Fx::new();
    let id = fx.open();
    let pk = fx.issuer.public_key(&fx.env);
    assert_eq!(
        fx.client().next_nonce(&pk, &fx.delivery_type(), &fx.order),
        0
    );
    let claim = fx.issuer.sequence_claim(
        &fx.env,
        &fx.delivery_type(),
        &fx.order,
        0,
        T0,
        T0 + CLAIM_LIFETIME,
    );
    assert_eq!(claim.replay_mode, ReplayMode::Sequence);
    let sig = fx.sign_with(&fx.issuer, &claim);
    assert_eq!(fx.release(id, &claim, &sig), Ok(()));
    assert_eq!(
        fx.client().next_nonce(&pk, &fx.delivery_type(), &fx.order),
        1
    );
}

#[test]
fn release_refuses_a_claim_of_another_type() {
    let fx = Fx::new();
    let id = fx.open();
    let mut claim = fx.claim_for(&fx.order, b"claim-1");
    claim.claim_type = hash(&fx.env, b"marketplace.refund.v1");
    let sig = fx.sign_with(&fx.issuer, &claim); // validly signed, still refused
    assert_eq!(
        fx.release(id, &claim, &sig),
        Err(hold_err(HoldError::WrongClaimType))
    );
    assert_eq!(fx.balance(&fx.hold), AMOUNT);
}

#[test]
fn release_refuses_a_claim_about_another_order() {
    let fx = Fx::new();
    let id = fx.open();
    let claim = fx.claim_for(&hash(&fx.env, b"order:99"), b"claim-1");
    let sig = fx.sign_with(&fx.issuer, &claim);
    assert_eq!(
        fx.release(id, &claim, &sig),
        Err(hold_err(HoldError::WrongSubject))
    );
    assert_eq!(fx.balance(&fx.seller), 0);
}

#[test]
fn the_same_claim_cannot_release_a_second_hold_for_the_same_order() {
    let fx = Fx::new();
    let first = fx.open();
    let second = fx
        .open_as(&fx.buyer, &fx.seller, AMOUNT, &fx.order)
        .unwrap();
    let (claim, sig) = fx.delivery_claim();
    assert_eq!(fx.release(first, &claim, &sig), Ok(()));
    assert_eq!(
        fx.release(second, &claim, &sig),
        Err(hold_err(HoldError::ClaimAlreadyUsed))
    );
    assert_eq!(fx.client().get_hold(&second).status, HoldStatus::Open);
    assert_eq!(fx.balance(&fx.hold), AMOUNT);
}

#[test]
fn a_released_hold_cannot_be_released_again() {
    let fx = Fx::new();
    let id = fx.open();
    let (claim, sig) = fx.delivery_claim();
    assert_eq!(fx.release(id, &claim, &sig), Ok(()));
    // Even a fresh, valid claim finds the hold closed.
    let again = fx.claim_for(&fx.order, b"claim-2");
    let again_sig = fx.sign_with(&fx.issuer, &again);
    assert_eq!(
        fx.release(id, &again, &again_sig),
        Err(hold_err(HoldError::HoldNotOpen))
    );
    assert_eq!(fx.balance(&fx.seller), AMOUNT);
}

#[test]
fn release_of_an_unknown_hold_fails() {
    let fx = Fx::new();
    let (claim, sig) = fx.delivery_claim();
    assert_eq!(
        fx.release(77, &claim, &sig),
        Err(hold_err(HoldError::HoldNotFound))
    );
}

#[test]
fn release_with_a_bad_signature_aborts_and_changes_nothing() {
    let fx = Fx::new();
    let id = fx.open();
    let (claim, _) = fx.delivery_claim();
    let forged = fx.sign_with(&MockIssuer::test(1), &claim);
    assert_eq!(fx.release(id, &claim, &forged), Err(Fail::Trap));
    let zero = BytesN::from_array(&fx.env, &[0u8; 64]);
    assert_eq!(fx.release(id, &claim, &zero), Err(Fail::Trap));
    assert_eq!(fx.client().get_hold(&id).status, HoldStatus::Open);
    assert_eq!(fx.balance(&fx.seller), 0);
    // The genuine signature still works afterwards.
    let (_, sig) = fx.delivery_claim();
    assert_eq!(fx.release(id, &claim, &sig), Ok(()));
}

#[test]
fn release_by_an_unregistered_issuer_is_refused() {
    let fx = Fx::new();
    let id = fx.open();
    let stranger = MockIssuer::test(1);
    let claim = stranger.unique_id_claim(
        &fx.env,
        &fx.delivery_type(),
        &fx.order,
        &hash(&fx.env, b"claim-1"),
        T0,
        T0 + CLAIM_LIFETIME,
    );
    let sig = fx.sign_with(&stranger, &claim);
    assert_eq!(
        fx.release(id, &claim, &sig),
        Err(hold_err(HoldError::IssuerNotRegistered))
    );
}

#[test]
fn release_with_an_expired_claim_is_refused_and_the_boundary_is_inclusive() {
    let fx = Fx::new();
    let id = fx.open();
    let (claim, sig) = fx.delivery_claim();
    fx.set_now(claim.expires_at + 1);
    assert_eq!(
        fx.release(id, &claim, &sig),
        Err(hold_err(HoldError::ClaimExpired))
    );
    fx.set_now(claim.expires_at);
    assert_eq!(fx.release(id, &claim, &sig), Ok(()));
}

// ---------- refund ----------

#[test]
fn refund_before_the_deadline_is_refused_including_at_the_deadline() {
    let fx = Fx::new();
    let id = fx.open();
    assert_eq!(
        fx.refund_as(&fx.buyer, id),
        Err(hold_err(HoldError::TooEarly))
    );
    fx.set_now(REFUND_AFTER);
    assert_eq!(
        fx.refund_as(&fx.buyer, id),
        Err(hold_err(HoldError::TooEarly))
    );
    assert_eq!(fx.balance(&fx.hold), AMOUNT);
}

#[test]
fn refund_after_the_deadline_returns_the_funds() {
    let fx = Fx::new();
    let id = fx.open();
    assert_eq!(fx.balance(&fx.buyer), 2 * AMOUNT);
    fx.set_now(REFUND_AFTER + 1);
    assert_eq!(fx.refund_as(&fx.buyer, id), Ok(()));
    assert_eq!(fx.balance(&fx.buyer), 3 * AMOUNT);
    assert_eq!(fx.balance(&fx.hold), 0);
    assert_eq!(fx.client().get_hold(&id).status, HoldStatus::Refunded);
}

#[test]
fn refund_is_refused_for_anyone_but_the_buyer() {
    let fx = Fx::new();
    let id = fx.open();
    fx.set_now(REFUND_AFTER + 1);
    assert_eq!(fx.refund_as(&fx.attacker, id), Err(Fail::Trap));
    let seller = fx.seller.clone();
    assert_eq!(fx.refund_as(&seller, id), Err(Fail::Trap));
    // No authorization at all.
    assert_eq!(
        outcome(fx.client().mock_auths(&[]).try_refund(&id)),
        Err(Fail::Trap)
    );
    assert_eq!(fx.balance(&fx.hold), AMOUNT);
    // The buyer can.
    assert_eq!(fx.refund_as(&fx.buyer, id), Ok(()));
}

#[test]
fn refund_after_release_is_refused() {
    let fx = Fx::new();
    let id = fx.open();
    let (claim, sig) = fx.delivery_claim();
    assert_eq!(fx.release(id, &claim, &sig), Ok(()));
    fx.set_now(REFUND_AFTER + 1);
    assert_eq!(
        fx.refund_as(&fx.buyer, id),
        Err(hold_err(HoldError::HoldNotOpen))
    );
    assert_eq!(fx.balance(&fx.seller), AMOUNT);
}

#[test]
fn refund_twice_and_release_after_refund_are_refused() {
    let fx = Fx::new();
    let id = fx.open();
    fx.set_now(REFUND_AFTER + 1);
    assert_eq!(fx.refund_as(&fx.buyer, id), Ok(()));
    assert_eq!(
        fx.refund_as(&fx.buyer, id),
        Err(hold_err(HoldError::HoldNotOpen))
    );
    // A claim that is still valid cannot revive a refunded hold.
    fx.set_now(T0 + 120);
    let (claim, sig) = fx.delivery_claim();
    assert_eq!(
        fx.release(id, &claim, &sig),
        Err(hold_err(HoldError::HoldNotOpen))
    );
    assert_eq!(fx.balance(&fx.seller), 0);
}

#[test]
fn refund_of_an_unknown_hold_fails() {
    let fx = Fx::new();
    assert_eq!(
        fx.refund_as(&fx.buyer, 9),
        Err(hold_err(HoldError::HoldNotFound))
    );
}

// ---------- issuer administration ----------

#[test]
fn admin_manages_issuers_under_its_own_authorization() {
    let fx = Fx::new();
    let second = MockIssuer::test(1).public_key(&fx.env);
    assert!(!fx.client().is_issuer(&second));
    assert_eq!(fx.add_issuer_as(&fx.admin, &second), Ok(()));
    assert!(fx.client().is_issuer(&second));
    assert_eq!(
        fx.add_issuer_as(&fx.admin, &second),
        Err(hold_err(HoldError::IssuerAlreadyRegistered))
    );
    assert_eq!(fx.remove_issuer_as(&fx.admin, &second), Ok(()));
    assert!(!fx.client().is_issuer(&second));
    assert_eq!(
        fx.remove_issuer_as(&fx.admin, &second),
        Err(hold_err(HoldError::IssuerNotFound))
    );
}

#[test]
fn non_admin_cannot_add_remove_or_rotate_issuers() {
    let fx = Fx::new();
    let first = fx.issuer.public_key(&fx.env);
    let second = MockIssuer::test(1).public_key(&fx.env);
    let (attacker, buyer) = (fx.attacker.clone(), fx.buyer.clone());
    for who in [&attacker, &buyer] {
        assert_eq!(fx.add_issuer_as(who, &second), Err(Fail::Trap));
        assert_eq!(fx.remove_issuer_as(who, &first), Err(Fail::Trap));
        assert_eq!(fx.rotate_as(who, &first, &second), Err(Fail::Trap));
    }
    // No authorization at all.
    assert_eq!(
        outcome(fx.client().mock_auths(&[]).try_add_issuer(&second)),
        Err(Fail::Trap)
    );
    assert!(fx.client().is_issuer(&first));
    assert!(!fx.client().is_issuer(&second));
}

#[test]
fn rotation_rejects_the_old_issuer_and_accepts_the_new_one() {
    let fx = Fx::new();
    let first_hold = fx.open();
    let second_hold = fx
        .open_as(&fx.buyer, &fx.seller, AMOUNT, &hash(&fx.env, b"order:43"))
        .unwrap();
    let old_claim = fx.claim_for(&fx.order, b"claim-1");
    let old_sig = fx.sign_with(&fx.issuer, &old_claim);

    let successor = MockIssuer::test(1);
    let old_pk = fx.issuer.public_key(&fx.env);
    let new_pk = successor.public_key(&fx.env);
    assert_eq!(fx.rotate_as(&fx.admin, &old_pk, &new_pk), Ok(()));
    assert!(!fx.client().is_issuer(&old_pk));
    assert!(fx.client().is_issuer(&new_pk));

    assert_eq!(
        fx.release(first_hold, &old_claim, &old_sig),
        Err(hold_err(HoldError::IssuerNotRegistered))
    );

    let order_43 = hash(&fx.env, b"order:43");
    let new_claim = successor.unique_id_claim(
        &fx.env,
        &fx.delivery_type(),
        &order_43,
        &hash(&fx.env, b"claim-9"),
        T0,
        T0 + CLAIM_LIFETIME,
    );
    let new_sig = fx.sign_with(&successor, &new_claim);
    assert_eq!(fx.release(second_hold, &new_claim, &new_sig), Ok(()));
    assert_eq!(fx.balance(&fx.seller), AMOUNT);
}
