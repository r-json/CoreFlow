import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/db/prisma';
import { getUserFromRequest, isAdmin } from '@/lib/auth';
import { parseBody, statusPatchSchema } from '@/lib/validation/schemas';
import { audit } from '@/lib/audit';

export async function PATCH(request: NextRequest, { params }: { params: { id: string } }) {
  // Role guard — only ADMIN can update escrow status (approve/reject/finalize/cancel)
  const user = await getUserFromRequest(request);
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (!isAdmin(user)) {
    return NextResponse.json(
      { error: 'Forbidden: only ADMIN can update escrow status' },
      { status: 403 }
    );
  }

  try {
    const onChainId = parseInt(params.id, 10);
    if (isNaN(onChainId)) {
      return NextResponse.json({ error: 'Invalid escrow ID' }, { status: 400 });
    }

    const body = await request.json().catch(() => null);
    const parsed = parseBody(statusPatchSchema, body);
    if (!parsed.ok) {
      return NextResponse.json({ error: parsed.error }, { status: 400 });
    }
    const { status, managerApproved, financeApproved, rejectionReason } = parsed.data;

    const updated = await prisma.escrow.update({
      where: { onChainId },
      data: {
        ...(status && { status }),
        ...(managerApproved !== undefined && { managerApproved }),
        ...(financeApproved !== undefined && { financeApproved }),
        ...(rejectionReason !== undefined && { rejectionReason }),
      },
    });

    await audit(status === 'rejected' ? 'escrow.reject' : 'escrow.status_update', {
      actor: user.walletAddress,
      target: String(onChainId),
      metadata: { status, managerApproved, financeApproved, rejectionReason },
    });

    return NextResponse.json({ escrow: updated }, { status: 200 });
  } catch (error) {
    console.error(`Failed to update escrow ${params.id}:`, error);
    return NextResponse.json({ error: 'Failed to update escrow' }, { status: 500 });
  }
}
