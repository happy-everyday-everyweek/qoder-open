import type {
  ChatMessage,
  ModelProvider,
  ModelRequest,
  ProviderConfig,
  StreamEvent,
  ToolCallRequest,
} from './types.ts';

// Anthropic Messages API 适配。
// 上游运行时同时支持 anthropic 与 anthropic-compatible 两种形态，
// 差异主要在工具结果与系统提示的组装方式。
export class AnthropicProvider implements ModelProvider {
  readonly id = 'anthropic-compatible';
  readonly defaultModel: string;

  constructor(private readonly config: ProviderConfig) {
    this.defaultModel = config.model;
  }

  private buildBody(request: ModelRequest): Record<string, unknown> {
    const systemParts: string[] = [];
    const messages: Record<string, unknown>[] = [];

    for (const message of request.messages) {
      if (message.role === 'system') {
        systemParts.push(typeof message.content === 'string' ? message.content : '');
        continue;
      }
      if (message.role === 'tool') {
        messages.push({
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: message.toolCallId ?? 'unknown',
              content: typeof message.content === 'string' ? message.content : '',
            },
          ],
        });
        continue;
      }

      const blocks: Record<string, unknown>[] = [];
      if (typeof message.content === 'string') {
        if (message.content.length > 0) blocks.push({ type: 'text', text: message.content });
      } else {
        for (const part of message.content) {
          if (part.type === 'text') {
            blocks.push({ type: 'text', text: part.text });
          } else {
            blocks.push({ type: 'image', source: { type: 'url', url: part.url } });
          }
        }
      }
      for (const call of message.toolCalls ?? []) {
        let input: unknown = {};
        try {
          input = JSON.parse(call.arguments);
        } catch {
          input = { raw: call.arguments };
        }
        blocks.push({ type: 'tool_use', id: call.id, name: call.name, input });
      }
      messages.push({ role: message.role, content: blocks });
    }

    const body: Record<string, unknown> = {
      model: request.model || this.defaultModel,
      max_tokens: request.maxTokens ?? 8192,
      messages,
      stream: true,
    };
    if (systemParts.length > 0) body['system'] = systemParts.join('\n');
    if (request.tools && request.tools.length > 0) {
      body['tools'] = request.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.parameters,
      }));
    }
    if (typeof request.temperature === 'number') body['temperature'] = request.temperature;
    return body;
  }

  async *stream(request: ModelRequest): AsyncIterable<StreamEvent> {
    const response = await fetch(`${this.config.baseUrl.replace(/\/$/, '')}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': this.config.apiKey,
        'anthropic-version': '2023-06-01',
        ...(this.config.headers ?? {}),
      },
      body: JSON.stringify(this.buildBody(request)),
      ...(request.abortSignal ? { signal: request.abortSignal } : {}),
    });

    if (!response.ok || !response.body) {
      const detail = await response.text().catch(() => '');
      throw new Error(`anthropic request failed: ${response.status} ${detail.slice(0, 500)}`);
    }

    const partial = new Map<number, { id: string; name: string; args: string }>();
    let finishReason = 'stop';

    for await (const payload of parseSSE(response.body)) {
      let event: Record<string, unknown>;
      try {
        event = JSON.parse(payload) as Record<string, unknown>;
      } catch {
        continue;
      }
      const type = event['type'];
      if (type === 'content_block_start') {
        const block = (event['content_block'] ?? {}) as Record<string, unknown>;
        if (block['type'] === 'tool_use') {
          const index = Number(event['index'] ?? 0);
          partial.set(index, {
            id: String(block['id'] ?? ''),
            name: String(block['name'] ?? ''),
            args: '',
          });
        }
      } else if (type === 'content_block_delta') {
        const delta = (event['delta'] ?? {}) as Record<string, unknown>;
        if (delta['type'] === 'text_delta' && typeof delta['text'] === 'string') {
          yield { kind: 'text', text: delta['text'] };
        } else if (delta['type'] === 'thinking_delta' && typeof delta['thinking'] === 'string') {
          yield { kind: 'reasoning', text: delta['thinking'] };
        } else if (delta['type'] === 'input_json_delta' && typeof delta['partial_json'] === 'string') {
          const index = Number(event['index'] ?? 0);
          const slot = partial.get(index);
          if (slot) slot.args += delta['partial_json'];
        }
      } else if (type === 'message_delta') {
        const delta = (event['delta'] ?? {}) as Record<string, unknown>;
        if (typeof delta['stop_reason'] === 'string') finishReason = delta['stop_reason'];
      } else if (type === 'message_start') {
        const message = (event['message'] ?? {}) as Record<string, unknown>;
        const usage = (message['usage'] ?? {}) as Record<string, number>;
        if (typeof usage['input_tokens'] === 'number') {
          yield {
            kind: 'usage',
            usage: { promptTokens: usage['input_tokens'], completionTokens: 0 },
          };
        }
      } else if (type === 'message_stop') {
        break;
      }
    }

    const ordered = [...partial.entries()].sort((a, b) => a[0] - b[0]);
    for (const [index, slot] of ordered) {
      const call: ToolCallRequest = {
        id: slot.id.length > 0 ? slot.id : `toolu_${index}`,
        name: slot.name,
        arguments: slot.args.length > 0 ? slot.args : '{}',
      };
      yield { kind: 'toolCall', toolCall: call };
    }
    yield { kind: 'done', finishReason };
  }
}

async function* parseSSE(body: ReadableStream<Uint8Array>): AsyncIterable<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let index = buffer.indexOf('\n');
    while (index >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line.startsWith('data:')) yield line.slice(5).trim();
      index = buffer.indexOf('\n');
    }
  }
  const tail = buffer.trim();
  if (tail.startsWith('data:')) yield tail.slice(5).trim();
}
