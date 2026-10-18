use soroban_sdk::contracterror;

/// Errors returned by `coreflow-attest`.
///
/// The codes occupy the reserved range 1101-1109 so they never collide with a
/// host contract's own `#[contracterror]` values. See `docs/kit/claim-format.md`
/// section 6 for the client-side next step for each code.
///
/// An invalid Ed25519 signature is **not** one of these errors: the host
/// function `ed25519_verify` aborts the invocation instead of returning.
#[contracterror]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u32)]
pub enum AttestError {
    /// The claim's issuer key is not in the registry.
    IssuerNotRegistered = 1101,
    /// `expires_at` is not later than `issued_at`.
    InvalidWindow = 1102,
    /// The ledger timestamp is later than `expires_at`.
    ClaimExpired = 1103,
    /// The replay fields do not match the replay mode, or a reserved
    /// `payload_encoding` / mode value was used.
    InvalidReplayFields = 1104,
    /// Sequence mode: `nonce` is not the next expected value for the scope.
    NonceMismatch = 1105,
    /// Unique-id mode: this `(issuer, claim_id)` was already accepted.
    ClaimAlreadyUsed = 1106,
    /// Sequence mode: the scope's counter cannot advance past `u64::MAX`.
    NonceOverflow = 1107,
    /// `register` was called for a key that is already registered.
    IssuerAlreadyRegistered = 1108,
    /// `revoke` or `rotate` named a key that is not registered.
    IssuerNotFound = 1109,
}
