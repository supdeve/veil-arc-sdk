/**
 * The encryption and identity helpers a developer needs, and nothing more.
 *
 * An earlier friction report on the developer experience named two gaps: the
 * developer had to construct the
 * key bindings by hand, and there was no documented way to find a
 * counterparty's public key. Both are closed here:
 *
 *   * `AgentDirectory` holds **public** keys only, in a documented format that
 *     can live in a file or behind an HTTP endpoint;
 *   * `sealFor` produces the envelope, its commitment and the reference the
 *     durable store keeps.
 *
 * The private key never leaves the agent, and the directory never holds it.
 */
import {createHash} from 'node:crypto';

import {bindKey, open, seal, type Recipient} from './privacy.js';
import {exportJWK} from 'jose';
import type {Signer} from 'ethers';

export interface AgentIdentity {
  /** A stable, public identifier, e.g. "agent:buyer". */
  readonly id: string;
  /** The agent's wallet address. */
  readonly address: string;
  /** The agent's public encryption key, as a JWK. */
  readonly encryptionKey: JsonWebKey;
  /** The agent's signature over the key binding. */
  readonly binding: string;
}

export interface DirectoryEntry {
  readonly id: string;
  readonly address: string;
  readonly encryptionKey: JsonWebKey;
  readonly binding: string;
  readonly updatedAt: string;
}

/**
 * A directory of **public** keys.
 *
 * It can be backed by a JSON file or by any object that implements the same
 * four methods; nothing here can reach a private key.
 */
export class AgentDirectory {
  private readonly entries = new Map<string, DirectoryEntry>();

  constructor(entries: DirectoryEntry[] = []) {
    for (const entry of entries) this.entries.set(entry.id, entry);
  }

  /** Load a directory from a JSON document. */
  static fromJson(document: {entries: DirectoryEntry[]}): AgentDirectory {
    return new AgentDirectory(document.entries ?? []);
  }

  /** Register (or replace) an agent's **public** key material. */
  register(identity: AgentIdentity, now = new Date().toISOString()): DirectoryEntry {
    const entry: DirectoryEntry = {
      id: identity.id,
      address: identity.address,
      encryptionKey: identity.encryptionKey,
      binding: identity.binding,
      updatedAt: now,
    };
    this.entries.set(identity.id, entry);
    return entry;
  }

  get(id: string): DirectoryEntry {
    const entry = this.entries.get(id);
    if (!entry) throw new Error(`the agent ${id} is not in the directory`);
    return entry;
  }

  list(): DirectoryEntry[] {
    return Array.from(this.entries.values());
  }

  toJson(): {entries: DirectoryEntry[]} {
    return {entries: this.list()};
  }
}

/**
 * Produce the **public** identity of an agent: its address, its public
 * encryption key and the wallet signature that binds the two.
 */
export async function bindIdentity(input: {
  readonly id: string;
  readonly signer: Signer;
  readonly publicKey: CryptoKey;
}): Promise<AgentIdentity> {
  const address = await input.signer.getAddress();
  const bound = await bindKey(input.signer, input.publicKey);
  return {
    id: input.id,
    address,
    encryptionKey: (await exportJWK(input.publicKey)) as JsonWebKey,
    binding: bound.binding,
  };
}

/** The commitment the store keeps: the keccak-like digest of the envelope. */
export function commitmentOf(envelope: string): string {
  return createHash('sha256').update(envelope).digest('hex');
}

export interface SealedAgreement {
  readonly envelope: string;
  readonly commitment: string;
  readonly ciphertextRef: string;
  readonly recipients: readonly string[];
}

/**
 * Seal the terms for exactly two agents.
 *
 * The caller's key binding is produced from the caller's **wallet signature**,
 * so a party that does not control the binding cannot be substituted.
 */
export async function sealFor(input: {
  readonly terms: string;
  readonly caller: {signer: Signer; publicKey: CryptoKey};
  readonly counterparty: AgentIdentity;
  readonly reference?: string;
}): Promise<SealedAgreement> {
  const callerBinding = await bindKey(input.caller.signer, input.caller.publicKey);
  const counterpartyKey = await crypto.subtle.importKey(
    'jwk',
    input.counterparty.encryptionKey,
    {name: 'RSA-OAEP', hash: 'SHA-256'},
    true,
    ['encrypt'],
  );
  const counterpartyBinding: Recipient = {
    wallet: input.counterparty.address,
    key: counterpartyKey,
    binding: input.counterparty.binding,
  };
  const recipients: Recipient[] = [callerBinding, counterpartyBinding];
  const envelope = await seal(input.terms, recipients);
  const serialized = JSON.stringify(envelope);
  return {
    envelope: serialized,
    commitment: commitmentOf(serialized),
    ciphertextRef: input.reference ?? `veil://agreement/${commitmentOf(serialized)}`,
    recipients: recipients.map(recipient => recipient.wallet),
  };
}

/** Open a sealed agreement with the recipient's private key. */
export async function openFor(envelope: string, privateKey: CryptoKey): Promise<string> {
  return open(JSON.parse(envelope), privateKey);
}
