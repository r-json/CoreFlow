/**
 * Which asset this deployment can actually settle.
 *
 * An escrow in the CoreFlow contract holds ONE Stellar Asset Contract. So the
 * question "is USDC supported?" has no global answer — it depends on the SAC this
 * deployment was configured with. Accepting a currency the settlement path cannot
 * honour produces a batch that validates, funds nothing, and fails at the wallet.
 *
 * Nothing here guesses a contract address. A missing SAC is reported as missing.
 */

import { SAC_DECIMALS } from '@/lib/money';

export interface SettlementAsset {
  /** Display code, e.g. USDC. */
  code: string;
  /** The Stellar Asset Contract address, or null when unconfigured. */
  contractId: string | null;
  /** SAC decimals. Always 7 for a Stellar Asset Contract. */
  decimals: number;
}

/** Default when the operator has not said otherwise. */
const DEFAULT_CODE = 'USDC';

/**
 * The configured settlement asset.
 *
 * Read on each call rather than captured at module load, so a test or a server
 * restart sees the current environment instead of whatever was set when the
 * module first happened to be imported.
 */
export function settlementAsset(): SettlementAsset {
  const code = (process.env.NEXT_PUBLIC_SETTLEMENT_ASSET_CODE || DEFAULT_CODE).trim().toUpperCase();
  const contractId = (process.env.NEXT_PUBLIC_STELLAR_TOKEN_ID || '').trim();
  return { code, contractId: contractId.length > 0 ? contractId : null, decimals: SAC_DECIMALS };
}

/**
 * Asset codes a payroll CSV may use here.
 *
 * Exactly one, because one escrow holds one SAC. A multi-asset payroll needs one
 * escrow per asset, which is a product decision and not something to paper over
 * by quietly accepting a code that cannot be paid.
 */
export function settleableAssetCodes(): readonly string[] {
  return [settlementAsset().code];
}

/**
 * The settlement SAC address, or a clear failure.
 *
 * Used where an address is genuinely required — funding custody, verifying a
 * transfer. Draft creation deliberately does NOT call this: a batch can be
 * prepared and reviewed before the operator has finished wiring the asset, and
 * refusing the upload for that reason would be unhelpful.
 */
export function requireSettlementContractId(): string {
  const { code, contractId } = settlementAsset();
  if (!contractId) {
    throw new Error(
      `NEXT_PUBLIC_STELLAR_TOKEN_ID is not set, so CoreFlow does not know which ` +
        `contract issues ${code}. It will not guess a Stellar Asset Contract address.`,
    );
  }
  return contractId;
}
