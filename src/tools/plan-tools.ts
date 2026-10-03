import type { ToolDefinition } from './types.ts';

// 待办状态与上游运行时保持一致
// pending / in_progress / completed / cancelled / blocked
export type TodoStatus = 'pending' | 'in_progress' | 'completed' | 'cancelled' | 'blocked';

export interface TodoItem {
  description: string;
  status: TodoStatus;
}

const VALID_STATUS: readonly TodoStatus[] = [
  'pending',
  'in_progress',
  'completed',
  'cancelled',
  'blocked',
];

// 待办列表由会话持有，工具通过闭包引用同一份状态
// 待办列表由会话持有，工具通过闭包引用同一份状态。
export function createTodoTool(store: { items: TodoItem[] }): ToolDefinition {
  return {
    name: 'TodoWrite',
    description:
      'Create and update a structured todo list for the current task. Each item has a description ' +
      'and a status of pending, in_progress, completed, cancelled or blocked. Pass the complete list ' +
      'on every call; it replaces the previous one.',
    parameters: {
      type: 'object',
      properties: {
        todos: {
          type: 'array',
          description: 'The complete todo list.',
          items: {
            type: 'object',
            properties: {
              description: { type: 'string', description: 'What needs to be done.' },
              status: {
                type: 'string',
                enum: [...VALID_STATUS],
                description: 'Current status of the item.',
              },
            },
            required: ['description', 'status'],
          },
        },
      },
      required: ['todos'],
    },
    async execute(input) {
      const raw = input['todos'];
      if (!Array.isArray(raw)) return { ok: false, output: 'todos must be an array' };
      const items: TodoItem[] = [];
      for (const entry of raw) {
        if (typeof entry !== 'object' || entry === null) {
          return { ok: false, output: 'each todo must be an object' };
        }
        const record = entry as Record<string, unknown>;
        const description = record['description'];
        const status = record['status'];
        if (typeof description !== 'string' || description.length === 0) {
          return { ok: false, output: 'each todo needs a non-empty description' };
        }
        if (typeof status !== 'string' || !VALID_STATUS.includes(status as TodoStatus)) {
          return { ok: false, output: `invalid todo status: ${String(status)}` };
        }
        items.push({ description, status: status as TodoStatus });
      }
      if (items.filter((i) => i.status === 'in_progress').length > 1) {
        return { ok: false, output: 'at most one todo may be in_progress' };
      }
      store.items = items;
      const summary = items
        .map((i) => `- [${i.status}] ${i.description}`)
        .join('\n');
      return {
        ok: true,
        output: summary.length > 0 ? summary : '(todo list cleared)',
        meta: { count: items.length },
      };
    },
  };
}
