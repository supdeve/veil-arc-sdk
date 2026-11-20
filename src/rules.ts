/**
 * The ERC-8183 rules of the **deployed** Arc Testnet escrow.
 *
 * These constraints were measured on chain against the deployed escrow; they
 * are properties of
 * *this* deployment, not of the ERC-8183 draft. The SDK therefore applies them
 * as a versioned, locally enforced preflight so that a developer never pays
 * for a transaction that the contract would refuse.
 */

export interface Erc8183Deployment {
  readonly identifier: string;
  readonly chainId: number;
  readonly contractAddress: string;
  readonly implementation: string;
  readonly implementationCodeHash: string;
  readonly assetAddress: string;
  readonly assetDecimals: number;
  /** The minimum lifetime of a job, in seconds. */
  readonly minimumExpirySeconds: number;
  /** The job description must be empty. */
  readonly requiresEmptyDescription: boolean;
}

export const ARC_TESTNET_ERC8183: Erc8183Deployment = {
  identifier: 'arc-testnet-erc8183-5.0.0',
  chainId: 5042002,
  contractAddress: '0x0747EEf0706327138c69792bF28Cd525089e4583',
  implementation: '0xa316fd02827242d537f84730f8a37d0ba5fd351a',
  implementationCodeHash: '0x7054f89cadf92af85003313db92e9b29ef670ee2c7a20b5295cdddf66ecaa4b3',
  assetAddress: '0x3600000000000000000000000000000000000000',
  assetDecimals: 6,
  minimumExpirySeconds: 300,
  requiresEmptyDescription: true,
};

export type Erc8183Violation =
  | 'EMPTY_DESCRIPTION_REQUIRED'
  | 'EXPIRY_TOO_SHORT'
  | 'INVALID_AMOUNT'
  | 'WRONG_DENOMINATION'
  | 'EVALUATOR_REQUIRED'
  | 'DUPLICATE_OPERATION'
  | 'UNSUPPORTED_DEPLOYMENT';

export interface Erc8183Preflight {
  readonly ok: boolean;
  readonly violations: readonly Erc8183Violation[];
  readonly messages: readonly string[];
}

/** Parse a decimal USDC amount into integer ERC-20 units. */
export function parseUsdcUnits(amount: string, decimals: number): bigint {
  const trimmed = amount.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) throw new Error(`invalid amount: ${amount}`);
  const [whole, fraction = ''] = trimmed.split('.');
  if (fraction.length > decimals) {
    throw new Error(`the amount has more than ${decimals} decimals: ${amount}`);
  }
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt((fraction + '0'.repeat(decimals)).slice(0, decimals) || '0');
}

/** Render integer ERC-20 units as a decimal amount. */
export function formatUsdcUnits(units: bigint, decimals: number): string {
  const whole = units / 10n ** BigInt(decimals);
  const fraction = (units % 10n ** BigInt(decimals)).toString().padStart(decimals, '0');
  return `${whole}.${fraction}`;
}

/**
 * The local preflight.
 *
 * It runs **before** a transaction is signed, so an invalid job costs the
 * developer nothing.
 */
export function preflightJob(input: {
  readonly deployment: Erc8183Deployment;
  readonly description: string;
  readonly expiredAt: number;
  readonly amountUnits: bigint;
  readonly assetAddress: string;
  readonly actingAgent: string;
  readonly evaluator: string;
  readonly operation: 'CREATE' | 'FUND' | 'SETTLE' | 'REFUND';
  readonly now?: number;
  readonly alreadySettled?: boolean;
}): Erc8183Preflight {
  const violations: Erc8183Violation[] = [];
  const messages: string[] = [];
  const now = input.now ?? Math.floor(Date.now() / 1000);

  if (input.deployment.requiresEmptyDescription && input.description.length > 0) {
    violations.push('EMPTY_DESCRIPTION_REQUIRED');
    messages.push(
      `the deployed escrow rejects a non-empty description (0xa04b28ec); the job description must stay empty and the agreement stays off-chain`,
    );
  }
  if (input.operation === 'CREATE') {
    const lifetime = input.expiredAt - now;
    if (lifetime < input.deployment.minimumExpirySeconds) {
      violations.push('EXPIRY_TOO_SHORT');
      messages.push(
        `the deployed escrow rejects an expiry less than ${input.deployment.minimumExpirySeconds} seconds away (0xf7a0748c); ${lifetime} seconds were requested`,
      );
    }
  }
  if (input.amountUnits <= 0n) {
    violations.push('INVALID_AMOUNT');
    messages.push('the amount must be positive');
  }
  if (input.assetAddress.toLowerCase() !== input.deployment.assetAddress.toLowerCase()) {
    violations.push('WRONG_DENOMINATION');
    messages.push(
      `the escrow holds ${input.deployment.assetAddress}; ${input.assetAddress} is a different asset`,
    );
  }
  if (input.operation === 'SETTLE' && input.actingAgent !== input.evaluator) {
    violations.push('EVALUATOR_REQUIRED');
    messages.push('only the evaluator may settle or reject a job');
  }
  if (input.operation === 'SETTLE' && input.alreadySettled) {
    violations.push('DUPLICATE_OPERATION');
    messages.push('the job was already settled or refunded; the ledger refuses a second one');
  }
  return {ok: violations.length === 0, violations, messages};
}
