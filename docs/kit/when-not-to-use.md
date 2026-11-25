# When not to use CoreFlow Kit

CoreFlow Kit verifies **claims signed off-chain by an issuer key**. That is the
right tool for some facts and the wrong one for others. This page is here so
you can rule it out quickly.

## First question: can your attester sign a Stellar transaction?

If the party vouching for the fact can hold a funded Stellar account and submit
(or co-sign) a transaction, **use Soroban's built-in `require_auth` instead.**
Keep an allowlist of attester addresses in your contract and call
`attester.require_auth()` in the function that acts on the fact. You get, for
free:

- authorization checked by the host, not by a library you have to trust;
- replay protection per invocation, with signature expiration handled by the protocol;
- Stellar multisig, hardware wallets and wallet UX for the attester's key;
- one less format to version and test.

Signed claims earn their place when that is not possible or not practical.

## Decision table

| Question | Favours `require_auth` | Favours signed claims |
|---|---|---|
| Can the signer hold a funded account and submit transactions? | Yes | No — a backend service, sensor, courier app or partner API |
| Who should pay the fee? | The attester, one transaction per fact, is fine | A relayer or the beneficiary should pay |
| Is the signer online when the fact is used? | Yes | No — it signs at the edge; someone submits later |
| How many signers feed one submitter? | A few | Many, batched by one relayer |
| Does the contract that uses the fact interact with the signer? | Yes, the signer calls it | No — the claim is consumed by a contract the signer never touches |
| Must the same fact be checked off-chain or elsewhere too? | On-chain only | The same signed bytes are checked by a backend, an auditor or another system |
| Do you need multisig, hardware-wallet or wallet-app signing? | Yes | A service key is acceptable |
| Can your team own a custom verifier? | No | Yes, or the kit provides it |
| Do auditors want a portable signed record of each fact? | Transaction history is enough | A signed claim stored next to the business record |

**Rule of thumb:** use `require_auth` unless the signer cannot submit
transactions, is offline, feeds a relayer alongside many other signers, or the
fact must be verifiable outside the chain as well. The other rows only break
ties.

## Other cases where this is the wrong tool

| You need… | Use instead | Why |
|---|---|---|
| Prices, rates or other numeric feeds aggregated from many sources | A price-feed oracle network | The kit verifies one issuer's statement; it does not aggregate, take medians or detect outliers. |
| Hosted escrow with milestones, dispute resolution and a ready UI | An escrow service such as [Trustless Work](https://docs.trustlesswork.com) | That decides *what* is released and to whom. Signed claims can complement it by deciding *whether the evidence counts*. |
| Audited custody of real funds on Mainnet | Audited contracts only | 0.1.0-alpha is unaudited and Testnet-only. See [security-model.md](security-model.md#audit-status). |
| A fact that needs k-of-n issuers to agree | Not supported in 0.1 | Verify several claims yourself in your contract, or wait for threshold support. |
| Signatures made by a wallet's "sign message" feature | Not supported in 0.1 | Wallets wrap the message in their own envelope, so the signed bytes are not the claim preimage. |
| Claims that must not be submittable by anyone | Your own auth on top | Any party can submit a valid claim; your contract must never reward the submitter. |

## Good fits

- A backend or device signs that something happened — a delivery, an
  inspection, a sensor reading, a completed milestone — and a contract releases
  funds when the claim verifies.
- A relayer collects facts from many issuers and submits them in batches.
- The same signed claim must be checked by your contract, your backend and an
  auditor, byte for byte.
- You want replay protection, expiry and key rotation without writing and
  testing them yourself.

See [claim-format.md](claim-format.md) for the format and
[key-rotation.md](key-rotation.md) for operating an issuer key.
