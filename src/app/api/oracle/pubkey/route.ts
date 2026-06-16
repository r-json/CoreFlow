/**
 * GET /api/oracle/pubkey
 *
 * Returns the oracle's Ed25519 public key (hex). Clients use this as the
 * escrow `oracle_pubkey` when creating an escrow, so the contract can later
 * verify hours-proof signatures produced by POST /api/oracle/attest.
 */

import { NextResponse } from 'next/server';
import { getOraclePublicKeyHex } from '@/lib/oracle';

export async function GET() {
  try {
    return NextResponse.json({ pubkey: getOraclePublicKeyHex() }, { status: 200 });
  } catch {
    return NextResponse.json({ error: 'Oracle is not configured' }, { status: 503 });
  }
}
