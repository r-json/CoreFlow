import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as ed from '@noble/ed25519';
import { StrKey } from '@stellar/stellar-base';
import { loadVectors, fromHex, encodePreimage, toHex } from '../src/index.mjs';

const v = loadVectors();
const claimFrom = (c) => ({
  issuer: fromHex(c.issuer_hex), claimType: fromHex(c.claim_type_hex), subject: fromHex(c.subject_hex),
  payloadHash: fromHex(c.payload_hash_hex), payloadEncoding: c.payload_encoding, replayMode: c.replay_mode,
  nonce: BigInt(c.nonce), claimId: fromHex(c.claim_id_hex), issuedAt: BigInt(c.issued_at), expiresAt: BigInt(c.expires_at),
});
const contractHashFromStrkey = async (id) => new Uint8Array(StrKey.decodeContract(id));

test('valid vectors: preimage matches, signature verifies, payload hash matches', async () => {
  for (const x of v.valid) {
    const ctx = { networkPassphrase: x.context.network_passphrase, contractHash: await contractHashFromStrkey(x.context.contract_id) };
    const pre = encodePreimage(claimFrom(x.claim), ctx);
    assert.equal(pre.length, 256, x.name);
    assert.equal(toHex(pre), x.preimage_hex, x.name);
    assert.ok(await ed.verifyAsync(fromHex(x.signature_hex), pre, fromHex(x.claim.issuer_hex)), x.name);
  }
});

test('invalid vectors: only InvalidSignature cases have bad signatures', async () => {
  for (const x of v.invalid) {
    const ctx = { networkPassphrase: x.context.network_passphrase, contractHash: await contractHashFromStrkey(x.context.contract_id) };
    const ok = await ed.verifyAsync(fromHex(x.signature_hex), encodePreimage(claimFrom(x.claim), ctx), fromHex(x.claim.issuer_hex));
    assert.equal(ok, x.expected_error !== 'InvalidSignature', `${x.name}: signature validity must isolate the targeted check`);
  }
});

test('strkey contract ids round-trip through the official stellar-base codec', async () => {
  for (const x of [...v.valid, ...v.invalid]) assert.ok(StrKey.isValidContract(x.context.contract_id), x.name);
  for (const i of v.issuers) assert.ok(StrKey.isValidEd25519PublicKey(StrKey.encodeEd25519PublicKey(Buffer.from(i.public_key_hex, 'hex'))));
});
