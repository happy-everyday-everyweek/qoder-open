import type { McpServerConfig, McpToolDescriptor } from './types.ts';

interface JsonRpcResponse {
  result?: unknown;
  error?: { code: number; message: string };
}

const PROTOCOL_VERSION = '2024-11-05';
const DEFAULT_TIMEOUT_MS = 30_000;

// 轻量 MCP 客户端：仅实现 HTTP 传输（JSON-RPC over HTTP，兼容 SSE 响应）。
// tcp 传输与 OAuth 授权流程尚未实现。
export class McpHttpClient {
  private readonly config: McpServerConfig;
  private nextId = 1;
  private initialized = false;

  constructor(config: McpServerConfig) {
    this.config = config;
  }

  get name(): string {
    return this.config.name;
  }

  private get endpoint(): string {
    const url = this.config.httpUrl;
    if (!url) throw new Error(`mcp server ${this.config.name} has no http_url configured`);
    return url;
  }

  private async rpc(method: string, params: Record<string, unknown>): Promise<unknown> {
    const id = this.nextId++;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    try {
      const response = await fetch(this.endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          ...(this.config.headers ?? {}),
        },
        body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const contentType = response.headers.get('content-type') ?? '';
      const text = await response.text();
      let payload: JsonRpcResponse;
      if (contentType.includes('text/event-stream')) {
        const line = text.split('\n').find((l) => l.startsWith('data:'));
        if (!line) throw new Error('empty event stream');
        payload = JSON.parse(line.slice(5).trim()) as JsonRpcResponse;
      } else {
        payload = JSON.parse(text) as JsonRpcResponse;
      }
      if (payload.error) {
        throw new Error(`rpc error ${payload.error.code}: ${payload.error.message}`);
      }
      return payload.result;
    } finally {
      clearTimeout(timeout);
    }
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    await this.rpc('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: {} },
      clientInfo: { name: 'qoder-open', version: '0.1.0' },
    });
    this.initialized = true;
  }

  async listTools(): Promise<McpToolDescriptor[]> {
    await this.initialize();
    const result = (await this.rpc('tools/list', {})) as { tools?: McpToolDescriptor[] } | undefined;
    return result?.tools ?? [];
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
    await this.initialize();
    const result = (await this.rpc('tools/call', { name, arguments: args })) as
      | { content?: { type?: string; text?: string }[]; isError?: boolean }
      | undefined;
    const parts = result?.content ?? [];
    const text = parts
      .map((part) => (typeof part.text === 'string' ? part.text : `[${part.type ?? 'unknown'} content]`))
      .join('\n');
    return { text: text.length > 0 ? text : '(empty result)', isError: result?.isError === true };
  }
}
