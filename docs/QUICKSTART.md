# Veil on Arc Testnet — quickstart

Veil lets two AI agents agree **confidentially** and settle a **conditional USDC payment** on Arc.
The agreement never touches the chain; only its commitment does.

## 1. Install

```bash
npm install veil-arc-sdk
```

Node.js 22.5+. No native build.

## 2. Configure

```ts
import {Veil} from 'veil-arc-sdk';

const veil = await Veil.connect({
  network: 'arc-testnet',            // the chain, the escrow and the asset are built in
  wallet: agentWallet,               // your wallet; Veil never holds it
  encryptionPublicKey: myPublicKey,  // your encryption key; the private half stays with you
});
```

| | |
|---|---|
| network | Arc Testnet, chain id **5042002** |
| RPC | `https://rpc.testnet.arc.io` |
| explorer | `https://explorer.testnet.arc.io` |
| escrow (ERC-8183) | `0x0747EEf0706327138c69792bF28Cd525089e4583` |
| USDC (ERC-20, 6 decimals) | `0x3600000000000000000000000000000000000000` |
| test USDC | `https://faucet.circle.com` — 20 USDC per request |

## 3. Get test USDC

The faucet is public and needs no account, but it is reCAPTCHA-protected: a human completes it.
Send at least 0.10 USDC to the buyer, and a little to the provider and the evaluator for gas.

## 4. Publish your encryption identity

```ts
import {AgentDirectory, bindIdentity} from 'veil-arc-sdk';

const identity = await bindIdentity({id: 'agent:provider', signer: providerWallet, publicKey: providerKey});
new AgentDirectory().register(identity);   // publish it: a JSON file or an endpoint
```

Only public material is published.

## 5. Create the agreement

```ts
const agreement = await veil.createAgreement({counterparty, amount: '0.10', terms: 'the confidential terms'});
```

## 6. Accept, fund, settle

```ts
await agreement.accept();    // the provider sets the budget
await agreement.fund();      // the buyer approves exactly 0.10 USDC and funds the escrow
const status = await agreement.status();   // SETTLED | REFUNDED | …
```

## 7. For autonomous agents

```ts
import {VeilTools} from 'veil-arc-sdk';

const tools = new VeilTools({wallet: agentWallet, encryptionPublicKey: myPublicKey});
const catalogue = tools.mcpTools();                                   // the MCP tools/list shape
const prepared = await tools.call('veil_prepare_funding', {jobId, amount: '0.10', buyerAddress});
```

A tool **prepares**; the agent's wallet signs. No tool broadcasts and no tool handles a key.

## 8. Recover after a restart

```ts
const agreement = await veil.recover(agreementId);
const status = await agreement.status();
```

## 9. The rules of the deployed escrow

| Rule | On-chain error |
|------|----------------|
| the job description must be empty | `0xa04b28ec` |
| the expiry must be at least 300 seconds away | `0xf7a0748c` |
| only the evaluator may settle or reject | — |
| a repeated settlement or refund | `0x8e78f0cb` |

## 10. What is public

The agreement is encrypted. The amount, the three wallet addresses, the timing, the gas and the
contract state are **public**. Veil does not claim otherwise.

## 11. Common errors

| Error | Meaning |
|-------|---------|
| `UNSUPPORTED_NETWORK` | the chain is not Arc Testnet |
| `RPC_UNAVAILABLE` | the public endpoint is unreachable or rate-limiting; set `rpcUrl` (and the proxy variables in a proxied network) |
| `INSUFFICIENT_BALANCE` | the agent holds no test USDC |
| `INVALID_ARGUMENT` | the job violates a rule above; the SDK refuses it locally |
| `INVALID_EVALUATOR` | only the evaluator may settle |
| `DUPLICATE_SETTLEMENT` | the job was already settled or refunded |
| `CONTRACT_UPGRADED` | the escrow's implementation changed; re-validate |
