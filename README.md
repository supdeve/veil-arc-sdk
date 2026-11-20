# veil-arc-sdk

Encrypted bilateral agent agreements with conditional USDC settlement on **Arc**.

```bash
npm install veil-arc-sdk
```

Node.js **>= 22.5**. The package depends on `ethers` and `jose` and nothing else — no native
build, no chain-specific runtime.

## One minute

```ts
import {Veil} from 'veil-arc-sdk';

const veil = await Veil.connect({
  network: 'arc-testnet',        // the chain, the escrow and the asset are built in
  wallet: agentWallet,             // your wallet; Veil never holds it
  encryptionPublicKey: myKey,      // your encryption key; the private half stays with you
});

const agreement = await veil.createAgreement({
  counterparty,                    // the other agent's public identity
  amount: '0.10',                 // USDC, six decimals
  terms: 'the confidential terms', // sealed to the two agents
});

await agreement.accept();         // the provider sets the budget
await agreement.fund();            // the buyer approves exactly 0.10 USDC and funds the escrow
const status = await agreement.status();   // SETTLED | REFUNDED | ...
```

## For autonomous agents

The same operations are exposed as validated tools with JSON schemas, plus an MCP-compatible
catalogue:

```ts
import {VeilTools} from 'veil-arc-sdk';

const tools = new VeilTools({wallet: agentWallet, encryptionPublicKey: myKey});
const catalogue = tools.mcpTools();                                     // the MCP tools/list shape
await tools.call('veil_prepare_funding', {jobId, amount: '0.10', buyerAddress});
```

A tool **prepares**; the agent's wallet signs. No tool broadcasts, no tool handles a private key,
and the read-only tools need no wallet at all.

## Arc Testnet

| | |
|---|---|
| network | Arc Testnet, chain id **5042002** |
| RPC | `https://rpc.testnet.arc.io` |
| explorer | `https://explorer.testnet.arc.io` |
| escrow (ERC-8183) | `0x0747EEf0706327138c69792bF28Cd525089e4583` |
| USDC (ERC-20, 6 decimals) | `0x3600000000000000000000000000000000000000` |
| test USDC | <https://faucet.circle.com> - 20 USDC per request, one request per asset and network every two hours |

## The rules of the deployed escrow (ERC-8183 5.0.0)

| Rule | On-chain error |
|------|----------------|
| the job description must be empty | `0xa04b28ec` |
| the expiry must be at least 300 seconds away | `0xf7a0748c` |
| only the evaluator may settle or reject | - |
| a repeated settlement or refund | `0x8e78f0cb` |

The SDK checks all of them locally, before your wallet signs.

## What is confidential, and what is not

| Field | Status |
|-------|--------|
| the agreement text | **ENCRYPTED** (RSA-OAEP-256 + A256GCM, two recipients) |
| the deliverable | **ENCRYPTED** (only a commitment is published) |
| the settlement amount | **PUBLIC** |
| the wallet identities | **PUBLIC** |
| the counterparty relationships | **PUBLICLY INFERABLE** |
| the transaction timing and the gas | **PUBLIC** |
| confidential on-chain execution | **NOT AVAILABLE** |

Veil does not claim fully private on-chain transactions. See `docs/PRIVACY.md`.

## Licence

MIT. See `LICENSE`, `NOTICE.md` and `CHANGELOG.md`.
