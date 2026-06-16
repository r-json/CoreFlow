import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/db/prisma';
import { getUserFromRequest, hasRole } from '@/lib/auth';

export async function PATCH(request: NextRequest, { params }: { params: { id: string } }) {
  // Role guard — only manager or finance can update escrow status
  const user = await getUserFromRequest(request);
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (!hasRole(user, ['manager', 'finance'])) {
    return NextResponse.json({ error: 'Forbidden: insufficient role' }, { status: 403 });
  }

  try {
    const onChainId = parseInt(params.id, 10);
    if (isNaN(onChainId)) {
      return NextResponse.json({ error: 'Invalid escrow ID' }, { status: 400 });
    }

    const body = await request.json();
    const { status, managerApproved, financeApproved } = body;

    // Prevent finance from doing manager actions and vice versa (admin may do both)
    if (managerApproved !== undefined && !hasRole(user, ['manager'])) {
      return NextResponse.json(
        { error: 'Forbidden: only managers can set managerApproved' },
        { status: 403 }
      );
    }
    if (financeApproved !== undefined && !hasRole(user, ['finance'])) {
      return NextResponse.json(
        { error: 'Forbidden: only finance can set financeApproved' },
        { status: 403 }
      );
    }

    const updated = await prisma.escrow.update({
      where: { onChainId },
      data: {
        ...(status && { status }),
        ...(managerApproved !== undefined && { managerApproved }),
        ...(financeApproved !== undefined && { financeApproved }),
      },
    });

    return NextResponse.json({ escrow: updated }, { status: 200 });
  } catch (error) {
    console.error(`Failed to update escrow ${params.id}:`, error);
    return NextResponse.json({ error: 'Failed to update escrow' }, { status: 500 });
  }
}
