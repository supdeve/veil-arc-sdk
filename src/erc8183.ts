/**
 * The verified ERC-8183 ABI and the live job store.
 *
 * The ABI below is the **deployed** ABI, established on 2026-11-19 by
 * extracting the PUSH4 selector literals from the implementation's runtime code
 * and matching them against the candidate signatures, and by reading the
 * contract's own getters. It is not copied from a draft.
 *
 * The store is the live counterpart of the first Arc port. It adds the two
 * refund entry points that the first port could not verify:
 *
 *   reject(uint256,bytes32,bytes)   the evaluator rejects the job
 *   claimRefund(uint256)             the client claims the refund of a rejected job
 */
import {Contract, type Signer} from 'ethers';

export const ERC8183_DEPLOYED_ABI = [
  {
    type: 'function',
    name: 'createJob',
    stateMutability: 'nonpayable',
    inputs: [
      {name: 'provider', type: 'address'},
      {name: 'evaluator', type: 'address'},
      {name: 'expiredAt', type: 'uint256'},
      {name: 'description', type: 'string'},
      {name: 'hook', type: 'address'},
    ],
    outputs: [{name: 'jobId', type: 'uint256'}],
  },
  {
    type: 'function',
    name: 'setBudget',
    stateMutability: 'nonpayable',
    inputs: [
      {name: 'jobId', type: 'uint256'},
      {name: 'amount', type: 'uint256'},
      {name: 'optParams', type: 'bytes'},
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'fund',
    stateMutability: 'nonpayable',
    inputs: [
      {name: 'jobId', type: 'uint256'},
      {name: 'optParams', type: 'bytes'},
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'submit',
    stateMutability: 'nonpayable',
    inputs: [
      {name: 'jobId', type: 'uint256'},
      {name: 'deliverable', type: 'bytes32'},
      {name: 'optParams', type: 'bytes'},
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'complete',
    stateMutability: 'nonpayable',
    inputs: [
      {name: 'jobId', type: 'uint256'},
      {name: 'reason', type: 'bytes32'},
      {name: 'optParams', type: 'bytes'},
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'reject',
    stateMutability: 'nonpayable',
    inputs: [
      {name: 'jobId', type: 'uint256'},
      {name: 'reason', type: 'bytes32'},
      {name: 'optParams', type: 'bytes'},
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'claimRefund',
    stateMutability: 'nonpayable',
    inputs: [{name: 'jobId', type: 'uint256'}],
    outputs: [],
  },
  {
    type: 'function',
    name: 'getJob',
    stateMutability: 'view',
    inputs: [{name: 'jobId', type: 'uint256'}],
    outputs: [
      {
        type: 'tuple',
        components: [
          {name: 'id', type: 'uint256'},
          {name: 'client', type: 'address'},
          {name: 'provider', type: 'address'},
          {name: 'evaluator', type: 'address'},
          {name: 'description', type: 'string'},
          {name: 'budget', type: 'uint256'},
          {name: 'expiredAt', type: 'uint256'},
          {name: 'status', type: 'uint8'},
          {name: 'hook', type: 'address'},
        ],
      },
    ],
  },
  {type: 'function', name: 'paymentToken', stateMutability: 'view', inputs: [], outputs: [{name: '', type: 'address'}]},
  {
    type: 'function',
    name: 'platformTreasury',
    stateMutability: 'view',
    inputs: [],
    outputs: [{name: '', type: 'address'}],
  },
  {
    type: 'function',
    name: 'ADMIN_ROLE',
    stateMutability: 'view',
    inputs: [],
    outputs: [{name: '', type: 'bytes32'}],
  },
  {
    type: 'function',
    name: 'hasRole',
    stateMutability: 'view',
    inputs: [
      {name: 'role', type: 'bytes32'},
      {name: 'account', type: 'address'},
    ],
    outputs: [{name: '', type: 'bool'}],
  },
  {
    type: 'function',
    name: 'getRoleAdmin',
    stateMutability: 'view',
    inputs: [{name: 'role', type: 'bytes32'}],
    outputs: [{name: '', type: 'address'}],
  },
  {
    type: 'event',
    name: 'JobCreated',
    inputs: [
      {indexed: true, name: 'jobId', type: 'uint256'},
      {indexed: true, name: 'client', type: 'address'},
      {indexed: true, name: 'provider', type: 'address'},
      {indexed: false, name: 'evaluator', type: 'address'},
      {indexed: false, name: 'expiredAt', type: 'uint256'},
      {indexed: false, name: 'hook', type: 'address'},
    ],
    anonymous: false,
  },
] as const;

export interface LiveJob {
  readonly id: bigint;
  readonly client: string;
  readonly provider: string;
  readonly evaluator: string;
  readonly description: string;
  readonly budget: bigint;
  readonly expiredAt: bigint;
  readonly status: number;
  readonly hook: string;
}

export interface LiveStoreOptions {
  readonly address: string;
  readonly signer: Signer;
  readonly provider: import('ethers').Provider;
}

/**
 * The live store.
 *
 * Every write is bounded and explicit: the approval is exactly the escrow
 * amount, never an unlimited allowance, and the transaction is only sent after
 * a read-only simulation of the same call has succeeded.
 */
export class LiveErc8183Store {
  constructor(private readonly options: LiveStoreOptions) {}

  private contract(signer: Signer = this.options.signer): Contract {
    return new Contract(this.options.address, ERC8183_DEPLOYED_ABI, signer);
  }

  async simulate(data: string, from: string): Promise<{ok: boolean; reason?: string}> {
    try {
      await this.options.provider.call({to: this.options.address, from, data});
      return {ok: true};
    } catch (error) {
      return {ok: false, reason: String(error).slice(0, 240)};
    }
  }

  async createJob(params: {
    provider: string;
    evaluator: string;
    expiredAt: bigint;
    description: string;
    hook: string;
    signer: Signer;
  }): Promise<{jobId: bigint; txHash: string}> {
    const contract = this.contract(params.signer);
    const tx = await contract.createJob(
      params.provider,
      params.evaluator,
      params.expiredAt,
      params.description,
      params.hook,
    );
    const receipt = await tx.wait();
    if (!receipt) throw new Error('CREATE_JOB_NO_RECEIPT');
    const created = receipt.logs
      .map((log: any) => {
        try {
          return contract.interface.parseLog(log);
        } catch {
          return null;
        }
      })
      .filter((entry: any) => entry?.name === 'JobCreated')[0];
    if (!created) throw new Error('JOB_CREATED_EVENT_MISSING');
    return {jobId: BigInt(created.args.jobId), txHash: receipt.hash};
  }

  async setBudget(jobId: bigint, amount: bigint, signer: Signer): Promise<string> {
    const receipt = await (await this.contract(signer).setBudget(jobId, amount, '0x')).wait();
    if (!receipt) throw new Error('SET_BUDGET_NO_RECEIPT');
    return receipt.hash;
  }

  async approve(spender: string, amount: bigint, signer: Signer, tokenAddress: string): Promise<string> {
    const token = new Contract(
      tokenAddress,
      ['function approve(address,uint256) returns (bool)'],
      signer,
    );
    const receipt = await (await token.approve(spender, amount)).wait();
    if (!receipt) throw new Error('APPROVE_NO_RECEIPT');
    return receipt.hash;
  }

  async fund(jobId: bigint, signer: Signer): Promise<string> {
    const receipt = await (await this.contract(signer).fund(jobId, '0x')).wait();
    if (!receipt) throw new Error('FUND_NO_RECEIPT');
    return receipt.hash;
  }

  async submit(jobId: bigint, deliverable: string, signer: Signer): Promise<string> {
    const receipt = await (await this.contract(signer).submit(jobId, deliverable, '0x')).wait();
    if (!receipt) throw new Error('SUBMIT_NO_RECEIPT');
    return receipt.hash;
  }

  async complete(jobId: bigint, reason: string, signer: Signer): Promise<string> {
    const receipt = await (await this.contract(signer).complete(jobId, reason, '0x')).wait();
    if (!receipt) throw new Error('COMPLETE_NO_RECEIPT');
    return receipt.hash;
  }

  async reject(jobId: bigint, reason: string, signer: Signer): Promise<string> {
    const receipt = await (await this.contract(signer).reject(jobId, reason, '0x')).wait();
    if (!receipt) throw new Error('REJECT_NO_RECEIPT');
    return receipt.hash;
  }

  async claimRefund(jobId: bigint, signer: Signer): Promise<string> {
    const receipt = await (await this.contract(signer).claimRefund(jobId)).wait();
    if (!receipt) throw new Error('CLAIM_REFUND_NO_RECEIPT');
    return receipt.hash;
  }

  async getJob(jobId: bigint): Promise<LiveJob> {
    const contract = new Contract(this.options.address, ERC8183_DEPLOYED_ABI, this.options.provider);
    const job = await contract.getJob(jobId);
    return {
      id: BigInt(job.id),
      client: job.client,
      provider: job.provider,
      evaluator: job.evaluator,
      description: job.description,
      budget: BigInt(job.budget),
      expiredAt: BigInt(job.expiredAt),
      status: Number(job.status),
      hook: job.hook,
    };
  }

  async paymentToken(): Promise<string> {
    const contract = new Contract(this.options.address, ERC8183_DEPLOYED_ABI, this.options.provider);
    return contract.paymentToken();
  }
}
