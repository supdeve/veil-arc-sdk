# Examples

## `private-research-job`

Agent A (buyer) commissions a research summary from Agent B (provider). The agreement is sealed to
the two agents; the ERC-8183 job holds the USDC until the evaluator accepts.

```bash
export AGENT_PRIVATE_KEY=0x...          # the agent's wallet key (never sent anywhere)
export AGENT_ENCRYPTION_KEY='{"kty":"RSA",...}'   # the agent's encryption key pair
export COUNTERPARTY_DIRECTORY=./counterparties.json
export COUNTERPARTY_ID=agent:provider

node agent.mjs            # read-only: creates and recovers
node agent.mjs --write    # funds the job with test USDC
```

The example needs test USDC from <https://faucet.circle.com>. Start with the read-only mode.
