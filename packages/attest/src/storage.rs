// The `Cfa` variant prefix is deliberate (it guards against key collisions), and
// `#[contracttype]` generates items that an item-level allow does not reach.
#![allow(clippy::enum_variant_names)]

use soroban_sdk::{contracttype, BytesN, Env, IntoVal, Val};

/// Persistent storage TTL, in ledgers.
pub(crate) const PERSISTENT_TTL_THRESHOLD: u32 = 17_280; // refresh when below 1 day
pub(crate) const PERSISTENT_TTL_EXTEND: u32 = 17_280 * 90; // extend to 90 days

/// Storage keys owned by this crate. Variants carry a `Cfa` prefix so they can
/// never collide with a host contract's own `DataKey` variants.
#[contracttype]
#[derive(Clone)]
pub(crate) enum StorageKey {
    /// Registered issuer public key -> `true`.
    CfaIssuer(BytesN<32>),
    /// Sequence scope digest -> next expected nonce (`u64`).
    CfaSeq(BytesN<32>),
    /// (issuer, claim_id) -> `true`.
    CfaUsed(BytesN<32>, BytesN<32>),
}

/// Write `value` to persistent storage and extend its rent.
///
/// Replay and registry state is persistent on purpose: an entry whose rent
/// lapses is archived and must be restored before it can be read, so it can
/// never silently reset to "absent". Temporary storage must not be used here.
pub(crate) fn put<V: IntoVal<Env, Val>>(env: &Env, key: &StorageKey, value: &V) {
    env.storage().persistent().set(key, value);
    // check:ttl begin
    env.storage()
        .persistent()
        .extend_ttl(key, PERSISTENT_TTL_THRESHOLD, PERSISTENT_TTL_EXTEND);
    // check:ttl end
}
