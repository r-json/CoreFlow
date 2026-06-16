import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/db/prisma';
import { getUserFromRequest } from '@/lib/auth';

export async function GET(request: NextRequest) {
  // Auth guard — all authenticated users can list escrows
  const user = await getUserFromRequest(request);
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const escrows = await prisma.escrow.findMany({
      orderBy: { createdAt: 'desc' },
      include: { timeLogs: true },
    });

    const mappedEscrows = escrows.map((e: any) => {
      const totalHours = e.timeLogs.reduce((acc: number, log: any) => acc + log.hoursLogged, 0);
      return {
        id: e.onChainId || e.id,
        worker:
          e.workerPubKey.length >= 10
            ? `${e.workerPubKey.slice(0, 6)}...${e.workerPubKey.slice(-4)}`
            : e.workerPubKey,
        amount: (e.amountCents / 100).toLocaleString(undefined, {
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        }),
        currency: e.currency,
        hoursLogged: totalHours.toString(),
        status: e.status,
        manager_approved: e.managerApproved,
        finance_approved: e.financeApproved,
        hours_verified: totalHours > 0,
        created_at: e.createdAt.toISOString(),
        isMock: false,
      };
    });

    return NextResponse.json({ escrows: mappedEscrows }, { status: 200 });
  } catch (error) {
    console.error('Failed to fetch escrows:', error);
    return NextResponse.json({ error: 'Failed to fetch escrows' }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  // Auth guard — only manager or finance can create escrow records
  const user = await getUserFromRequest(request);
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (!['manager', 'finance'].includes(user.role)) {
    return NextResponse.json({ error: 'Forbidden: insufficient role' }, { status: 403 });
  }

  try {
    const body = await request.json();
    const { onChainId, workerPubKey, amountCents, rateCents } = body;

    if (!workerPubKey || amountCents == null || rateCents == null) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
    }

    // Only index a real on-chain id. A missing/zero/negative id would otherwise
    // be stored as 0, and the second such escrow would collide on the @unique
    // constraint and be silently dropped as "already indexed".
    const normalizedOnChainId =
      typeof onChainId === 'number' && onChainId > 0 ? onChainId : null;

    const escrow = await prisma.escrow.create({
      data: { onChainId: normalizedOnChainId, workerPubKey, amountCents, rateCents },
    });

    return NextResponse.json({ escrow }, { status: 201 });
  } catch (error: any) {
    if (error?.code === 'P2002') {
      return NextResponse.json({ message: 'Escrow already indexed' }, { status: 200 });
    }
    console.error('Failed to create escrow:', error);
    return NextResponse.json({ error: 'Failed to create escrow' }, { status: 500 });
  }
}
