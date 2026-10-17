/**
 * Independent reference implementation of the signed claim format
 * (docs/kit/claim-format.md, wire version 1), plus a mock issuer for tests.
 *
 * This file deliberately shares no code with @coreflow/sdk or coreflow-attest:
 * it has its own preimage encoder, its own strkey codec and signs with
 * @noble/ed25519. The vectors it produces are only a meaningful cross-check if
 * the implementations under test cannot have influenced them.
 *
 * TEST ONLY. Every key here is derived from a public string. Anyone can
 * recompute it. Never use these keys, or this module, to protect real value.
 */
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import * as ed from '@noble/ed25519';

export const MAGIC = Uint8Array.from([0x43, 0x46, 0x43, 0x4c]); // "CFCL"
export const WIRE_VERSION = 1;
export const PREIMAGE_LENGTH = 256;
export const NETWORKS = {
  testnet: 'Test SDF Network ; September 2015',
  mainnet: 'Public Global Stellar Network ; September 2015',
};

export const sha256 = (data) =>
  new Uint8Array(createHash('sha256').update(typeof data === 'string' ? Buffer.from(data, 'utf8') : data).digest());
export const toHex = (b) => Buffer.from(b).toString('hex');
export const fromHex = (h) => new Uint8Array(Buffer.from(h, 'hex'));
const ZERO32 = new Uint8Array(32);

// ---- strkey (SEP-23): version byte || payload || CRC16-XModem (LE), base32 ----
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const VERSION = { account: 6 << 3, contract: 2 << 3, seed: 18 << 3 };

function crc16xmodem(bytes) {
  let crc = 0;
  for (const b of bytes) {
    crc ^= b << 8;
    for (let i = 0; i < 8; i++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc;
}
function base32(bytes) {
  let bits = 0, value = 0, out = '';
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}
export function encodeStrkey(kind, payload32) {
  const body = new Uint8Array(33);
  body[0] = VERSION[kind];
  body.set(payload32, 1);
  const crc = crc16xmodem(body);
  const full = new Uint8Array(35);
  full.set(body);
  full[33] = crc & 0xff;
  full[34] = crc >> 8;
  return base32(full);
}

// ---- format ----
const u64be = (v) => {
  const n = BigInt(v);
  if (n < 0n || n > 0xffffffffffffffffn) throw new RangeError(`u64 out of range: ${v}`);
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, n);
  return out;
};

export const networkId = (passphrase) => sha256(passphrase);

/** SHA-256 of XDR(ScVal::Address(Contract(hash))) = 0x00000012 || 0x00000001 || hash. */
export function contractDigestFromHash(contractHash32) {
  const xdr = new Uint8Array(40);
  xdr.set([0, 0, 0, 0x12, 0, 0, 0, 0x01]);
  xdr.set(contractHash32, 8);
  return sha256(xdr);
}

/**
 * Build the 256-byte preimage. `claim` uses the vector JSON shape with byte
 * fields as Uint8Array and integers as bigint-compatible values.
 */
export function encodePreimage(claim, { networkPassphrase, contractHash }) {
  const out = new Uint8Array(PREIMAGE_LENGTH);
  let o = 0;
  const put = (bytes) => { out.set(bytes, o); o += bytes.length; };
  put(MAGIC);
  put(Uint8Array.from([0, WIRE_VERSION]));
  put(networkId(networkPassphrase));
  put(contractDigestFromHash(contractHash));
  put(claim.issuer);
  put(claim.claimType);
  put(claim.subject);
  put(claim.payloadHash);
  put(Uint8Array.from([claim.payloadEncoding]));
  put(Uint8Array.from([claim.replayMode]));
  put(u64be(claim.nonce));
  put(claim.claimId);
  put(u64be(claim.issuedAt));
  put(u64be(claim.expiresAt));
  if (o !== PREIMAGE_LENGTH) throw new Error(`preimage length ${o}`);
  return out;
}

// ---- mock issuer ----
/** Seed for test issuer `index`: SHA-256("coreflow-test-issuer-<index>"). Same rule as coreflow-attest's MockIssuer::test. */
export const testIssuerSeed = (index) => sha256(`coreflow-test-issuer-${index}`);

/**
 * A mock issuer for Vitest / node:test suites: deterministic keys, signs
 * preimages built by this module's independent encoder.
 */
export async function mockIssuer(index = 0) {
  const seed = testIssuerSeed(index);
  const publicKey = await ed.getPublicKeyAsync(seed);
  return {
    index,
    seed,
    publicKey,
    secretStrkey: encodeStrkey('seed', seed),
    publicStrkey: encodeStrkey('account', publicKey),
    /** Sign a claim (vector shape) for the given network and contract hash. */
    async sign(claim, ctx) {
      const preimage = encodePreimage({ ...claim, issuer: claim.issuer ?? publicKey }, ctx);
      return { preimage, signature: await ed.signAsync(preimage, seed) };
    },
  };
}

export const randomClaimId = () => new Uint8Array(randomBytes(32));

/** The committed vectors, parsed. */
export function loadVectors() {
  return JSON.parse(readFileSync(new URL('../vectors/claim-v1.json', import.meta.url), 'utf8'));
}
