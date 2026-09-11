#![no_std]
use soroban_sdk::token::TokenClient;
use soroban_sdk::xdr::ToXdr;
use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, symbol_short, Address, Bytes, BytesN, Env,
    String, Vec,
};

// ========== ENUMS & ERRORS ==========

#[contracterror]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u32)]
pub enum ContractError {
    AlreadyApproved = 1,
    Unauthorized = 2,
    InvalidOracleSignature = 3,
    InvalidPaymentId = 4,
    InsufficientApprovals = 5,
    PaymentAlreadyFinalized = 6,
    InvalidAmount = 7,
    EscrowCancelled = 8,
    InvalidNonce = 9,
    NotAdmin = 10,
    Paused = 11,
    AdminAlreadySet = 12,
    ProofMissing = 13,
    NonceOverflow = 14,
    SignersNotDistinct = 15,
    /// The oracle public key is not on the admin-managed registry.
    OracleKeyNotRegistered = 16,
    /// Attested hours x rate_per_hour does not equal the escrowed amount.
    AmountHoursMismatch = 17,
    /// end_date is not strictly after start_date.
    InvalidPeriod = 18,
    /// Batch exceeds MAX_BATCH_SIZE payments.
    BatchTooLarge = 19,
    /// This WASM pins an expected admin and the supplied address is not it.
    AdminMismatch = 20,
    /// No admin transfer is pending, or the caller is not the proposed admin.
    NoPendingAdmin = 21,
    /// `upgrade` requires the contract to be paused first.
    NotPaused = 22,
}

#[contracttype]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u32)]
pub enum PaymentStatus {
    Pending = 0,
    ManagerApproved = 1,
    FinanceApproved = 2,
    Finalized = 3,
    Cancelled = 4,
}

// ========== STRUCTS ==========

#[contracttype]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PaymentSchedule {
    pub id: u32,
    pub worker: Address,
    /// Per-payee Stellar Asset Contract (SAC) address — e.g. the USDC SAC for
    /// one payee and the native XLM SAC for another within the same batch.
    pub token: Address,
    pub amount: i128,
    pub start_date: u64,
    pub end_date: u64,
    pub hours_logged: i128,
    pub rate_per_hour: i128,
    /// Set true only by `submit_hours_proof` after a valid Ed25519 oracle
    /// signature. `pay_batch` refuses to settle a payment without it.
    pub proof_verified: bool,
    pub status: PaymentStatus,
}

#[contracttype]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CoreFlowEscrow {
    pub manager: Address,
    pub finance_approver: Address,
    pub oracle_pubkey: BytesN<32>,
    pub payments: Vec<PaymentSchedule>,
    pub manager_approved: bool,
    pub finance_approved: bool,
    pub cancelled: bool,
    /// Times the oracle key has been rotated on this escrow (audit trail).
    pub oracle_rotations: u32,
}

// ========== STORAGE KEYS ==========

#[contracttype]
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum DataKey {
    EscrowCount,
    Escrow(u32),
    Nonce(u32),
    Admin,
    /// Proposed next admin, awaiting acceptance (two-step handover).
    PendingAdmin,
    Paused,
    /// Registered oracle signing keys. Presence => trusted by the platform admin.
    OracleKey(BytesN<32>),
}

// Storage TTL constants (in ledgers)
// ~1 ledger ≈ 5 seconds; 17280 ledgers ≈ 1 day
const INSTANCE_TTL_THRESHOLD: u32 = 17280; // Extend when below 1 day
const INSTANCE_TTL_EXTEND: u32 = 17280 * 30; // Extend to 30 days
const PERSISTENT_TTL_THRESHOLD: u32 = 17280; // Extend when below 1 day
const PERSISTENT_TTL_EXTEND: u32 = 17280 * 90; // Extend to 90 days

/// Upper bound on payments per escrow. Every entry point loads and rewrites the
/// whole escrow, so an unbounded Vec is a denial-of-service vector: a batch big
/// enough to exceed the ledger resource limits would make its own escrow
/// permanently uncallable, stranding custody. 100 matches the API batch cap.
const MAX_BATCH_SIZE: u32 = 100;

// ===== Oracle attestation domain separation (schema v2) =====
//
// v1 signed only `escrow_id || payment_id || hours || nonce`. That message said
// nothing about WHICH chain, WHICH contract, WHICH worker or HOW MUCH, so one
// signature was valid on every deployment of this contract on every network for
// the same tuple -- a Testnet attestation replayed verbatim against Mainnet.
//
// v2 binds the attestation to its full context. Every field below is read from
// STORED escrow state rather than from caller arguments, so a caller cannot
// shift the message onto a payment the oracle never saw.
const PROOF_MAGIC: [u8; 4] = *b"CFWP"; // CoreFlow Work Proof
const PROOF_VERSION: u16 = 2;

/// Build-time admin pin — the fix for `init_admin` front-running.
///
/// THE PROBLEM: `init_admin` is first-caller-wins, and a Stellar transaction may
/// carry only ONE Soroban operation, so deploy and initialize cannot be bundled
/// atomically. That leaves a window in which anyone watching the ledger can call
/// `init_admin` first, become admin, and then `upgrade` the contract to
/// arbitrary code that drains every escrow's custody.
///
/// THE FIX: a production build bakes the expected admin address into the WASM
/// (`COREFLOW_ADMIN=G... cargo build ...`). `init_admin` then refuses any other
/// address, so winning the race gains an attacker nothing — the window still
/// exists, but there is nothing to win.
///
/// Builds without the pin (tests, local development) keep the old first-caller
/// behaviour, because test addresses are generated at runtime and cannot be
/// known at compile time. `scripts/deploy-testnet.sh` refuses to deploy an
/// unpinned WASM, and `expected_admin()` lets anyone verify a deployment's pin
/// on-chain after the fact.
const PINNED_ADMIN: Option<&str> = option_env!("COREFLOW_ADMIN");

// ========== CONTRACT ==========

#[contract]
pub struct CoreFlowContract;

#[contractimpl]
impl CoreFlowContract {
    // ===== Admin / circuit breaker / upgrade =====

    /// Set the contract admin once, immediately after deploy. Idempotent-guard:
    /// fails if an admin is already configured. If never called, the contract
    /// simply has no admin and can never be paused or upgraded.
    pub fn init_admin(env: Env, admin: Address) -> Result<(), ContractError> {
        if env.storage().instance().has(&DataKey::Admin) {
            return Err(ContractError::AdminAlreadySet);
        }

        // Front-running guard. When this WASM was built with COREFLOW_ADMIN set,
        // only that address may claim the role — so losing the race to call
        // `init_admin` first costs nothing.
        if let Some(pinned) = PINNED_ADMIN {
            let expected = Address::from_string(&String::from_str(&env, pinned));
            if admin != expected {
                return Err(ContractError::AdminMismatch);
            }
        }

        admin.require_auth();
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage()
            .instance()
            .extend_ttl(INSTANCE_TTL_THRESHOLD, INSTANCE_TTL_EXTEND);
        env.events()
            .publish((symbol_short!("admin"), symbol_short!("init")), admin);
        Ok(())
    }

    /// The admin address baked into this WASM at build time, if any.
    ///
    /// Read-only, so an operator (or an auditor) can confirm after deploy that
    /// the running code is pinned to the key they expect, rather than trusting
    /// that the deploy script was run correctly.
    pub fn expected_admin(env: Env) -> Option<Address> {
        PINNED_ADMIN.map(|p| Address::from_string(&String::from_str(&env, p)))
    }

    /// Propose a new admin (current admin only). Step 1 of 2.
    ///
    /// Handover is two-step because a single-step transfer to a mistyped or
    /// uncontrolled address permanently destroys the ability to pause, upgrade,
    /// or manage the oracle registry. The proposed key must prove it can sign.
    pub fn propose_admin(env: Env, new_admin: Address) -> Result<(), ContractError> {
        Self::require_admin(&env)?;
        env.storage()
            .instance()
            .set(&DataKey::PendingAdmin, &new_admin);
        env.storage()
            .instance()
            .extend_ttl(INSTANCE_TTL_THRESHOLD, INSTANCE_TTL_EXTEND);
        env.events()
            .publish((symbol_short!("admin"), symbol_short!("propose")), new_admin);
        Ok(())
    }

    /// Accept a pending admin handover (proposed admin only). Step 2 of 2.
    pub fn accept_admin(env: Env) -> Result<(), ContractError> {
        let pending: Address = env
            .storage()
            .instance()
            .get(&DataKey::PendingAdmin)
            .ok_or(ContractError::NoPendingAdmin)?;

        pending.require_auth();

        env.storage().instance().set(&DataKey::Admin, &pending);
        env.storage().instance().remove(&DataKey::PendingAdmin);
        env.storage()
            .instance()
            .extend_ttl(INSTANCE_TTL_THRESHOLD, INSTANCE_TTL_EXTEND);
        env.events()
            .publish((symbol_short!("admin"), symbol_short!("accept")), pending);
        Ok(())
    }

    /// The currently configured admin, if one has been set.
    pub fn get_admin(env: Env) -> Option<Address> {
        env.storage().instance().get(&DataKey::Admin)
    }

    /// Pause or unpause state-changing operations (admin only). `cancel_escrow`
    /// stays available while paused so funds can always be refunded.
    pub fn set_paused(env: Env, paused: bool) -> Result<(), ContractError> {
        Self::require_admin(&env)?;
        env.storage().instance().set(&DataKey::Paused, &paused);
        env.storage()
            .instance()
            .extend_ttl(INSTANCE_TTL_THRESHOLD, INSTANCE_TTL_EXTEND);
        env.events()
            .publish((symbol_short!("admin"), symbol_short!("paused")), paused);
        Ok(())
    }

    pub fn is_paused(env: Env) -> bool {
        env.storage()
            .instance()
            .get(&DataKey::Paused)
            .unwrap_or(false)
    }

    /// Upgrade the contract WASM (admin only). Enables fixes without changing
    /// the contract address or migrating escrow funds.
    pub fn upgrade(env: Env, new_wasm_hash: BytesN<32>) -> Result<(), ContractError> {
        Self::require_admin(&env)?;

        // Upgrading is the one admin power that can drain every escrow at once:
        // it replaces the code holding custody. Requiring the contract to be
        // paused first makes that a deliberate two-transaction sequence with an
        // observable `paused` event in between, rather than something that can
        // happen silently while the system looks healthy. It does not stop a
        // malicious admin -- nothing at this layer can -- but it removes the
        // silent path and gives monitoring something to alert on.
        if !env
            .storage()
            .instance()
            .get(&DataKey::Paused)
            .unwrap_or(false)
        {
            return Err(ContractError::NotPaused);
        }

        env.events().publish(
            (symbol_short!("admin"), symbol_short!("upgrade")),
            new_wasm_hash.clone(),
        );
        env.deployer().update_current_contract_wasm(new_wasm_hash);
        Ok(())
    }

    fn require_admin(env: &Env) -> Result<Address, ContractError> {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(ContractError::NotAdmin)?;
        admin.require_auth();
        Ok(admin)
    }

    fn require_not_paused(env: &Env) -> Result<(), ContractError> {
        if env
            .storage()
            .instance()
            .get(&DataKey::Paused)
            .unwrap_or(false)
        {
            return Err(ContractError::Paused);
        }
        Ok(())
    }

    // ===== Oracle key registry (admin-managed) =====

    /// Register an oracle signing key as trusted by the platform (admin only).
    ///
    /// WHY A REGISTRY: previously the manager passed any `oracle_pubkey` they
    /// liked into `initialize_multi_sig_escrow`, so a manager could install
    /// their own key and sign their own "verified work" attestations. The
    /// proof-of-work gate was therefore manager-attestable -- procedural, not
    /// cryptographic. Escrows may now only name a key the admin has registered,
    /// which makes the oracle an independent party by construction.
    pub fn register_oracle_key(env: Env, pubkey: BytesN<32>) -> Result<(), ContractError> {
        Self::require_admin(&env)?;
        env.storage()
            .persistent()
            .set(&DataKey::OracleKey(pubkey.clone()), &true);
        env.storage().persistent().extend_ttl(
            &DataKey::OracleKey(pubkey.clone()),
            PERSISTENT_TTL_THRESHOLD,
            PERSISTENT_TTL_EXTEND,
        );
        env.events()
            .publish((symbol_short!("oracle"), symbol_short!("reg")), pubkey);
        Ok(())
    }

    /// Revoke a previously registered oracle key (admin only).
    ///
    /// Existing escrows already naming this key keep functioning -- revoking is
    /// not retroactive, because silently invalidating in-flight attestations
    /// would strand funded escrows. It stops the key being named by NEW escrows
    /// and NEW rotations. To retire a key from a live escrow, the manager calls
    /// `rotate_oracle_key`, which revokes that escrow's verified proofs.
    pub fn revoke_oracle_key(env: Env, pubkey: BytesN<32>) -> Result<(), ContractError> {
        Self::require_admin(&env)?;
        env.storage()
            .persistent()
            .remove(&DataKey::OracleKey(pubkey.clone()));
        env.events()
            .publish((symbol_short!("oracle"), symbol_short!("revoke")), pubkey);
        Ok(())
    }

    /// True if `pubkey` is on the admin-managed registry.
    pub fn is_oracle_key_registered(env: Env, pubkey: BytesN<32>) -> bool {
        env.storage()
            .persistent()
            .get(&DataKey::OracleKey(pubkey))
            .unwrap_or(false)
    }

    /// Bootstrap exception: if no admin was ever configured, the contract has no
    /// registry authority and the registry check cannot be satisfied by anyone.
    /// Rather than bricking such a deployment, an admin-less contract accepts any
    /// key -- exactly the v1 trust model, and no weaker. Once `init_admin` runs,
    /// the registry is enforced from that point on.
    fn require_registered_oracle(env: &Env, pubkey: &BytesN<32>) -> Result<(), ContractError> {
        if !env.storage().instance().has(&DataKey::Admin) {
            return Ok(());
        }
        if env
            .storage()
            .persistent()
            .get(&DataKey::OracleKey(pubkey.clone()))
            .unwrap_or(false)
        {
            Ok(())
        } else {
            Err(ContractError::OracleKeyNotRegistered)
        }
    }

    // ===== Oracle primitives =====

    /// SHA-256 of an address's XDR serialization.
    ///
    /// Addresses serialize to a variable number of bytes (an account ScAddress
    /// and a contract ScAddress differ in length), so hashing each to a fixed 32
    /// bytes keeps the proof preimage fixed-width and trivially reproducible
    /// off-chain. `scripts/oracle-cli.mjs` and `src/lib/oracle/index.ts` build
    /// the identical digest; `test_cli_generated_signature_is_accepted_onchain`
    /// fails if the two ever drift.
    fn addr_digest(env: &Env, addr: &Address) -> BytesN<32> {
        env.crypto().sha256(&addr.clone().to_xdr(env))
    }

    /// Build the domain-separated attestation preimage (schema v2, 198 bytes).
    ///
    ///   magic        "CFWP"                4
    ///   version      u16 BE                2
    ///   network_id   sha256(passphrase)   32   <- binds to Testnet vs Mainnet
    ///   contract     sha256(addr xdr)     32   <- binds to THIS deployment
    ///   worker       sha256(addr xdr)     32   <- binds to the payee
    ///   token        sha256(addr xdr)     32   <- binds to the asset
    ///   escrow_id    u32 BE                4
    ///   payment_id   u32 BE                4
    ///   amount       i128 BE              16   <- binds to how much moves
    ///   hours        i128 BE              16
    ///   start_date   u64 BE                8
    ///   end_date     u64 BE                8   <- binds to the pay period
    ///   nonce        u64 BE                8
    ///
    /// `worker`, `token`, `amount` and the period come from the STORED payment
    /// row, never from caller arguments.
    fn build_proof_message(
        env: &Env,
        escrow_id: u32,
        payment_id: u32,
        payment: &PaymentSchedule,
        hours: i128,
        nonce: u64,
    ) -> Bytes {
        let mut m = Bytes::new(env);
        m.extend_from_array(&PROOF_MAGIC);
        m.extend_from_array(&PROOF_VERSION.to_be_bytes());
        m.extend_from_array(&env.ledger().network_id().to_array());
        m.extend_from_array(&Self::addr_digest(env, &env.current_contract_address()).to_array());
        m.extend_from_array(&Self::addr_digest(env, &payment.worker).to_array());
        m.extend_from_array(&Self::addr_digest(env, &payment.token).to_array());
        m.extend_from_array(&escrow_id.to_be_bytes());
        m.extend_from_array(&payment_id.to_be_bytes());
        m.extend_from_array(&payment.amount.to_be_bytes());
        m.extend_from_array(&hours.to_be_bytes());
        m.extend_from_array(&payment.start_date.to_be_bytes());
        m.extend_from_array(&payment.end_date.to_be_bytes());
        m.extend_from_array(&nonce.to_be_bytes());
        m
    }

    /// Verify an Ed25519 oracle attestation over `payload`.
    ///
    /// NOTE ON RETURN TYPE: this cannot return `bool`. `Env::crypto().ed25519_verify`
    /// traps the host on an invalid signature and there is no catchable failure in
    /// `no_std` wasm, so a `-> bool` signature could only ever return `true`. A
    /// caller that branches on a bool would read as a check while enforcing nothing.
    /// Returning `()` and trapping is the honest contract.
    fn verify_oracle_work(env: &Env, payload: &Bytes, sig: &BytesN<64>, pub_key: &BytesN<32>) {
        env.crypto().ed25519_verify(pub_key, payload, sig);
    }

    /// Consume `nonce` for `escrow_id`, rejecting replays.
    ///
    /// NOTE ON STORAGE: this uses a monotonic counter rather than a `Vec` of spent
    /// nonces. A Vec grows without bound, costs more rent every call, and eventually
    /// makes the escrow unusable — and it only rejects *exact* duplicates. A counter
    /// is O(1) forever and rejects every nonce at or below the watermark, which is a
    /// strictly stronger replay guarantee.
    fn track_nonce(env: &Env, escrow_id: u32, nonce: u64) -> Result<(), ContractError> {
        let expected: u64 = env
            .storage()
            .persistent()
            .get(&DataKey::Nonce(escrow_id))
            .unwrap_or(0u64);
        if nonce != expected {
            return Err(ContractError::InvalidNonce);
        }
        let next = nonce.checked_add(1).ok_or(ContractError::NonceOverflow)?;
        env.storage().persistent().set(&DataKey::Nonce(escrow_id), &next);
        env.storage().persistent().extend_ttl(
            &DataKey::Nonce(escrow_id),
            PERSISTENT_TTL_THRESHOLD,
            PERSISTENT_TTL_EXTEND,
        );
        Ok(())
    }

    /// Rotate the oracle public key for an escrow. Signatures produced by the
    /// retired key stop verifying immediately, since `verify_oracle_work` reads
    /// this stored key. Manager-authorized; refused once funds have moved.
    pub fn rotate_oracle_key(
        env: Env,
        escrow_id: u32,
        new_pubkey: BytesN<32>,
    ) -> Result<(), ContractError> {
        Self::require_not_paused(&env)?;
        let mut escrow: CoreFlowEscrow = env
            .storage()
            .persistent()
            .get(&DataKey::Escrow(escrow_id))
            .ok_or(ContractError::InvalidPaymentId)?;

        escrow.manager.require_auth();

        // Rotation cannot be used to escape the registry.
        Self::require_registered_oracle(&env, &new_pubkey)?;

        if escrow.cancelled {
            return Err(ContractError::EscrowCancelled);
        }
        for i in 0..escrow.payments.len() {
            if escrow.payments.get(i).unwrap().status == PaymentStatus::Finalized {
                return Err(ContractError::PaymentAlreadyFinalized);
            }
        }

        escrow.oracle_pubkey = new_pubkey.clone();
        escrow.oracle_rotations += 1;

        // Proofs verified under the retired key are revoked: a rotation means the
        // old attestations are no longer trustworthy, so they must be re-submitted.
        let mut revoked = Vec::new(&env);
        for i in 0..escrow.payments.len() {
            let mut p = escrow.payments.get(i).unwrap();
            p.proof_verified = false;
            revoked.push_back(p);
        }
        escrow.payments = revoked;

        env.storage()
            .persistent()
            .set(&DataKey::Escrow(escrow_id), &escrow);
        env.storage().persistent().extend_ttl(
            &DataKey::Escrow(escrow_id),
            PERSISTENT_TTL_THRESHOLD,
            PERSISTENT_TTL_EXTEND,
        );

        env.events().publish(
            (symbol_short!("oracle"), symbol_short!("rotate")),
            (escrow_id, escrow.oracle_rotations),
        );

        Ok(())
    }

    /// Initialize a multi-signature escrow with payment schedules and oracle public key.
    /// The oracle_pubkey is an Ed25519 public key used to verify work proof signatures.
    pub fn initialize_multi_sig_escrow(
        env: Env,
        manager: Address,
        finance_approver: Address,
        oracle_pubkey: BytesN<32>,
        payments: Vec<PaymentSchedule>,
    ) -> Result<u32, ContractError> {
        Self::require_not_paused(&env)?;
        manager.require_auth();

        // Dual control is the core security property: one key holding both roles
        // would make `pay_batch`'s two-approval gate vacuous. Rejected at creation
        // so a mis-configured escrow can never be funded in the first place.
        if manager == finance_approver {
            return Err(ContractError::SignersNotDistinct);
        }

        if payments.is_empty() {
            return Err(ContractError::InvalidAmount);
        }
        if payments.len() > MAX_BATCH_SIZE {
            return Err(ContractError::BatchTooLarge);
        }

        // The oracle must be one the platform admin trusts, not one the manager
        // chose. See `register_oracle_key`.
        Self::require_registered_oracle(&env, &oracle_pubkey)?;

        // Guard amounts/rates. `total_amount` is for the event only — custody is
        // now funded per asset, since a batch may mix e.g. USDC and native XLM.
        let mut total_amount: i128 = 0;
        for i in 0..payments.len() {
            let p = payments.get(i).unwrap();
            if p.amount <= 0 || p.rate_per_hour <= 0 {
                return Err(ContractError::InvalidAmount);
            }
            // A zero-width or inverted period would make the attested pay period
            // meaningless, and the period is a signed field of the proof.
            if p.end_date <= p.start_date {
                return Err(ContractError::InvalidPeriod);
            }
            // The amount must be reachable by whole attested hours at this rate,
            // otherwise `submit_hours_proof`'s `hours x rate == amount` check can
            // never be satisfied and the escrow is funded but unsettleable.
            if p.amount % p.rate_per_hour != 0 {
                return Err(ContractError::AmountHoursMismatch);
            }
            total_amount += p.amount;
        }

        // EscrowCount in persistent storage — must survive alongside escrow
        // data to prevent ID reuse if instance storage expires first.
        let escrow_id: u32 = env
            .storage()
            .persistent()
            .get(&DataKey::EscrowCount)
            .unwrap_or(0u32)
            + 1;

        // Pull custody per distinct asset: one transfer per token rather than one
        // per payee, so a 50-row batch paying two assets costs two sub-invocations
        // instead of fifty. The outer loop visits each token once (skipping any
        // already handled at a lower index); the inner loop sums that token's rows.
        let contract_addr = env.current_contract_address();
        for i in 0..payments.len() {
            let token_i = payments.get(i).unwrap().token;

            let mut already_funded = false;
            for j in 0..i {
                if payments.get(j).unwrap().token == token_i {
                    already_funded = true;
                    break;
                }
            }
            if already_funded {
                continue;
            }

            let mut asset_total: i128 = 0;
            for j in 0..payments.len() {
                let p = payments.get(j).unwrap();
                if p.token == token_i {
                    asset_total += p.amount;
                }
            }

            // Traps if the manager lacks balance or a trustline for this asset.
            TokenClient::new(&env, &token_i).transfer(&manager, &contract_addr, &asset_total);
        }

        let escrow = CoreFlowEscrow {
            manager: manager.clone(),
            finance_approver: finance_approver.clone(),
            oracle_pubkey,
            payments: payments.clone(),
            manager_approved: false,
            finance_approved: false,
            cancelled: false,
            oracle_rotations: 0,
        };

        // Store escrow in persistent storage (per-key TTL control)
        env.storage()
            .persistent()
            .set(&DataKey::Escrow(escrow_id), &escrow);
        env.storage().persistent().extend_ttl(
            &DataKey::Escrow(escrow_id),
            PERSISTENT_TTL_THRESHOLD,
            PERSISTENT_TTL_EXTEND,
        );

        // Initialize nonce for this escrow
        env.storage()
            .persistent()
            .set(&DataKey::Nonce(escrow_id), &0u64);
        env.storage().persistent().extend_ttl(
            &DataKey::Nonce(escrow_id),
            PERSISTENT_TTL_THRESHOLD,
            PERSISTENT_TTL_EXTEND,
        );

        // Counter in persistent storage with same TTL as escrow data
        env.storage()
            .persistent()
            .set(&DataKey::EscrowCount, &escrow_id);
        env.storage().persistent().extend_ttl(
            &DataKey::EscrowCount,
            PERSISTENT_TTL_THRESHOLD,
            PERSISTENT_TTL_EXTEND,
        );

        // Emit event: escrow_created (escrow_id, manager, total funded amount)
        env.events().publish(
            (symbol_short!("escrow"), symbol_short!("created")),
            (escrow_id, manager, total_amount),
        );

        // One event PER PAYMENT, carrying that payment's full financial identity.
        //
        // WHY THIS EXISTS: the escrow-level events above say only how much moved
        // in aggregate. An indexer given just those cannot reconstruct who was
        // paid what, so it would have to read `get_escrow` at index time — which
        // returns CURRENT state, not the state at that ledger. That makes the
        // projection non-deterministic and unreplayable: re-indexing from
        // scratch after later activity would produce different rows.
        //
        // Emitting per-payment events makes the event stream self-sufficient, so
        // the off-chain projection is a pure function of the log. `payment_index`
        // is the zero-based Vec index, matching the `payment_id` argument that
        // `submit_hours_proof` and `proof_preimage` take.
        for i in 0..payments.len() {
            let p = payments.get(i).unwrap();
            env.events().publish(
                (symbol_short!("payment"), symbol_short!("add")),
                (
                    escrow_id,
                    i,
                    p.worker.clone(),
                    p.token.clone(),
                    p.amount,
                    p.rate_per_hour,
                    p.start_date,
                    p.end_date,
                ),
            );
        }

        Ok(escrow_id)
    }

    /// Submit hours proof verified by an Ed25519 oracle signature.
    ///
    /// The oracle signs the 198-byte domain-separated preimage documented on
    /// `build_proof_message` (schema v2). The contract rebuilds that preimage
    /// from stored state, verifies it against the escrow's oracle public key,
    /// enforces `hours x rate == amount`, and consumes the next expected nonce.
    pub fn submit_hours_proof(
        env: Env,
        escrow_id: u32,
        payment_id: u32,
        hours_logged: i128,
        nonce: u64,
        signature: BytesN<64>,
    ) -> Result<(), ContractError> {
        Self::require_not_paused(&env)?;
        // Validate escrow exists (persistent storage)
        let mut escrow: CoreFlowEscrow = env
            .storage()
            .persistent()
            .get(&DataKey::Escrow(escrow_id))
            .ok_or(ContractError::InvalidPaymentId)?;

        // Guard: check if escrow is cancelled
        if escrow.cancelled {
            return Err(ContractError::EscrowCancelled);
        }

        // Guard: do not allow hours submission after manager or finance has approved
        if escrow.manager_approved || escrow.finance_approved {
            return Err(ContractError::AlreadyApproved);
        }

        if payment_id >= escrow.payments.len() {
            return Err(ContractError::InvalidPaymentId);
        }

        let mut payment = escrow.payments.get(payment_id).unwrap();

        // The attested work must justify the escrowed amount exactly. Without
        // this, `hours_logged` was decorative: the oracle could attest to any
        // number of hours while `amount` -- fixed at creation and already funded
        // into custody -- paid out regardless. Tying them makes "verified work
        // determines payment" an on-chain invariant rather than a description.
        let earned = hours_logged
            .checked_mul(payment.rate_per_hour)
            .ok_or(ContractError::InvalidAmount)?;
        if earned != payment.amount {
            return Err(ContractError::AmountHoursMismatch);
        }

        // Domain-separated preimage (schema v2). Built from stored payment state,
        // so a caller cannot retarget a signature onto a different payee, asset,
        // amount, period, contract or network.
        let message =
            Self::build_proof_message(&env, escrow_id, payment_id, &payment, hours_logged, nonce);

        // Signature first, then nonce. Verification traps on a bad signature, so
        // consuming the nonce beforehand would let an attacker burn the escrow's
        // nonce sequence with garbage signatures.
        Self::verify_oracle_work(&env, &message, &signature, &escrow.oracle_pubkey);
        Self::track_nonce(&env, escrow_id, nonce)?;

        // Mark the payment as carrying a verified proof — `pay_batch` requires it.
        payment.hours_logged = hours_logged;
        payment.proof_verified = true;

        escrow.payments.set(payment_id, payment);
        env.storage()
            .persistent()
            .set(&DataKey::Escrow(escrow_id), &escrow);
        env.storage().persistent().extend_ttl(
            &DataKey::Escrow(escrow_id),
            PERSISTENT_TTL_THRESHOLD,
            PERSISTENT_TTL_EXTEND,
        );

        // Emit event: hours_submitted
        env.events().publish(
            (symbol_short!("hours"), symbol_short!("submit")),
            (escrow_id, payment_id, hours_logged),
        );

        Ok(())
    }

    /// Manager approval of payment(s)
    pub fn manager_approve(env: Env, escrow_id: u32) -> Result<(), ContractError> {
        Self::require_not_paused(&env)?;
        let mut escrow: CoreFlowEscrow = env
            .storage()
            .persistent()
            .get(&DataKey::Escrow(escrow_id))
            .ok_or(ContractError::InvalidPaymentId)?;

        // Guard: check if escrow is cancelled
        if escrow.cancelled {
            return Err(ContractError::EscrowCancelled);
        }

        escrow.manager.require_auth();

        if escrow.manager_approved {
            return Err(ContractError::AlreadyApproved);
        }

        escrow.manager_approved = true;
        env.storage()
            .persistent()
            .set(&DataKey::Escrow(escrow_id), &escrow);
        env.storage().persistent().extend_ttl(
            &DataKey::Escrow(escrow_id),
            PERSISTENT_TTL_THRESHOLD,
            PERSISTENT_TTL_EXTEND,
        );

        // Emit event: manager_approved
        env.events().publish(
            (symbol_short!("approve"), symbol_short!("manager")),
            escrow_id,
        );

        Ok(())
    }

    /// Finance approval of payment(s)
    pub fn finance_approve(env: Env, escrow_id: u32) -> Result<(), ContractError> {
        Self::require_not_paused(&env)?;
        let mut escrow: CoreFlowEscrow = env
            .storage()
            .persistent()
            .get(&DataKey::Escrow(escrow_id))
            .ok_or(ContractError::InvalidPaymentId)?;

        // Guard: check if escrow is cancelled
        if escrow.cancelled {
            return Err(ContractError::EscrowCancelled);
        }

        escrow.finance_approver.require_auth();

        if escrow.finance_approved {
            return Err(ContractError::AlreadyApproved);
        }

        escrow.finance_approved = true;
        env.storage()
            .persistent()
            .set(&DataKey::Escrow(escrow_id), &escrow);
        env.storage().persistent().extend_ttl(
            &DataKey::Escrow(escrow_id),
            PERSISTENT_TTL_THRESHOLD,
            PERSISTENT_TTL_EXTEND,
        );

        // Emit event: finance_approved
        env.events().publish(
            (symbol_short!("approve"), symbol_short!("finance")),
            escrow_id,
        );

        Ok(())
    }

    /// Finalize payment once both approvals are obtained
    /// Deprecated alias retained so the Mainnet-deployed ABI and the existing
    /// dashboard client keep working. New callers should use `pay_batch`.
    pub fn finalize_payment(
        env: Env,
        escrow_id: u32,
    ) -> Result<Vec<PaymentSchedule>, ContractError> {
        Self::pay_batch(env, escrow_id)
    }

    /// Settle every payment in the escrow: one transaction, one SAC transfer per
    /// payee, each in that payee's own asset. Requires both approvals AND a
    /// verified oracle proof on every row.
    pub fn pay_batch(
        env: Env,
        escrow_id: u32,
    ) -> Result<Vec<PaymentSchedule>, ContractError> {
        Self::require_not_paused(&env)?;
        let mut escrow: CoreFlowEscrow = env
            .storage()
            .persistent()
            .get(&DataKey::Escrow(escrow_id))
            .ok_or(ContractError::InvalidPaymentId)?;

        // Guard: check if escrow is cancelled
        if escrow.cancelled {
            return Err(ContractError::EscrowCancelled);
        }

        escrow.manager.require_auth();

        if escrow.manager == escrow.finance_approver {
            return Err(ContractError::SignersNotDistinct);
        }

        if !escrow.manager_approved || !escrow.finance_approved {
            return Err(ContractError::InsufficientApprovals);
        }

        // Guard: double-finalize protection, and refuse to move funds for any
        // payment lacking a verified oracle attestation. This is what makes the
        // "funds only move against proof of work" claim true on-chain rather
        // than merely procedural.
        for i in 0..escrow.payments.len() {
            let p = escrow.payments.get(i).unwrap();
            if p.status == PaymentStatus::Finalized {
                return Err(ContractError::PaymentAlreadyFinalized);
            }
            if !p.proof_verified {
                return Err(ContractError::ProofMissing);
            }
        }

        // Settle each payee in that payee's own asset. Atomic by construction:
        // any failing transfer (missing trustline, insufficient custody) traps
        // and reverts the whole batch, so custody can never partially drain.
        let contract_addr = env.current_contract_address();
        let mut finalized_payments = Vec::new(&env);
        let mut total_amount: i128 = 0;
        for i in 0..escrow.payments.len() {
            let mut p = escrow.payments.get(i).unwrap();
            p.status = PaymentStatus::Finalized;
            TokenClient::new(&env, &p.token).transfer(&contract_addr, &p.worker, &p.amount);
            total_amount += p.amount;

            // Per-payment settlement event, emitted AFTER the transfer for this
            // payee. A trapping transfer reverts the whole batch, so an emitted
            // `paid` event always corresponds to value that actually moved.
            env.events().publish(
                (symbol_short!("payment"), symbol_short!("paid")),
                (
                    escrow_id,
                    i,
                    p.worker.clone(),
                    p.token.clone(),
                    p.amount,
                    p.hours_logged,
                ),
            );

            finalized_payments.push_back(p);
        }

        escrow.payments = finalized_payments.clone();
        env.storage()
            .persistent()
            .set(&DataKey::Escrow(escrow_id), &escrow);

        // Extend storage TTL to preserve finalized records
        env.storage().persistent().extend_ttl(
            &DataKey::Escrow(escrow_id),
            PERSISTENT_TTL_THRESHOLD,
            PERSISTENT_TTL_EXTEND,
        );

        // Emit event: payment_finalized
        env.events().publish(
            (symbol_short!("payment"), symbol_short!("final")),
            (escrow_id, total_amount, finalized_payments.len()),
        );

        Ok(finalized_payments)
    }

    /// Cancel an escrow (dispute resolution — manager only).
    /// Allowed even while paused (emergency withdrawal path).
    pub fn cancel_escrow(env: Env, escrow_id: u32) -> Result<(), ContractError> {
        let mut escrow: CoreFlowEscrow = env
            .storage()
            .persistent()
            .get(&DataKey::Escrow(escrow_id))
            .ok_or(ContractError::InvalidPaymentId)?;

        // Guard: prevent double-cancel (would re-execute a zero-amount refund
        // transfer and emit a duplicate event).
        if escrow.cancelled {
            return Err(ContractError::EscrowCancelled);
        }

        escrow.manager.require_auth();

        // Cannot cancel already finalized escrows.
        for i in 0..escrow.payments.len() {
            if escrow.payments.get(i).unwrap().status == PaymentStatus::Finalized {
                return Err(ContractError::PaymentAlreadyFinalized);
            }
        }

        // Refund per asset, mirroring how custody was funded — one transfer per
        // distinct token back to the manager. Nothing was ever partially
        // released, since pay_batch settles atomically.
        let contract_addr = env.current_contract_address();
        for i in 0..escrow.payments.len() {
            let token_i = escrow.payments.get(i).unwrap().token;

            let mut already_refunded = false;
            for j in 0..i {
                if escrow.payments.get(j).unwrap().token == token_i {
                    already_refunded = true;
                    break;
                }
            }
            if already_refunded {
                continue;
            }

            let mut asset_total: i128 = 0;
            for j in 0..escrow.payments.len() {
                let p = escrow.payments.get(j).unwrap();
                if p.token == token_i {
                    asset_total += p.amount;
                }
            }

            if asset_total > 0 {
                TokenClient::new(&env, &token_i).transfer(
                    &contract_addr,
                    &escrow.manager,
                    &asset_total,
                );
            }
        }

        escrow.cancelled = true;

        // Mark all payments as cancelled
        let mut cancelled_payments = Vec::new(&env);
        for i in 0..escrow.payments.len() {
            let mut p = escrow.payments.get(i).unwrap();
            p.status = PaymentStatus::Cancelled;
            // Per-payment cancellation, so the off-chain projection can move
            // each payment to a terminal state from the log alone.
            env.events().publish(
                (symbol_short!("payment"), symbol_short!("cancel")),
                (escrow_id, i),
            );
            cancelled_payments.push_back(p);
        }
        escrow.payments = cancelled_payments;

        env.storage()
            .persistent()
            .set(&DataKey::Escrow(escrow_id), &escrow);

        // Emit event: escrow_cancelled
        env.events().publish(
            (symbol_short!("escrow"), symbol_short!("cancel")),
            escrow_id,
        );

        Ok(())
    }

    /// Retrieve escrow details
    pub fn get_escrow(env: Env, escrow_id: u32) -> Result<CoreFlowEscrow, ContractError> {
        env.storage()
            .persistent()
            .get(&DataKey::Escrow(escrow_id))
            .ok_or(ContractError::InvalidPaymentId)
    }

    /// Extend an escrow's storage lifetime. Anyone may call this.
    ///
    /// Persistent entries that run out of rent are archived to the Expired
    /// State Stack and can be restored; they are not deleted. The failure this
    /// avoids is a funded escrow becoming temporarily unusable until someone
    /// pays to restore it.
    //
    // ── The Soroban storage lifecycle, precisely ────────────────────────────
    // Escrow state and its nonce watermark live in PERSISTENT storage. When a
    // persistent entry runs out of rent it is removed from the live ledger and
    // placed on the Expired State Stack, from which it can be restored with a
    // Stellar Core `RestoreFootprint` operation. Persistent entries are NOT
    // permanently deleted -- that is the behaviour of TEMPORARY storage, which
    // this contract deliberately does not use for anything.
    //
    // So the failure mode is a funded escrow becoming temporarily *unusable*
    // (every entry point loads the escrow first, so all of them fail) until
    // someone pays to restore it. Recoverable, not fund loss. Still worth
    // avoiding: an escrow needing an out-of-band restore before a worker can be
    // paid is an operational incident.
    //
    // ── Why anyone may call this ────────────────────────────────────────────
    // Requiring the manager's authorization would tie an escrow's survival to
    // one key remaining available and willing. The party with the strongest
    // interest in keeping a funded escrow alive is often the WORKER awaiting
    // payment, and they hold no authority over it. Keeping this open lets the
    // worker, the platform, or a keeper bot pay the rent. There is nothing to
    // abuse: the only effect is paying to keep someone else's data alive, and
    // the caller funds the transaction.
    //
    // Both keys are extended together. Letting the nonce watermark and the
    // escrow diverge in lifetime would mean restoring one without the other.
    pub fn extend_escrow_ttl(env: Env, escrow_id: u32) -> Result<(), ContractError> {
        // Confirm the escrow exists before charging anyone rent for a key that
        // holds nothing.
        if !env
            .storage()
            .persistent()
            .has(&DataKey::Escrow(escrow_id))
        {
            return Err(ContractError::InvalidPaymentId);
        }

        // Extend to the network maximum: the caller has explicitly chosen to pay
        // for longevity, so buying the least possible would be a strange default.
        let max = env.storage().max_ttl();

        env.storage()
            .persistent()
            .extend_ttl(&DataKey::Escrow(escrow_id), max, max);
        env.storage()
            .persistent()
            .extend_ttl(&DataKey::Nonce(escrow_id), max, max);
        env.storage().persistent().extend_ttl(
            &DataKey::EscrowCount,
            max,
            max,
        );
        // The contract instance carries Admin and Paused; if it lapses, nothing
        // works regardless of how healthy an individual escrow is.
        env.storage().instance().extend_ttl(max, max);

        env.events().publish(
            (symbol_short!("escrow"), symbol_short!("ttl")),
            (escrow_id, max),
        );

        Ok(())
    }

    /// Return the exact bytes the oracle must sign for this payment.
    ///
    /// Read-only. Exposing the preimage makes the CONTRACT the single source of
    /// truth for the message format: an off-chain signer can simulate this call
    /// and sign the returned bytes verbatim instead of reimplementing the layout
    /// and hoping the two agree. Every historical mismatch between a signer and
    /// a verifier is a bug this removes by construction.
    pub fn proof_preimage(
        env: Env,
        escrow_id: u32,
        payment_id: u32,
        hours: i128,
        nonce: u64,
    ) -> Result<Bytes, ContractError> {
        let escrow: CoreFlowEscrow = env
            .storage()
            .persistent()
            .get(&DataKey::Escrow(escrow_id))
            .ok_or(ContractError::InvalidPaymentId)?;
        if payment_id >= escrow.payments.len() {
            return Err(ContractError::InvalidPaymentId);
        }
        let payment = escrow.payments.get(payment_id).unwrap();
        Ok(Self::build_proof_message(
            &env, escrow_id, payment_id, &payment, hours, nonce,
        ))
    }

    /// Return the next expected oracle nonce for an escrow.
    /// The oracle must sign a proof using this exact value (replay protection).
    /// Returns 0 for an unknown/uninitialized escrow.
    pub fn get_nonce(env: Env, escrow_id: u32) -> u64 {
        env.storage()
            .persistent()
            .get(&DataKey::Nonce(escrow_id))
            .unwrap_or(0u64)
    }
}

#[cfg(test)]
mod test;
