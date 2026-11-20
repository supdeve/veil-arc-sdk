/**
 * The durable agreement, job and transaction store.
 *
 * The store is a **recoverable index**, not a financial ledger: the chain is
 * authoritative for the payment state, and the database only records what was
 * observed, where and when. It uses the Node runtime's own SQLite binding, so
 * the distributable package has no native dependency.
 *
 * What it guarantees:
 *
 *   * an agreement, its job and its transactions survive a process restart;
 *   * a public job id can never be attached to the wrong encrypted agreement
 *     (the mapping is unique and checked on write);
 *   * a conflicting or corrupt observation fails loudly instead of overwriting
 *     what was already recorded;
 *   * event provenance is tracked by (transaction hash, block hash, log index),
 *     so duplicate or out-of-order ingestion is detected.
 */
import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {mkdirSync, copyFileSync, existsSync} from 'node:fs';
import {dirname} from 'node:path';

import {VeilError} from './errors.js';

export const SCHEMA_VERSION = 1;

export const MIGRATIONS: readonly string[] = [
  `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS agreements (
    agreement_id TEXT PRIMARY KEY,
    network TEXT NOT NULL,
    chain_id INTEGER NOT NULL,
    buyer_identity TEXT NOT NULL,
    provider_identity TEXT NOT NULL,
    evaluator_identity TEXT NOT NULL,
    ciphertext_ref TEXT NOT NULL,
    ciphertext_commitment TEXT NOT NULL,
    creation_state TEXT NOT NULL,
    acceptance_state TEXT NOT NULL,
    asset_address TEXT NOT NULL,
    asset_amount TEXT NOT NULL,
    deadline INTEGER NOT NULL,
    schema_version INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS jobs (
    contract_address TEXT NOT NULL,
    erc8183_job_id TEXT NOT NULL,
    agreement_id TEXT NOT NULL UNIQUE,
    funding_tx TEXT,
    settlement_tx TEXT,
    refund_tx TEXT,
    status TEXT NOT NULL,
    last_block INTEGER,
    last_block_hash TEXT,
    last_update TEXT,
    last_reconciled_at TEXT,
    PRIMARY KEY (contract_address, erc8183_job_id),
    FOREIGN KEY (agreement_id) REFERENCES agreements(agreement_id)
  );
  CREATE TABLE IF NOT EXISTS transactions (
    tx_id TEXT PRIMARY KEY,
    agreement_id TEXT,
    agent TEXT NOT NULL,
    tx_hash TEXT,
    nonce INTEGER,
    operation TEXT NOT NULL,
    submission_state TEXT NOT NULL,
    block_number INTEGER,
    block_hash TEXT,
    log_index INTEGER,
    receipt_json TEXT,
    revert_reason TEXT,
    gas_used TEXT,
    effective_gas_price TEXT,
    confirmed_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS chain_events (
    event_key TEXT PRIMARY KEY,
    tx_hash TEXT NOT NULL,
    block_hash TEXT,
    log_index INTEGER,
    kind TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    observed_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS transactions_by_hash ON transactions(tx_hash);
  CREATE INDEX IF NOT EXISTS transactions_by_agreement ON transactions(agreement_id);
  CREATE UNIQUE INDEX IF NOT EXISTS jobs_by_agreement ON jobs(agreement_id);
  `,
];

export type CreationState = 'CREATED' | 'ACCEPTED';
export type AcceptanceState = 'PENDING' | 'ACCEPTED' | 'REJECTED';
export type JobStatus =
  | 'OPEN'
  | 'FUNDED'
  | 'SUBMITTED'
  | 'COMPLETED'
  | 'REJECTED'
  | 'EXPIRED'
  | 'UNKNOWN';
export type SubmissionState =
  | 'PREPARED'
  | 'SIGNED'
  | 'SUBMITTED'
  | 'CONFIRMED'
  | 'FAILED'
  | 'REVERTED'
  | 'UNKNOWN';

export interface AgreementRecord {
  readonly agreementId: string;
  readonly network: string;
  readonly chainId: number;
  readonly buyerIdentity: string;
  readonly providerIdentity: string;
  readonly evaluatorIdentity: string;
  readonly ciphertextRef: string;
  readonly ciphertextCommitment: string;
  readonly creationState: CreationState;
  readonly acceptanceState: AcceptanceState;
  readonly assetAddress: string;
  readonly assetAmount: string;
  readonly deadline: number;
  readonly schemaVersion: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface JobRecord {
  readonly contractAddress: string;
  readonly erc8183JobId: string;
  readonly agreementId: string;
  readonly fundingTx?: string;
  readonly settlementTx?: string;
  readonly refundTx?: string;
  readonly status: JobStatus;
  readonly lastBlock?: number;
  readonly lastBlockHash?: string;
  readonly lastUpdate?: string;
  readonly lastReconciledAt?: string;
}

export interface TransactionRecord {
  readonly txId: string;
  readonly agreementId?: string;
  readonly agent: string;
  readonly txHash?: string;
  readonly nonce?: number;
  readonly operation: string;
  readonly submissionState: SubmissionState;
  readonly blockNumber?: number;
  readonly blockHash?: string;
  readonly logIndex?: number;
  readonly receiptJson?: string;
  readonly revertReason?: string;
  readonly gasUsed?: string;
  readonly effectiveGasPrice?: string;
  readonly confirmedAt?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ChainEventRecord {
  readonly eventKey: string;
  readonly txHash: string;
  readonly blockHash?: string;
  readonly logIndex?: number;
  readonly kind: string;
  readonly payloadJson: string;
  readonly observedAt: string;
}

const now = (): string => new Date().toISOString();

export class VeilStore {
  private constructor(private readonly db: DatabaseSync, readonly path: string) {}

  /** Open (and migrate) the store at `path`. */
  static open(path: string): VeilStore {
    try {
      mkdirSync(dirname(path), {recursive: true});
      const db = new DatabaseSync(path);
      db.exec('PRAGMA journal_mode = WAL;');
      db.exec('PRAGMA foreign_keys = ON;');
      const store = new VeilStore(db, path);
      store.migrate();
      return store;
    } catch (error) {
      throw new VeilError('DATABASE_UNAVAILABLE', `cannot open the store at ${path}`, {
        cause: String(error).slice(0, 200),
      });
    }
  }

  /** An in-memory store, for tests. */
  static openInMemory(): VeilStore {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON;');
    const store = new VeilStore(db, ':memory:');
    store.migrate();
    return store;
  }

  private migrate(): void {
    let applied = new Set<number>();
    try {
      applied = new Set(
        (this.db.prepare('SELECT version FROM schema_migrations').all() as {version: number}[]).map(
          row => row.version,
        ),
      );
    } catch {
      // The migrations table does not exist yet: nothing has been applied.
      applied = new Set();
    }
    for (const [index, statement] of MIGRATIONS.entries()) {
      const version = index + 1;
      if (applied.has(version)) continue;
      try {
        this.db.exec('BEGIN');
        this.db.exec(statement);
        this.db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(
          version,
          now(),
        );
        this.db.exec('COMMIT');
      } catch (error) {
        this.db.exec('ROLLBACK');
        throw new VeilError('DATABASE_CONFLICT', `the migration to version ${version} failed`, {
          cause: String(error).slice(0, 200),
        });
      }
    }
  }

  /** The schema version the store is at. */
  schemaVersion(): number {
    const rows = this.db.prepare('SELECT MAX(version) AS version FROM schema_migrations').all() as {
      version: number | null;
    }[];
    return rows[0]?.version ?? 0;
  }

  // ------------------------------------------------------------------ agreements

  /** Insert or update an agreement. */
  saveAgreement(record: Omit<AgreementRecord, 'createdAt' | 'updatedAt'>): AgreementRecord {
    const timestamp = now();
    try {
      this.db
        .prepare(
          `INSERT INTO agreements (
             agreement_id, network, chain_id, buyer_identity, provider_identity, evaluator_identity,
             ciphertext_ref, ciphertext_commitment, creation_state, acceptance_state, asset_address,
             asset_amount, deadline, schema_version, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(agreement_id) DO UPDATE SET
             ciphertext_ref = excluded.ciphertext_ref,
             ciphertext_commitment = excluded.ciphertext_commitment,
             acceptance_state = excluded.acceptance_state,
             asset_amount = excluded.asset_amount,
             deadline = excluded.deadline,
             updated_at = excluded.updated_at`,
        )
        .run(
          record.agreementId,
          record.network,
          record.chainId,
          record.buyerIdentity,
          record.providerIdentity,
          record.evaluatorIdentity,
          record.ciphertextRef,
          record.ciphertextCommitment,
          record.creationState,
          record.acceptanceState,
          record.assetAddress,
          record.assetAmount,
          record.deadline,
          record.schemaVersion,
          timestamp,
          timestamp,
        );
    } catch (error) {
      throw new VeilError('DATABASE_CONFLICT', `cannot save the agreement ${record.agreementId}`, {
        cause: String(error).slice(0, 200),
      });
    }
    const stored = this.getAgreement(record.agreementId);
    if (!stored) {
      throw new VeilError('CORRUPT_RECORD', `the agreement ${record.agreementId} vanished after the write`);
    }
    return stored;
  }

  getAgreement(agreementId: string): AgreementRecord | undefined {
    const rows = this.db
      .prepare('SELECT * FROM agreements WHERE agreement_id = ?')
      .all(agreementId) as any[];
    if (!rows.length) return undefined;
    const row = rows[0];
    if (!row.agreement_id || !row.ciphertext_commitment) {
      throw new VeilError('CORRUPT_RECORD', `the agreement ${agreementId} is incomplete`);
    }
    return {
      agreementId: row.agreement_id,
      network: row.network,
      chainId: Number(row.chain_id),
      buyerIdentity: row.buyer_identity,
      providerIdentity: row.provider_identity,
      evaluatorIdentity: row.evaluator_identity,
      ciphertextRef: row.ciphertext_ref,
      ciphertextCommitment: row.ciphertext_commitment,
      creationState: row.creation_state,
      acceptanceState: row.acceptance_state,
      assetAddress: row.asset_address,
      assetAmount: row.asset_amount,
      deadline: Number(row.deadline),
      schemaVersion: Number(row.schema_version),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  listAgreements(): AgreementRecord[] {
    const rows = this.db.prepare('SELECT agreement_id FROM agreements ORDER BY created_at').all() as {
      agreement_id: string;
    }[];
    return rows.map(row => this.getAgreement(row.agreement_id)!);
  }

  // ------------------------------------------------------------------ jobs

  /**
   * Attach a public job to an agreement.
   *
   * The mapping is unique in both directions: a job id belongs to exactly one
   * agreement, and an agreement has exactly one job.
   */
  linkJob(record: {
    contractAddress: string;
    erc8183JobId: string;
    agreementId: string;
    status?: JobStatus;
  }): JobRecord {
    if (!this.getAgreement(record.agreementId)) {
      throw new VeilError(
        'JOB_MAPPING_MISSING',
        `the agreement ${record.agreementId} is not stored, so the job cannot be linked`,
      );
    }
    const existing = this.getJob(record.contractAddress, record.erc8183JobId);
    if (existing && existing.agreementId !== record.agreementId) {
      throw new VeilError(
        'JOB_MAPPING_CONFLICT',
        `the job ${record.erc8183JobId} is already bound to the agreement ${existing.agreementId}`,
        {existingAgreement: existing.agreementId, requestedAgreement: record.agreementId},
      );
    }
    const byAgreement = this.db
      .prepare('SELECT * FROM jobs WHERE agreement_id = ?')
      .all(record.agreementId) as any[];
    if (byAgreement.length && byAgreement[0].erc8183_job_id !== record.erc8183JobId) {
      throw new VeilError(
        'JOB_MAPPING_CONFLICT',
        `the agreement ${record.agreementId} is already bound to the job ${byAgreement[0].erc8183_job_id}`,
      );
    }
    try {
      this.db
        .prepare(
          `INSERT INTO jobs (
             contract_address, erc8183_job_id, agreement_id, status, last_reconciled_at
           ) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(contract_address, erc8183_job_id) DO UPDATE SET
             status = excluded.status,
             last_reconciled_at = excluded.last_reconciled_at`,
        )
        .run(
          record.contractAddress,
          record.erc8183JobId,
          record.agreementId,
          record.status ?? 'OPEN',
          now(),
        );
    } catch (error) {
      throw new VeilError('DATABASE_CONFLICT', 'the job mapping could not be written', {
        cause: String(error).slice(0, 200),
      });
    }
    return this.getJob(record.contractAddress, record.erc8183JobId)!;
  }

  getJob(contractAddress: string, erc8183JobId: string): JobRecord | undefined {
    const rows = this.db
      .prepare('SELECT * FROM jobs WHERE contract_address = ? AND erc8183_job_id = ?')
      .all(contractAddress, erc8183JobId) as any[];
    if (!rows.length) return undefined;
    const row = rows[0];
    return {
      contractAddress: row.contract_address,
      erc8183JobId: row.erc8183_job_id,
      agreementId: row.agreement_id,
      fundingTx: row.funding_tx ?? undefined,
      settlementTx: row.settlement_tx ?? undefined,
      refundTx: row.refund_tx ?? undefined,
      status: row.status,
      lastBlock: row.last_block ?? undefined,
      lastBlockHash: row.last_block_hash ?? undefined,
      lastUpdate: row.last_update ?? undefined,
      lastReconciledAt: row.last_reconciled_at ?? undefined,
    };
  }

  jobForAgreement(agreementId: string): JobRecord | undefined {
    const rows = this.db.prepare('SELECT * FROM jobs WHERE agreement_id = ?').all(agreementId) as any[];
    if (!rows.length) return undefined;
    const row = rows[0];
    return this.getJob(row.contract_address, row.erc8183_job_id);
  }

  /** Update the authoritative observations of a job. */
  updateJob(
    contractAddress: string,
    erc8183JobId: string,
    update: Partial<{
      fundingTx: string | null;
      settlementTx: string | null;
      refundTx: string | null;
      status: JobStatus;
      lastBlock: number | null;
      lastBlockHash: string | null;
      lastUpdate: string | null;
    }>,
  ): JobRecord {
    const current = this.getJob(contractAddress, erc8183JobId);
    if (!current) {
      throw new VeilError('JOB_MAPPING_MISSING', `the job ${erc8183JobId} is not stored`);
    }
    const value = (next: unknown, fallback: unknown): unknown =>
      next === undefined ? (fallback === undefined ? null : fallback) : next;
    this.db
      .prepare(
        `UPDATE jobs SET
           funding_tx = ?, settlement_tx = ?, refund_tx = ?, status = ?,
           last_block = ?, last_block_hash = ?, last_update = ?, last_reconciled_at = ?
         WHERE contract_address = ? AND erc8183_job_id = ?`,
      )
      .run(
        value(update.fundingTx, current.fundingTx) as string | null,
        value(update.settlementTx, current.settlementTx) as string | null,
        value(update.refundTx, current.refundTx) as string | null,
        value(update.status, current.status) as string,
        value(update.lastBlock, current.lastBlock) as number | null,
        value(update.lastBlockHash, current.lastBlockHash) as string | null,
        value(update.lastUpdate, current.lastUpdate) as string | null,
        now(),
        contractAddress,
        erc8183JobId,
      );
    return this.getJob(contractAddress, erc8183JobId)!;
  }

  // ------------------------------------------------------------------ transactions

  /** Record (or update) a transaction the SDK is tracking. */
  saveTransaction(record: {
    txId: string;
    agreementId?: string;
    agent: string;
    txHash?: string;
    nonce?: number;
    operation: string;
    submissionState: SubmissionState;
    blockNumber?: number;
    blockHash?: string;
    logIndex?: number;
    receiptJson?: string;
    revertReason?: string;
    gasUsed?: string;
    effectiveGasPrice?: string;
    confirmedAt?: string;
  }): TransactionRecord {
    const timestamp = now();
    const existing = this.getTransaction(record.txId);
    if (existing) {
      // A transaction never moves backwards silently: a confirmed transaction
      // that is re-reported as "submitted" is a conflict, not an update.
      if (
        existing.submissionState === 'CONFIRMED' &&
        record.submissionState !== 'CONFIRMED' &&
        record.submissionState !== 'REVERTED'
      ) {
        throw new VeilError(
          'DATABASE_CONFLICT',
          `the transaction ${record.txId} is already confirmed and cannot go back to ${record.submissionState}`,
          {stored: existing.submissionState, reported: record.submissionState},
        );
      }
      this.db
        .prepare(
          `UPDATE transactions SET tx_hash = ?, nonce = ?, submission_state = ?, block_number = ?,
             block_hash = ?, log_index = ?, receipt_json = ?, revert_reason = ?, gas_used = ?,
             effective_gas_price = ?, confirmed_at = ?, updated_at = ?
           WHERE tx_id = ?`,
        )
        .run(
          record.txHash ?? existing.txHash ?? null,
          record.nonce ?? existing.nonce ?? null,
          record.submissionState,
          record.blockNumber ?? existing.blockNumber ?? null,
          record.blockHash ?? existing.blockHash ?? null,
          record.logIndex ?? existing.logIndex ?? null,
          record.receiptJson ?? existing.receiptJson ?? null,
          record.revertReason ?? existing.revertReason ?? null,
          record.gasUsed ?? existing.gasUsed ?? null,
          record.effectiveGasPrice ?? existing.effectiveGasPrice ?? null,
          record.confirmedAt ?? existing.confirmedAt ?? null,
          timestamp,
          record.txId,
        );
    } else {
      this.db
        .prepare(
          `INSERT INTO transactions (
             tx_id, agreement_id, agent, tx_hash, nonce, operation, submission_state, block_number,
             block_hash, log_index, receipt_json, revert_reason, gas_used, effective_gas_price,
             confirmed_at, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          record.txId,
          record.agreementId ?? null,
          record.agent,
          record.txHash ?? null,
          record.nonce ?? null,
          record.operation,
          record.submissionState,
          record.blockNumber ?? null,
          record.blockHash ?? null,
          record.logIndex ?? null,
          record.receiptJson ?? null,
          record.revertReason ?? null,
          record.gasUsed ?? null,
          record.effectiveGasPrice ?? null,
          record.confirmedAt ?? null,
          timestamp,
          timestamp,
        );
    }
    return this.getTransaction(record.txId)!;
  }

  getTransaction(txId: string): TransactionRecord | undefined {
    const rows = this.db.prepare('SELECT * FROM transactions WHERE tx_id = ?').all(txId) as any[];
    if (!rows.length) return undefined;
    const row = rows[0];
    return {
      txId: row.tx_id,
      agreementId: row.agreement_id ?? undefined,
      agent: row.agent,
      txHash: row.tx_hash ?? undefined,
      nonce: row.nonce ?? undefined,
      operation: row.operation,
      submissionState: row.submission_state,
      blockNumber: row.block_number ?? undefined,
      blockHash: row.block_hash ?? undefined,
      logIndex: row.log_index ?? undefined,
      receiptJson: row.receipt_json ?? undefined,
      revertReason: row.revert_reason ?? undefined,
      gasUsed: row.gas_used ?? undefined,
      effectiveGasPrice: row.effective_gas_price ?? undefined,
      confirmedAt: row.confirmed_at ?? undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  listTransactions(agreementId?: string): TransactionRecord[] {
    const rows = agreementId
      ? (this.db
          .prepare('SELECT tx_id FROM transactions WHERE agreement_id = ? ORDER BY created_at')
          .all(agreementId) as {tx_id: string}[])
      : (this.db.prepare('SELECT tx_id FROM transactions ORDER BY created_at').all() as {tx_id: string}[]);
    return rows.map(row => this.getTransaction(row.tx_id)!);
  }

  findTransactionByHash(txHash: string): TransactionRecord | undefined {
    const rows = this.db
      .prepare('SELECT * FROM transactions WHERE tx_hash = ? ORDER BY created_at')
      .all(txHash) as any[];
    if (!rows.length) return undefined;
    return this.getTransaction(rows[0].tx_id);
  }

  // ------------------------------------------------------------------ events

  /**
   * Ingest a chain event, keyed by its provenance.
   *
   * The same event observed twice is recognised (the key is the provenance), and
   * an event that contradicts a stored one is a conflict rather than an
   * overwrite.
   */
  ingestEvent(event: {
    txHash: string;
    blockHash?: string;
    logIndex?: number;
    kind: string;
    payload: unknown;
  }): {duplicate: boolean; record: ChainEventRecord} {
    const key = `${event.txHash}:${event.blockHash ?? 'pending'}:${event.logIndex ?? 0}:${event.kind}`;
    const payloadJson = JSON.stringify(event.payload);
    const existing = this.db.prepare('SELECT * FROM chain_events WHERE event_key = ?').all(key) as any[];
    if (existing.length) {
      if (existing[0].payload_json !== payloadJson) {
        throw new VeilError(
          'DATABASE_CONFLICT',
          `the event ${key} was observed with a different payload`,
          {stored: existing[0].payload_json, observed: payloadJson},
        );
      }
      return {duplicate: true, record: this.toEvent(existing[0])};
    }
    this.db
      .prepare(
        `INSERT INTO chain_events (event_key, tx_hash, block_hash, log_index, kind, payload_json, observed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        key,
        event.txHash,
        event.blockHash ?? null,
        event.logIndex ?? null,
        event.kind,
        payloadJson,
        now(),
      );
    const row = this.db.prepare('SELECT * FROM chain_events WHERE event_key = ?').all(key)[0] as any;
    return {duplicate: false, record: this.toEvent(row)};
  }

  listEvents(): ChainEventRecord[] {
    const rows = this.db.prepare('SELECT * FROM chain_events ORDER BY observed_at').all() as any[];
    return rows.map(row => this.toEvent(row));
  }

  private toEvent(row: any): ChainEventRecord {
    return {
      eventKey: row.event_key,
      txHash: row.tx_hash,
      blockHash: row.block_hash ?? undefined,
      logIndex: row.log_index ?? undefined,
      kind: row.kind,
      payloadJson: row.payload_json,
      observedAt: row.observed_at,
    };
  }

  // ------------------------------------------------------------------ maintenance

  /** Copy the database (and its WAL) to `target`, for a backup. */
  backup(target: string): string {
    try {
      mkdirSync(dirname(target), {recursive: true});
      this.db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
      copyFileSync(this.path, target);
      return target;
    } catch (error) {
      throw new VeilError('DATABASE_UNAVAILABLE', 'the backup could not be written', {
        cause: String(error).slice(0, 200),
      });
    }
  }

  /** The number of rows per table, for the diagnostics. */
  stats(): Record<string, number> {
    const count = (table: string): number =>
      (this.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).all() as {n: number}[])[0]?.n ?? 0;
    return {
      agreements: count('agreements'),
      jobs: count('jobs'),
      transactions: count('transactions'),
      chainEvents: count('chain_events'),
    };
  }

  close(): void {
    this.db.close();
  }
}

/** The commitment Veil publishes for a sealed payload: the keccak of the envelope. */
export function commitmentOf(envelope: string): string {
  return createHash('sha256').update(envelope).digest('hex');
}
