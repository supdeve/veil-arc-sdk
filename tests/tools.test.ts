/**
 * The agent-tool interface tests.
 *
 * They pin the authorization boundary: a tool prepares, the wallet signs, and
 * nothing leaks.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {Wallet} from 'ethers';
import {generateKeyPair} from 'jose';

import {VeilTools} from '../src/tools.js';

const REQUIRED = [
  'veil_create_agreement',
  'veil_accept_agreement',
  'veil_prepare_funding',
  'veil_submit_deliverable',
  'veil_get_status',
  'veil_get_privacy_capabilities',
  'veil_recover_agreement',
];

async function harness() {
  const wallet = Wallet.createRandom();
  const keys = await generateKeyPair('RSA-OAEP-256', {extractable: true});
  const tools = new VeilTools({
    wallet,
    encryptionPublicKey: keys.publicKey,
    statusProvider: async (agreementId: string) => ({
      jobId: '193100',
      lifecycle: 'SETTLED',
      chainStatus: 'COMPLETED',
      uncertain: false,
      agreementId,
    }),
  });
  return {tools, wallet, keys};
}

test('01 the catalogue exposes every required operation', async () => {
  const {tools} = await harness();
  const names = tools.list().map(tool => tool.name);
  for (const required of REQUIRED) assert.ok(names.includes(required), `${required} is missing`);
});

test('02 no financial tool broadcasts and no read-only tool needs a wallet', async () => {
  const {tools} = await harness();
  for (const tool of tools.list()) {
    assert.equal(tool.broadcasts, false, `${tool.name} must not broadcast`);
    if (tool.readOnly) {
      assert.equal(tool.requiresWalletAddress, false, `${tool.name} must not need a wallet`);
    }
  }
});

test('03 an unknown tool is refused', async () => {
  const {tools} = await harness();
  const result = await tools.call('veil_not_a_tool', {});
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.error.code, 'UNKNOWN_TOOL');
});

test('04 an undeclared argument is refused', async () => {
  const {tools} = await harness();
  const result = await tools.call('veil_get_status', {agreementId: 'a1', secret: 'x'});
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.error.code, 'INVALID_ARGUMENT');
});

test('05 a malformed address is refused', async () => {
  const {tools} = await harness();
  const result = await tools.call('veil_prepare_funding', {
    jobId: '193100',
    amount: '0.1',
    buyerAddress: 'not-an-address',
  });
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.error.code, 'INVALID_ARGUMENT');
});

test('06 a malformed amount is refused', async () => {
  const {tools} = await harness();
  const result = await tools.call('veil_accept_agreement', {jobId: '193100', amount: '0.1000001'});
  assert.equal(result.ok, false);
});

test('07 creating an agreement returns a commitment and never the terms', async () => {
  const {tools, wallet, keys} = await harness();
  const provider = Wallet.createRandom();
  const providerKeys = await generateKeyPair('RSA-OAEP-256', {extractable: true});
  const {bindIdentity} = await import('../src/sealing.js');
  const counterparty = await bindIdentity({
    id: 'agent:provider',
    signer: provider,
    publicKey: providerKeys.publicKey,
  });
  const counterpartyKey = await crypto.subtle.importKey(
    'jwk',
    counterparty.encryptionKey,
    {name: 'RSA-OAEP', hash: 'SHA-256'},
    true,
    ['encrypt'],
  );
  const result = await tools.call('veil_create_agreement', {
    agreementId: 'agreement-1',
    counterparty: {
      id: counterparty.id,
      address: counterparty.address,
      encryptionKey: counterpartyKey,
      binding: counterparty.binding,
    },
    amount: '0.10',
    terms: 'CONFIDENTIAL RESEARCH REQUEST',
    clientAddress: wallet.address,
    providerAddress: provider.address,
    evaluatorAddress: provider.address,
    deadlineSeconds: 3600,
  });
  assert.equal(result.ok, true);
  const data = result.ok ? result.data : {};
  assert.ok(typeof data.commitment === 'string' && (data.commitment as string).length > 0);
  assert.ok(!JSON.stringify(data).includes('CONFIDENTIAL RESEARCH REQUEST'));
  assert.ok(!JSON.stringify(data).includes('privateKey'));
  void keys;
});

test('08 preparing a funding operation produces an exact allowance', async () => {
  const {tools, wallet} = await harness();
  const result = await tools.call('veil_prepare_funding', {
    jobId: '193100',
    amount: '0.10',
    buyerAddress: wallet.address,
  });
  assert.equal(result.ok, true);
  const approval = result.ok ? (result.data.approval as any) : {};
  assert.equal(approval.amount, '0.100000');
  assert.equal(approval.spender, '0x0747EEf0706327138c69792bF28Cd525089e4583');
  const serialised = JSON.stringify(result);
  assert.ok(
    !/1157920892373161954235709850086879078532699846656405640394575840079131296399|0xffff+/.test(
      serialised,
    ),
    'the approval must never carry a maximum-uint allowance',
  );
});

test('09 the read-only tools work without a wallet', async () => {
  const tools = new VeilTools({
    statusProvider: async (agreementId: string) => ({agreementId, lifecycle: 'SETTLED'}),
  });
  const capabilities = await tools.call('veil_get_privacy_capabilities', {});
  assert.equal(capabilities.ok, true);
  const status = await tools.call('veil_get_status', {agreementId: 'a1'});
  assert.equal(status.ok, true);
  const recovered = await tools.call('veil_recover_agreement', {agreementId: 'a1'});
  assert.equal(recovered.ok, true);
});

test('10 the published capabilities state the truth', async () => {
  const {tools} = await harness();
  const result = await tools.call('veil_get_privacy_capabilities', {});
  const capabilities = result.ok ? (result.data.capabilities as any) : {};
  assert.equal(capabilities.agreementContent, 'ENCRYPTED');
  assert.equal(capabilities.settlementAmount, 'PUBLIC');
  assert.equal(capabilities.confidentialExecution, 'UNAVAILABLE');
});

test('11 the MCP descriptor is well formed', async () => {
  const {tools} = await harness();
  const catalogue = tools.mcpTools();
  assert.ok(catalogue.length >= REQUIRED.length);
  for (const tool of catalogue) {
    assert.ok(tool.name.startsWith('veil_'));
    assert.ok(tool.description.length > 20);
    assert.equal(tool.inputSchema.type, 'object');
    assert.equal(tool.inputSchema.additionalProperties, false);
  }
  const response = await tools.callMcp({name: 'veil_get_privacy_capabilities', arguments: {}});
  assert.equal(response.isError, false);
  assert.ok(response.content[0].text.includes('ENCRYPTED'));
});

test('12 an agent cannot obtain another agent plaintext', async () => {
  const {tools} = await harness();
  const result = await tools.call('veil_get_status', {agreementId: 'someone-elses-agreement'});
  assert.equal(result.ok, true);
  assert.ok(!JSON.stringify(result).toLowerCase().includes('privateTerms'));
  assert.ok(!JSON.stringify(result).toLowerCase().includes('terms'));
});
