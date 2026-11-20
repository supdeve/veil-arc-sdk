# Privacy: what Veil hides, and what it does not

**Topology:** Arc Testnet (5042002), one participant, independent agent wallets, the ERC-8183
reference as the escrow. **Observer scope:** the unrelated agent plus any public reader.

## 1. The rows

| # | Requirement | State | Assertion |
|---|-------------|-------|-----------|
| **P1** | Agreement confidentiality | **PASS_WITHIN_TESTED_SCOPE** | the terms are sealed to two agents; the public job carries a commitment, not the terms; an unrelated agent is refused and a third key cannot open the envelope |
| **P2** | Amount confidentiality | **FAIL** | the budget is in the ERC-8183 contract state and in the USDC transfer logs |
| **P3** | Relationship confidentiality | **FAIL** | the client, provider and evaluator addresses are public and the job links them |
| **P4** | Controlled disclosure | **PASS_WITHIN_TESTED_SCOPE** | the evaluator's tool sees only the digests and the deadline; the observer sees no plaintext |
| **P5** | Asset authorization and settlement | **PASS_WITHIN_TESTED_SCOPE** | the exact amount is approved, the duplicate settlement is refused, the escrow accounting is exact, and the real job `193100` reconciles to `SETTLED` |
| **P6** | Infrastructure visibility | **PARTIAL** | the timing, the gas, the balances, the events and the RPC surface are public; the operator, the registry and the historical stream were not exercised |

## 2. What "the tested scope" means

The confidentiality claim is an **application-layer** claim: Veil keeps the agreement out of the
chain and out of every other party's reach. It is not a claim about the chain, which publishes the
payment in full.

## 3. What was measured on the live chain

| Observation | Evidence |
|-------------|----------|
| the job's public state (status, budget, the three addresses) | `getJob(193100)` → `COMPLETED` |
| the settlement transfer | the receipt of `0x886247b3…` |
| the observer's balance | 0 — the unrelated agent never received a unit |
| the capability report | `agreementContent: ENCRYPTED`, `settlementAmount: PUBLIC`, `confidentialExecution: UNAVAILABLE` |

## 4. The refusals

| Attempt | Result |
|---------|--------|
| an unrelated agent reads the agreement state | refused |
| a third key opens the envelope | refused |
| an undeclared tool argument | refused |
| a non-evaluator settles | refused |
| a duplicate settlement | refused |
| a seven-decimal amount | refused |

## 5. The remaining limits

* the amount and the relationship are public by construction — that is Arc, not a Veil defect;
* confidential execution is unavailable on the verified implementation;
* the escrow is a UUPS proxy;
* the review was internal.
