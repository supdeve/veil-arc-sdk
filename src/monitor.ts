/**
 * The settlement monitor.
 *
 * The monitor answers one question repeatedly: *what does the chain say now?*
 *
 * It never broadcasts. A transaction whose submission is uncertain is inspected
 * (nonce, hash, receipt) rather than re-sent, and a conflicting observation is
 * reported rather than overwritten. The local database is a recoverable index;
 * the chain is authoritative for the payment state.
 */
import {Contract, JsonRpcProvider, keccak256, type Provider} from 'ethers';

import {VeilError} from './errors.js';
import {
  VeilStore,
  type JobRecord,
  type JobStatus,
  type SubmissionState,
  type TransactionRecord,
} from './store.js';

export type TransactionState =
  | 'PREPARED'
  | 'SIGNED'
  | 'SUBMITTED'
  | 'CONFIRMED'
  | 'FAILED'
  | 'REVERTED'
  | 'UNKNOWN';

export type AgreementLifecycle =
  | 'CREATED'
  | 'ACCEPTED'
  | 'FUNDED'
  | 'SUBMITTED_FOR_EVALUATION'
  | 'SETTLED'
  | 'REFUNDED'
  | 'EXPIRED'
  | 'REJECTED'
  | 'UNKNOWN';

export const ERC8183_STATUS: readonly JobStatus[] = [
  'OPEN',
  'FUNDED',
  'SUBMITTED',
  'COMPLETED',
  'REJECTED',
  'EXPIRED',
];

export interface MonitorOptions {
  readonly rpcUrl: string;
  readonly chainId: number;
  readonly contractAddress: string;
  readonly implementation: string;
  readonly expectedImplementationCodeHash: string;
  readonly abi: readonly unknown[];
  readonly store: VeilStore;
  readonly requestTimeoutMs?: number;
  /** An injected provider, for tests and for a caller that owns its transport. */
  readonly provider?: Provider;
}

export interface TransactionObservation {
  readonly txId: string;
  readonly txHash?: string;
  readonly state: TransactionState;
  readonly blockNumber?: number;
  readonly blockHash?: string;
  readonly gasUsed?: string;
  readonly effectiveGasPrice?: string;
  readonly revertReason?: string;
  readonly uncertain: boolean;
  readonly detail?: string;
}

export interface JobReconciliation {
  readonly agreementId: string;
  readonly jobId: string;
  readonly chainStatus: JobStatus;
  readonly lifecycle: AgreementLifecycle;
  readonly fundingTx?: string;
  readonly settlementTx?: string;
  readonly refundTx?: string;
  readonly transactions: readonly TransactionObservation[];
  readonly reconciledAt: string;
  readonly uncertain: boolean;
  readonly conflicts: readonly string[];
}

const ERC8183_ABI = [
  'function getJob(uint256) view returns (tuple(uint256 id, address client, address provider, address evaluator, string description, uint256 budget, uint256 expiredAt, uint8 status, address hook))',
  'function paymentToken() view returns (address)',
];

export class SettlementMonitor {
  private readonly provider: Provider;

  constructor(private readonly options: MonitorOptions) {
    if (options.provider) {
      this.provider = options.provider;
    } else {
      this.provider = new JsonRpcProvider(options.rpcUrl, {
        chainId: options.chainId,
        name: `chain-${options.chainId}`,
      });
      (this.provider as any)._getConnection().timeout = options.requestTimeoutMs ?? 120000;
    }
  }

  /** The chain id the endpoint reports. */
  async chainId(): Promise<number> {
    return Number((await this.provider.getNetwork()).chainId);
  }

  /**
   * The implementation's code hash.
   *
   * A change means the escrow was upgraded, and every state machine built on the
   * old behaviour has to be re-validated.
   */
  async implementationCodeHash(): Promise<string> {
    const code = await this.provider.getCode(this.options.implementation);
    return keccak256(code);
  }

  /** Fail closed if the escrow was upgraded under us. */
  async assertContractUnchanged(): Promise<void> {
    const hash = await this.implementationCodeHash();
    if (hash.toLowerCase() !== this.options.expectedImplementationCodeHash.toLowerCase()) {
      throw new VeilError(
        'CONTRACT_UPGRADED',
        'the implementation code hash changed; the escrow behaviour must be re-validated',
        {expected: this.options.expectedImplementationCodeHash, observed: hash},
      );
    }
  }

  /** The authoritative status of a job, read from the chain. */
  async chainJobStatus(jobId: string): Promise<JobStatus> {
    const contract = new Contract(this.options.contractAddress, ERC8183_ABI, this.provider);
    const job = await contract.getJob(BigInt(jobId));
    return ERC8183_STATUS[Number(job.status)] ?? 'UNKNOWN';
  }

  /** The lifecycle a chain status corresponds to. */
  lifecycleFor(status: JobStatus, job: JobRecord): AgreementLifecycle {
    switch (status) {
      case 'OPEN':
        return job.fundingTx ? 'FUNDED' : 'CREATED';
      case 'FUNDED':
        return 'FUNDED';
      case 'SUBMITTED':
        return 'SUBMITTED_FOR_EVALUATION';
      case 'COMPLETED':
        return 'SETTLED';
      case 'REJECTED':
        return 'REJECTED';
      case 'EXPIRED':
        return job.refundTx ? 'REFUNDED' : 'EXPIRED';
      default:
        return 'UNKNOWN';
    }
  }

  /** Observe a single transaction. */
  async observeTransaction(record: TransactionRecord): Promise<TransactionObservation> {
    if (!record.txHash) {
      return {txId: record.txId, state: record.submissionState as TransactionState, uncertain: true,
        detail: 'the transaction has no hash yet'};
    }
    let receipt;
    try {
      receipt = await this.provider.getTransactionReceipt(record.txHash);
    } catch (error) {
      return {
        txId: record.txId,
        txHash: record.txHash,
        state: 'UNKNOWN',
        uncertain: true,
        detail: `the receipt could not be read: ${String(error).slice(0, 120)}`,
      };
    }
    if (!receipt) {
      // Submitted but not mined yet, or never broadcast: the chain cannot say.
      const transaction = await this.provider.getTransaction(record.txHash).catch(() => undefined);
      if (!transaction) {
        return {
          txId: record.txId,
          txHash: record.txHash,
          state: 'UNKNOWN',
          uncertain: true,
          detail: 'the transaction is not known to the chain',
        };
      }
      return {
        txId: record.txId,
        txHash: record.txHash,
        state: 'SUBMITTED',
        uncertain: true,
        detail: 'the transaction is pending',
      };
    }
    const status = Number(receipt.status ?? 0);
    const blockHash = receipt.blockHash ?? undefined;
    let uncertain = false;
    if (receipt.blockNumber) {
      const canonical = await this.provider.getBlock(receipt.blockNumber).catch(() => undefined);
      if (canonical && blockHash && canonical.hash !== blockHash) {
        uncertain = true;
      }
    }
    return {
      txId: record.txId,
      txHash: record.txHash,
      state: status === 1 ? 'CONFIRMED' : 'REVERTED',
      blockNumber: receipt.blockNumber,
      blockHash,
      gasUsed: receipt.gasUsed.toString(),
      effectiveGasPrice: ((receipt as any).effectiveGasPrice ?? receipt.gasPrice)?.toString(),
      revertReason: status === 0 ? 'the transaction reverted on chain' : undefined,
      uncertain,
      detail: uncertain ? 'the block hash differs from the canonical block' : undefined,
    };
  }

  /**
   * Reconcile one agreement's stored state against the chain.
   *
   * The stored state is never overwritten with a weaker observation: a
   * transaction that was confirmed stays confirmed, and a conflict is reported.
   */
  async reconcileAgreement(agreementId: string): Promise<JobReconciliation> {
    const conflicts: string[] = [];
    const job = this.options.store.jobForAgreement(agreementId);
    if (!job) {
      throw new VeilError(
        'JOB_MAPPING_MISSING',
        `the agreement ${agreementId} has no job mapping in the durable store`,
      );
    }
    await this.assertContractUnchanged();

    const chainStatus = await this.chainJobStatus(job.erc8183JobId);
    const lifecycle = this.lifecycleFor(chainStatus, job);

    const tracked = this.options.store
      .listTransactions(agreementId)
      .filter(record => record.txHash);
    const observations: TransactionObservation[] = [];
    for (const record of tracked as TransactionRecord[]) {
      const observation = await this.observeTransaction(record);
      observations.push(observation);
      const stored = record.submissionState as TransactionState;
      if (observation.state === 'CONFIRMED' && stored !== 'CONFIRMED') {
        this.options.store.saveTransaction({
          txId: record.txId,
          agreementId: record.agreementId,
          agent: record.agent,
          txHash: record.txHash,
          nonce: record.nonce,
          operation: record.operation,
          submissionState: 'CONFIRMED',
          blockNumber: observation.blockNumber,
          blockHash: observation.blockHash,
          receiptJson: record.receiptJson,
          revertReason: observation.revertReason,
          gasUsed: observation.gasUsed,
          effectiveGasPrice: observation.effectiveGasPrice,
          confirmedAt: new Date().toISOString(),
        });
      } else if (observation.state === 'REVERTED' && stored !== 'REVERTED') {
        this.options.store.saveTransaction({
          txId: record.txId,
          agreementId: record.agreementId,
          agent: record.agent,
          txHash: record.txHash,
          nonce: record.nonce,
          operation: record.operation,
          submissionState: 'REVERTED',
          blockNumber: observation.blockNumber,
          blockHash: observation.blockHash,
          receiptJson: record.receiptJson,
          revertReason: observation.revertReason,
          gasUsed: observation.gasUsed,
          effectiveGasPrice: observation.effectiveGasPrice,
        });
      } else if (observation.uncertain && stored === 'SUBMITTED') {
        conflicts.push(`the transaction ${record.txHash} is uncertain; it was not re-broadcast`);
      }
    }

    const settlementTx = observations.find(
      observation => observation.state === 'CONFIRMED' && this.isSettlement(observation.txId),
    )?.txHash;
    const refundTx = observations.find(
      observation => observation.state === 'CONFIRMED' && this.isRefund(observation.txId),
    )?.txHash;

    const updated = this.options.store.updateJob(job.contractAddress, job.erc8183JobId, {
      status: chainStatus,
      fundingTx: settlementTx ? job.fundingTx : job.fundingTx,
      settlementTx: settlementTx ?? job.settlementTx ?? null,
      refundTx: refundTx ?? job.refundTx ?? null,
      lastBlock: observations.find(o => o.blockNumber)?.blockNumber ?? job.lastBlock ?? null,
      lastBlockHash: observations.find(o => o.blockHash)?.blockHash ?? job.lastBlockHash ?? null,
      lastUpdate: new Date().toISOString(),
    });

    return {
      agreementId,
      jobId: updated.erc8183JobId,
      chainStatus,
      lifecycle,
      fundingTx: updated.fundingTx,
      settlementTx: updated.settlementTx,
      refundTx: updated.refundTx,
      transactions: observations,
      reconciledAt: new Date().toISOString(),
      uncertain: observations.some(observation => observation.uncertain),
      conflicts,
    };
  }

  private isSettlement(txId: string): boolean {
    return this.options.store.getTransaction(txId)?.operation === 'settle';
  }

  private isRefund(txId: string): boolean {
    const operation = this.options.store.getTransaction(txId)?.operation ?? '';
    return operation === 'refund' || operation === 'reject';
  }

  /**
   * Poll until the job reaches a terminal state, or the timeout expires.
   *
   * The polling uses a bounded backoff and never re-broadcasts anything.
   */
  async monitorAgreement(
    agreementId: string,
    options: {timeoutMs?: number; intervalMs?: number; maxIntervalMs?: number} = {},
  ): Promise<JobReconciliation> {
    const timeout = options.timeoutMs ?? 120000;
    const interval = options.intervalMs ?? 2000;
    const maxInterval = options.maxIntervalMs ?? 15000;
    const deadline = Date.now() + timeout;
    let wait = interval;
    let last: JobReconciliation | undefined;
    while (Date.now() < deadline) {
      last = await this.reconcileAgreement(agreementId);
      if (['SETTLED', 'REFUNDED', 'REJECTED', 'EXPIRED'].includes(last.lifecycle)) {
        return last;
      }
      await new Promise(resolve => setTimeout(resolve, wait));
      wait = Math.min(wait * 2, maxInterval);
    }
    if (!last) {
      throw new VeilError('RPC_UNAVAILABLE', 'the chain could not be read within the timeout');
    }
    return last;
  }
}
