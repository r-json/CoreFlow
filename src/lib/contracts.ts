/**
 * CoreFlow Client - Soroban Smart Contract Integration
 * Handles communication with the CoreFlow contract on Stellar
 * 
 * Following: https://github.com/armlynobinguar/Stellar-Bootcamp-2026/blob/main/STELLAR_FREIGHTER_INTEGRATION_GUIDE.md
 * 
 * NOTE: This module requires js-stellar-sdk to be installed for actual contract interactions.
 * Install with: npm install js-stellar-sdk@10
 */

import { STELLAR_CONFIG } from './config';

export interface PaymentSchedule {
  id: number;
  worker: string;
  amount: bigint;
  currency: string;
  start_date: number;
  end_date: number;
  hours_logged: bigint;
  rate_per_hour: bigint;
  status: number;
}

export interface SimulateResult {
  result: any;
  error?: string;
}

export interface SubmitResult {
  transactionHash: string;
  status: string;
}

/**
 * CoreFlowClient: Main class for interacting with the CoreFlow contract
 * 
 * All Stellar SDK imports are deferred to runtime to avoid build-time errors
 * when js-stellar-sdk is not installed.
 */
export class CoreFlowClient {
  private contractAddress: string;
  private networkPassphrase: string;

  constructor() {
    this.contractAddress = STELLAR_CONFIG.contract.id;
    this.networkPassphrase = STELLAR_CONFIG.getNetworkPassphrase();
  }

  private async loadSDK() {
    try {
      return await import('@stellar/stellar-sdk');
    } catch {
      throw new Error(
        'js-stellar-sdk not installed. Install with: npm install js-stellar-sdk@10'
      );
    }
  }

  /**
   * Simulate manager_approve transaction
   */
  async simulateManagerApprove(escrowId: number): Promise<SimulateResult> {
    try {
      const sdk = await this.loadSDK();
      const readAddress = STELLAR_CONFIG.addresses.readAddress;

      if (!readAddress) {
        throw new Error('NEXT_PUBLIC_STELLAR_READ_ADDRESS not configured');
      }

      const rpcClient = new sdk.rpc.Server(STELLAR_CONFIG.getRpcUrl());
      const contract = new sdk.Contract(this.contractAddress);
      const sourceAccount = await rpcClient.getAccount(readAddress);

      const transaction = new sdk.TransactionBuilder(sourceAccount, {
        fee: sdk.BASE_FEE,
        networkPassphrase: this.networkPassphrase,
      })
        .addOperation(contract.call('manager_approve', sdk.nativeToScVal(escrowId, { type: 'u32' })))
        .setTimeout(300)
        .build();

      const simulated = await rpcClient.simulateTransaction(transaction);
      if (sdk.rpc.Api.isSimulationError(simulated)) {
        return { result: null, error: simulated.error };
      }

      return { result: simulated };
    } catch (error) {
      return { result: null, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  }

  /**
   * Simulate finance_approve transaction
   */
  async simulateFinanceApprove(escrowId: number): Promise<SimulateResult> {
    try {
      const sdk = await this.loadSDK();
      const readAddress = STELLAR_CONFIG.addresses.readAddress;

      if (!readAddress) {
        throw new Error('NEXT_PUBLIC_STELLAR_READ_ADDRESS not configured');
      }

      const rpcClient = new sdk.rpc.Server(STELLAR_CONFIG.getRpcUrl());
      const contract = new sdk.Contract(this.contractAddress);
      const sourceAccount = await rpcClient.getAccount(readAddress);

      const transaction = new sdk.TransactionBuilder(sourceAccount, {
        fee: sdk.BASE_FEE,
        networkPassphrase: this.networkPassphrase,
      })
        .addOperation(contract.call('finance_approve', sdk.nativeToScVal(escrowId, { type: 'u32' })))
        .setTimeout(300)
        .build();

      const simulated = await rpcClient.simulateTransaction(transaction);
      if (sdk.rpc.Api.isSimulationError(simulated)) {
        return { result: null, error: simulated.error };
      }

      return { result: simulated };
    } catch (error) {
      return { result: null, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  }

  /**
   * Submit manager_approve transaction via Freighter
   */
  async submitManagerApprove(escrowId: number): Promise<SubmitResult> {
    try {
      const sdk = await this.loadSDK();
      const signingAddress = await this.getSigningAddress();
      const rpcClient = new sdk.rpc.Server(STELLAR_CONFIG.getRpcUrl());
      const contract = new sdk.Contract(this.contractAddress);
      const sourceAccount = await rpcClient.getAccount(signingAddress);

      const transaction = new sdk.TransactionBuilder(sourceAccount, {
        fee: sdk.BASE_FEE,
        networkPassphrase: this.networkPassphrase,
      })
        .addOperation(contract.call('manager_approve', sdk.nativeToScVal(escrowId, { type: 'u32' })))
        .setTimeout(300)
        .build();

      const simulated = await rpcClient.simulateTransaction(transaction);
      if (sdk.rpc.Api.isSimulationError(simulated)) {
        throw new Error(`Simulation failed: ${simulated.error}`);
      }

      const prepared = sdk.rpc.assembleTransaction(transaction, simulated).build();
      const signedXDR = await STELLAR_CONFIG.freighter.signTransaction(prepared.toXDR());
      const response = await rpcClient.sendTransaction(
        sdk.TransactionBuilder.fromXDR(signedXDR, this.networkPassphrase)
      );

      if (response.status === 'PENDING') {
        const result = await this.pollForResult(rpcClient, response.hash);
        return { transactionHash: response.hash, status: result };
      }

      return { transactionHash: response.hash, status: response.status };
    } catch (error) {
      throw new Error(`Failed to submit manager approval: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Submit finance_approve transaction via Freighter
   */
  async submitFinanceApprove(escrowId: number): Promise<SubmitResult> {
    try {
      const sdk = await this.loadSDK();
      const signingAddress = await this.getSigningAddress();
      const rpcClient = new sdk.rpc.Server(STELLAR_CONFIG.getRpcUrl());
      const contract = new sdk.Contract(this.contractAddress);
      const sourceAccount = await rpcClient.getAccount(signingAddress);

      const transaction = new sdk.TransactionBuilder(sourceAccount, {
        fee: sdk.BASE_FEE,
        networkPassphrase: this.networkPassphrase,
      })
        .addOperation(contract.call('finance_approve', sdk.nativeToScVal(escrowId, { type: 'u32' })))
        .setTimeout(300)
        .build();

      const simulated = await rpcClient.simulateTransaction(transaction);
      if (sdk.rpc.Api.isSimulationError(simulated)) {
        throw new Error(`Simulation failed: ${simulated.error}`);
      }

      const prepared = sdk.rpc.assembleTransaction(transaction, simulated).build();
      const signedXDR = await STELLAR_CONFIG.freighter.signTransaction(prepared.toXDR());
      const response = await rpcClient.sendTransaction(
        sdk.TransactionBuilder.fromXDR(signedXDR, this.networkPassphrase)
      );

      if (response.status === 'PENDING') {
        const result = await this.pollForResult(rpcClient, response.hash);
        return { transactionHash: response.hash, status: result };
      }

      return { transactionHash: response.hash, status: response.status };
    } catch (error) {
      throw new Error(`Failed to submit finance approval: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Get the signing address from Freighter wallet
   */
  private async getSigningAddress(): Promise<string> {
    const isConnected = await STELLAR_CONFIG.freighter.isConnected();
    if (!isConnected) {
      return await STELLAR_CONFIG.freighter.connect();
    }
    return STELLAR_CONFIG.addresses.signingAddress || (await STELLAR_CONFIG.freighter.connect());
  }

  /**
   * Poll for transaction result
   */
  private async pollForResult(rpcClient: any, transactionHash: string): Promise<string> {
    const maxAttempts = 30;
    const delayMs = 1000;

    for (let i = 0; i < maxAttempts; i++) {
      try {
        const result = await rpcClient.getTransaction(transactionHash);
        if (result.status !== 'PENDING') {
          return result.status;
        }
      } catch (error) {
        // Continue polling
      }

      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }

    throw new Error('Transaction polling timeout');
  }

  /**
   * Get escrow details (read-only)
   */
  async getEscrow(escrowId: number): Promise<any> {
    try {
      const sdk = await this.loadSDK();
      const readAddress = STELLAR_CONFIG.addresses.readAddress;

      if (!readAddress) {
        throw new Error('NEXT_PUBLIC_STELLAR_READ_ADDRESS not configured');
      }

      const rpcClient = new sdk.rpc.Server(STELLAR_CONFIG.getRpcUrl());
      const contract = new sdk.Contract(this.contractAddress);
      const sourceAccount = await rpcClient.getAccount(readAddress);

      const transaction = new sdk.TransactionBuilder(sourceAccount, {
        fee: sdk.BASE_FEE,
        networkPassphrase: this.networkPassphrase,
      })
        .addOperation(contract.call('get_escrow', sdk.nativeToScVal(escrowId, { type: 'u32' })))
        .setTimeout(300)
        .build();

      const simulated = await rpcClient.simulateTransaction(transaction);
      if (sdk.rpc.Api.isSimulationError(simulated)) {
        throw new Error(`Failed to get escrow: ${simulated.error}`);
      }

      return simulated;
    } catch (error) {
      throw new Error(`Failed to get escrow: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }
}
