import type { ChatMessage, ModelProvider, ModelRequest, ToolCallRequest, Usage } from '../model/types.ts';
import type { ToolContext, ToolRegistry } from '../tools/types.ts';
import type { PermissionEngine } from './permissions.ts';
import { estimateTokens, shouldCompact, trimToolOutputs } from './context.ts';

export interface AgentEvent {
  type: 'text' | 'reasoning' | 'turn-start' | 'tool-start' | 'tool-end' | 'compacted' | 'turn-end' | 'done';
  text?: string;
  turn?: number;
  toolName?: string;
  toolInput?: Record<string, unknown>;
  toolResult?: string;
  ok?: boolean;
}

export interface AgentOptions {
  provider: ModelProvider;
  registry: ToolRegistry;
  permissions: PermissionEngine;
  cwd: string;
  systemPrompt: string;
  model?: string;
  maxTurns?: number;
  // 超过该估算 token 数时进行上下文整理
  compactThreshold?: number;
  signal?: AbortSignal;
  onEvent?: (event: AgentEvent) => void;
  // 权限判定为 ask 时，由上层提供确认交互
  askUser?: (question: string) => Promise<boolean>;
}

export interface AgentResult {
  messages: ChatMessage[];
  usage: Usage;
  turns: number;
  finishReason: string;
}

const MAX_TOOL_RESULT_CHARS = 60_000;

// 解析模型给出的工具参数；参数不合法时不中断回合，而是把它作为工具错误回填给模型
function parseArguments(raw: string): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  if (raw.trim().length === 0) return { ok: true, value: {} };
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return { ok: false, error: 'arguments must be a JSON object' };
    }
    return { ok: true, value: parsed as Record<string, unknown> };
  } catch (err) {
    return { ok: false, error: `invalid JSON arguments: ${(err as Error).message}` };
  }
}

export async function runAgent(options: AgentOptions): Promise<AgentResult> {
  const {
    provider,
    registry,
    permissions,
    cwd,
    systemPrompt,
    model = provider.defaultModel,
    maxTurns = 40,
    compactThreshold = 60_000,
    signal,
    onEvent,
    askUser,
  } = options;

  const emit = (event: AgentEvent): void => onEvent?.(event);
  const messages: ChatMessage[] = [{ role: 'system', content: systemPrompt }];
  const usage: Usage = { promptTokens: 0, completionTokens: 0 };
  let turns = 0;
  let finishReason = 'stop';

  while (turns < maxTurns) {
    if (signal?.aborted) {
      finishReason = 'aborted';
      break;
    }
    turns++;
    emit({ type: 'turn-start', turn: turns });

    if (shouldCompact(messages, compactThreshold)) {
      const before = estimateTokens(messages);
      const trimmed = trimToolOutputs(messages);
      messages.length = 0;
      messages.push(...trimmed);
      emit({ type: 'compacted', text: `${before} -> ${estimateTokens(messages)} tokens` });
    }

    const request: ModelRequest = {
      model,
      messages,
      tools: registry.schemas(),
      stream: true,
      ...(signal ? { abortSignal: signal } : {}),
    };

    let assistantText = '';
    const toolCalls: ToolCallRequest[] = [];
    for await (const event of provider.stream(request)) {
      if (event.kind === 'text') {
        assistantText += event.text;
        emit({ type: 'text', text: event.text });
      } else if (event.kind === 'reasoning') {
        emit({ type: 'reasoning', text: event.text });
      } else if (event.kind === 'toolCall') {
        toolCalls.push(event.toolCall);
      } else if (event.kind === 'usage') {
        usage.promptTokens += event.usage.promptTokens;
        usage.completionTokens += event.usage.completionTokens;
      } else if (event.kind === 'done') {
        finishReason = event.finishReason;
      }
    }

    const assistantMessage: ChatMessage = {
      role: 'assistant',
      content: assistantText,
      ...(toolCalls.length > 0 ? { toolCalls } : {}),
    };
    messages.push(assistantMessage);

    if (toolCalls.length === 0) {
      emit({ type: 'turn-end', turn: turns });
      break;
    }

    const ctx: ToolContext = {
      cwd,
      ...(signal ? { signal } : {}),
      ...(askUser ? { askUser } : {}),
      approve: async (toolName, input) => {
        const def = registry.get(toolName);
        if (!def) return { decision: 'deny', rationale: `unknown tool: ${toolName}` };
        return permissions.evaluate(def, input);
      },
    };

    for (const call of toolCalls) {
      emit({ type: 'tool-start', toolName: call.name });
      const parsed = parseArguments(call.arguments);
      if (!parsed.ok) {
        messages.push({
          role: 'tool',
          toolCallId: call.id,
          content: `error: ${parsed.error}`,
        });
        emit({ type: 'tool-end', toolName: call.name, ok: false, toolResult: parsed.error });
        continue;
      }

      const definition = registry.get(call.name);
      if (!definition) {
        messages.push({
          role: 'tool',
          toolCallId: call.id,
          content: `error: unknown tool ${call.name}`,
        });
        emit({ type: 'tool-end', toolName: call.name, ok: false, toolResult: 'unknown tool' });
        continue;
      }

      emit({ type: 'tool-start', toolName: call.name, toolInput: parsed.value });
      const verdict = permissions.evaluate(definition, parsed.value);
      let resultText: string;
      let ok: boolean;

      if (verdict.decision === 'deny') {
        ok = false;
        resultText = `permission denied${verdict.constraints ? `: ${verdict.constraints}` : ''}`;
      } else if (verdict.decision === 'ask') {
        const question = `allow ${call.name}${verdict.constraints ? ` (${verdict.constraints})` : ''}?`;
        const allowed = ctx.askUser ? await ctx.askUser(question) : false;
        if (!allowed) {
          ok = false;
          resultText = 'permission denied by the user';
        } else {
          const outcome = await definition.execute(parsed.value, ctx);
          ok = outcome.ok;
          resultText = outcome.output;
        }
      } else {
        const outcome = await definition.execute(parsed.value, ctx);
        ok = outcome.ok;
        resultText = outcome.output;
      }

      if (resultText.length > MAX_TOOL_RESULT_CHARS) {
        resultText = `${resultText.slice(0, MAX_TOOL_RESULT_CHARS)}\n... (tool output truncated)`;
      }
      messages.push({ role: 'tool', toolCallId: call.id, content: resultText });
      emit({ type: 'tool-end', toolName: call.name, ok, toolResult: resultText.slice(0, 2000) });
    }

    emit({ type: 'turn-end', turn: turns });
  }

  emit({ type: 'done' });
  return { messages, usage, turns, finishReason };
}
