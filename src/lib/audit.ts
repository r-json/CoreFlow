/**
 * Append-only audit log for security-sensitive actions (role grants, logout,
 * escrow creation). Best-effort: a logging failure must never break the action,
 * so writes are wrapped and errors only logged.
 */

import prisma from '@/lib/db/prisma';

export async function audit(
  action: string,
  opts: { actor?: string | null; target?: string | null; metadata?: Record<string, unknown> } = {}
): Promise<void> {
  try {
    await prisma.auditLog.create({
      data: {
        action,
        actor: opts.actor ?? null,
        target: opts.target ?? null,
        metadata: opts.metadata ? JSON.stringify(opts.metadata) : null,
      },
    });
  } catch (error) {
    console.error('[audit] failed to write audit log:', error);
  }
}
