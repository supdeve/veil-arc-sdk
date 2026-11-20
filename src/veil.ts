/**
 * The developer-facing API.
 *
 * An earlier friction report measured eight configuration values, a hand-built
 * key binding and no first-class way to fund a job. This module removes all
 * three:
 *
 *   const veil = await Veil.connect({network: 'arc-testnet', wallet});
 *   const agreement = await veil.createAgreement({
 *     counterparty, amount: '0.10', terms,
 *   });
 *   await agreement.accept();
 *   await agreement.fund();
 *   const status = await agreement.status();
 *
 * The backend stays neutral: the escrow's rules are applied by a versioned
 * preflight, and the chain remains the authority for the payment state.
 */
import {Contract, JsonRpcProvider, Wallet, type Signer} from 'ethers';

import {VeilError, VeilStore} from './index.js';
import {SettlementMonitor} from './monitor.js';
import {ERC8183_DEPLOYED_ABI} from './erc8183.js';
import {
  ARC_TESTNET_ERC8183,
  formatUsdcUnits,
  parseUsdcUnits,
  preflightJob,
  type Erc8183Deployment,
} from './rules.js';
import {ArcTransport} from './transport.js';
import {
  AgentDirectory,
  commitmentOf,
  sealFor,
  type AgentIdentity,
} from './sealing.js';

export const NETWORKS: Record<string, Erc8183Deployment> = {
  'arc-testnet': ARC_TESTNET_ERC8183,
};

export interface ConnectOptions {
  /** The network name; "arc-testnet" is the only supported one today. */
  readonly network: string;
  /** The agent's own wallet. It is never stored. */
  readonly wallet: Signer;
  /** The agent's own encryption key pair. Neither part is ever stored. */
  readonly encryptionKey?: CryptoKey;
  /** The agent's public encryption key, when the private key stays elsewhere. */
  readonly encryptionPublicKey?: CryptoKey;
  /** The agent's public identity. */
  readonly identity?: AgentIdentity;
  /** The counterparty's identity, needed to seal an agreement. */
  readonly counterparty?: AgentIdentity;
  /** A directory of public keys, when the counterparty is not passed inline. */
  readonly directory?: AgentDirectory;
  /** The RPC endpoint; the default is the public one. */
  readonly rpcUrl?: string;
  /** Where the durable store lives; the default is "./data/veil.sqlite". */
  readonly storePath?: string;
  /** The store, when the caller already has one. */
  readonly store?: VeilStore;
  /** The evaluator's identity; only it may settle or reject. */
  readonly evaluator?: AgentIdentity;
}

export interface CreateAgreementInput {
  readonly counterparty: AgentIdentity;
  readonly amount: string;
  readonly terms: string;
  readonly asset?: string;
  readonly deadlineSeconds?: number;
  readonly agreementId?: string;
}

export interface AgreementStatus {
  readonly agreementId: string;
  readonly jobId?: string;
  readonly lifecycle: string;
  readonly chainStatus: string;
  readonly amount: string;
  readonly uncertain: boolean;
  readonly settlementTx?: string;
  readonly refundTx?: string;
  readonly updatedAt: string;
}

export interface OperationOutcome {
  readonly operation: string;
  readonly txHash?: string;
  readonly state: string;
  readonly jobId?: string;
  readonly gasUsed?: string;
  readonly note?: string;
}

export class Veil {
  private constructor(
    private readonly options: ConnectOptions & {
      deployment: Erc8183Deployment;
      store: VeilStore;
      monitor: SettlementMonitor;
      provider: JsonRpcProvider;
      transport: ArcTransport;
      contract: Contract;
    },
  ) {}

  /** Connect an agent to a network. */
  static async connect(options: ConnectOptions): Promise<Veil> {
    const deployment = NETWORKS[options.network];
    if (!deployment) {
      throw new VeilError('UNSUPPORTED_NETWORK', `the network ${options.network} is not supported`, {
        supported: Object.keys(NETWORKS),
      });
    }
    const rpcUrl = options.rpcUrl ?? 'https://rpc.testnet.arc.io';
    const provider = new JsonRpcProvider(rpcUrl, {
      chainId: deployment.chainId,
      name: options.network,
    });
    const store = options.store ?? VeilStore.open(options.storePath ?? './data/veil.sqlite');
    const monitor = new SettlementMonitor({
      rpcUrl,
      chainId: deployment.chainId,
      contractAddress: deployment.contractAddress,
      implementation: deployment.implementation,
      expectedImplementationCodeHash: deployment.implementationCodeHash,
      abi: ERC8183_DEPLOYED_ABI,
      store,
    });
    const contract = new Contract(deployment.contractAddress, ERC8183_DEPLOYED_ABI, options.wallet);
    const transport = new ArcTransport({url: rpcUrl, chainId: deployment.chainId});
    return new Veil({
      ...options,
      deployment,
      store,
      monitor,
      provider,
      transport,
      contract,
    });
  }

  /** The published privacy classification of this network. */
  privacyCapabilities() {
    return {
      agreementContent: 'ENCRYPTED' as const,
      deliverableContent: 'ENCRYPTED' as const,
      settlementAmount: 'PUBLIC' as const,
      walletRelationships: 'PUBLIC' as const,
      transactionMetadata: 'PUBLIC' as const,
      confidentialExecution: 'UNAVAILABLE' as const,
    };
  }

  /** The agent's own address. */
  async address(): Promise<string> {
    return this.options.wallet.getAddress();
  }

  /** The USDC balance of the agent, in decimal units. */
  async balance(): Promise<string> {
    const address = await this.options.wallet.getAddress();
    const asset = new Contract(
      this.options.deployment.assetAddress,
      ['function balanceOf(address) view returns (uint256)'],
      this.options.provider,
    );
    const units = BigInt(await asset.balanceOf(address));
    return formatUsdcUnits(units, this.options.deployment.assetDecimals);
  }

  /** Create an encrypted bilateral agreement and its on-chain job. */
  async createAgreement(input: CreateAgreementInput): Promise<VeilAgreement> {
    const callerAddress = await this.options.wallet.getAddress();
    const publicEncryptionKey = this.options.encryptionPublicKey ?? this.options.encryptionKey;
    if (!publicEncryptionKey) {
      throw new VeilError('INVALID_ARGUMENT', 'the agent must provide its encryption key to seal an agreement');
    }
    const counterparty = input.counterparty;
    const sealed = await sealFor({
      terms: input.terms,
      caller: {
        signer: this.options.wallet,
        publicKey: publicEncryptionKey,
      },
      counterparty,
    });

    const amountUnits = parseUsdcUnits(input.amount, this.options.deployment.assetDecimals);
    const deadlineSeconds = input.deadlineSeconds ?? 3600;
    const expiredAt = Math.floor(Date.now() / 1000) + deadlineSeconds;
    const preflight = preflightJob({
      deployment: this.options.deployment,
      description: '',
      expiredAt,
      amountUnits,
      assetAddress: this.options.deployment.assetAddress,
      actingAgent: callerAddress,
      evaluator: this.options.evaluator?.address ?? callerAddress,
      operation: 'CREATE',
    });
    if (!preflight.ok) {
      throw new VeilError('INVALID_ARGUMENT', preflight.messages.join('; '), {
        violations: preflight.violations,
      });
    }

    const agreementId = input.agreementId ?? `0x${sealed.commitment.slice(0, 64).padEnd(64, '0')}`;
    const record = this.options.store.saveAgreement({
      agreementId,
      network: this.options.network,
      chainId: this.options.deployment.chainId,
      buyerIdentity: callerAddress,
      providerIdentity: counterparty.address,
      evaluatorIdentity: this.options.evaluator?.address ?? counterparty.address,
      ciphertextRef: sealed.ciphertextRef,
      ciphertextCommitment: sealed.commitment,
      creationState: 'CREATED',
      acceptanceState: 'PENDING',
      assetAddress: this.options.deployment.assetAddress,
      assetAmount: amountUnits.toString(),
      deadline: expiredAt,
      schemaVersion: 1,
    });
    return new VeilAgreement(this, record, {
      counterparty,
      amountUnits,
      expiredAt,
      sealed,
    });
  }

  /** Recover an existing job after a restart, from the chain alone. */
  async recover(agreementId: string): Promise<VeilAgreement> {
    const record = this.options.store.getAgreement(agreementId);
    if (!record) {
      throw new VeilError('JOB_MAPPING_MISSING', `the agreement ${agreementId} is not in the store`);
    }
    const job = this.options.store.jobForAgreement(agreementId);
    if (!job) {
      throw new VeilError('JOB_MAPPING_MISSING', `the agreement ${agreementId} has no job mapping`);
    }
    return new VeilAgreement(this, record, {
      counterparty: undefined,
      amountUnits: BigInt(record.assetAmount),
      expiredAt: record.deadline,
      sealed: undefined,
    });
  }

  /** The durable store, for a developer who wants to inspect it. */
  get store(): VeilStore {
    return this.options.store;
  }

  /** The settlement monitor. */
  get monitor(): SettlementMonitor {
    return this.options.monitor;
  }

  /** The deployment the SDK is talking to. */
  get deployment(): Erc8183Deployment {
    return this.options.deployment;
  }

  /** The agent's own wallet. */
  get wallet(): Signer {
    return this.options.wallet;
  }

  /** The escrow contract, bound to the agent's wallet. */
  get contract(): Contract {
    return this.options.contract;
  }

  /** The chain provider the SDK uses. */
  get provider(): JsonRpcProvider {
    return this.options.provider;
  }

  close(): void {
    this.options.store.close();
  }
}

export class VeilAgreement {
  constructor(
    private readonly veil: Veil,
    private readonly record: {agreementId: string; assetAmount: string; deadline: number},
    private readonly context: {
      counterparty?: AgentIdentity;
      amountUnits: bigint;
      expiredAt: number;
      sealed?: {envelope: string; commitment: string; ciphertextRef: string};
    },
  ) {}

  get agreementId(): string {
    return this.record.agreementId;
  }

  /** The commitment the store keeps; the public binding of the sealed terms. */
  get commitment(): string {
    return this.veil.store.getAgreement(this.record.agreementId)?.ciphertextCommitment ?? '';
  }

  /** The provider accepts by setting the budget. */
  async accept(): Promise<OperationOutcome> {
    const provider = this.context.counterparty;
    if (!provider) {
      throw new VeilError('INVALID_ARGUMENT', 'the counterparty identity is needed to accept');
    }
    const jobId = this.veil.store.jobForAgreement(this.record.agreementId)?.erc8183JobId;
    if (!jobId) {
      throw new VeilError('JOB_MAPPING_MISSING', 'the agreement has no job yet');
    }
    const txId = `accept-${jobId}`;
    this.veil.store.saveTransaction({
      txId,
      agreementId: this.record.agreementId,
      agent: provider.address,
      operation: 'accept',
      submissionState: 'PREPARED',
    });
    const tx = await this.veil.contract.setBudget(BigInt(jobId), this.context.amountUnits);
    const receipt = await tx.wait();
    this.veil.store.saveTransaction({
      txId,
      agreementId: this.record.agreementId,
      agent: provider.address,
      txHash: receipt?.hash,
      operation: 'accept',
      submissionState: receipt?.status === 1 ? 'CONFIRMED' : 'REVERTED',
      blockNumber: receipt?.blockNumber,
      gasUsed: receipt?.gasUsed?.toString(),
      confirmedAt: new Date().toISOString(),
    });
    return {
      operation: 'accept',
      txHash: receipt?.hash,
      state: receipt?.status === 1 ? 'CONFIRMED' : 'REVERTED',
      jobId,
      gasUsed: receipt?.gasUsed?.toString(),
    };
  }

  /**
   * Fund the job.
   *
   * The helper verifies the balance, sets an **exact** allowance, estimates the
   * gas, submits, confirms the receipt and updates the job state. A repeated
   * call is refused rather than funded twice.
   */
  async fund(): Promise<OperationOutcome> {
    const address = await this.veil.wallet.getAddress();
    const jobId = this.veil.store.jobForAgreement(this.record.agreementId)?.erc8183JobId;
    if (!jobId) {
      throw new VeilError('JOB_MAPPING_MISSING', 'the agreement has no job yet');
    }
    const job = this.veil.store.jobForAgreement(this.record.agreementId)!;
    if (job.fundingTx) {
      throw new VeilError('DUPLICATE_SETTLEMENT', 'the job was already funded', {fundingTx: job.fundingTx});
    }
    const asset = new Contract(
      this.veil.deployment.assetAddress,
      ['function balanceOf(address) view returns (uint256)', 'function allowance(address,address) view returns (uint256)'],
      this.veil.provider,
    );
    const balance = BigInt(await asset.balanceOf(address));
    if (balance < this.context.amountUnits) {
      throw new VeilError(
        'INSUFFICIENT_BALANCE',
        `the agent holds ${formatUsdcUnits(balance, this.veil.deployment.assetDecimals)} USDC; the job needs ${formatUsdcUnits(this.context.amountUnits, this.veil.deployment.assetDecimals)}`,
      );
    }
    const allowance = BigInt(await asset.allowance(address, this.veil.deployment.contractAddress));
    const txId = `fund-${jobId}`;
    this.veil.store.saveTransaction({
      txId,
      agreementId: this.record.agreementId,
      agent: address,
      operation: 'fund',
      submissionState: 'PREPARED',
    });
    if (allowance < this.context.amountUnits) {
      const approval = await (await asset as any).approve(
        this.veil.deployment.contractAddress,
        this.context.amountUnits,
      );
      await approval.wait();
    }
    const tx = await this.veil.contract.fund(BigInt(jobId), '0x');
    const receipt = await tx.wait();
    this.veil.store.saveTransaction({
      txId,
      agreementId: this.record.agreementId,
      agent: address,
      txHash: receipt?.hash,
      operation: 'fund',
      submissionState: receipt?.status === 1 ? 'CONFIRMED' : 'REVERTED',
      blockNumber: receipt?.blockNumber,
      gasUsed: receipt?.gasUsed?.toString(),
      confirmedAt: new Date().toISOString(),
    });
    if (receipt?.status === 1) {
      this.veil.store.updateJob(this.veil.deployment.contractAddress, jobId, {
        fundingTx: receipt.hash,
        status: 'FUNDED',
      });
    }
    return {
      operation: 'fund',
      txHash: receipt?.hash,
      state: receipt?.status === 1 ? 'CONFIRMED' : 'REVERTED',
      jobId,
      gasUsed: receipt?.gasUsed?.toString(),
    };
  }

  /** The authoritative status of the agreement. */
  async status(): Promise<AgreementStatus> {
    const reconciliation = await this.veil.monitor.reconcileAgreement(this.record.agreementId);
    return {
      agreementId: this.record.agreementId,
      jobId: reconciliation.jobId,
      lifecycle: reconciliation.lifecycle,
      chainStatus: reconciliation.chainStatus,
      amount: formatUsdcUnits(this.context.amountUnits, this.veil.deployment.assetDecimals),
      uncertain: reconciliation.uncertain,
      settlementTx: reconciliation.settlementTx,
      refundTx: reconciliation.refundTx,
      updatedAt: reconciliation.reconciledAt,
    };
  }
}

export {AgentDirectory, bindIdentity, commitmentOf, openFor, sealFor} from './sealing.js';
export type {AgentIdentity, DirectoryEntry, SealedAgreement} from './sealing.js';
export {ARC_TESTNET_ERC8183, parseUsdcUnits, formatUsdcUnits, preflightJob} from './rules.js';
export {ArcTransport} from './transport.js';
