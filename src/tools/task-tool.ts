import { runAgent } from '../agent/loop.ts';
import type { PermissionEngine } from '../agent/permissions.ts';
import type { ModelProvider } from '../model/types.ts';
import type { ToolContext, ToolDefinition, ToolRegistry } from './types.ts';

export interface TaskToolDeps {
  // 使用 getter 避免 registry 与工具自身的循环引用
  getProvider: () => ModelProvider | undefined;
  getRegistry: () => ToolRegistry | undefined;
  permissions: PermissionEngine;
  model?: string;
  // 子代理允许的最大回合数，默认取较小值以避免失控
  maxTurns?: number;
}

// 子代理工具：把一个自包含任务交给嵌套的 agent 循环执行，
// 只把最终文本返回给父代理，从而隔离中间步骤的上下文开销。
export function createTaskTool(deps: TaskToolDeps): ToolDefinition {
  return {
    name: 'Task',
    description:
      'Delegate a self-contained task to a sub agent that runs in the same workspace. ' +
      'The sub agent has the same tools available and only its final answer is returned.',
    parameters: {
      type: 'object',
      properties: {
        description: { type: 'string', description: 'Short description of the task.' },
        prompt: { type: 'string', description: 'The task for the agent.' },
      },
      required: ['prompt'],
    },
    async execute(input, ctx: ToolContext) {
      const prompt = typeof input['prompt'] === 'string' ? input['prompt'] : '';
      if (prompt.trim().length === 0) return { ok: false, output: 'prompt is required' };
      const description = typeof input['description'] === 'string' ? input['description'] : 'sub task';

      const provider = deps.getProvider();
      const registry = deps.getRegistry();
      if (!provider || !registry) {
        return { ok: false, output: 'sub agent is not available in this session' };
      }

      let lastText = '';
      try {
        const result = await runAgent({
          provider,
          registry,
          permissions: deps.permissions,
          cwd: ctx.cwd,
          systemPrompt:
            'You are a focused sub agent. Complete the assigned task and report the result concisely.',
          ...(deps.model ? { model: deps.model } : {}),
          maxTurns: deps.maxTurns ?? 12,
          ...(ctx.signal ? { signal: ctx.signal } : {}),
          ...(ctx.askUser ? { askUser: ctx.askUser } : {}),
          onEvent: (event) => {
            if (event.type === 'text') lastText += event.text ?? '';
          },
        });
        return {
          ok: true,
          title: description,
          output: lastText.length > 0 ? lastText : `(sub agent finished in ${result.turns} turns)`,
          meta: { turns: result.turns, finishReason: result.finishReason },
        };
      } catch (err) {
        return { ok: false, output: `sub agent failed: ${(err as Error).message}` };
      }
    },
  };
}
