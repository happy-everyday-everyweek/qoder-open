import type { ChatMessage } from '../model/types.ts';

// 粗略 token 估算：按字符数折算，中文与代码混排时偏差可接受。
// 上游运行时对 systemPromptTokens 与压缩阈值均显式建模，本实现先给出可用近似。
export function estimateTokens(messages: ChatMessage[]): number {
  let chars = 0;
  for (const message of messages) {
    chars += typeof message.content === 'string' ? message.content.length : 0;
    for (const call of message.toolCalls ?? []) {
      chars += call.name.length + call.arguments.length;
    }
  }
  return Math.ceil(chars / 3);
}

const TRUNCATED_NOTE = '\n... (older tool output truncated to save context) ...';

// 裁剪最早的冗长工具结果，保留用户与助手消息。
// 这是压缩前的一级手段，对应上游在摘要压缩之前的裁剪阶段。
export function trimToolOutputs(
  messages: ChatMessage[],
  limit = 2000,
  keepRecent = 6,
): ChatMessage[] {
  const out: ChatMessage[] = [];
  let seenToolMessages = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i] as ChatMessage;
    if (message.role !== 'tool') {
      out.unshift(message);
      continue;
    }
    seenToolMessages++;
    const content = typeof message.content === 'string' ? message.content : '';
    if (seenToolMessages > keepRecent && content.length > limit) {
      out.unshift({
        ...message,
        content: content.slice(0, limit) + TRUNCATED_NOTE,
      });
    } else {
      out.unshift(message);
    }
  }
  return out;
}

// 摘要压缩为一次独立模型请求。失败时向上抛出带类别的错误，不静默丢弃。
export class CompactionError extends Error {
  constructor(message: string, readonly category: CompactionFailure) {
    super(message);
    this.name = 'CompactionError';
  }
}

export type CompactionFailure =
  | 'empty_summary'
  | 'inflated_token_count'
  | 'model_request_failed'
  | 'precompact_blocked';

export function shouldCompact(messages: ChatMessage[], thresholdTokens: number): boolean {
  return estimateTokens(messages) >= thresholdTokens;
}
