/**
 * The typed error surface of the Veil SDK.
 *
 * Every failure a developer can hit has a stable, catchable code. The codes are
 * part of the public contract of the package.
 */
export type VeilErrorCode =
  | 'UNSUPPORTED_NETWORK'
  | 'MISSING_WALLET_PERMISSION'
  | 'INSUFFICIENT_BALANCE'
  | 'AGREEMENT_EXPIRED'
  | 'INVALID_EVALUATOR'
  | 'RPC_UNAVAILABLE'
  | 'TRANSACTION_REVERTED'
  | 'DUPLICATE_SETTLEMENT'
  | 'JOB_MAPPING_MISSING'
  | 'JOB_MAPPING_CONFLICT'
  | 'DATABASE_CONFLICT'
  | 'DATABASE_UNAVAILABLE'
  | 'CORRUPT_RECORD'
  | 'CONTRACT_UPGRADED'
  | 'CONFIDENTIAL_EXECUTION_UNAVAILABLE'
  | 'UNKNOWN_TRANSACTION'
  | 'INVALID_ARGUMENT';

export class VeilError extends Error {
  constructor(readonly code: VeilErrorCode, message: string, readonly detail?: Record<string, unknown>) {
    super(`${code}: ${message}`);
    this.name = 'VeilError';
  }
}

export function isVeilError(error: unknown, code?: VeilErrorCode): error is VeilError {
  return error instanceof VeilError && (code === undefined || error.code === code);
}
