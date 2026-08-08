/**
 * Stellar Freighter Integration Configuration
 * Following: https://github.com/armlynobinguar/Stellar-Bootcamp-2026/blob/main/STELLAR_FREIGHTER_INTEGRATION_GUIDE.md
 * 
 * Section 4: Configuration Module
 */

import { isConnected, requestAccess, signTransaction, signMessage } from '@stellar/freighter-api';

export const STELLAR_CONFIG = {
  // Network configuration
  network: {
    testnet: {
      name: 'TESTNET' as const,
      rpcUrl: 'https://soroban-testnet.stellar.org',
      networkPassphrase: 'Test SDF Network ; September 2015',
      friendbotUrl: 'https://friendbot.stellar.org',
    },
    public: {
      name: 'PUBLIC' as const,
      rpcUrl: 'https://mainnet.sorobanrpc.com',
      networkPassphrase: 'Public Global Stellar Network ; September 2015',
      friendbotUrl: null,
    },
  },

  // Smart contract configuration
  contract: {
    // Replace with deployed contract ID
    id: process.env.NEXT_PUBLIC_STELLAR_CONTRACT_ID || 'CCTF5WBOQR7JP2KPLQT372X7JCGCINHDFRSAPF4YTYRKZXZ3J2XPRFFW',

    // Network selection
    network: (process.env.NEXT_PUBLIC_STELLAR_NETWORK as 'testnet' | 'public') || 'testnet',
  },

  // Settlement token (Stellar Asset Contract address, e.g. USDC SAC).
  // Funds are pulled into escrow custody on creation and released on finalize.
  token: {
    id: process.env.NEXT_PUBLIC_STELLAR_TOKEN_ID || '',
  },

  // Wallet configuration
  wallet: {
    // Freighter wallet configuration
    freighter: {
      enabled: true,
      timeout: 5000,
    },
  },

  // Application addresses (from Freighter)
  addresses: {
    // Read-only address for simulations (Section 3)
    readAddress: process.env.NEXT_PUBLIC_STELLAR_READ_ADDRESS || '',

    // Signing address (obtained from Freighter requestAccess)
    signingAddress: null as string | null,
  },

  // RPC endpoint helpers
  getRpcUrl: () => {
    const network = STELLAR_CONFIG.contract.network;
    return STELLAR_CONFIG.network[network].rpcUrl;
  },

  getNetworkPassphrase: () => {
    const network = STELLAR_CONFIG.contract.network;
    return STELLAR_CONFIG.network[network].networkPassphrase;
  },

  // Freighter interaction helpers (v6 API — all functions return structured objects)
  freighter: {
    isConnected: async (): Promise<boolean> => {
      try {
        const result = await isConnected();
        return !!result.isConnected;
      } catch (e) {
        return false;
      }
    },

    connect: async (): Promise<string> => {
      const connResult = await isConnected();
      if (!connResult.isConnected) throw new Error('Freighter wallet not found');

      const result = await requestAccess();
      if (result.error) {
        throw new Error(
          typeof result.error === 'string' ? result.error : result.error.message || 'User declined access'
        );
      }
      if (!result.address) throw new Error('Freighter did not return a wallet address');

      return result.address;
    },

    signTransaction: async (transactionXDR: string): Promise<string> => {
      const result = await signTransaction(transactionXDR, {
        networkPassphrase: STELLAR_CONFIG.getNetworkPassphrase(),
      });

      if (result.error) {
        throw new Error(
          typeof result.error === 'string' ? result.error : result.error.message || 'User declined to sign'
        );
      }
      if (!result.signedTxXdr) throw new Error('Freighter did not return a signed transaction');

      return result.signedTxXdr;
    },

    signMessage: async (message: string): Promise<string> => {
      const result = await signMessage(message, {
        networkPassphrase: STELLAR_CONFIG.getNetworkPassphrase(),
      });

      if (result.error) {
        throw new Error(
          typeof result.error === 'string' ? result.error : result.error.message || 'User declined to sign'
        );
      }

      const signatureRaw = result.signedMessage;
      if (!signatureRaw) throw new Error('Freighter did not return a signature');

      // Freighter v6 may return a Buffer (v3-style) or base64 string (v4-style).
      // Normalize to a base64 string for JSON transport to the backend.
      if (typeof signatureRaw !== 'string') {
        if (signatureRaw instanceof Uint8Array || Buffer.isBuffer(signatureRaw)) {
          return Buffer.from(signatureRaw).toString('base64');
        }
      }

      return signatureRaw as string;
    },
  },
};

// Export type for easier usage
export type StellarConfig = typeof STELLAR_CONFIG;
