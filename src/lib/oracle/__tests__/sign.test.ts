// @vitest-environment node
import { describe, it, expect, beforeAll } from 'vitest';
import { Keypair } from '@stellar/stellar-sdk';
import { buildProofMessage, getOracleKeypair, getOraclePublicKeyHex, signHoursProof } from '../index';

// Deterministic 32-byte test seed.
const SEED = '0101010101010101010101010101010101010101010101010101010101010101';

describe('oracle signing', () => {
  beforeAll(() => {
    process.env.ORACLE_SECRET_KEY = SEED;
  });

  it('builds a 32-byte message with the contract byte layout', () => {
    const msg = buildProofMessage(7, 2, 80n, 3n);
    expect(msg.length).toBe(32);
    expect(msg.readUInt32BE(0)).toBe(7); // escrow_id
    expect(msg.readUInt32BE(4)).toBe(2); // payment_id
    expect(msg.readBigUInt64BE(24)).toBe(3n); // nonce
    // hours (i128) occupies bytes 8..24; low byte holds 80.
    expect(msg[23]).toBe(80);
  });

  it('produces a signature the matching public key verifies', () => {
    const sigB64 = signHoursProof(1, 0, 40, 0);
    const sig = Buffer.from(sigB64, 'base64');
    expect(sig.length).toBe(64);

    const pubHex = getOraclePublicKeyHex();
    const kp = Keypair.fromPublicKey(getOracleKeypair().publicKey());
    const msg = buildProofMessage(1, 0, 40n, 0n);
    expect(kp.verify(msg, sig)).toBe(true);
    // Public key is the 32-byte raw Ed25519 key as hex.
    expect(pubHex).toHaveLength(64);
  });

  it('rejects a signature for a tampered nonce', () => {
    const sig = Buffer.from(signHoursProof(1, 0, 40, 0), 'base64');
    const kp = Keypair.fromPublicKey(getOracleKeypair().publicKey());
    const wrongMsg = buildProofMessage(1, 0, 40n, 1n); // nonce changed
    expect(kp.verify(wrongMsg, sig)).toBe(false);
  });
});
