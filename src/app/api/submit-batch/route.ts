/**
 * POST /api/submit-batch
 *
 * Produces the oracle attestations a batch needs before `pay_batch` will settle.
 * This is the one step that MUST run server-side: ORACLE_SECRET_KEY never
 * reaches the browser.
 *
 * Request:  { escrow_id: number, payees: [{ address, amount, token }] }
 * Response: { escrowId, oraclePublicKey, startNonce, signatures: [...] }
 *
 * The client submits each signature via `submit_hours_proof`, then the two
 * signers approve, then anyone calls `pay_batch`.
 *
 * AUTHORIZATION — why this endpoint is gated twice:
 * The oracle's signature is the only thing standing between "a payment row
 * exists" and "the contract will move funds for it" (`pay_batch` refuses any
 * payment whose `proof_verified` is false). An unauthenticated signer would
 * therefore let anyone on the internet manufacture the proof-of-work half of
 * the security model, which is exactly the property the product claims to
 * enforce. So we require (1) a valid CoreFlow session, and (2) that the caller
 * is the escrow's on-chain manager — read live from the contract, not from a
 * client-supplied field. A worker cannot attest to their own hours.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getOraclePublicKeyHex, signHoursProof, type ProofContext } from '@/lib/oracle';
import { STELLAR_CONFIG } from '@/lib/config';
import { CoreFlowClient } from '@/lib/contracts';
import prisma from '@/lib/db/prisma';
import { getUserFromRequest } from '@/lib/auth';
import { resolveTenant, findEscrowByOnChainId, requirePermission } from '@/lib/tenancy/resolve';
import { rateLimit } from '@/lib/ratelimit';
import { audit } from '@/lib/audit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface PayeeInput {
  address: string;
  amount: string | number;
  token: string;
}

const G_ADDRESS = /^G[A-Z2-7]{55}$/;

export async function POST(request: NextRequest) {
  // ---- Gate 1: authenticated session -------------------------------------
  const user = await getUserFromRequest(request);
  if (!user) {
    return NextResponse.json(
      { error: 'Sign in with your Stellar wallet to request oracle attestations.' },
      { status: 401 }
    );
  }

  // Signing is CPU-bound and security-sensitive; brake it per wallet.
  const rl = rateLimit(`submit-batch:${user.walletAddress}`, 10, 60_000);
  if (!rl.ok) {
    return NextResponse.json(
      { error: 'Too many attestation requests. Try again shortly.' },
      { status: 429, headers: { 'Retry-After': String(rl.retryAfter) } }
    );
  }

  let body: { escrow_id?: number; payees?: PayeeInput[] };

  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Body must be valid JSON' }, { status: 400 });
  }

  const escrowId = Number(body.escrow_id);
  const payees = body.payees;

  if (!Number.isInteger(escrowId) || escrowId < 1) {
    return NextResponse.json({ error: 'escrow_id must be a positive integer' }, { status: 400 });
  }
  if (!Array.isArray(payees) || payees.length === 0) {
    return NextResponse.json({ error: 'payees must be a non-empty array' }, { status: 400 });
  }
  if (payees.length > 100) {
    return NextResponse.json({ error: 'Batch is limited to 100 payees' }, { status: 400 });
  }

  for (const [i, p] of payees.entries()) {
    if (!p || !G_ADDRESS.test(String(p.address))) {
      return NextResponse.json({ error: `Row ${i + 1}: invalid Stellar address` }, { status: 400 });
    }
    if (!(Number(p.amount) > 0)) {
      return NextResponse.json({ error: `Row ${i + 1}: amount must be > 0` }, { status: 400 });
    }
  }

  let oraclePublicKey: string;
  try {
    oraclePublicKey = getOraclePublicKeyHex();
  } catch {
    return NextResponse.json({ error: 'Oracle is not configured' }, { status: 503 });
  }

  // ---- Gate 1b: the escrow must belong to an organization the caller is in --
  // The on-chain manager check below proves control of a key, but not that this
  // escrow is part of the caller's workspace. Both are required: a wallet can be
  // the manager of an escrow recorded under a different tenant, and attestations
  // must not cross that line.
  const orgId =
    request.headers.get('x-organization-id') ??
    new URL(request.url).searchParams.get('orgId') ??
    (await prisma.orgMember
      .findMany({ where: { userId: user.userId, status: 'ACTIVE' }, select: { orgId: true }, take: 2 })
      .then((m) => (m.length === 1 ? m[0].orgId : null)));

  const tenant = await resolveTenant(prisma, user.userId, orgId);
  if (!tenant.ok) {
    return NextResponse.json({ error: tenant.message }, { status: tenant.status });
  }
  const permissionDenied = requirePermission(tenant.value, 'oracle:attest:request');
  if (permissionDenied) {
    return NextResponse.json(
      { error: permissionDenied.message, code: permissionDenied.code },
      { status: 403 }
    );
  }
  const ownedEscrow = await findEscrowByOnChainId(prisma, tenant.value, escrowId);
  if (!ownedEscrow.ok) {
    return NextResponse.json({ error: ownedEscrow.message }, { status: ownedEscrow.status });
  }

  const client = new CoreFlowClient();

  // ---- Gate 2: caller must be the escrow's on-chain manager ---------------
  // Read from the contract so the check cannot be spoofed by request content.
  let escrow: Awaited<ReturnType<CoreFlowClient['getEscrow']>>;
  try {
    escrow = await client.getEscrow(escrowId);
  } catch {
    return NextResponse.json(
      { error: `Could not read escrow ${escrowId}. Does it exist on this network?` },
      { status: 502 }
    );
  }
  const onChainManager = escrow.manager;

  if (user.walletAddress !== onChainManager) {
    await audit('oracle.attest.denied', {
      actor: user.walletAddress,
      target: String(escrowId),
      metadata: { reason: 'caller is not the on-chain manager' },
    });
    return NextResponse.json(
      { error: 'Only the escrow manager can request attestations for this batch.' },
      { status: 403 }
    );
  }

  // The contract accepts only the next expected nonce, so signatures must start
  // from the live on-chain watermark rather than zero — a batch signed from 0
  // against an escrow that already has proofs would be rejected with #9.
  let startNonce = 0;
  try {
    startNonce = await client.getNonce(escrowId);
  } catch {
    return NextResponse.json(
      { error: `Could not read nonce for escrow ${escrowId}. Does it exist on this network?` },
      { status: 502 }
    );
  }

  // The uploaded CSV must describe the escrow that was actually funded. The
  // signed preimage is built from ON-CHAIN payment rows, so a mismatched CSV
  // would otherwise produce signatures that silently attest to something the
  // uploader never reviewed. Reject rather than sign the discrepancy.
  if (payees.length !== escrow.payments.length) {
    return NextResponse.json(
      {
        error:
          `This file has ${payees.length} payee(s) but escrow ${escrowId} was funded ` +
          `for ${escrow.payments.length}. Upload the file this escrow was created from.`,
      },
      { status: 409 }
    );
  }

  for (const [i, payee] of payees.entries()) {
    const row = escrow.payments[i];
    if (row.worker !== payee.address) {
      return NextResponse.json(
        {
          error:
            `Row ${i + 1} pays ${payee.address}, but payment ${i} of escrow ${escrowId} ` +
            `is held for ${row.worker}.`,
        },
        { status: 409 }
      );
    }
  }

  const ctxFor = (payment: (typeof escrow.payments)[number]): ProofContext => ({
    networkPassphrase: STELLAR_CONFIG.getNetworkPassphrase(),
    contractId: STELLAR_CONFIG.contract.id,
    worker: payment.worker,
    token: payment.token,
    amount: payment.amount,
    startDate: BigInt(payment.start_date),
    endDate: BigInt(payment.end_date),
  });

  const signatures = escrow.payments.map((payment, i) => {
    const nonce = startNonce + i;
    // Hours are derived from what was actually escrowed, not from the upload:
    // the contract enforces `hours x rate == amount`, so any other value would
    // be rejected on chain. Deriving it here makes that impossible to get wrong.
    const hours = payment.amount / payment.rate_per_hour;
    return {
      paymentId: i,
      address: payment.worker,
      token: payment.token,
      hours: Number(hours),
      nonce,
      signature: signHoursProof(ctxFor(payment), escrowId, i, hours, nonce),
    };
  });

  await audit('oracle.attest.issued', {
    actor: user.walletAddress,
    target: String(escrowId),
    metadata: { payees: payees.length, startNonce },
  });

  return NextResponse.json(
    { escrowId, oraclePublicKey, startNonce, signatures },
    { status: 200 }
  );
}
