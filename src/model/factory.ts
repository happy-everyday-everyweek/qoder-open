import { AnthropicProvider } from './anthropic.ts';
import { OpenAICompatibleProvider } from './openai.ts';
import type { ModelProvider } from './types.ts';

export type ProviderKind = 'openai' | 'openai-compatible' | 'anthropic' | 'anthropic-compatible';

export interface ProviderSelection {
  kind: ProviderKind;
  baseUrl: string;
  apiKey: string;
  model: string;
  headers?: Record<string, string>;
}

// 按协议形态选择适配器。
// 上游的模型层同样按 provider 分支（anthropic / openai / openai-responses /
// openai-compatible / anthropic-compatible），此处保留相同思路。
export function createProvider(config: ProviderSelection): ModelProvider {
  const headers = config.headers ?? {};
  switch (config.kind) {
    case 'anthropic':
    case 'anthropic-compatible':
      return new AnthropicProvider({
        baseUrl: config.baseUrl,
        apiKey: config.apiKey,
        model: config.model,
        headers,
      });
    case 'openai':
    case 'openai-compatible':
    default:
      return new OpenAICompatibleProvider({
        baseUrl: config.baseUrl,
        apiKey: config.apiKey,
        model: config.model,
        headers,
      });
  }
}
