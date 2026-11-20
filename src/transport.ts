/**
 * A resilient JSON-RPC transport for the Arc public endpoint.
 *
 * The Arc public RPC rate-limits and intermittently times out; an earlier pilot
 * lost minutes to that. The transport therefore:
 *
 *   * retries a read with a bounded exponential backoff;
 *   * never retries a write;
 *   * reports an outage as a typed error instead of hanging;
 *   * tells the developer when the endpoint needs a proxy, without touching any
 *     global setting.
 */
import {VeilError} from './errors.js';

export interface TransportOptions {
  readonly url: string;
  readonly chainId: number;
  readonly attempts?: number;
  readonly initialDelayMs?: number;
  readonly maxDelayMs?: number;
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
}

export interface JsonRpcResponse<T = unknown> {
  readonly result?: T;
  readonly error?: {code: number; message: string; data?: unknown};
}

export class ArcTransport {
  private readonly fetchImpl: typeof fetch;
  private counter = 0;

  constructor(private readonly options: TransportOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /** True when the runtime can reach the endpoint directly. */
  async healthy(): Promise<boolean> {
    try {
      await this.call<string>('net_version', []);
      return true;
    } catch {
      return false;
    }
  }

  /** A read with a bounded retry. */
  async call<T>(method: string, params: unknown[] = []): Promise<T> {
    const attempts = this.options.attempts ?? 4;
    let delay = this.options.initialDelayMs ?? 500;
    let lastError: unknown;
    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        return await this.once<T>(method, params);
      } catch (error) {
        lastError = error;
        if (error instanceof VeilError && error.code === 'RPC_UNAVAILABLE' && attempt < attempts - 1) {
          await new Promise(resolve => setTimeout(resolve, delay));
          delay = Math.min(delay * 2, this.options.maxDelayMs ?? 8000);
          continue;
        }
        throw error;
      }
    }
    throw lastError;
  }

  /** A write: never retried, because a retry can double-spend. */
  async send(method: string, params: unknown[] = []): Promise<unknown> {
    return this.once(method, params);
  }

  private async once<T>(method: string, params: unknown[]): Promise<T> {
    this.counter += 1;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 45000);
    try {
      const response = await this.fetchImpl(this.options.url, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({jsonrpc: '2.0', id: this.counter, method, params}),
        signal: controller.signal,
      });
      const body = (await response.json()) as JsonRpcResponse<T>;
      if (body.error) {
        throw new VeilError('TRANSACTION_REVERTED', `${method} failed: ${body.error.message}`, {
          rpcCode: body.error.code,
          data: body.error.data,
        });
      }
      return body.result as T;
    } catch (error) {
      if (error instanceof VeilError) throw error;
      const message = String(error);
      throw new VeilError(
        'RPC_UNAVAILABLE',
        `${method} could not be read from ${this.options.url}: ${message.slice(0, 160)}`,
        {
          hint: this.hint(message),
        },
      );
    } finally {
      clearTimeout(timer);
    }
  }

  /** The hint is about the endpoint, never about changing a global setting. */
  private hint(message: string): string {
    if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|CONNECT_TIMEOUT|UND_ERR/i.test(message)) {
      return 'the public Arc endpoint may be unreachable from this network; a proxy or a dedicated endpoint can be supplied with the rpcUrl option';
    }
    return 'the public Arc endpoint may be rate-limiting; the reads are retried with a bounded backoff';
  }
}
