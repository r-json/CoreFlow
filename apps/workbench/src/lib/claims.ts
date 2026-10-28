import { KNOWN_NETWORKS, type ClaimContext, type ClaimJSON } from '@coreflow/sdk';
import type { Vector, VectorClaim } from './data';

export type NetworkChoice = 'testnet' | 'futurenet' | 'mainnet' | 'custom';

export const NETWORK_OPTIONS: { value: NetworkChoice; label: string }[] = [
  { value: 'testnet', label: 'Testnet' },
  { value: 'futurenet', label: 'Futurenet' },
  { value: 'mainnet', label: 'Mainnet (not supported by 0.1.0-alpha)' },
  { value: 'custom', label: 'Custom passphrase' },
];

/** The passphrase for a network choice; `custom` uses the text the person typed. */
export function passphraseFor(choice: NetworkChoice, custom: string): string {
  if (choice === 'custom') return custom;
  return KNOWN_NETWORKS.find((n) => n.name === choice)!.passphrase;
}

/** The network choice whose passphrase is `passphrase`, or `custom`. */
export function choiceFor(passphrase: string): NetworkChoice {
  return KNOWN_NETWORKS.find((n) => n.passphrase === passphrase)?.name ?? 'custom';
}

/**
 * The contract the reference Testnet run deployed (examples/marketplace-hold,
 * evidence testnet-e2e-20261018T020314Z.json). Used only as a valid default.
 */
export const REFERENCE_CONTRACT_ID = 'CBZZ4ATLYUNXXGQHIBYRJK7ZONFWXI5RDOYMXQGDPAHR6HGHFKKL7H6K';

/** The vector file's claim, re-keyed into the SDK's portable JSON form. */
export function vectorClaimJSON(c: VectorClaim): ClaimJSON {
  return {
    issuer: c.issuer_hex,
    claim_type: c.claim_type_hex,
    subject: c.subject_hex,
    payload_hash: c.payload_hash_hex,
    payload_encoding: c.payload_encoding,
    replay_mode: c.replay_mode,
    nonce: c.nonce,
    claim_id: c.claim_id_hex,
    issued_at: c.issued_at,
    expires_at: c.expires_at,
  };
}

export function vectorContext(v: Vector): ClaimContext {
  return { networkPassphrase: v.context.network_passphrase, contractId: v.context.contract_id };
}

/** Pretty JSON for display and copying. */
export const prettyJSON = (value: unknown) => JSON.stringify(value, null, 2);
