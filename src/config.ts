/**
 * The Arc Testnet configuration and the ERC-8183 ABI.
 *
 * Every value here is taken from an authoritative source: the Arc documentation
 * (the contract-addresses reference, the EVM-differences reference and the
 * ERC-8183 quickstart) or from a live read-only probe of the deployed
 * reference contract. Nothing is guessed.
 */
import {id as keccakId} from 'ethers';

export const ARC_TESTNET = {
  name: 'Arc Testnet',
  chainId: 5042002,
  rpc: 'https://rpc.testnet.arc.io',
  explorer: 'https://explorer.testnet.arc.io',
  faucet: 'https://faucet.circle.com',
  /** USDC is the gas asset; the ERC-20 interface uses 6 decimals. */
  gasAsset: 'USDC',
} as const;

/** The optional ERC-20 interface of the native USDC balance (6 decimals). */
export const USDC_ERC20 = '0x3600000000000000000000000000000000000000';
export const USDC_ERC20_DECIMALS = 6;
/** The native USDC balance uses 18 decimals; the two interfaces share one balance. */
export const USDC_NATIVE_DECIMALS = 18;
export const USDC_DECIMAL_FACTOR = 10n ** BigInt(USDC_NATIVE_DECIMALS - USDC_ERC20_DECIMALS);

/** The AgenticCommerce reference implementation (ERC-8183) on Arc Testnet. */
export const ERC8183_REFERENCE = '0x0747EEf0706327138c69792bF28Cd525089e4583';

/** The virtual address that emits the USDC transfer logs (it has no code). */
export const ARC_SYSTEM_EMITTER = '0xfffffffffffffffffffffffffffffffffffffffe';

export const ERC8183_STATUS = [
  'Open',
  'Funded',
  'Submitted',
  'Completed',
  'Rejected',
  'Expired',
] as const;

export type Erc8183Status = (typeof ERC8183_STATUS)[number];

export const ERC8183_ABI = [
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

export const ERC8183_SELECTORS = {
  createJob: keccakId('createJob(address,address,uint256,string,address)').slice(0, 10),
  setBudget: keccakId('setBudget(uint256,uint256,bytes)').slice(0, 10),
  fund: keccakId('fund(uint256,bytes)').slice(0, 10),
  submit: keccakId('submit(uint256,bytes32,bytes)').slice(0, 10),
  complete: keccakId('complete(uint256,bytes32,bytes)').slice(0, 10),
  getJob: keccakId('getJob(uint256)').slice(0, 10),
} as const;

export const ERC20_ABI = [
  {
    type: 'function',
    name: 'approve',
    stateMutability: 'nonpayable',
    inputs: [
      {name: 'spender', type: 'address'},
      {name: 'amount', type: 'uint256'},
    ],
    outputs: [{name: '', type: 'bool'}],
  },
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{name: 'account', type: 'address'}],
    outputs: [{name: '', type: 'uint256'}],
  },
  {
    type: 'function',
    name: 'allowance',
    stateMutability: 'view',
    inputs: [
      {name: 'owner', type: 'address'},
      {name: 'spender', type: 'address'},
    ],
    outputs: [{name: '', type: 'uint256'}],
  },
  {
    type: 'function',
    name: 'decimals',
    stateMutability: 'view',
    inputs: [],
    outputs: [{name: '', type: 'uint8'}],
  },
  {
    type: 'function',
    name: 'transfer',
    stateMutability: 'nonpayable',
    inputs: [
      {name: 'to', type: 'address'},
      {name: 'amount', type: 'uint256'},
    ],
    outputs: [{name: '', type: 'bool'}],
  },
] as const;

/**
 * The privacy capabilities Veil exposes through the SDK.
 *
 * The application layer keeps the agreement content and the deliverable
 * encrypted; the settlement amount, the wallet relationship, the transaction
 * metadata and the public contract state are visible on a public EVM.
 */
export const ARC_PRIVACY_CAPABILITIES = {
  agreementContent: 'ENCRYPTED',
  deliverableContent: 'ENCRYPTED',
  settlementAmount: 'PUBLIC',
  walletRelationships: 'PUBLIC',
  transactionMetadata: 'PUBLIC',
  confidentialExecution: 'UNAVAILABLE',
} as const;

/** Convert an ERC-20 (6 decimals) amount into the native (18 decimals) scale. */
export function toNativeScale(erc20Amount: bigint): bigint {
  return erc20Amount * USDC_DECIMAL_FACTOR;
}

/** Convert a native (18 decimals) amount into the ERC-20 (6 decimals) scale. */
export function toErc20Scale(nativeAmount: bigint): bigint {
  return nativeAmount / USDC_DECIMAL_FACTOR;
}

/** Parse a decimal USDC string into ERC-20 units, without floating point. */
export function parseUsdc(amount: string): bigint {
  const [whole, fraction = ''] = amount.trim().split('.');
  if (!/^\d+$/.test(whole)) throw new Error(`invalid USDC amount: ${amount}`);
  if (fraction.length > USDC_ERC20_DECIMALS) {
    throw new Error(`USDC amount has more than ${USDC_ERC20_DECIMALS} decimals: ${amount}`);
  }
  return BigInt(whole) * 10n ** BigInt(USDC_ERC20_DECIMALS) + BigInt((fraction + '0'.repeat(USDC_ERC20_DECIMALS)).slice(0, USDC_ERC20_DECIMALS) || '0');
}

/** Format ERC-20 units as a decimal USDC string. */
export function formatUsdc(units: bigint): string {
  const whole = units / 10n ** BigInt(USDC_ERC20_DECIMALS);
  const fraction = (units % 10n ** BigInt(USDC_ERC20_DECIMALS)).toString().padStart(USDC_ERC20_DECIMALS, '0');
  return `${whole}.${fraction}`;
}
