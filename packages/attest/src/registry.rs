//! Issuer registry: the set of Ed25519 public keys a contract trusts.
//!
//! **This crate never authorizes.** Every function here mutates storage
//! unconditionally. The host contract MUST authorize the caller first, for
//! example `admin.require_auth()` inside its own admin function, before calling
//! `register`, `revoke` or `rotate`. Calling these from an unauthenticated
//! entry point lets anyone choose which keys the contract trusts.

use soroban_sdk::{contractevent, BytesN, Env};

use crate::error::AttestError;
use crate::storage::{put, StorageKey};

/// Emitted when an issuer key is registered.
#[contractevent]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct IssuerRegistered {
    #[topic]
    pub issuer: BytesN<32>,
}

/// Emitted when an issuer key is revoked.
#[contractevent]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct IssuerRevoked {
    #[topic]
    pub issuer: BytesN<32>,
}

/// Emitted when an issuer key is rotated.
#[contractevent]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct IssuerRotated {
    #[topic]
    pub old: BytesN<32>,
    #[topic]
    pub new: BytesN<32>,
}

/// True if `issuer` is registered.
pub fn is_registered(env: &Env, issuer: &BytesN<32>) -> bool {
    env.storage()
        .persistent()
        .get(&StorageKey::CfaIssuer(issuer.clone()))
        .unwrap_or(false)
}

/// Trust `issuer` from now on.
///
/// The host must authorize the caller before calling this (see module docs).
///
/// # Errors
/// `IssuerAlreadyRegistered` if the key is already registered.
pub fn register(env: &Env, issuer: &BytesN<32>) -> Result<(), AttestError> {
    // check:register-duplicate begin
    if is_registered(env, issuer) {
        return Err(AttestError::IssuerAlreadyRegistered);
    }
    // check:register-duplicate end
    put(env, &StorageKey::CfaIssuer(issuer.clone()), &true);
    IssuerRegistered {
        issuer: issuer.clone(),
    }
    .publish(env);
    Ok(())
}

/// Stop trusting `issuer` immediately, including for claims it already signed
/// that have not yet been submitted.
///
/// The host must authorize the caller before calling this (see module docs).
///
/// # Errors
/// `IssuerNotFound` if the key is not registered.
pub fn revoke(env: &Env, issuer: &BytesN<32>) -> Result<(), AttestError> {
    // check:revoke-unknown begin
    if !is_registered(env, issuer) {
        return Err(AttestError::IssuerNotFound);
    }
    // check:revoke-unknown end
    env.storage()
        .persistent()
        .remove(&StorageKey::CfaIssuer(issuer.clone()));
    IssuerRevoked {
        issuer: issuer.clone(),
    }
    .publish(env);
    Ok(())
}

/// Register `new` and revoke `old` in one call. Both checks run before any
/// write, so a failed rotation changes nothing.
///
/// The host must authorize the caller before calling this (see module docs).
///
/// # Errors
/// `IssuerNotFound` if `old` is not registered; `IssuerAlreadyRegistered` if
/// `new` already is (including `old == new`).
pub fn rotate(env: &Env, old: &BytesN<32>, new: &BytesN<32>) -> Result<(), AttestError> {
    // check:rotate-unknown begin
    if !is_registered(env, old) {
        return Err(AttestError::IssuerNotFound);
    }
    // check:rotate-unknown end
    // check:rotate-duplicate begin
    if is_registered(env, new) {
        return Err(AttestError::IssuerAlreadyRegistered);
    }
    // check:rotate-duplicate end
    put(env, &StorageKey::CfaIssuer(new.clone()), &true);
    // check:rotate-remove-old begin
    env.storage()
        .persistent()
        .remove(&StorageKey::CfaIssuer(old.clone()));
    // check:rotate-remove-old end
    IssuerRotated {
        old: old.clone(),
        new: new.clone(),
    }
    .publish(env);
    Ok(())
}
