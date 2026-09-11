/**
 * GET  /api/invitations/:token — what this invitation offers
 * POST /api/invitations/:token — accept it
 *
 * Public by necessity: the recipient has no membership yet, so there is nothing to
 * authorize against except the token itself. Acceptance still requires an
 * authenticated wallet — a token proves you were invited, not who you are.
 *
 * ── Why every failure looks the same ────────────────────────────────────────
 * Expired, revoked, already-used and never-existed all return the same 404 body.
 * Distinguishing them tells someone probing tokens which of their guesses were
 * real, and a real-but-used token still reveals that an organization invited that
 * address.
 */

import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/db/prisma';
import { getUserFromRequest } from '@/lib/auth';
import { resolveInvitation, acceptInvitation } from '@/lib/tenancy/membership';
import { permissionsFor } from '@/lib/tenancy/rbac';
import { rateLimit, clientIp } from '@/lib/ratelimit';

const NOT_FOUND = NextResponse.json(
  { error: 'This invitation is not valid. Ask your administrator for a new one.' },
  { status: 404 }
);

export async function GET(_request: NextRequest, { params }: { params: { token: string } }) {
  // Unauthenticated and guessable-by-construction, so brake it per IP.
  const rl = rateLimit(`invite-read:${clientIp(_request)}`, 30, 60_000);
  if (!rl.ok) return NOT_FOUND;

  const resolved = await resolveInvitation(prisma, params.token);
  if (!resolved.ok) {
    console.warn(`[invitations] rejected lookup: ${resolved.reason}`);
    return NOT_FOUND;
  }

  const org = await prisma.organization.findUnique({
    where: { id: resolved.value.orgId },
    select: { name: true, slug: true },
  });

  return NextResponse.json({
    invitation: {
      // The organization NAME is shown so the recipient knows what they are
      // joining. Its id is not: that is an internal identifier with no business
      // meaning to an invitee.
      organizationName: org?.name ?? 'an organization',
      email: resolved.value.email,
      role: resolved.value.orgRole,
      permissions: permissionsFor(resolved.value.orgRole),
    },
  });
}

export async function POST(request: NextRequest, { params }: { params: { token: string } }) {
  const rl = rateLimit(`invite-accept:${clientIp(request)}`, 10, 60_000);
  if (!rl.ok) return NOT_FOUND;

  // A token says you were invited. It does not say who you are — that needs a
  // wallet signature, so the membership is bound to a proven identity.
  const user = await getUserFromRequest(request);
  if (!user) {
    return NextResponse.json(
      {
        error: 'Connect and sign in with your Stellar wallet to accept this invitation.',
        code: 'AUTHENTICATION_REQUIRED',
      },
      { status: 401 }
    );
  }

  const result = await acceptInvitation(prisma, params.token, {
    id: user.userId,
    walletAddress: user.walletAddress,
  });

  if (!result.ok) {
    // A 403 here is meaningful and safe: the caller is authenticated, and being
    // told their membership was removed is information they already have.
    if (result.status === 403) {
      return NextResponse.json({ error: result.message }, { status: 403 });
    }
    return NOT_FOUND;
  }

  const org = await prisma.organization.findUnique({
    where: { id: result.value.orgId },
    select: { id: true, name: true, slug: true },
  });

  return NextResponse.json({
    joined: true,
    organization: org,
    role: result.value.role,
    permissions: permissionsFor(result.value.role),
  });
}
