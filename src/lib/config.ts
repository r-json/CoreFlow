/**
 * Stellar Freighter Integration Configuration
 * Following: https://github.com/armlynobinguar/Stellar-Bootcamp-2026/blob/main/STELLAR_FREIGHTER_INTEGRATION_GUIDE.md
 * 
 * Section 4: Configuration Module
 */

export const STELLAR_CONFIG = {
  // Network configuration
  network: {
    testnet: {
      name: 'TESTNET_SDF_TEST_SDF_TEST_SDF_TEST_SDF_TEST_SDF_TEST_SDF_TEST_SDF_TEST_SBUWIMF' as const,
      rpcUrl: 'https://soroban-testnet.stellar.org',
      networkPassphrase: 'Test SDF Network ; September 2015',
      friendbotUrl: 'https://friendbot.stellar.org',
    },
    public: {
      name: 'PUBLIC_SDF_NETWORK_SDF_PUBLIC_SDF_NETWORK_SDF_PUBLIC_SDF_NETWORK_SDF_PUBLI_QBULR' as const,
      rpcUrl: 'https://soroban-mainnet.stellar.org',
      networkPassphrase: 'Public Global Stellar Network ; September 2015',
      friendbotUrl: null,
    },
  },

  // Smart contract configuration
  contract: {
    // Replace with deployed contract ID
    id: process.env.NEXT_PUBLIC_STELLAR_CONTRACT_ID || 'CAU3FQTWCAFJF4XFVRXSEPWRPBCVHDSRBSCPTM75HJFDZD5XQQQY47A4',
    
    // Network selection
    network: (process.env.NEXT_PUBLIC_STELLAR_NETWORK as 'testnet' | 'public') || 'testnet',
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

  // Freighter interaction helpers
  freighter: {
    isConnected: async (): Promise<boolean> => {
      if (typeof window === 'undefined') return false;
      return (window as any).freighter?.isConnected?.() || false;
    },

    connect: async (): Promise<string> => {
      if (typeof window === 'undefined') throw new Error('Window not available');
      
      const freighter = (window as any).freighter;
      if (!freighter) throw new Error('Freighter wallet not found');
      
      const result = await freighter.requestAccess({
        network: STELLAR_CONFIG.getNetworkPassphrase(),
      });

      if (result.error) throw new Error(result.error);
      return result.publicKey;
    },

    signTransaction: async (transactionXDR: string): Promise<string> => {
      if (typeof window === 'undefined') throw new Error('Window not available');
      
      const freighter = (window as any).freighter;
      if (!freighter) throw new Error('Freighter wallet not found');

      const result = await freighter.signTransaction(transactionXDR, {
        network: STELLAR_CONFIG.getNetworkPassphrase(),
      });

      if (result.error) throw new Error(result.error);
      return result.signedXDR;
    },

    signMessage: async (message: string): Promise<string> => {
      if (typeof window === 'undefined') throw new Error('Window not available');
      
      const freighter = (window as any).freighter;
      if (!freighter) throw new Error('Freighter wallet not found');

      const result = await freighter.signMessage(message, {
        network: STELLAR_CONFIG.getNetworkPassphrase(),
      });

      if (result.error) throw new Error(result.error);
      return result.signedMessage;
    },
  },
};

// Export type for easier usage
export type StellarConfig = typeof STELLAR_CONFIG;
