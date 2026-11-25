// @vitest-environment node
/**
 * Oracle signing tests — CFWP schema v2.
 *
 * The vector below is the OTHER HALF of a cross-language pin. The identical
 * constants are asserted by the Soroban contract suite in
 * contracts/core-flow/src/test.rs (`test_proof_preimage_matches_cross_language_vector`),
 * and the canonical copy lives in docs/evidence/proof-vector-v2.json.
 *
 * Two independent implementations pinned to one vector is what makes "the
 * signer and the verifier agree" a tested claim rather than an assumption. A
 * field added, reordered, resized or dropped on either side breaks one suite.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  buildProofMessage,
  signHoursProof,
  verifyHoursProof,
  getOraclePublicKeyHex,
  resetOracleKeypairCache,
  networkId,
  PROOF_MESSAGE_BYTES,
  type ProofContext,
} from '../index';

/** Deterministic 32-byte seed; the Rust suite derives the same keypair. */
const SEED = '0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20';
const ORACLE_PUBKEY = '79b5562e8fe654f94078b112e8a98ba7901f853ae695bed7e0e3910bad049664';

const TESTNET = 'Test SDF Network ; September 2015';
const MAINNET = 'Public Global Stellar Network ; September 2015';

const CTX: ProofContext = {
  networkPassphrase: TESTNET,
  contractId: 'CCQ2DINBUGQ2DINBUGQ2DINBUGQ2DINBUGQ2DINBUGQ2DINBUGQ2CNSG',
  worker: 'GB43KVROR7TFJ6KAPCYRF2FJROTZAH4FHLTJLPWX4DRZCC5NASLGITR6',
  token: 'CCZLFMVSWKZLFMVSWKZLFMVSWKZLFMVSWKZLFMVSWKZLFMVSWKZLEB3K',
  amount: 10000n,
  startDate: 1000n,
  endDate: 2000n,
};

/** escrow 1 / payment 0 / 40 hours / nonce 0 — the shared vector. */
const VECTOR_MESSAGE_HEX =
  '434657500002cee0302d59844d32bdca915c8203dd44b33fbb7edc19051ea37abedf28ecd472' +
  '5b0c63242683ea58b14aff3c6a455fa6dbf3573ddedc1e4fa218e0406711ba422cbbd006041e' +
  'ea71603dacf22e8af1a8cbf2f3b0083caa8b8bf333ab565ce2e0511957404a7b60b722a93985' +
  '8e47fa9205c5f7c71de7941f15d2f489c8c53ceb000000010000000000000000000000000000' +
  '0000000027100000000000000000000000000000002800000000000003e800000000000007d0' +
  '0000000000000000';
const VECTOR_SIGNATURE =
  'TdKHLe52uA6PSuj70Lkkkopd5gTgmzLic2ZT3HmOZ6e4U6DoKanImbyjUT40bA8uRxzWhbFo8Alfl2HYfKs+Cg==';

describe('oracle signing — CFWP v2', () => {
  beforeEach(() => {
    process.env.ORACLE_SECRET_KEY = SEED;
    resetOracleKeypairCache();
  });
  afterEach(() => {
    delete process.env.ORACLE_SECRET_KEY;
    resetOracleKeypairCache();
  });

  it('derives the same public key the Rust suite does', () => {
    expect(getOraclePublicKeyHex()).toBe(ORACLE_PUBKEY);
  });

  it('builds the exact preimage pinned by the cross-language vector', () => {
    const msg = buildProofMessage(CTX, 1, 0, 40n, 0n);
    expect(msg.length).toBe(PROOF_MESSAGE_BYTES);
    expect(msg.toString('hex')).toBe(VECTOR_MESSAGE_HEX);
  });

  it('produces the exact signature pinned by the vector', () => {
    expect(signHoursProof(CTX, 1, 0, 40, 0)).toBe(VECTOR_SIGNATURE);
  });

  it('derives network_id as sha256 of the passphrase, matching Soroban', () => {
    // env.ledger().network_id() is sha256(passphrase); the preimage embeds it
    // at offset 6. If these diverge, every signature is rejected on-chain.
    expect(networkId(TESTNET).toString('hex')).toBe(
      VECTOR_MESSAGE_HEX.slice(12, 76)
    );
  });

  it('verifies its own signature', () => {
    const sig = signHoursProof(CTX, 1, 0, 40, 0);
    expect(verifyHoursProof(CTX, 1, 0, 40, 0, sig)).toBe(true);
  });

  describe('domain separation — each field must change the signature', () => {
    // Signing must happen inside each test: describe-scope bodies run at
    // collection time, before beforeEach has set ORACLE_SECRET_KEY.
    const sign = (ctx: ProofContext, e = 1, p = 0, h = 40, n = 0) =>
      signHoursProof(ctx, e, p, h, n);

    it('a Testnet proof is not valid on Mainnet', () => {
      // This is the exact substitution v1 permitted: same escrow, same payment,
      // same hours, same nonce, different chain.
      const testnet = sign(CTX);
      const mainnet = sign({ ...CTX, networkPassphrase: MAINNET });
      expect(mainnet).not.toBe(testnet);
      expect(verifyHoursProof({ ...CTX, networkPassphrase: MAINNET }, 1, 0, 40, 0, testnet)).toBe(false);
    });

    it('a proof for one contract is not valid on another deployment', () => {
      const other = { ...CTX, contractId: 'CCZLFMVSWKZLFMVSWKZLFMVSWKZLFMVSWKZLFMVSWKZLFMVSWKZLEB3K' };
      expect(sign(other)).not.toBe(sign(CTX));
      expect(verifyHoursProof(other, 1, 0, 40, 0, sign(CTX))).toBe(false);
    });

    it('a proof cannot be redirected to a different payee', () => {
      const other = { ...CTX, worker: 'GCEZWKCA5VLDNRLN3RPRJMRZOX3Z6G5CHCGSNFHEYVXM3XOJMDS674JZ' };
      expect(verifyHoursProof(other, 1, 0, 40, 0, sign(CTX))).toBe(false);
    });

    it('a proof cannot be redirected to a different asset', () => {
      const other = { ...CTX, token: 'CCQ2DINBUGQ2DINBUGQ2DINBUGQ2DINBUGQ2DINBUGQ2DINBUGQ2CNSG' };
      expect(verifyHoursProof(other, 1, 0, 40, 0, sign(CTX))).toBe(false);
    });

    it('a proof is bound to the amount that will actually move', () => {
      const other = { ...CTX, amount: 20000n };
      expect(verifyHoursProof(other, 1, 0, 40, 0, sign(CTX))).toBe(false);
    });

    it('a proof is bound to its pay period', () => {
      const other = { ...CTX, startDate: 5000n, endDate: 6000n };
      expect(verifyHoursProof(other, 1, 0, 40, 0, sign(CTX))).toBe(false);
    });

    it('a proof for one escrow is not valid for another', () => {
      expect(verifyHoursProof(CTX, 2, 0, 40, 0, sign(CTX))).toBe(false);
    });

    it('a proof for one payment row is not valid for another', () => {
      expect(verifyHoursProof(CTX, 1, 1, 40, 0, sign(CTX))).toBe(false);
    });

    it('rejects a signature replayed at the next nonce', () => {
      // The contract consumes nonces from a monotonic watermark; binding the
      // nonce into the preimage is what makes a consumed proof unreusable.
      expect(verifyHoursProof(CTX, 1, 0, 40, 1, sign(CTX))).toBe(false);
    });

    it('rejects a signature for tampered hours', () => {
      expect(verifyHoursProof(CTX, 1, 0, 41, 0, sign(CTX))).toBe(false);
    });
  });

  it('refuses to build a short preimage', () => {
    // A dropped field would otherwise sign cleanly and fail only on-chain, as
    // an opaque signature rejection.
    expect(() =>
      buildProofMessage({ ...CTX, contractId: '' }, 1, 0, 40n, 0n)
    ).toThrow();
  });
});
