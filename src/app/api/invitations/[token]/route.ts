import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/db/prisma';
import { getUserFromRequest, Role } from '@/lib/auth';
import { audit } from '@/lib/audit';

export async function GET(request: NextRequest, { params }: { params: { token: string } }) {
  try {
    const invitation = await prisma.invitation.findUnique({
      where: { token: params.token },
    });

    if (!invitation) {
      return NextResponse.json({ error: 'Invalid or expired invitation token' }, { status: 404 });
    }

    if (invitation.usedAt) {
      return NextResponse.json({ error: 'This invitation link has already been used' }, { status: 400 });
    }

    if (invitation.expiresAt < new Date()) {
      return NextResponse.json({ error: 'This invitation has expired' }, { status: 400 });
    }

    return NextResponse.json({
      invitation: {
        email: invitation.email,
        role: invitation.role,
        expiresAt: invitation.expiresAt,
      },
    });
  } catch (error) {
    console.error('[invitations/token] GET error:', error);
    return NextResponse.json({ error: 'Failed to validate invitation' }, { status: 500 });
  }
}

export async function POST(request: NextRequest, { params }: { params: { token: string } }) {
  const user = await getUserFromRequest(request);
  if (!user) {
    return NextResponse.json({ error: 'Please connect and sign in with your wallet first' }, { status: 401 });
  }

  try {
    const invitation = await prisma.invitation.findUnique({
      where: { token: params.token },
    });

    if (!invitation) {
      return NextResponse.json({ error: 'Invalid invitation token' }, { status: 404 });
    }

    if (invitation.usedAt) {
      return NextResponse.json({ error: 'This invitation link has already been redeemed' }, { status: 400 });
    }

    if (invitation.expiresAt < new Date()) {
      return NextResponse.json({ error: 'This invitation link has expired' }, { status: 400 });
    }

    // Assign the role to the logged-in wallet user
    const updatedUser = await prisma.user.update({
      where: { walletAddress: user.walletAddress },
      data: { role: invitation.role as Role },
    });

    // Mark invitation as used
    await prisma.invitation.update({
      where: { token: params.token },
      data: { usedAt: new Date() },
    });

    await audit('invitation.accept', {
      actor: user.walletAddress,
      target: invitation.email,
      metadata: { role: invitation.role, token: params.token },
    });

    return NextResponse.json({
      message: `Invitation accepted! Role set to ${updatedUser.role}`,
      user: updatedUser,
    });
  } catch (error) {
    console.error('[invitations/token] POST error:', error);
    return NextResponse.json({ error: 'Failed to redeem invitation' }, { status: 500 });
  }
}
