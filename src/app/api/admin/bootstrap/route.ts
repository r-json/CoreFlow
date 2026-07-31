import { NextRequest } from 'next/server';
import { ApiResponse } from '@/lib/api-response';
import prisma from '@/lib/db/prisma';
import { Role } from '@prisma/client';
import { audit } from '@/lib/audit';

export async function POST(req: NextRequest) {
  const secret = process.env.BOOTSTRAP_SECRET;

  // Security guard: If BOOTSTRAP_SECRET is unset or empty, disable this endpoint completely with 404
  if (!secret || secret.trim() === '') {
    return ApiResponse.notFound('Endpoint not available');
  }

  try {
    const body = await req.json().catch(() => ({}));
    const requestSecret = req.headers.get('x-bootstrap-secret') || body.bootstrapSecret;

    if (requestSecret !== secret) {
      return ApiResponse.notFound('Endpoint not available');
    }

    // Determine target wallet address
    let targetWallet = body.walletAddress;
    if (!targetWallet) {
      const defaultWallets = (process.env.ADMIN_WALLETS || process.env.ADMIN_WALLET_ADDRESS || '')
        .split(',')
        .map((w) => w.trim())
        .filter(Boolean);
      targetWallet = defaultWallets[0];
    }

    if (!targetWallet) {
      return ApiResponse.error('No target walletAddress provided or configured in ADMIN_WALLETS', 400);
    }

    const user = await prisma.user.upsert({
      where: { walletAddress: targetWallet },
      create: {
        walletAddress: targetWallet,
        role: Role.ADMIN,
      },
      update: {
        role: Role.ADMIN,
      },
    });

    await audit('admin.bootstrap', {
      actor: targetWallet,
      target: targetWallet,
      metadata: { message: 'Admin bootstrapped via /api/admin/bootstrap' },
    });

    console.log(`[Bootstrap] Successfully promoted/created ADMIN wallet: ${targetWallet}`);

    return ApiResponse.success({
      message: 'Admin wallet bootstrapped successfully',
      user: {
        id: user.id,
        walletAddress: user.walletAddress,
        role: user.role,
      },
    });
  } catch (err: any) {
    console.error('[Bootstrap Error]', err);
    return ApiResponse.serverError(err?.message || 'Failed to bootstrap admin');
  }
}
