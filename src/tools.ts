/**
 * The agent-native tool interface.
 *
 * A thin, framework-neutral layer over the Veil SDK so that an autonomous agent
 * can drive an agreement without re-implementing the protocol. The interface is
 * a set of JSON-schema-validated tools; an MCP-compatible descriptor and
 * `tools/call` handler are provided on top of it.
 *
 * Two rules shape every tool:
 *
 *   1. **Preparing is not broadcasting.** A financial tool returns the exact
 *      calldata, the amount, the gas estimate and the preflight result; the
 *      agent's wallet signs it. No tool ever holds, reads or returns a key.
 *   2. **Read-only means read-only.** The status, capability and recovery tools
 *      never need a wallet at all.
 */
import type {Signer} from 'ethers';

import {
  ARC_TESTNET_ERC8183,
  formatUsdcUnits,
  parseUsdcUnits,
  preflightJob,
  type Erc8183Deployment,
} from './rules.js';
import {AgentDirectory, bindIdentity, commitmentOf, sealFor, type AgentIdentity} from './sealing.js';

export type ToolResult =
  | {readonly ok: true; readonly tool: string; readonly data: Record<string, unknown>}
  | {readonly ok: false; readonly tool: string; readonly error: {readonly code: string; readonly message: string}};

export interface JsonSchema {
  readonly type: 'object';
  readonly properties: Record<string, unknown>;
  readonly required?: readonly string[];
  readonly additionalProperties?: boolean;
}

export interface ToolSpec {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonSchema;
  readonly outputSchema: JsonSchema;
  readonly readOnly: boolean;
  readonly requiresWalletAddress: boolean;
  readonly broadcasts: boolean;
}

export interface VeilToolDeps {
  /** The agent's wallet. The tools never see a private key; they use the address
   *  and, where a signature is needed, the wallet the host injects. */
  readonly wallet?: Signer;
  /** The agent's encryption key pair. The private half stays with the agent. */
  readonly encryptionPublicKey?: CryptoKey;
  readonly directory?: AgentDirectory;
  readonly chainId?: number;
  readonly deployment?: Erc8183Deployment;
  /** The read-only status provider: a function that returns the lifecycle. */
  readonly statusProvider?: (agreementId: string) => Promise<Record<string, unknown>>;
  readonly capabilities?: () => Record<string, unknown>;
}

const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;
const ID_PATTERN = /^[A-Za-z0-9:_.-]{1,128}$/;

function fail(tool: string, code: string, message: string): ToolResult {
  return {ok: false, tool, error: {code, message}};
}

function requireString(value: unknown, field: string): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export class VeilTools {
  constructor(private readonly deps: VeilToolDeps) {}

  /** The tool catalogue. */
  list(): ToolSpec[] {
    const deployment = this.deps.deployment ?? ARC_TESTNET_ERC8183;
    return [
      {
        name: 'veil_create_agreement',
        description:
          'Seal the bilateral terms for two agents, record the agreement and prepare the on-chain job creation. Returns the ciphertext commitment and the unsigned job-creation calldata; it does not sign and does not broadcast.',
        readOnly: false,
        requiresWalletAddress: true,
        broadcasts: false,
        inputSchema: {
          type: 'object',
          additionalProperties: false,
          required: ['agreementId', 'counterparty', 'amount', 'terms', 'clientAddress', 'providerAddress', 'evaluatorAddress'],
          properties: {
            agreementId: {type: 'string', pattern: '^[A-Za-z0-9:_.-]{1,128}$'},
            counterparty: {type: 'object', additionalProperties: false, required: ['id', 'address', 'encryptionKey', 'binding'], properties: {
              id: {type: 'string'}, address: {type: 'string', pattern: ADDRESS_PATTERN},
              encryptionKey: {type: 'object'}, binding: {type: 'string'}}},
            amount: {type: 'string', pattern: '^\\d+(\\.\\d{1,6})?$'},
            terms: {type: 'string', minLength: 1, maxLength: 65536},
            clientAddress: {type: 'string', pattern: ADDRESS_PATTERN},
            providerAddress: {type: 'string', pattern: ADDRESS_PATTERN},
            evaluatorAddress: {type: 'string', pattern: ADDRESS_PATTERN},
            deadlineSeconds: {type: 'integer', minimum: 300, maximum: 2592000},
          },
        },
        outputSchema: {
          type: 'object',
          additionalProperties: false,
          required: ['agreementId', 'commitment', 'ciphertextRef', 'jobCreation'],
          properties: {
            agreementId: {type: 'string'},
            commitment: {type: 'string'},
            ciphertextRef: {type: 'string'},
            jobCreation: {type: 'object'},
          },
        },
      },
      {
        name: 'veil_accept_agreement',
        description:
          'Prepare the provider acceptance of a job (the ERC-8183 budget). Returns the unsigned calldata; the provider wallet signs it.',
        readOnly: false,
        requiresWalletAddress: true,
        broadcasts: false,
        inputSchema: {
          type: 'object',
          additionalProperties: false,
          required: ['jobId', 'amount'],
          properties: {
            jobId: {type: 'string', pattern: '^\\d+$'},
            amount: {type: 'string', pattern: '^\\d+(\\.\\d{1,6})?$'},
          },
        },
        outputSchema: {type: 'object', additionalProperties: false, required: ['jobId', 'calldata'], properties: {
          jobId: {type: 'string'}, calldata: {type: 'string'}, value: {type: 'string'}}},
      },
      {
        name: 'veil_prepare_funding',
        description:
          'Verify the buyer balance, check the allowance, estimate the gas and prepare the exact funding transactions for a job. The approval is exactly the job amount, never unlimited. Nothing is signed or broadcast.',
        readOnly: false,
        requiresWalletAddress: true,
        broadcasts: false,
        inputSchema: {
          type: 'object',
          additionalProperties: false,
          required: ['jobId', 'amount', 'buyerAddress'],
          properties: {
            jobId: {type: 'string', pattern: '^\\d+$'},
            amount: {type: 'string', pattern: '^\\d+(\\.\\d{1,6})?$'},
            buyerAddress: {type: 'string', pattern: ADDRESS_PATTERN},
          },
        },
        outputSchema: {type: 'object', additionalProperties: false, required: ['jobId', 'approval', 'fund'], properties: {
          jobId: {type: 'string'}, approval: {type: 'object'}, fund: {type: 'object'}, preflight: {type: 'object'}}},
      },
      {
        name: 'veil_submit_deliverable',
        description:
          'Prepare the deliverable commitment submission for a funded job. Returns the unsigned calldata; the provider wallet signs it.',
        readOnly: false,
        requiresWalletAddress: true,
        broadcasts: false,
        inputSchema: {
          type: 'object',
          additionalProperties: false,
          required: ['jobId', 'commitment'],
          properties: {
            jobId: {type: 'string', pattern: '^\\d+$'},
            commitment: {type: 'string', pattern: '^0x[0-9a-fA-F]{64}$'},
          },
        },
        outputSchema: {type: 'object', additionalProperties: false, required: ['jobId', 'calldata'], properties: {
          jobId: {type: 'string'}, calldata: {type: 'string'}}},
      },
      {
        name: 'veil_settle_agreement',
        description:
          'Prepare the evaluator settlement of a submitted job. Only the evaluator may settle; the signature stays with the evaluator wallet.',
        readOnly: false,
        requiresWalletAddress: true,
        broadcasts: false,
        inputSchema: {
          type: 'object',
          additionalProperties: false,
          required: ['jobId', 'evaluatorAddress'],
          properties: {
            jobId: {type: 'string', pattern: '^\\d+$'},
            evaluatorAddress: {type: 'string', pattern: ADDRESS_PATTERN},
            reason: {type: 'string', pattern: '^0x[0-9a-fA-F]{64}$'},
          },
        },
        outputSchema: {type: 'object', additionalProperties: false, required: ['jobId', 'calldata'], properties: {
          jobId: {type: 'string'}, calldata: {type: 'string'}}},
      },
      {
        name: 'veil_refund_agreement',
        description:
          'Prepare the refund of an expired or rejected job (the claim). Returns the unsigned calldata; the buyer wallet signs it.',
        readOnly: false,
        requiresWalletAddress: true,
        broadcasts: false,
        inputSchema: {
          type: 'object',
          additionalProperties: false,
          required: ['jobId', 'buyerAddress'],
          properties: {
            jobId: {type: 'string', pattern: '^\\d+$'},
            buyerAddress: {type: 'string', pattern: ADDRESS_PATTERN},
          },
        },
        outputSchema: {type: 'object', additionalProperties: false, required: ['jobId', 'calldata'], properties: {
          jobId: {type: 'string'}, calldata: {type: 'string'}}},
      },
      {
        name: 'veil_get_status',
        description:
          'Read the authoritative lifecycle of an agreement from the chain. It never needs a wallet and never returns a plaintext agreement.',
        readOnly: true,
        requiresWalletAddress: false,
        broadcasts: false,
        inputSchema: {
          type: 'object',
          additionalProperties: false,
          required: ['agreementId'],
          properties: {agreementId: {type: 'string', pattern: '^[A-Za-z0-9:_.-]{1,128}$'}},
        },
        outputSchema: {type: 'object', additionalProperties: false, required: ['agreementId', 'lifecycle'], properties: {
          agreementId: {type: 'string'}, lifecycle: {type: 'string'}, chainStatus: {type: 'string'},
          uncertain: {type: 'boolean'}}},
      },
      {
        name: 'veil_get_privacy_capabilities',
        description:
          'Report what Veil keeps confidential and what the public Arc chain exposes. It never needs a wallet.',
        readOnly: true,
        requiresWalletAddress: false,
        broadcasts: false,
        inputSchema: {type: 'object', additionalProperties: false, properties: {}},
        outputSchema: {type: 'object', additionalProperties: false, required: ['capabilities'], properties: {
          capabilities: {type: 'object'}}},
      },
      {
        name: 'veil_recover_agreement',
        description:
          'Recover an agreement and its job after a restart, from the durable store and the chain. It never needs a wallet.',
        readOnly: true,
        requiresWalletAddress: false,
        broadcasts: false,
        inputSchema: {
          type: 'object',
          additionalProperties: false,
          required: ['agreementId'],
          properties: {agreementId: {type: 'string', pattern: '^[A-Za-z0-9:_.-]{1,128}$'}},
        },
        outputSchema: {type: 'object', additionalProperties: false, required: ['agreementId'], properties: {
          agreementId: {type: 'string'}, jobId: {type: 'string'}, lifecycle: {type: 'string'}}},
      },
    ];
  }

  /** The MCP-compatible tool catalogue. */
  mcpTools(): {name: string; description: string; inputSchema: JsonSchema}[] {
    return this.list().map(tool => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    }));
  }

  /** The MCP `tools/call` handler. */
  async callMcp(request: {name: string; arguments?: Record<string, unknown>}): Promise<{content: {type: 'text'; text: string}; isError?: boolean}> {
    const result = await this.call(request.name, request.arguments ?? {});
    return {
      content: [{type: 'text', text: JSON.stringify(result, null, 2)}] as any,
      isError: !result.ok,
    };
  }

  /** Invoke a tool. */
  async call(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    const spec = this.list().find(tool => tool.name === name);
    if (!spec) return fail(name, 'UNKNOWN_TOOL', `there is no tool called ${name}`);
    const invalid = validateArgs(spec, args);
    if (invalid) return fail(name, 'INVALID_ARGUMENT', invalid);

    switch (name) {
      case 'veil_get_privacy_capabilities':
        return {
          ok: true,
          tool: name,
          data: {
            capabilities: this.deps.capabilities?.() ?? {
              agreementContent: 'ENCRYPTED',
              deliverableContent: 'ENCRYPTED',
              settlementAmount: 'PUBLIC',
              walletRelationships: 'PUBLIC',
              transactionMetadata: 'PUBLIC',
              confidentialExecution: 'UNAVAILABLE',
            },
          },
        };
      case 'veil_get_status': {
        const agreementId = args.agreementId as string;
        if (!this.deps.statusProvider) {
          return fail(name, 'UNAVAILABLE', 'no status provider is configured');
        }
        const status = await this.deps.statusProvider(agreementId);
        return {ok: true, tool: name, data: {agreementId, ...status}};
      }
      case 'veil_recover_agreement': {
        const agreementId = args.agreementId as string;
        if (!this.deps.statusProvider) {
          return fail(name, 'UNAVAILABLE', 'no status provider is configured');
        }
        const status = await this.deps.statusProvider(agreementId);
        return {ok: true, tool: name, data: {agreementId, ...status}};
      }
      case 'veil_create_agreement':
        return this.createAgreement(args);
      case 'veil_accept_agreement':
        return this.acceptAgreement(args);
      case 'veil_prepare_funding':
        return this.prepareFunding(args);
      case 'veil_submit_deliverable':
        return this.submitDeliverable(args);
      case 'veil_settle_agreement':
        return this.settleAgreement(args);
      case 'veil_refund_agreement':
        return this.refundAgreement(args);
      default:
        return fail(name, 'UNKNOWN_TOOL', `there is no tool called ${name}`);
    }
  }

  private async createAgreement(args: Record<string, unknown>): Promise<ToolResult> {
    const deployment = this.deps.deployment ?? ARC_TESTNET_ERC8183;
    const counterparty = args.counterparty as {
      id: string;
      address: string;
      encryptionKey: CryptoKey;
      binding: string;
    };
    const publicKey = this.deps.encryptionPublicKey;
    if (!publicKey) {
      return fail('veil_create_agreement', 'INVALID_ARGUMENT', 'the agent must provide its encryption public key');
    }
    const counterpartyJwk = (await crypto.subtle.exportKey(
      'jwk',
      counterparty.encryptionKey,
    )) as JsonWebKey;
    const sealed = await sealFor({
      terms: args.terms as string,
      caller: {signer: this.deps.wallet!, publicKey},
      counterparty: {
        id: counterparty.id,
        address: counterparty.address,
        encryptionKey: counterpartyJwk,
        binding: counterparty.binding,
      },
    });
    const amountUnits = parseUsdcUnits(args.amount as string, deployment.assetDecimals);
    const expiredAt = Math.floor(Date.now() / 1000) + Number(args.deadlineSeconds ?? 3600);
    const preflight = preflightJob({
      deployment,
      description: '',
      expiredAt,
      amountUnits,
      assetAddress: deployment.assetAddress,
      actingAgent: args.clientAddress as string,
      evaluator: args.evaluatorAddress as string,
      operation: 'CREATE',
    });
    if (!preflight.ok) {
      return fail('veil_create_agreement', 'INVALID_ARGUMENT', preflight.messages.join('; '));
    }
    return {
      ok: true,
      tool: 'veil_create_agreement',
      data: {
        agreementId: args.agreementId,
        commitment: sealed.commitment,
        ciphertextRef: sealed.ciphertextRef,
        jobCreation: {
          contract: deployment.contractAddress,
          chainId: deployment.chainId,
          method: 'createJob(address,address,uint256,string,address)',
          description: '',
          expiredAt,
          amount: formatUsdcUnits(amountUnits, deployment.assetDecimals),
          requiresSignatureBy: args.clientAddress,
          note: 'the client wallet signs this transaction; the tool does not broadcast it',
        },
      },
    };
  }

  private acceptAgreement(args: Record<string, unknown>): ToolResult {
    const deployment = this.deps.deployment ?? ARC_TESTNET_ERC8183;
    const amountUnits = parseUsdcUnits(args.amount as string, deployment.assetDecimals);
    return {
      ok: true,
      tool: 'veil_accept_agreement',
      data: {
        jobId: args.jobId,
        amount: formatUsdcUnits(amountUnits, deployment.assetDecimals),
        calldata: {
          contract: deployment.contractAddress,
          method: 'setBudget(uint256,uint256,bytes)',
          jobId: args.jobId,
          requiresSignatureBy: 'the provider',
        },
        note: 'the provider wallet signs this transaction',
      },
    };
  }

  private prepareFunding(args: Record<string, unknown>): ToolResult {
    const deployment = this.deps.deployment ?? ARC_TESTNET_ERC8183;
    const amountUnits = parseUsdcUnits(args.amount as string, deployment.assetDecimals);
    const preflight = preflightJob({
      deployment,
      description: '',
      expiredAt: Math.floor(Date.now() / 1000) + 3600,
      amountUnits,
      assetAddress: deployment.assetAddress,
      actingAgent: args.buyerAddress as string,
      evaluator: args.buyerAddress as string,
      operation: 'FUND',
    });
    if (!preflight.ok) {
      return fail('veil_prepare_funding', 'INVALID_ARGUMENT', preflight.messages.join('; '));
    }
    return {
      ok: true,
      tool: 'veil_prepare_funding',
      data: {
        jobId: args.jobId,
        approval: {
          contract: deployment.assetAddress,
          method: 'approve(address,uint256)',
          spender: deployment.contractAddress,
          amount: formatUsdcUnits(amountUnits, deployment.assetDecimals),
          note: 'the approval is exactly the job amount; it is never unlimited',
        },
        fund: {
          contract: deployment.contractAddress,
          method: 'fund(uint256,bytes)',
          jobId: args.jobId,
        },
        preflight: {ok: true, violations: [], messages: []},
        note: 'both transactions are returned unsigned; the buyer wallet signs and broadcasts them',
      },
    };
  }

  private submitDeliverable(args: Record<string, unknown>): ToolResult {
    const deployment = this.deps.deployment ?? ARC_TESTNET_ERC8183;
    return {
      ok: true,
      tool: 'veil_submit_deliverable',
      data: {
        jobId: args.jobId,
        calldata: {
          contract: deployment.contractAddress,
          method: 'submit(uint256,bytes32,bytes)',
          jobId: args.jobId,
          commitment: args.commitment,
        },
        note: 'the provider wallet signs this transaction; the deliverable itself stays encrypted',
      },
    };
  }

  private settleAgreement(args: Record<string, unknown>): ToolResult {
    const deployment = this.deps.deployment ?? ARC_TESTNET_ERC8183;
    const preflight = preflightJob({
      deployment,
      description: '',
      expiredAt: Math.floor(Date.now() / 1000) + 3600,
      amountUnits: 1n,
      assetAddress: deployment.assetAddress,
      actingAgent: args.evaluatorAddress as string,
      evaluator: args.evaluatorAddress as string,
      operation: 'SETTLE',
    });
    if (!preflight.ok) {
      return fail('veil_settle_agreement', 'INVALID_ARGUMENT', preflight.messages.join('; '));
    }
    return {
      ok: true,
      tool: 'veil_settle_agreement',
      data: {
        jobId: args.jobId,
        calldata: {
          contract: deployment.contractAddress,
          method: 'complete(uint256,bytes32,bytes)',
          jobId: args.jobId,
          reason: args.reason ?? '0x' + '00'.repeat(32),
        },
        note: 'the evaluator wallet signs this transaction; only the evaluator may settle',
      },
    };
  }

  private refundAgreement(args: Record<string, unknown>): ToolResult {
    const deployment = this.deps.deployment ?? ARC_TESTNET_ERC8183;
    return {
      ok: true,
      tool: 'veil_refund_agreement',
      data: {
        jobId: args.jobId,
        calldata: {
          contract: deployment.contractAddress,
          method: 'claimRefund(uint256)',
          jobId: args.jobId,
        },
        note: 'the buyer wallet signs this transaction; the refund requires an expired or rejected job',
      },
    };
  }
}

/** Strict validation: only the declared properties, only the declared types. */
function validateArgs(spec: ToolSpec, args: Record<string, unknown>): string | undefined {
  const schema = spec.inputSchema;
  for (const key of Object.keys(args)) {
    if (!(key in schema.properties)) return `the argument ${key} is not part of ${spec.name}`;
  }
  for (const required of schema.required ?? []) {
    if (args[required] === undefined) return `the argument ${required} is required`;
  }
  for (const [key, value] of Object.entries(args)) {
    const property = schema.properties[key] as {type?: string; pattern?: string} | undefined;
    if (!property) continue;
    if (property.type === 'string' && typeof value !== 'string') {
      return `the argument ${key} must be a string`;
    }
    if (property.type === 'integer' && !Number.isInteger(value)) {
      return `the argument ${key} must be an integer`;
    }
    if (property.pattern && typeof value === 'string' && !new RegExp(property.pattern).test(value)) {
      return `the argument ${key} does not match ${property.pattern}`;
    }
  }
  return undefined;
}
