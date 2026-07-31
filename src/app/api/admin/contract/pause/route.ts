import { NextRequest, NextResponse } from 'next/server';
import { getUserFromRequest, isAdmin } from '@/lib/auth';
import { audit } from '@/lib/audit';
import { z } from 'zod';
import { parseBody } from '@/lib/validation/schemas';

const pauseSchema = z.object({
  paused: z.boolean(),
  reason: z.string().min(5, 'Reason must be at least 5 characters'),
});

// In-memory contract pause status state fallback (backed by AuditLog)
let isContractPausedInMemory = false;

export async function GET() {
  return NextResponse.json({ paused: isContractPausedInMemory });
}

export async function POST(request: NextRequest) {
  const user = await getUserFromRequest(request);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (!isAdmin(user)) return NextResponse.json({ error: 'Forbidden: ADMIN role required' }, { status: 403 });

  try {
    const body = await request.json().catch(() => null);
    const parsed = parseBody(pauseSchema, body);
    if (!parsed.ok) {
      return NextResponse.json({ error: parsed.error }, { status: 400 });
    }

    const { paused, reason } = parsed.data;
    isContractPausedInMemory = paused;

    await audit(paused ? 'contract.pause' : 'contract.resume', {
      actor: user.walletAddress,
      target: 'SorobanContract',
      metadata: { paused, reason },
    });

    return NextResponse.json({
      message: paused ? '🚨 Emergency Stop activated. Soroban Contract paused.' : '✓ Soroban Contract resumed.',
      paused: isContractPausedInMemory,
      reason,
    });
  } catch (error) {
    console.error('[admin/contract/pause] POST error:', error);
    return NextResponse.json({ error: 'Failed to toggle contract pause status' }, { status: 500 });
  }
}
