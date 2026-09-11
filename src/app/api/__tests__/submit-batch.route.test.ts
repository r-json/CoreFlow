// @vitest-environment node
/**
 * Authorization regression tests for POST /api/submit-batch.
 *
 * This endpoint issues the Ed25519 attestations that flip `proof_verified` on
 * chain, and `pay_batch` refuses to move funds without them. It was previously
 * reachable with no session at all, which meant anyone could manufacture the
 * proof-of-work half of the security model. These tests pin the two gates that
 * now stand in the way: a verified session, and caller == on-chain manager.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/auth', async (orig) => {
  const actual = await orig<typeof import('@/lib/auth')>();
  return { ...actual, getUserFromRequest: vi.fn() };
});

vi.mock('@/lib/oracle', () => ({
  getOraclePublicKeyHex: vi.fn(() => 'ab'.repeat(32)),
  signHoursProof: vi.fn(() => 'SIGNATURE_BASE64'),
}));

vi.mock('@/lib/config', () => ({
  STELLAR_CONFIG: {
    contract: { id: 'CCQ2DINBUGQ2DINBUGQ2DINBUGQ2DINBUGQ2DINBUGQ2DINBUGQ2CNSG' },
    getNetworkPassphrase: () => 'Test SDF Network ; September 2015',
  },
}));

const getEscrow = vi.fn();
const getNonce = vi.fn();
vi.mock('@/lib/contracts', () => ({
  CoreFlowClient: class {
    getEscrow = getEscrow;
    getNonce = getNonce;
  },
}));

vi.mock('@/lib/audit', () => ({ audit: vi.fn() }));

// Tenant layer: the escrow must belong to an organization the caller is in, on
// top of the on-chain manager check.
vi.mock('@/lib/db/prisma', () => {
  const prisma: any = {
    orgMember: { findUnique: vi.fn(), findMany: vi.fn() },
    escrow: { findFirst: vi.fn() },
  };
  return { default: prisma };
});

import { POST } from '../submit-batch/route';
import { getUserFromRequest } from '@/lib/auth';
import { signHoursProof } from '@/lib/oracle';
import prismaDefault from '@/lib/db/prisma';

const prismaMock = prismaDefault as any;
const ORG = 'orgA';

/** Give the signed-in caller an ACTIVE membership that owns the escrow. */
function grantTenant(role = 'MANAGER', walletAddress = MANAGER) {
  prismaMock.orgMember.findMany.mockResolvedValue([{ orgId: ORG, role }]);
  prismaMock.orgMember.findUnique.mockResolvedValue({
    orgId: ORG, userId: 'u1', role, status: 'ACTIVE',
    org: { id: ORG, name: 'Org A', slug: 'org-a' },
    user: { walletAddress },
  });
  prismaMock.escrow.findFirst.mockResolvedValue({ id: 'esc1', orgId: ORG, onChainId: 1 });
}

const mockGetUser = getUserFromRequest as unknown as ReturnType<typeof vi.fn>;

const MANAGER = 'G' + 'A'.repeat(55);
const WORKER = 'G' + 'B'.repeat(55);
const PAYEE = 'G' + 'C'.repeat(55);

function req(body: unknown) {
  return new Request('http://localhost/api/submit-batch', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }) as any;
}

const validBody = {
  escrow_id: 1,
  payees: [{ address: PAYEE, amount: '40', token: 'USDC' }],
};

/** One on-chain payment row: 10000 units at 250/hour == 40 hours. */
const onChainPayment = (worker: string) => ({
  worker,
  token: 'CCZLFMVSWKZLFMVSWKZLFMVSWKZLFMVSWKZLFMVSWKZLFMVSWKZLEB3K',
  amount: 10000n,
  rate_per_hour: 250n,
  start_date: 1000,
  end_date: 2000,
});

describe('POST /api/submit-batch — authorization', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getEscrow.mockResolvedValue({
      manager: MANAGER,
      payments: [onChainPayment(PAYEE)],
    });
    getNonce.mockResolvedValue(0);
    grantTenant();
  });

  it('401s an unauthenticated caller and signs nothing', async () => {
    mockGetUser.mockResolvedValue(null);

    const res = await POST(req(validBody));

    expect(res.status).toBe(401);
    expect(signHoursProof).not.toHaveBeenCalled();
  });

  it('403s a signed-in worker who is not the on-chain manager', async () => {
    // The worker holds a perfectly valid session — the only thing stopping them
    // from attesting to their own hours is the on-chain manager check.
    mockGetUser.mockResolvedValue({ userId: 'u1', walletAddress: WORKER, role: 'EMPLOYEE' });
    grantTenant('MANAGER', WORKER);

    const res = await POST(req(validBody));

    expect(res.status).toBe(403);
    expect(signHoursProof).not.toHaveBeenCalled();
  });

  it('403s even an ADMIN who is not the escrow manager', async () => {
    // Platform admin is not the same authority as this escrow's manager;
    // role must not substitute for on-chain custody of the escrow.
    mockGetUser.mockResolvedValue({ userId: 'u1', walletAddress: WORKER, role: 'ADMIN' });
    grantTenant('ADMIN', WORKER);

    const res = await POST(req(validBody));

    expect(res.status).toBe(403);
    expect(signHoursProof).not.toHaveBeenCalled();
  });

  it('issues attestations to the on-chain manager', async () => {
    mockGetUser.mockResolvedValue({ userId: 'u1', walletAddress: MANAGER, role: 'EMPLOYEE' });

    const res = await POST(req(validBody));
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.signatures).toHaveLength(1);
    expect(data.signatures[0].signature).toBe('SIGNATURE_BASE64');
  });

  it('starts nonces at the live on-chain watermark, not zero', async () => {
    // Signing from 0 against an escrow that already consumed nonces would
    // produce signatures the contract rejects with InvalidNonce (#9).
    mockGetUser.mockResolvedValue({ userId: 'u1', walletAddress: MANAGER, role: 'EMPLOYEE' });
    getNonce.mockResolvedValue(7);
    getEscrow.mockResolvedValue({
      manager: MANAGER,
      payments: [onChainPayment(PAYEE), onChainPayment(WORKER)],
    });

    const data = await (await POST(req({
      escrow_id: 1,
      payees: [
        { address: PAYEE, amount: '40', token: 'USDC' },
        { address: WORKER, amount: '32', token: 'USDC' },
      ],
    }))).json();

    expect(data.startNonce).toBe(7);
    expect(data.signatures.map((s: { nonce: number }) => s.nonce)).toEqual([7, 8]);
  });

  it('rejects a batch over the 100-payee cap before touching the oracle', async () => {
    mockGetUser.mockResolvedValue({ userId: 'u1', walletAddress: MANAGER, role: 'EMPLOYEE' });

    const res = await POST(req({
      escrow_id: 1,
      payees: Array.from({ length: 101 }, () => ({ address: PAYEE, amount: '1', token: 'USDC' })),
    }));

    expect(res.status).toBe(400);
    expect(signHoursProof).not.toHaveBeenCalled();
  });

  it('refuses when the upload has a different payee count than the escrow', async () => {
    // The signed preimage comes from on-chain rows, so a mismatched upload
    // would attest to something the uploader never reviewed.
    mockGetUser.mockResolvedValue({ userId: 'u1', walletAddress: MANAGER, role: 'EMPLOYEE' });

    const res = await POST(req({
      escrow_id: 1,
      payees: [
        { address: PAYEE, amount: '40', token: 'USDC' },
        { address: WORKER, amount: '32', token: 'USDC' },
      ],
    }));

    expect(res.status).toBe(409);
    expect(signHoursProof).not.toHaveBeenCalled();
  });

  it('refuses when an uploaded payee does not match the on-chain row', async () => {
    mockGetUser.mockResolvedValue({ userId: 'u1', walletAddress: MANAGER, role: 'EMPLOYEE' });

    const res = await POST(req({
      escrow_id: 1,
      payees: [{ address: WORKER, amount: '40', token: 'USDC' }], // chain holds PAYEE
    }));

    expect(res.status).toBe(409);
    expect(signHoursProof).not.toHaveBeenCalled();
  });

  it('derives hours from the escrowed amount, not from the upload', async () => {
    // The contract enforces `hours x rate == amount`; 10000/250 = 40 regardless
    // of what the CSV claims, so a wrong CSV figure cannot reach the signature.
    mockGetUser.mockResolvedValue({ userId: 'u1', walletAddress: MANAGER, role: 'EMPLOYEE' });

    const data = await (await POST(req({
      escrow_id: 1,
      payees: [{ address: PAYEE, amount: '999999', token: 'USDC' }],
    }))).json();

    expect(data.signatures[0].hours).toBe(40);
  });

  it('403s a caller whose organization does not own the escrow', async () => {
    // The caller may well be the on-chain manager — controlling a key is not the
    // same as the escrow being part of their workspace.
    mockGetUser.mockResolvedValue({ userId: 'u1', walletAddress: MANAGER, role: 'EMPLOYEE' });
    grantTenant('MANAGER', MANAGER);
    prismaMock.escrow.findFirst.mockResolvedValue(null); // not in this tenant

    const res = await POST(req(validBody));

    expect(res.status).toBe(404);
    expect(signHoursProof).not.toHaveBeenCalled();
  });

  it('403s a role that cannot request attestations', async () => {
    mockGetUser.mockResolvedValue({ userId: 'u1', walletAddress: MANAGER, role: 'EMPLOYEE' });
    grantTenant('VIEWER', MANAGER);

    const res = await POST(req(validBody));

    expect(res.status).toBe(403);
    expect(signHoursProof).not.toHaveBeenCalled();
  });

  it('rejects a malformed payee address', async () => {
    mockGetUser.mockResolvedValue({ userId: 'u1', walletAddress: MANAGER, role: 'EMPLOYEE' });

    const res = await POST(req({
      escrow_id: 1,
      payees: [{ address: 'not-a-stellar-address', amount: '40', token: 'USDC' }],
    }));

    expect(res.status).toBe(400);
    expect(signHoursProof).not.toHaveBeenCalled();
  });
});
