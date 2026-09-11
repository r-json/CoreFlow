import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/db/prisma';
import { getUserFromRequest, isEmployee } from '@/lib/auth';
import { resolveTenant, findEscrowByOnChainId } from '@/lib/tenancy/resolve';
import { parseBody, hoursSchema } from '@/lib/validation/schemas';
import { audit } from '@/lib/audit';

export async function POST(request: NextRequest) {
  // Auth guard — EMPLOYEE (and ADMIN) can submit hours
  const user = await getUserFromRequest(request);
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // isEmployee returns true for both EMPLOYEE and ADMIN roles
  if (!isEmployee(user)) {
    return NextResponse.json(
      { error: 'Forbidden: insufficient role' },
      { status: 403 }
    );
  }

  try {
    const body = await request.json().catch(() => null);
    const parsed = parseBody(hoursSchema, body);
    if (!parsed.ok) {
      return NextResponse.json({ error: parsed.error }, { status: 400 });
    }
    const { onChainId, hoursLogged, paymentId, txHash } = parsed.data;

    // TENANT SCOPE. `onChainId` comes from the contract, so the same id exists in
    // other organizations on other deployments — resolving it globally would let
    // a member of any organization log hours against another's escrow.
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

    const owned = await findEscrowByOnChainId(prisma, tenant.value, onChainId);
    if (!owned.ok) {
      return NextResponse.json({ error: owned.message }, { status: owned.status });
    }
    const escrow = owned.value;

    const timeLog = await prisma.timeLog.create({
      data: { escrowId: escrow.id, hoursLogged, paymentId, txHash },
    });

    // Deliberately NOT advancing payment state here.
    //
    // This endpoint records that a client submitted an hours proof. Whether the
    // CONTRACT accepted it is a separate question, answered by the `hours/submit`
    // event the indexer observes. Moving the payment to ORACLE_VERIFIED from here
    // would let a client assert a verification the chain may have rejected —
    // exactly the "frontend manufactures a successful state" failure the state
    // machine exists to prevent.

    await audit('hours.submit', {
      actor: user.walletAddress,
      target: String(escrow.id),
      metadata: { onChainId, hoursLogged, paymentId, txHash },
    });

    return NextResponse.json({ timeLog }, { status: 201 });
  } catch (error: any) {
    if (error?.code === 'P2002') {
      return NextResponse.json({ message: 'Hours proof already indexed' }, { status: 200 });
    }
    console.error('Failed to log hours:', error);
    return NextResponse.json({ error: 'Failed to log hours' }, { status: 500 });
  }
}
