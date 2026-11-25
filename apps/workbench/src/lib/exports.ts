import type { ClaimJSON } from '@coreflow/sdk';
import type { NetworkChoice } from './claims';

/**
 * The claim as a `stellar contract invoke` argument. u64 fields are written
 * as bare JSON numbers, which stellar-cli reads exactly, including values
 * above 2^53: this is the form examples/marketplace-hold/scripts/e2e-testnet.mjs
 * used for the recorded Testnet releases.
 */
export function claimInvokeArg(json: ClaimJSON): string {
  const parts = [
    `"issuer":"${json.issuer}"`,
    `"claim_type":"${json.claim_type}"`,
    `"subject":"${json.subject}"`,
    `"payload_hash":"${json.payload_hash}"`,
    `"payload_encoding":${json.payload_encoding}`,
    `"replay_mode":${json.replay_mode}`,
    `"nonce":${json.nonce}`,
    `"claim_id":"${json.claim_id}"`,
    `"issued_at":${json.issued_at}`,
    `"expires_at":${json.expires_at}`,
  ];
  return `{${parts.join(',')}}`;
}

const CLI_NETWORK: Partial<Record<NetworkChoice, string>> = { testnet: 'testnet', futurenet: 'futurenet' };

/**
 * A `stellar contract invoke` command that submits the claim to the
 * marketplace-hold example's `release`. Placeholders in angle brackets are
 * left for the person to fill in.
 */
export function releaseCommand(opts: {
  json: ClaimJSON;
  contractId: string;
  network: NetworkChoice;
  signatureHex?: string;
}): string {
  const network = CLI_NETWORK[opts.network] ?? '<NETWORK>';
  return [
    'stellar contract invoke \\',
    `  --id ${opts.contractId} \\`,
    '  --source <YOUR_STELLAR_CLI_IDENTITY> \\',
    `  --network ${network} \\`,
    '  -- release \\',
    '  --hold_id <HOLD_ID> \\',
    `  --claim '${claimInvokeArg(opts.json)}' \\`,
    `  --signature ${opts.signatureHex ?? '<SIGNATURE_HEX_FROM_YOUR_ISSUER>'}`,
  ].join('\n');
}

const NETWORK_CONST: Partial<Record<NetworkChoice, string>> = {
  testnet: 'Networks.TESTNET',
  futurenet: 'Networks.FUTURENET',
  mainnet: 'Networks.PUBLIC',
};

export interface SnippetInput {
  network: NetworkChoice;
  passphrase: string;
  contractId: string;
  claimTypeName: string;
  subject: { mode: 'text' | 'hex'; value: string };
  payload: { mode: 'text' | 'hex'; value: string };
  payloadEncoding: 'raw' | 'xdr';
  replay: { mode: 'unique-id'; claimIdHex: string } | { mode: 'sequence'; nonce: string };
  issuedAt: string;
  expiresAt: string;
}

/**
 * TypeScript for an issuer backend that signs the same claim with
 * @coreflow/sdk. Only the issuer differs: the backend uses its own key.
 */
export function issuerSnippet(s: SnippetInput): string {
  const q = (text: string) => JSON.stringify(text);
  const network = NETWORK_CONST[s.network] ?? q(s.passphrase);
  const subject = s.subject.mode === 'text' ? `sha256(${q(s.subject.value)})` : `fromHex(${q(s.subject.value)})`;
  const payload =
    s.payload.mode === 'text' ? `sha256(${q(s.payload.value)})` : `sha256(fromHex(${q(s.payload.value)}))`;
  const replay =
    s.replay.mode === 'unique-id'
      ? `{ mode: 'unique-id', claimId: fromHex(${q(s.replay.claimIdHex)}) }, // or randomClaimId()`
      : `{ mode: 'sequence', nonce: ${s.replay.nonce}n },`;
  const imports = ['claimType', 'fromHex', 'issuerPublicKey', 'sha256', 'signClaim', 'verifyClaim', 'type Claim'];
  return [
    "import { Networks } from '@stellar/stellar-base';",
    `import { ${imports.join(', ')} } from '@coreflow/sdk';`,
    '',
    `const ctx = { networkPassphrase: ${network}, contractId: ${q(s.contractId)} };`,
    '// Load the issuer secret from your secret manager. Never send it to a browser.',
    'const secret = process.env.ISSUER_SECRET!;',
    '',
    'const claim: Claim = {',
    '  issuer: issuerPublicKey(secret),',
    `  claimType: claimType(${q(s.claimTypeName)}),`,
    `  subject: ${subject},`,
    `  payloadHash: ${payload},`,
    `  payloadEncoding: '${s.payloadEncoding}',`,
    `  replay: ${replay}`,
    `  issuedAt: ${s.issuedAt}n,`,
    `  expiresAt: ${s.expiresAt}n,`,
    '};',
    '',
    'const { signature } = signClaim(claim, ctx, secret);',
    'verifyClaim(claim, ctx, signature); // the same off-chain pre-check the Workbench runs',
  ].join('\n');
}
