import { Keypair, StrKey } from '@stellar/stellar-base';
import { assertBytes } from './bytes.js';
import { PREIMAGE_LENGTH } from './encode.js';
import { ClaimError } from './errors.js';
import { PREIMAGE_LAYOUT, type PreimageFieldName } from './layout.js';

/**
 * Every field of a preimage, read back as it is on the wire.
 *
 * Nothing here is validated beyond the structure (length, magic, version):
 * `payloadEncoding` and `replayMode` are the raw bytes, and both `nonce` and
 * `claimId` are returned whatever the replay mode, so a preimage built by a
 * buggy encoder can be inspected rather than rejected.
 */
export interface DecodedPreimage {
  /** Wire version, always 1 for a preimage this function accepts. */
  version: number;
  /** `SHA-256(network passphrase)`. See `identifyNetwork`. */
  networkId: Uint8Array;
  /** `SHA-256(XDR(ScVal::Address(contract)))`. Compare with `contractDigest(contractId)`. */
  contractDigest: Uint8Array;
  issuer: Uint8Array;
  claimType: Uint8Array;
  subject: Uint8Array;
  payloadHash: Uint8Array;
  /** Raw byte: 0 = raw, 1 = XDR. Other values are reserved and never valid. */
  payloadEncoding: number;
  /** Raw byte: 0 = sequence, 1 = unique-id. Other values are not defined. */
  replayMode: number;
  nonce: bigint;
  claimId: Uint8Array;
  issuedAt: bigint;
  expiresAt: bigint;
}

const MAGIC = [0x43, 0x46, 0x43, 0x4c]; // "CFCL"

function slice(bytes: Uint8Array, name: PreimageFieldName): Uint8Array {
  const f = PREIMAGE_LAYOUT.find((x) => x.name === name)!;
  return bytes.slice(f.offset, f.offset + f.size);
}

/**
 * Read a 256-byte preimage back into its fields (claim-format.md section 2).
 *
 * Use it to see what a signer or a contract actually put into the signed
 * bytes, for example when a signature verifies in one language but not the
 * other. The network and contract come back as digests: hashes cannot be
 * reversed, so compare them with `networkId(passphrase)` and
 * `contractDigest(contractId)` or `identifyNetwork`.
 *
 * @example
 * const d = decodePreimage(fromHex(preimageHex));
 * identifyNetwork(d.networkId)?.name; // 'testnet'
 *
 * @throws {ClaimError} `InvalidInput` when the input is not 256 bytes, does
 *   not start with `CFCL`, or carries a wire version other than 1.
 */
export function decodePreimage(preimage: Uint8Array): DecodedPreimage {
  assertBytes(preimage, PREIMAGE_LENGTH, 'preimage');
  if (!MAGIC.every((b, i) => preimage[i] === b)) {
    throw new ClaimError('InvalidInput', 'preimage: does not start with the magic "CFCL" (0x4346434c)');
  }
  const view = new DataView(preimage.buffer, preimage.byteOffset, preimage.byteLength);
  const version = view.getUint16(4);
  if (version !== 1) {
    throw new ClaimError('InvalidInput', `preimage: wire version ${version} is not supported (expected 1)`);
  }
  return {
    version,
    networkId: slice(preimage, 'network_id'),
    contractDigest: slice(preimage, 'contract'),
    issuer: slice(preimage, 'issuer'),
    claimType: slice(preimage, 'claim_type'),
    subject: slice(preimage, 'subject'),
    payloadHash: slice(preimage, 'payload_hash'),
    payloadEncoding: preimage[198]!,
    replayMode: preimage[199]!,
    nonce: view.getBigUint64(200),
    claimId: slice(preimage, 'claim_id'),
    issuedAt: view.getBigUint64(240),
    expiresAt: view.getBigUint64(248),
  };
}

/**
 * Check that `signature` is the Ed25519 signature of the issuer named inside
 * `preimage` over exactly these 256 bytes.
 *
 * This answers one narrow question: "do these bytes and this signature belong
 * together?" It does **not** check the network, the contract, the validity
 * window, expiry or the replay fields. Use `verifyClaim` to check a claim.
 *
 * @throws {ClaimError} `InvalidSignature` when the signature does not match;
 *   `InvalidInput` for a malformed preimage or a signature that is not 64 bytes.
 */
export function verifyPreimage(preimage: Uint8Array, signature: Uint8Array): void {
  assertBytes(signature, 64, 'signature');
  const { issuer } = decodePreimage(preimage);
  // check:preimage-signature begin
  const key = Keypair.fromPublicKey(StrKey.encodeEd25519PublicKey(issuer as never));
  if (!key.verify(preimage as never, signature as never)) {
    throw new ClaimError('InvalidSignature', 'signature is not the embedded issuer key over these bytes');
  }
  // check:preimage-signature end
}

/** One field that differs between two preimages. */
export interface PreimageFieldDiff {
  name: PreimageFieldName;
  offset: number;
  size: number;
  a: Uint8Array;
  b: Uint8Array;
}

/**
 * Compare two 256-byte preimages field by field and return the fields that
 * differ, in layout order. An empty array means the bytes are identical.
 *
 * Neither input needs a valid magic or version, so this also works on the
 * output of an encoder that is wrong in exactly those places.
 *
 * @example
 * comparePreimages(fromHex(tsHex), fromHex(rustHex)).map((d) => d.name); // ['contract']
 *
 * @throws {ClaimError} `InvalidInput` unless both inputs are 256-byte `Uint8Array`s.
 */
export function comparePreimages(a: Uint8Array, b: Uint8Array): PreimageFieldDiff[] {
  assertBytes(a, PREIMAGE_LENGTH, 'a');
  assertBytes(b, PREIMAGE_LENGTH, 'b');
  const diffs: PreimageFieldDiff[] = [];
  for (const f of PREIMAGE_LAYOUT) {
    const x = a.slice(f.offset, f.offset + f.size);
    const y = b.slice(f.offset, f.offset + f.size);
    if (!x.every((v, i) => v === y[i])) diffs.push({ name: f.name, offset: f.offset, size: f.size, a: x, b: y });
  }
  return diffs;
}
