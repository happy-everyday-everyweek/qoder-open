import type {
  ChatMessage,
  ModelProvider,
  ModelRequest,
  ProviderConfig,
  StreamEvent,
  ToolCallRequest,
} from './types.ts';

// OpenAI 兼容协议的流式适配。
// 上游客户端同时支持 openai / openai-responses / openai-compatible 等形态，
// 本实现先覆盖最通用的 chat completions 流式接口。
export class OpenAICompatibleProvider implements ModelProvider {
  readonly id = 'openai-compatible';
  readonly defaultModel: string;

  constructor(private readonly config: ProviderConfig) {
    this.defaultModel = config.model;
  }

  private toWireMessage(message: ChatMessage): Record<string, unknown> {
    const base: Record<string, unknown> = { role: message.role };
    if (Array.isArray(message.content)) {
      base['content'] = message.content.map((part) =>
        part.type === 'text'
          ? { type: 'text', text: part.text }
          : {
              type: 'image_url',
              image_url: { url: part.url, ...(part.detail ? { detail: part.detail } : {}) },
            },
      );
    } else {
      base['content'] = message.content;
    }
    if (message.toolCalls && message.toolCalls.length > 0) {
      base['tool_calls'] = message.toolCalls.map((call) => ({
        id: call.id,
        type: 'function',
        function: { name: call.name, arguments: call.arguments },
      }));
    }
    if (message.toolCallId) base['tool_call_id'] = message.toolCallId;
    return base;
  }

  async *stream(request: ModelRequest): AsyncIterable<StreamEvent> {
    const body: Record<string, unknown> = {
      model: request.model || this.defaultModel,
      messages: request.messages.map((m) => this.toWireMessage(m)),
      stream: true,
    };
    if (request.tools && request.tools.length > 0) {
      body['tools'] = request.tools.map((tool) => ({
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
        },
      }));
    }
    if (typeof request.temperature === 'number') body['temperature'] = request.temperature;
    if (typeof request.maxTokens === 'number') body['max_tokens'] = request.maxTokens;

    const response = await fetch(`${this.config.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.config.apiKey}`,
        ...(this.config.headers ?? {}),
      },
      body: JSON.stringify(body),
      ...(request.abortSignal ? { signal: request.abortSignal } : {}),
    });

    if (!response.ok || !response.body) {
      const detail = await response.text().catch(() => '');
      throw new Error(`model request failed: ${response.status} ${detail.slice(0, 500)}`);
    }

    // 工具调用按 index 分槽累积参数碎片
    const pending = new Map<number, { id: string; name: string; args: string }>();
    let finishReason = 'stop';

    for await (const event of parseSSE(response.body)) {
      if (event === '[DONE]') break;
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(event) as Record<string, unknown>;
      } catch {
        continue;
      }
      const choices = parsed['choices'];
      if (!Array.isArray(choices) || choices.length === 0) {
        const usage = parsed['usage'];
        if (usage && typeof usage === 'object') {
          const u = usage as Record<string, number>;
          yield {
            kind: 'usage',
            usage: {
              promptTokens: u['prompt_tokens'] ?? 0,
              completionTokens: u['completion_tokens'] ?? 0,
            },
          };
        }
        continue;
      }
      const choice = choices[0] as Record<string, unknown>;
      if (typeof choice['finish_reason'] === 'string') finishReason = choice['finish_reason'];
      const delta = (choice['delta'] ?? {}) as Record<string, unknown>;

      const text = delta['content'];
      if (typeof text === 'string' && text.length > 0) {
        yield { kind: 'text', text };
      }
      const reasoning = delta['reasoning_content'];
      if (typeof reasoning === 'string' && reasoning.length > 0) {
        yield { kind: 'reasoning', text: reasoning };
      }
      const calls = delta['tool_calls'];
      if (Array.isArray(calls)) {
        for (const raw of calls) {
          const call = raw as Record<string, unknown>;
          const index = typeof call['index'] === 'number' ? call['index'] : 0;
          const slot = pending.get(index) ?? { id: '', name: '', args: '' };
          if (typeof call['id'] === 'string') slot.id = call['id'];
          const fn = call['function'];
          if (fn && typeof fn === 'object') {
            const f = fn as Record<string, unknown>;
            if (typeof f['name'] === 'string') slot.name = f['name'];
            if (typeof f['arguments'] === 'string') slot.args += f['arguments'];
          }
          pending.set(index, slot);
        }
      }
    }

    const ordered = [...pending.entries()].sort((a, b) => a[0] - b[0]);
    for (const [index, slot] of ordered) {
      if (slot.name.length === 0) continue;
      const call: ToolCallRequest = {
        id: slot.id.length > 0 ? slot.id : `call_${index}`,
        name: slot.name,
        arguments: slot.args.length > 0 ? slot.args : '{}',
      };
      yield { kind: 'toolCall', toolCall: call };
    }
    yield { kind: 'done', finishReason };
  }
}

// 逐行解析 SSE，拼接 data: 负载
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
      if (line.startsWith('data:')) {
        yield line.slice(5).trim();
      }
      index = buffer.indexOf('\n');
    }
  }
  const tail = buffer.trim();
  if (tail.startsWith('data:')) yield tail.slice(5).trim();
}
