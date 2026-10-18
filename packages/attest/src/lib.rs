//! Verify issuer-signed off-chain claims inside a Soroban contract.
//!
//! A claim is a fixed-layout statement signed with an Ed25519 key. This crate
//! rebuilds the 256-byte preimage on-chain (binding it to the network and the
//! verifying contract), checks the issuer registry, expiry and replay state,
//! verifies the signature, and records the claim as used.
//!
//! The wire format is specified in `docs/kit/claim-format.md`. The crate never
//! authorizes callers: the host contract must authorize registry changes.
//!
//! Status: 0.1.0-alpha, unaudited, testnet only.
#![no_std]

mod claim;
mod error;
pub mod registry;
pub mod replay;
mod storage;
mod verify;

#[cfg(any(test, feature = "testutils"))]
pub mod testutils;

pub use claim::{preimage, Claim, ReplayMode, MAGIC, PREIMAGE_LEN, WIRE_VERSION};
pub use error::AttestError;
pub use verify::verify_claim;
