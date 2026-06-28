import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/db/prisma';
import { getUserFromRequest } from '@/lib/auth';
import { parseBody, hoursSchema } from '@/lib/validation/schemas';

export async function POST(request: NextRequest) {
  // Auth guard — any authenticated user can submit hours (worker, manager, finance)
  const user = await getUserFromRequest(request);
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const body = await request.json().catch(() => null);
    const parsed = parseBody(hoursSchema, body);
    if (!parsed.ok) {
      return NextResponse.json({ error: parsed.error }, { status: 400 });
    }
    const { onChainId, hoursLogged, paymentId, txHash } = parsed.data;

    const escrow = await prisma.escrow.findUnique({ where: { onChainId } });

    if (!escrow) {
      return NextResponse.json({ error: 'Escrow not found in database index' }, { status: 404 });
    }

    const timeLog = await prisma.timeLog.create({
      data: { escrowId: escrow.id, hoursLogged, paymentId, txHash },
    });

    await prisma.escrow.update({
      where: { id: escrow.id },
      data: { status: 'pending_manager' },
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
