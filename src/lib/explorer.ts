/**
 * Stellar Expert explorer links, derived from the ACTIVE network.
 *
 * ── Why this is centralized ──────────────────────────────────────────────────
 * Several call sites hard-coded `/explorer/public/` (Mainnet) regardless of
 * which network the app was actually pointed at. A Testnet transaction linked
 * to the Mainnet explorer resolves to nothing — and, worse, presents Testnet
 * activity as though it happened on Mainnet. For a product whose credibility
 * rests on verifiable settlement, a link that misstates the network is a
 * correctness bug, not a cosmetic one.
 *
 * ── CoreFlow v1 vs v2 ────────────────────────────────────────────────────────
 * CoreFlow v1 is deployed on Mainnet. CoreFlow v2 — the hardened contract with
 * domain-separated attestations, an admin-managed oracle registry, and the
 * work/amount invariant — is deployed on TESTNET ONLY. These are different
 * contracts with different security properties. `V1_MAINNET` exists so the one
 * place that deliberately references the historical deployment can do so
 * explicitly, rather than by a Mainnet default leaking through.
 */

import { STELLAR_CONFIG } from './config';

const BASE = 'https://stellar.expert/explorer';

/** The historical v1 contract on Mainnet. Not v2, and not security-hardened. */
export const V1_MAINNET = {
  contractId: 'CCTF5WBOQR7JP2KPLQT372X7JCGCINHDFRSAPF4YTYRKZXZ3J2XPRFFW',
  network: 'public' as const,
  label: 'CoreFlow v1 · Stellar Mainnet',
  url: `${BASE}/public/contract/CCTF5WBOQR7JP2KPLQT372X7JCGCINHDFRSAPF4YTYRKZXZ3J2XPRFFW`,
};

/** `public` or `testnet`, matching the network the app is configured for. */
function segment(): 'public' | 'testnet' {
  return STELLAR_CONFIG.isMainnet() ? 'public' : 'testnet';
}

export function txUrl(hash: string): string {
  return `${BASE}/${segment()}/tx/${hash}`;
}

export function contractUrl(contractId: string): string {
  return `${BASE}/${segment()}/contract/${contractId}`;
}

export function accountUrl(address: string): string {
  return `${BASE}/${segment()}/account/${address}`;
}

/**
 * Human label for the active network, for use next to an explorer link so a
 * reader never has to infer which chain a hash belongs to.
 */
export function explorerNetworkLabel(): string {
  return STELLAR_CONFIG.isMainnet() ? 'Mainnet' : 'Testnet';
}
