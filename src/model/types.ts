// 模型层公共类型。协议形态参照对上游客户端的静态分析结果：
// 消息与工具调用结构兼容 OpenAI Chat Completions，并保留推理强度、
// 前缀缓存补丁、元数据等扩展位。

export type Role = 'system' | 'user' | 'assistant' | 'tool';

export interface TextPart {
  type: 'text';
  text: string;
}

export interface ImagePart {
  type: 'image';
  url: string;
  detail?: string;
}

export type ContentPart = TextPart | ImagePart;

export interface ToolCallRequest {
  id: string;
  name: string;
  arguments: string;
}

export interface ChatMessage {
  role: Role;
  content: string | ContentPart[];
  toolCalls?: ToolCallRequest[];
  toolCallId?: string;
  reasoning?: string;
}

export type ReasoningEffort =
  | 'none'
  | 'low'
  | 'medium'
  | 'high'
  | 'xhigh'
  | 'max';

export interface ToolSchema {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ModelRequest {
  model: string;
  messages: ChatMessage[];
  tools?: ToolSchema[];
  temperature?: number;
  maxTokens?: number;
  reasoningEffort?: ReasoningEffort;
  stream?: boolean;
  abortSignal?: AbortSignal;
}

export interface Usage {
  promptTokens: number;
  completionTokens: number;
  cachedTokens?: number;
  reasoningTokens?: number;
}

export type StreamEvent =
  | { kind: 'text'; text: string }
  | { kind: 'reasoning'; text: string }
  | { kind: 'toolCall'; toolCall: ToolCallRequest }
  | { kind: 'usage'; usage: Usage }
  | { kind: 'done'; finishReason: string };

export interface ModelProvider {
  readonly id: string;
  readonly defaultModel: string;
  stream(request: ModelRequest): AsyncIterable<StreamEvent>;
}

export interface ProviderConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  headers?: Record<string, string>;
}
