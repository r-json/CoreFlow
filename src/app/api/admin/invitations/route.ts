import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/db/prisma';
import { getUserFromRequest, isAdmin, Role } from '@/lib/auth';
import { audit } from '@/lib/audit';
import crypto from 'crypto';
import { z } from 'zod';
import { parseBody } from '@/lib/validation/schemas';

const createInviteSchema = z.object({
  email: z.string().email(),
  role: z.enum(['ADMIN', 'EMPLOYEE']).default('EMPLOYEE'),
});

export async function GET(request: NextRequest) {
  const user = await getUserFromRequest(request);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (!isAdmin(user)) return NextResponse.json({ error: 'Forbidden: ADMIN role required' }, { status: 403 });

  try {
    const invitations = await prisma.invitation.findMany({
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    return NextResponse.json({ invitations }, { status: 200 });
  } catch (error) {
    console.error('[admin/invitations] GET error:', error);
    return NextResponse.json({ error: 'Failed to fetch invitations' }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  const user = await getUserFromRequest(request);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (!isAdmin(user)) return NextResponse.json({ error: 'Forbidden: ADMIN role required' }, { status: 403 });

  try {
    const body = await request.json().catch(() => null);
    const parsed = parseBody(createInviteSchema, body);
    if (!parsed.ok) {
      return NextResponse.json({ error: parsed.error }, { status: 400 });
    }
    const { email, role } = parsed.data;

    // Check if invitation already exists for this email
    const existing = await prisma.invitation.findUnique({ where: { email } });
    if (existing && !existing.usedAt && existing.expiresAt > new Date()) {
      return NextResponse.json(
        { invitation: existing, message: 'Existing active invitation retrieved' },
        { status: 200 }
      );
    }

    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days

    const invitation = await prisma.invitation.upsert({
      where: { email },
      create: {
        email,
        role: role as Role,
        token,
        expiresAt,
      },
      update: {
        role: role as Role,
        token,
        expiresAt,
        usedAt: null,
      },
    });

    await audit('invitation.create', {
      actor: user.walletAddress,
      target: email,
      metadata: { role, token, expiresAt: expiresAt.toISOString() },
    });

    return NextResponse.json({ invitation }, { status: 201 });
  } catch (error) {
    console.error('[admin/invitations] POST error:', error);
    return NextResponse.json({ error: 'Failed to create invitation' }, { status: 500 });
  }
}
