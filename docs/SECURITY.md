# Security: the release review

**Evidence:** the release check is `npm run verify:package` (`scripts/verify-package.mjs`); the
review record itself is internal.
**Scope:** a targeted internal release review. **This is not an independent security audit**, and
the reviewer is the implementation team.

## 1. The result

**19 checks, 19 pass, 0 fail** — five cryptographic, six financial-safety, four public-release and
four application-security.

## 2. Cryptography

| Check | Result |
|-------|--------|
| a wrong key binding is refused | PASS — sealing to a counterparty whose binding another wallet signed fails |
| only the two recipients can open the envelope | PASS — the third key is refused |
| the ciphertext is authenticated | PASS — a modified ciphertext fails to decrypt |
| every envelope is unique | PASS — two seals of the same terms differ |
| no key material in the envelope | PASS |

## 3. Financial safety

| Check | Result |
|-------|--------|
| the denomination is exact | PASS — a seven-decimal amount is refused |
| the chain identity is pinned | PASS — chain id 5042002 |
| the asset identity is checked | PASS — a foreign asset is refused locally |
| a duplicate settlement is refused | PASS |
| only the evaluator may settle | PASS |
| the escrow proxy is disclosed | PASS — a UUPS proxy whose administrator can replace the implementation |

## 4. Public release

| Check | Result |
|-------|--------|
| the package carries no evidence, wallet or secret file | PASS — 64 entries, none matching |
| the website carries no secret | PASS |
| the website carries no absolute local path | PASS |
| the website leaks no internal material | PASS |

## 5. Application security

| Check | Result |
|-------|--------|
| no tool broadcasts | PASS |
| the read-only tools need no wallet | PASS |
| the arguments are strictly validated | PASS — an undeclared argument is refused and nothing in it is executed |
| the tools never return a key | PASS |

## 6. The limitations

* no independent audit; these are internal negative tests;
* the Arc endpoint and the escrow were **read**, not audited;
* the issuer, the registry and the faucet were outside the review;
* the escrow's upgrade path and the registry's credentials were not assessed;
* the review does not cover the developer's own integration mistakes.

## 7. What would change the verdict

An independent review of the SDK, the tool interface and the escrow integration, plus a funded
Testnet exercise of the full lifecycle by a party outside the team.
