/**
 * CoreFlow Client - Soroban Smart Contract Integration
 * Handles communication with the CoreFlow contract on Stellar
 * 
 * Following: https://github.com/armlynobinguar/Stellar-Bootcamp-2026/blob/main/STELLAR_FREIGHTER_INTEGRATION_GUIDE.md
 */

import { STELLAR_CONFIG } from './config';

export interface PaymentScheduleInput {
  worker: string;
  /** Per-payee Stellar Asset Contract address (USDC SAC, native XLM SAC, ...). */
  token: string;
  amount: bigint;
  start_date: number;
  end_date: number;
  rate_per_hour: bigint;
}

export interface PaymentSchedule {
  id: number;
  worker: string;
  token: string;
  amount: bigint;
  start_date: number;
  end_date: number;
  hours_logged: bigint;
  rate_per_hour: bigint;
  proof_verified: boolean;
  status: number;
}

export interface EscrowDetails {
  manager: string;
  finance_approver: string;
  oracle_pubkey: string;
  payments: PaymentSchedule[];
  manager_approved: boolean;
  finance_approved: boolean;
  cancelled: boolean;
  oracle_rotations: number;
}

export interface SimulateResult {
  result: any;
  error?: string;
}

export interface SubmitResult {
  transactionHash: string;
  status: string;
  returnValue?: any;
}

export class CoreFlowClient {
  private contractAddress: string;
  private networkPassphrase: string;

  constructor() {
    // Throws when unset rather than defaulting to a mainnet address.
    this.contractAddress = STELLAR_CONFIG.requireContractId();
    this.networkPassphrase = STELLAR_CONFIG.getNetworkPassphrase();
  }

  private async loadSDK() {
    try {
      return await import('@stellar/stellar-sdk');
    } catch {
      throw new Error(
        'js-stellar-sdk not installed. Install with: npm install @stellar/stellar-sdk'
      );
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
   * Helper to build, simulate, sign via Freighter, and submit a transaction
   */
  /**
   * Invoke a contract method: simulate, sign with Freighter, submit, then poll.
   *
   * `onSubmitted` fires the INSTANT the network accepts the transaction, before
   * polling begins. That matters for funding: `initialize_multi_sig_escrow` moves
   * custody and is not idempotent, so if polling then fails, the caller must still
   * know the hash — otherwise the only record of a transaction that may already
   * have moved money is lost, and the obvious recovery is to sign a second one.
   */
  private async submitTransaction(
    method: string,
    args: any[],
    onSubmitted?: (hash: string) => void | Promise<void>
  ): Promise<SubmitResult> {
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
        .addOperation(contract.call(method, ...args))
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
        // Report the hash before waiting on confirmation. A failure inside the
        // callback must not lose the hash either, so it is isolated.
        if (onSubmitted) {
          try {
            await onSubmitted(response.hash);
          } catch {
            // The caller's bookkeeping failed; the transaction is still in flight
            // and the hash is still returned below.
          }
        }

        const resultStatus = await this.pollForResult(rpcClient, response.hash);
        
        // Fetch transaction details to parse return value if needed
        let returnValue: any = null;
        try {
          const txDetails = await rpcClient.getTransaction(response.hash);
          if (txDetails.status === 'SUCCESS' && txDetails.resultMetaXdr) {
            const txResult = txDetails.resultMetaXdr as any;
            // Parse contract result from transaction meta if available
            const meta = typeof txResult === 'string'
              ? sdk.xdr.TransactionMeta.fromXDR(txResult, 'base64')
              : txResult;
            const v3 = meta.v3();
            if (v3 && v3.sorobanMeta() && v3.sorobanMeta().returnValue()) {
              returnValue = sdk.scValToNative(v3.sorobanMeta().returnValue());
            }
          }
        } catch (e) {
          console.warn('Failed to parse transaction return value:', e);
        }

        return { transactionHash: response.hash, status: resultStatus, returnValue };
      }

      return { transactionHash: response.hash, status: response.status };
    } catch (error) {
      throw new Error(`Failed to execute ${method}: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
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
  async getEscrow(escrowId: number): Promise<EscrowDetails> {
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
        throw new Error(`Failed to simulate get_escrow: ${simulated.error}`);
      }

      if (!simulated.result || !simulated.result.retval) {
        throw new Error('No simulation result returned');
      }

      const rawEscrow = sdk.scValToNative(simulated.result.retval);
      
      // Map raw JS structure returned from scValToNative to EscrowDetails
      return {
        manager: rawEscrow.manager,
        finance_approver: rawEscrow.finance_approver,
        oracle_pubkey: rawEscrow.oracle_pubkey,
        oracle_rotations: Number(rawEscrow.oracle_rotations ?? 0),
        manager_approved: rawEscrow.manager_approved,
        finance_approved: rawEscrow.finance_approved,
        cancelled: rawEscrow.cancelled,
        payments: (rawEscrow.payments || []).map((p: any) => ({
          token: p.token,
          proof_verified: Boolean(p.proof_verified),
          id: Number(p.id),
          worker: p.worker,
          amount: BigInt(p.amount),
          start_date: Number(p.start_date),
          end_date: Number(p.end_date),
          hours_logged: BigInt(p.hours_logged),
          rate_per_hour: BigInt(p.rate_per_hour),
          status: Number(p.status), // enum maps to number values in native parsing
        })),
      };
    } catch (error) {
      throw new Error(`Failed to get escrow: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Read the next expected oracle nonce for an escrow (read-only simulation).
   * The oracle must sign a proof using exactly this value.
   */
  async getNonce(escrowId: number): Promise<number> {
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
      .addOperation(contract.call('get_nonce', sdk.nativeToScVal(escrowId, { type: 'u32' })))
      .setTimeout(300)
      .build();

    const simulated = await rpcClient.simulateTransaction(transaction);
    if (sdk.rpc.Api.isSimulationError(simulated)) {
      throw new Error(`Failed to read nonce: ${simulated.error}`);
    }
    if (!simulated.result || !simulated.result.retval) {
      throw new Error('No nonce returned from simulation');
    }
    return Number(sdk.scValToNative(simulated.result.retval));
  }

  /**
   * Initialize a new multi-sig escrow with payments
   */
  async submitInitializeEscrow(
    managerAddress: string,
    financeAddress: string,
    oraclePubkeyHex: string,
    payments: PaymentScheduleInput[],
    /** Called as soon as the network accepts the transaction. See submitTransaction. */
    onSubmitted?: (hash: string) => void | Promise<void>
  ): Promise<SubmitResult> {
    const sdk = await this.loadSDK();

    // Map PaymentScheduleInput to native ScVals compatible with PaymentSchedule Rust struct
    const mappedPayments = payments.map((p, idx) => ({
      id: idx + 1, // Start with sequential ID
      worker: sdk.Address.fromString(p.worker),
      token: sdk.Address.fromString(p.token),
      amount: p.amount,
      start_date: BigInt(p.start_date),
      end_date: BigInt(p.end_date),
      hours_logged: 0n,
      rate_per_hour: p.rate_per_hour,
      proof_verified: false,
      status: 0, // PaymentStatus::Pending
    }));

    const managerScVal = sdk.Address.fromString(managerAddress);
    const financeScVal = sdk.Address.fromString(financeAddress);
    // Convert hex oracle public key to BytesN<32> ScVal.
    // The contract expects a fixed 32-byte value, so we must use the exact
    // byte-length encoding rather than variable-length scvBytes.
    const oracleBytes = Buffer.from(oraclePubkeyHex, 'hex');
    if (oracleBytes.length !== 32) {
      throw new Error(`Oracle public key must be exactly 32 bytes (got ${oracleBytes.length})`);
    }
    const oraclePubkeyScVal = sdk.nativeToScVal(oracleBytes, { type: 'bytes' });
    const paymentsScVal = sdk.nativeToScVal(mappedPayments);

    return this.submitTransaction(
      'initialize_multi_sig_escrow',
      [managerScVal, financeScVal, oraclePubkeyScVal, paymentsScVal],
      onSubmitted
    );
  }

  /**
   * Submit hours proof from an oracle (simulated oracle signature verify)
   */
  async submitHoursProof(
    escrowId: number,
    paymentId: number,
    hoursLogged: number,
    nonce: number,
    signatureBase64: string
  ): Promise<SubmitResult> {
    const sdk = await this.loadSDK();
    
    const escrowIdScVal = sdk.nativeToScVal(escrowId, { type: 'u32' });
    const paymentIdScVal = sdk.nativeToScVal(paymentId, { type: 'u32' });
    const hoursScVal = sdk.nativeToScVal(BigInt(hoursLogged), { type: 'i128' });
    const nonceScVal = sdk.nativeToScVal(BigInt(nonce), { type: 'u64' });
    
    // Convert signature base64 to BytesN<64> ScVal
    const sigBuffer = Buffer.from(signatureBase64, 'base64');
    const sigBytesScVal = sdk.xdr.ScVal.scvBytes(sigBuffer);

    return this.submitTransaction('submit_hours_proof', [
      escrowIdScVal,
      paymentIdScVal,
      hoursScVal,
      nonceScVal,
      sigBytesScVal,
    ]);
  }

  /**
   * Submit manager approval
   */
  async submitManagerApprove(escrowId: number): Promise<SubmitResult> {
    const sdk = await this.loadSDK();
    return this.submitTransaction('manager_approve', [
      sdk.nativeToScVal(escrowId, { type: 'u32' }),
    ]);
  }

  /**
   * Submit finance approval
   */
  async submitFinanceApprove(escrowId: number): Promise<SubmitResult> {
    const sdk = await this.loadSDK();
    return this.submitTransaction('finance_approve', [
      sdk.nativeToScVal(escrowId, { type: 'u32' }),
    ]);
  }

  /**
   * Settle the batch: one transaction, one SAC transfer per payee, each in
   * that payee's own asset. Requires both approvals and a verified oracle
   * proof on every payment.
   */
  async submitPayBatch(escrowId: number): Promise<SubmitResult> {
    const sdk = await this.loadSDK();
    return this.submitTransaction('pay_batch', [
      sdk.nativeToScVal(escrowId, { type: 'u32' }),
    ]);
  }

  /** @deprecated Use submitPayBatch. Retained for the live Mainnet ABI. */
  async submitFinalizePayment(escrowId: number): Promise<SubmitResult> {
    return this.submitPayBatch(escrowId);
  }

  /**
   * Rotate the escrow's oracle public key. Signatures made by the retired key
   * stop verifying, and any previously verified proofs are revoked.
   */
  async submitRotateOracleKey(escrowId: number, newPubkeyHex: string): Promise<SubmitResult> {
    const sdk = await this.loadSDK();
    const bytes = Buffer.from(newPubkeyHex, 'hex');
    if (bytes.length !== 32) {
      throw new Error(`Oracle public key must be exactly 32 bytes (got ${bytes.length})`);
    }
    return this.submitTransaction('rotate_oracle_key', [
      sdk.nativeToScVal(escrowId, { type: 'u32' }),
      sdk.nativeToScVal(bytes, { type: 'bytes' }),
    ]);
  }

  /**
   * Ask the contract for the exact bytes the oracle must sign (read-only).
   *
   * The contract is the single source of truth for the attestation preimage.
   * A signer that reads it here cannot drift from the verifier, which is the
   * failure mode every reimplementation of a message format eventually hits.
   */
  async getProofPreimage(
    escrowId: number,
    paymentId: number,
    hours: bigint,
    nonce: bigint
  ): Promise<Buffer> {
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
      .addOperation(
        contract.call(
          'proof_preimage',
          sdk.nativeToScVal(escrowId, { type: 'u32' }),
          sdk.nativeToScVal(paymentId, { type: 'u32' }),
          sdk.nativeToScVal(hours, { type: 'i128' }),
          sdk.nativeToScVal(nonce, { type: 'u64' })
        )
      )
      .setTimeout(300)
      .build();

    const simulated = await rpcClient.simulateTransaction(transaction);
    if (sdk.rpc.Api.isSimulationError(simulated)) {
      throw new Error(`Failed to read proof preimage: ${simulated.error}`);
    }
    if (!simulated.result?.retval) {
      throw new Error('No preimage returned from simulation');
    }
    return Buffer.from(sdk.scValToNative(simulated.result.retval));
  }

  /**
   * Register an oracle signing key as platform-trusted (contract admin only).
   *
   * Escrows may only name a registered key, so a manager cannot install their
   * own oracle and attest to their own work.
   */
  async submitRegisterOracleKey(pubkeyHex: string): Promise<SubmitResult> {
    const sdk = await this.loadSDK();
    const bytes = Buffer.from(pubkeyHex, 'hex');
    if (bytes.length !== 32) {
      throw new Error(`Oracle public key must be exactly 32 bytes (got ${bytes.length})`);
    }
    return this.submitTransaction('register_oracle_key', [
      sdk.nativeToScVal(bytes, { type: 'bytes' }),
    ]);
  }

  /** Revoke a registered oracle key (contract admin only). */
  async submitRevokeOracleKey(pubkeyHex: string): Promise<SubmitResult> {
    const sdk = await this.loadSDK();
    const bytes = Buffer.from(pubkeyHex, 'hex');
    if (bytes.length !== 32) {
      throw new Error(`Oracle public key must be exactly 32 bytes (got ${bytes.length})`);
    }
    return this.submitTransaction('revoke_oracle_key', [
      sdk.nativeToScVal(bytes, { type: 'bytes' }),
    ]);
  }

  /** True if the contract admin has registered this oracle key (read-only). */
  async isOracleKeyRegistered(pubkeyHex: string): Promise<boolean> {
    const sdk = await this.loadSDK();
    const readAddress = STELLAR_CONFIG.addresses.readAddress;
    if (!readAddress) {
      throw new Error('NEXT_PUBLIC_STELLAR_READ_ADDRESS not configured');
    }
    const bytes = Buffer.from(pubkeyHex, 'hex');
    if (bytes.length !== 32) {
      throw new Error(`Oracle public key must be exactly 32 bytes (got ${bytes.length})`);
    }

    const rpcClient = new sdk.rpc.Server(STELLAR_CONFIG.getRpcUrl());
    const contract = new sdk.Contract(this.contractAddress);
    const sourceAccount = await rpcClient.getAccount(readAddress);

    const transaction = new sdk.TransactionBuilder(sourceAccount, {
      fee: sdk.BASE_FEE,
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(
        contract.call('is_oracle_key_registered', sdk.nativeToScVal(bytes, { type: 'bytes' }))
      )
      .setTimeout(300)
      .build();

    const simulated = await rpcClient.simulateTransaction(transaction);
    if (sdk.rpc.Api.isSimulationError(simulated)) {
      throw new Error(`Failed to read oracle registry: ${simulated.error}`);
    }
    return Boolean(sdk.scValToNative(simulated.result!.retval));
  }

  /**
   * Submit escrow cancellation
   */
  async submitCancelEscrow(escrowId: number): Promise<SubmitResult> {
    const sdk = await this.loadSDK();
    return this.submitTransaction('cancel_escrow', [
      sdk.nativeToScVal(escrowId, { type: 'u32' }),
    ]);
  }
}
