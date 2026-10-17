#!/usr/bin/env node
/**
 * Generate vectors/claim-v1.json from the independent implementation in
 * src/index.mjs. Output is deterministic (Ed25519 signatures are
 * deterministic and every input is fixed), so `--check` regenerates in memory
 * and fails if the committed file differs.
 *
 * Usage: node scripts/generate.mjs [--check]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import {
  NETWORKS, sha256, toHex, encodeStrkey, networkId, contractDigestFromHash,
  encodePreimage, mockIssuer,
} from '../src/index.mjs';

const OUT = new URL('../vectors/claim-v1.json', import.meta.url);
const ZERO32 = new Uint8Array(32);
const U64_MAX = 0xffffffffffffffffn;
const T0 = 1_790_000_000n; // fixed issue time (2026-09-21T14:13:20Z)

const issuers = [await mockIssuer(0), await mockIssuer(1)];
const contracts = [0, 1].map((i) => sha256(`coreflow-test-vector-contract-${i}`));

const context = (network, contractIndex) => ({
  networkPassphrase: NETWORKS[network],
  contractHash: contracts[contractIndex],
});
const contextJson = (ctx) => ({
  network_passphrase: ctx.networkPassphrase,
  network_id_hex: toHex(networkId(ctx.networkPassphrase)),
  contract_id: encodeStrkey('contract', ctx.contractHash),
  contract_digest_hex: toHex(contractDigestFromHash(ctx.contractHash)),
});
const claimJson = (c) => ({
  issuer_hex: toHex(c.issuer),
  claim_type_hex: toHex(c.claimType),
  claim_type_string: c.claimTypeString,
  subject_hex: toHex(c.subject),
  payload_hex: toHex(c.payload),
  payload_hash_hex: toHex(c.payloadHash),
  payload_encoding: c.payloadEncoding,
  replay_mode: c.replayMode,
  nonce: c.nonce.toString(),
  claim_id_hex: toHex(c.claimId),
  issued_at: c.issuedAt.toString(),
  expires_at: c.expiresAt.toString(),
});

function claim({ issuer = 0, type = 'marketplace.delivery.v1', subject = 'order:42',
  payload = 'delivered', encoding = 0, mode = 0, nonce = 0n, claimId = ZERO32,
  issuedAt = T0, expiresAt = T0 + 3600n }) {
  const payloadBytes = typeof payload === 'string' ? new TextEncoder().encode(payload) : payload;
  return {
    issuer: issuers[issuer].publicKey,
    claimType: sha256(type),
    claimTypeString: type,
    subject: sha256(subject),
    payload: payloadBytes,
    payloadHash: sha256(payloadBytes),
    payloadEncoding: encoding,
    replayMode: mode,
    nonce,
    claimId,
    issuedAt,
    expiresAt,
  };
}

async function valid(name, description, c, ctx, { signer, now } = {}) {
  const { preimage, signature } = await issuers[signer ?? 0].sign(c, ctx);
  return {
    name,
    description,
    context: contextJson(ctx),
    claim: claimJson(c),
    now: (now ?? c.issuedAt + 60n).toString(),
    preimage_hex: toHex(preimage),
    signature_hex: toHex(signature),
  };
}

// An invalid vector carries a claim, the context it is VERIFIED under, and a
// signature that may have been produced under a different claim or context.
async function invalid(name, reason, expected, c, verifyCtx, { signClaim, signCtx, signer, now, signature } = {}) {
  const sig = signature ?? (await issuers[signer ?? 0].sign(signClaim ?? c, signCtx ?? verifyCtx)).signature;
  return {
    name,
    reason,
    expected_error: expected,
    context: contextJson(verifyCtx),
    claim: claimJson(c),
    now: (now ?? c.issuedAt + 60n).toString(),
    signature_hex: toHex(sig),
  };
}

const tn0 = context('testnet', 0);
const tn1 = context('testnet', 1);
const mn0 = context('mainnet', 0);
// XDR ScVal: SCV_U64 (5) followed by u64 big-endian 42.
const xdrPayload = Uint8Array.from([0, 0, 0, 5, 0, 0, 0, 0, 0, 0, 0, 42]);

const base = claim({});
const doc = {
  version: 1,
  description:
    'Test vectors for the CoreFlow signed claim format, wire version 1 (docs/kit/claim-format.md). ' +
    'TEST ONLY: issuer seeds are SHA-256("coreflow-test-issuer-<n>") and are public.',
  generator: 'packages/test-vectors/scripts/generate.mjs',
  issuers: issuers.map((i) => ({
    name: `test-issuer-${i.index}`,
    seed_rule: `SHA-256("coreflow-test-issuer-${i.index}")`,
    seed_hex: toHex(i.seed),
    public_key_hex: toHex(i.publicKey),
  })),
  valid: [
    await valid('sequence-first', 'Sequence mode, first claim in the scope (nonce 0), raw payload.', base, tn0),
    await valid('sequence-next', 'Sequence mode, nonce 1.', claim({ nonce: 1n }), tn0),
    await valid('unique-id', 'Unique-id mode with a content-derived claim id; nonce is 0.',
      claim({ mode: 1, claimId: sha256('claim-0001') }), tn0),
    await valid('xdr-payload', 'Payload encoding 1 (XDR ScVal), hash of the XDR bytes.',
      claim({ encoding: 1, payload: xdrPayload, type: 'sensor.reading.v1', subject: 'sensor:7' }), tn0),
    await valid('u64-extremes', 'Largest nonce and widest window: nonce 2^64-1, issued_at 0, expires_at 2^64-1.',
      claim({ nonce: U64_MAX, issuedAt: 0n, expiresAt: U64_MAX }), tn0, { now: 1n }),
    await valid('mainnet-second-issuer', 'Mainnet passphrase, second contract, second issuer.',
      claim({ issuer: 1, subject: 'order:7' }), context('mainnet', 1), { signer: 1 }),
  ],
  invalid: [
    await invalid('expired', 'Ledger time is one second past expires_at.', 'ClaimExpired',
      base, tn0, { now: base.expiresAt + 1n }),
    await invalid('empty-window', 'expires_at equals issued_at.', 'InvalidWindow',
      claim({ expiresAt: T0 }), tn0, { now: T0 }),
    await invalid('sequence-with-claim-id', 'Sequence mode must carry an all-zero claim_id.', 'InvalidReplayFields',
      claim({ claimId: sha256('claim-0001') }), tn0),
    await invalid('unique-id-with-nonce', 'Unique-id mode must carry nonce 0.', 'InvalidReplayFields',
      claim({ mode: 1, nonce: 5n, claimId: sha256('claim-0002') }), tn0),
    await invalid('other-network', 'Signed for mainnet, verified on testnet.', 'InvalidSignature',
      base, tn0, { signCtx: mn0 }),
    await invalid('other-contract', 'Signed for contract 1, verified by contract 0.', 'InvalidSignature',
      base, tn0, { signCtx: tn1 }),
    await invalid('tampered-subject', 'Subject changed after signing.', 'InvalidSignature',
      claim({ subject: 'order:43' }), tn0, { signClaim: base }),
    await invalid('tampered-expiry', 'expires_at extended after signing.', 'InvalidSignature',
      claim({ expiresAt: T0 + 7200n }), tn0, { signClaim: base }),
    await invalid('wrong-issuer-key', 'Claim names issuer 0 but issuer 1 signed it.', 'InvalidSignature',
      base, tn0, { signer: 1, signClaim: claim({ issuer: 1 }) }),
    await invalid('zero-signature', 'All-zero 64-byte signature.', 'InvalidSignature',
      base, tn0, { signature: new Uint8Array(64) }),
  ],
};

const body = JSON.stringify(doc, null, 2) + '\n';
if (process.argv.includes('--check')) {
  const committed = readFileSync(OUT, 'utf8');
  if (committed !== body) {
    console.error('vectors/claim-v1.json is stale: run `npm run generate` and commit the result.');
    process.exit(1);
  }
  console.log(`vectors/claim-v1.json is up to date (${doc.valid.length} valid, ${doc.invalid.length} invalid).`);
} else {
  writeFileSync(OUT, body);
  console.log(`wrote vectors/claim-v1.json (${doc.valid.length} valid, ${doc.invalid.length} invalid)`);
}
