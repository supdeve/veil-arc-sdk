/**
 * A minimal Veil agent.
 *
 * It shows the whole developer surface:
 *
 *   1. connect an agent wallet to Arc Testnet;
 *   2. recover an existing agreement and read its authoritative status;
 *   3. create an encrypted bilateral agreement with a counterparty;
 *   4. (optionally) accept, fund and monitor it.
 *
 * Everything the agent needs is in its own environment:
 *
 *   AGENT_PRIVATE_KEY        the agent's wallet key            (never stored by Veil)
 *   AGENT_ENCRYPTION_KEY     the agent's encryption key pair, as JWK
 *   COUNTERPARTY_DIRECTORY   a JSON file of the counterparty's public keys
 *   AGENT_IDENTITY           the agent's public identifier
 *
 * The example runs read-only unless `--write` is passed, because a funding
 * transaction needs test USDC that only the developer can obtain.
 */
import {readFileSync, existsSync, mkdirSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

import {Wallet, JsonRpcProvider} from 'ethers';
import {generateKeyPair, importJWK, exportJWK} from 'jose';

import {Veil, AgentDirectory, bindIdentity, parseUsdcUnits} from '@veil/arc-sdk';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const write = args.includes('--write');
const jobId = (args.find(argument => argument.startsWith('--job=')) ?? '').split('=')[1];

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

async function main(): Promise<void> {
  const started = Date.now();
  const marks: Record<string, number> = {};

  // 1. the agent's own credentials
  const wallet = new Wallet(requireEnv('AGENT_PRIVATE_KEY'));
  const provider = new JsonRpcProvider(process.env.ARC_RPC ?? 'https://rpc.testnet.arc.io', {
    chainId: 5042002,
    name: 'arc-testnet',
  });
  const encryptionKey = await importJWK(JSON.parse(requireEnv('AGENT_ENCRYPTION_KEY')), 'RSA-OAEP-256');
  const encryptionPublic = await crypto.subtle.importKey(
    'jwk',
    await exportJWK(encryptionKey),
    {name: 'RSA-OAEP', hash: 'SHA-256'},
    true,
    ['encrypt'],
  );
  marks.credentialsReady = Date.now() - started;

  // 2. the counterparty's public directory
  const directoryPath = process.env.COUNTERPARTY_DIRECTORY ?? join(here, 'counterparties.json');
  const directory = existsSync(directoryPath)
    ? AgentDirectory.fromJson(JSON.parse(readFileSync(directoryPath, 'utf8')))
    : new AgentDirectory();
  marks.directoryReady = Date.now() - started;

  // 3. connect: two configuration values
  const veil = await Veil.connect({
    network: 'arc-testnet',
    wallet,
    encryptionPublicKey: encryptionPublic,
    rpcUrl: process.env.ARC_RPC ?? 'https://rpc.testnet.arc.io',
    storePath: process.env.VEIL_STORE ?? join(here, 'data', 'veil.sqlite'),
    evaluator: undefined,
  });
  marks.connected = Date.now() - started;
  console.log('the agent connected:', await veil.address());
  console.log('the agent holds', await veil.balance(), 'USDC');
  console.log('the privacy classification:', JSON.stringify(veil.privacyCapabilities()));

  // 4. read-only recovery of an existing job
  if (jobId) {
    const agreementId = process.env.AGREEMENT_ID;
    if (!agreementId) throw new Error('--job= needs AGREEMENT_ID in the environment');
    const agreement = await veil.recover(agreementId);
    const status = await agreement.status();
    console.log('recovered job', jobId, '->', status.lifecycle, status.chainStatus);
    console.log('onboarding marks (ms):', JSON.stringify(marks));
    return;
  }

  // 5. create an encrypted agreement with the counterparty
  const counterpartyId = process.env.COUNTERPARTY_ID;
  if (!counterpartyId) {
    console.log('no COUNTERPARTY_ID: nothing more to do');
    console.log('onboarding marks (ms):', JSON.stringify(marks));
    return;
  }
  const counterparty = directory.get(counterpartyId);
  const agreement = await veil.createAgreement({
    counterparty: {
      id: counterparty.id,
      address: counterparty.address,
      encryptionKey: counterparty.encryptionKey as JsonWebKey,
      binding: counterparty.binding,
    },
    amount: '0.10',
    terms: 'Confidential research request: summarise the private findings of project Orion.',
    deadlineSeconds: 3600,
  });
  marks.agreementCreated = Date.now() - started;
  console.log('the encrypted agreement is', agreement.agreementId);
  console.log('its public commitment is', agreement.commitment);
  console.log('onboarding marks (ms):', JSON.stringify(marks));

  if (!write) {
    console.log('read-only run: pass --write to fund the job with test USDC');
    return;
  }

  const funded = await agreement.fund();
  marks.funded = Date.now() - started;
  console.log('funded:', funded.state, funded.txHash);
  const status = await agreement.status();
  console.log('the job is now', status.lifecycle);
  console.log('onboarding marks (ms):', JSON.stringify(marks));
}

main().catch(error => {
  console.error('the agent failed:', error?.code ?? error?.message ?? error);
  process.exitCode = 1;
});
