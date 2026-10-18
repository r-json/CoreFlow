use soroban_sdk::{BytesN, Env};

use crate::claim::{preimage, Claim, ReplayMode};
use crate::error::AttestError;
use crate::{registry, replay};

/// Verify `claim` against `signature` and, if valid, mark it as used.
///
/// Performs spec section 5 steps 1-7 in order and fails with the named error at
/// the first check that does not hold:
///
/// 1. issuer registered (`IssuerNotRegistered`)
/// 2. `expires_at > issued_at` (`InvalidWindow`)
/// 3. ledger timestamp `<= expires_at` (`ClaimExpired`; equality is valid)
/// 4. replay fields match the mode, `payload_encoding` is 0 or 1
///    (`InvalidReplayFields`)
/// 5. replay check (`NonceMismatch` / `ClaimAlreadyUsed`)
/// 6. Ed25519 signature over the rebuilt preimage
/// 7. consume the nonce or claim id (`NonceOverflow`)
///
/// On success the claim is consumed, so a second call with the same claim
/// fails at step 5. Call this from the host function that acts on the claim
/// (for example a release), in the same invocation, so the claim is consumed
/// atomically with the action.
///
/// An invalid signature does **not** return an error: `ed25519_verify` aborts
/// the invocation, the transaction fails, and step 7 never persists. Clients
/// should check the signature off-chain first.
///
/// # Errors
/// Any [`AttestError`] named above. Must be called from contract context.
pub fn verify_claim(env: &Env, claim: &Claim, signature: &BytesN<64>) -> Result<(), AttestError> {
    // check:issuer-registered begin
    if !registry::is_registered(env, &claim.issuer) {
        return Err(AttestError::IssuerNotRegistered);
    }
    // check:issuer-registered end

    // check:window begin
    if claim.expires_at <= claim.issued_at {
        return Err(AttestError::InvalidWindow);
    }
    // check:window end

    // check:expiry begin
    if env.ledger().timestamp() > claim.expires_at {
        return Err(AttestError::ClaimExpired);
    }
    // check:expiry end

    // check:replay-fields begin
    let fields_match_mode = match claim.replay_mode {
        ReplayMode::Sequence => claim.claim_id == BytesN::from_array(env, &[0u8; 32]),
        ReplayMode::UniqueId => claim.nonce == 0,
    };
    if !fields_match_mode {
        return Err(AttestError::InvalidReplayFields);
    }
    // check:replay-fields end

    // check:payload-encoding begin
    if claim.payload_encoding > 1 {
        return Err(AttestError::InvalidReplayFields);
    }
    // check:payload-encoding end

    replay::check(env, claim)?;

    // check:signature begin
    env.crypto()
        .ed25519_verify(&claim.issuer, &preimage(env, claim), signature);
    // check:signature end

    // check:consume begin
    replay::consume(env, claim)?;
    // check:consume end
    Ok(())
}
