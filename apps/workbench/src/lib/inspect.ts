import {
  ClaimError,
  PREIMAGE_LAYOUT,
  claimType,
  contractDigest,
  decodePreimage,
  identifyNetwork,
  issuerToStrkey,
  networkId,
  toHex,
  type DecodedPreimage,
  type PreimageFieldName,
} from '@coreflow/sdk';
import { relativeTime, unixToIso } from './format';

export interface FieldRow {
  name: PreimageFieldName;
  offset: number;
  size: number;
  hex: string;
  /** Plain-language reading of the value. */
  meaning: string;
  tone: 'neutral' | 'ok' | 'warn';
}

export interface Inspection {
  rows: FieldRow[];
  /** Set when the bytes are 256 long but are not a wire-version-1 preimage. */
  decodeError?: string;
  decoded?: DecodedPreimage;
  warnings: string[];
}

/** Claim type names the Workbench can recognise from their hash. */
export const KNOWN_CLAIM_TYPES = ['marketplace.delivery.v1'];

export interface InspectOptions {
  now: bigint;
  /** When given, the network digest is compared against SHA-256 of this passphrase. */
  expectedPassphrase?: string;
  /** When given, the contract digest is compared against this contract's digest. */
  expectedContractId?: string;
  /** Extra claim type names to recognise. */
  claimTypeNames?: string[];
}

const ZERO = (bytes: Uint8Array) => bytes.every((b) => b === 0);

/** Split a 256-byte buffer by the preimage layout and explain each field. */
export function inspectPreimage(bytes: Uint8Array, opts: InspectOptions): Inspection {
  const raw = PREIMAGE_LAYOUT.map((f) => ({ ...f, hex: toHex(bytes.slice(f.offset, f.offset + f.size)) }));
  const warnings: string[] = [];
  let decoded: DecodedPreimage;
  try {
    decoded = decodePreimage(bytes);
  } catch (e) {
    if (!(e instanceof ClaimError)) throw e;
    return {
      rows: raw.map((f) => ({
        ...f,
        meaning: '',
        tone: f.name === 'magic' || f.name === 'version' ? 'warn' : 'neutral',
      })),
      decodeError: e.message,
      warnings: [e.message],
    };
  }

  const meaning = new Map<PreimageFieldName, [string, FieldRow['tone']]>();
  meaning.set('magic', ['"CFCL", the CoreFlow claim marker', 'ok']);
  meaning.set('version', ['Wire version 1 (claim-format v0.1)', 'ok']);

  const net = identifyNetwork(decoded.networkId);
  if (opts.expectedPassphrase !== undefined && opts.expectedPassphrase !== '') {
    const match = toHex(networkId(opts.expectedPassphrase)) === toHex(decoded.networkId);
    meaning.set('network_id', [
      match
        ? `Matches "${opts.expectedPassphrase}"`
        : `Does not match "${opts.expectedPassphrase}"${net ? `; it is ${net.name}` : ''}`,
      match ? 'ok' : 'warn',
    ]);
    if (!match)
      warnings.push(
        'The network digest does not match the network you entered, so the contract on that network would reject this signature.',
      );
  } else {
    meaning.set('network_id', [
      net
        ? `${net.name[0]!.toUpperCase()}${net.name.slice(1)} (${net.passphrase})`
        : 'Not a public network: a private network, or a wrong passphrase',
      net ? 'ok' : 'warn',
    ]);
    if (!net)
      warnings.push('The network digest is not Mainnet, Testnet or Futurenet. Check the passphrase the signer used.');
  }

  if (opts.expectedContractId) {
    let match = false;
    let note = '';
    try {
      match = toHex(contractDigest(opts.expectedContractId)) === toHex(decoded.contractDigest);
    } catch {
      note = ' (the contract ID you entered is not a valid C... address)';
    }
    meaning.set('contract', [
      match ? `Matches ${opts.expectedContractId}` : `Does not match the contract you entered${note}`,
      match ? 'ok' : 'warn',
    ]);
    if (!match && !note)
      warnings.push(
        'The contract digest does not match the contract you entered, so that contract would reject this signature.',
      );
  } else {
    meaning.set('contract', ['SHA-256 of the verifying contract address. Enter a contract ID to compare.', 'neutral']);
  }

  meaning.set('issuer', [issuerToStrkey(decoded.issuer), 'neutral']);
  const typeHex = toHex(decoded.claimType);
  const known = [...KNOWN_CLAIM_TYPES, ...(opts.claimTypeNames ?? [])].find(
    (n) => n && toHex(claimType(n)) === typeHex,
  );
  meaning.set('claim_type', [
    known ? `SHA-256("${known}")` : 'SHA-256 of a claim type name not listed here',
    known ? 'ok' : 'neutral',
  ]);
  meaning.set('subject', ['Chosen by the application, e.g. SHA-256("order:42")', 'neutral']);
  meaning.set('payload_hash', ['SHA-256 of the off-chain payload', 'neutral']);

  const enc = decoded.payloadEncoding;
  meaning.set('payload_encoding', [
    enc === 0 ? '0: raw bytes' : enc === 1 ? '1: XDR ScVal' : `${enc}: reserved, never valid`,
    enc <= 1 ? 'neutral' : 'warn',
  ]);
  if (enc > 1)
    warnings.push(`payload_encoding ${enc} is reserved; the contract rejects it with 1104 InvalidReplayFields.`);

  const mode = decoded.replayMode;
  meaning.set('replay_mode', [
    mode === 0 ? '0: sequence' : mode === 1 ? '1: unique-id' : `${mode}: undefined mode`,
    mode <= 1 ? 'neutral' : 'warn',
  ]);
  if (mode > 1) warnings.push(`replay_mode ${mode} is not defined. Only 0 (sequence) and 1 (unique-id) exist.`);

  if (mode === 0) {
    meaning.set('nonce', [`Sequence number ${decoded.nonce}`, 'neutral']);
    const bad = !ZERO(decoded.claimId);
    meaning.set('claim_id', [
      bad ? 'Must be all zero in sequence mode' : 'All zero, as sequence mode requires',
      bad ? 'warn' : 'ok',
    ]);
    if (bad)
      warnings.push(
        'A sequence claim carries a non-zero claim_id; the contract rejects it with 1104 InvalidReplayFields.',
      );
  } else if (mode === 1) {
    const bad = decoded.nonce !== 0n;
    meaning.set('nonce', [
      bad ? `${decoded.nonce}: must be 0 in unique-id mode` : '0, as unique-id mode requires',
      bad ? 'warn' : 'ok',
    ]);
    if (bad)
      warnings.push(
        'A unique-id claim carries a non-zero nonce; the contract rejects it with 1104 InvalidReplayFields.',
      );
    meaning.set('claim_id', ['One-time identifier, accepted once per issuer', 'neutral']);
  } else {
    meaning.set('nonce', [String(decoded.nonce), 'neutral']);
    meaning.set('claim_id', ['', 'neutral']);
  }

  const when = (s: bigint) => {
    const iso = unixToIso(s);
    return iso ? `${s} = ${iso} (${relativeTime(s, opts.now)})` : `${s} (beyond any calendar date)`;
  };
  meaning.set('issued_at', [when(decoded.issuedAt), 'neutral']);
  const expired = opts.now > decoded.expiresAt;
  meaning.set('expires_at', [when(decoded.expiresAt), expired ? 'warn' : 'neutral']);
  if (decoded.expiresAt <= decoded.issuedAt)
    warnings.push('expires_at is not later than issued_at; the contract rejects it with 1102 InvalidWindow.');
  else if (expired) warnings.push('This claim has expired; a contract would now reject it with 1103 ClaimExpired.');

  return {
    rows: raw.map((f) => {
      const [text, tone] = meaning.get(f.name) ?? ['', 'neutral'];
      return { ...f, meaning: text, tone };
    }),
    decoded,
    warnings,
  };
}
