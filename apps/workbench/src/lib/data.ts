/**
 * Repository data the Workbench reads at build time. Both files are the
 * committed originals, not copies, so the Workbench cannot drift from them.
 */
import vectorFile from '@repo/packages/test-vectors/vectors/claim-v1.json';

export interface VectorContext {
  network_passphrase: string;
  network_id_hex: string;
  contract_id: string;
  contract_digest_hex: string;
}
export interface VectorClaim {
  issuer_hex: string;
  claim_type_hex: string;
  claim_type_string?: string;
  subject_hex: string;
  payload_hex?: string;
  payload_hash_hex: string;
  payload_encoding: number;
  replay_mode: number;
  nonce: string;
  claim_id_hex: string;
  issued_at: string;
  expires_at: string;
}
export interface Vector {
  name: string;
  description?: string;
  reason?: string;
  expected_error?: string;
  context: VectorContext;
  claim: VectorClaim;
  now: string;
  preimage_hex?: string;
  signature_hex: string;
}
export interface VectorIssuer {
  name: string;
  seed_rule: string;
  seed_hex: string;
  public_key_hex: string;
}
export interface VectorFile {
  version: number;
  description: string;
  issuers: VectorIssuer[];
  valid: Vector[];
  invalid: Vector[];
}

export const VECTORS = vectorFile as VectorFile;

/** One step recorded by examples/marketplace-hold/scripts/e2e-testnet.mjs. */
export interface EvidenceStep {
  name: string;
  at: string;
  txHash?: string;
  ledger?: number;
  explorer?: string;
  contractId?: string;
  holdId?: number;
  claim?: Record<string, unknown>;
  signatureHex?: string;
  preimageHex?: string;
  payloadUtf8?: string;
  expected?: number;
  observed?: number;
  errorName?: string;
  submitted?: boolean;
  simulationMessage?: string;
  [key: string]: unknown;
}
export interface EvidenceRun {
  file: string;
  scriptVersion: string;
  runId: string;
  network: string;
  networkPassphrase: string;
  startedAt: string;
  finishedAt?: string;
  outcome?: string;
  contractId?: string;
  steps: EvidenceStep[];
}

const evidenceModules = import.meta.glob<{ default: Omit<EvidenceRun, 'file'> }>(
  '@repo/examples/marketplace-hold/evidence/testnet-e2e-*.json',
  { eager: true },
);

/** Recorded passing Testnet runs, oldest first. */
export const EVIDENCE_RUNS: EvidenceRun[] = Object.entries(evidenceModules)
  .map(([path, mod]) => ({ ...mod.default, file: path.split('/').pop() ?? path }))
  .sort((a, b) => a.startedAt.localeCompare(b.startedAt));

export const REPO_URL = 'https://github.com/r-json/CoreFlow';
/** A link to a file on the repository's main branch. */
export const repoLink = (path: string) => `${REPO_URL}/blob/main/${path}`;
