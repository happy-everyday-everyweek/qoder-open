import type { MemoryKind, MemoryStore } from '../memory/store.ts';
import type { ToolDefinition } from './types.ts';

const VALID_KINDS: readonly MemoryKind[] = ['user', 'feedback', 'project', 'reference', 'journal'];

export interface MemoryToolDeps {
  store: MemoryStore;
  // 记忆整理（consolidation）由上层决定内容，工具只负责落盘
  onConsolidate?: (entries: string[]) => Promise<{ kept: number; removed: number }>;
}

// 记忆工具的三种动作，对应上游运行时的写入、检索与整理：
// save（含当日记忆）、search、consolidate。
export function createMemoryTool(deps: MemoryToolDeps): ToolDefinition {
  return {
    name: 'Memory',
    description:
      'Persist and recall durable facts across sessions. Use action=save to record a memory ' +
      '(user preferences, validated feedback, project constraints, or a daily journal entry), ' +
      'action=search to look up relevant memories, and action=consolidate to rewrite the store ' +
      'with a deduplicated set of ids.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['save', 'search', 'consolidate'],
          description: 'Operation to perform.',
        },
        kind: {
          type: 'string',
          enum: [...VALID_KINDS],
          description: 'Memory category, used with action=save.',
        },
        text: { type: 'string', description: 'Memory content, used with action=save.' },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional tags for retrieval.',
        },
        query: { type: 'string', description: 'Search terms, used with action=search.' },
        keep_ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'Ids to keep when consolidating; every other entry is dropped.',
        },
      },
      required: ['action'],
    },
    async execute(input) {
      const action = input['action'];
      if (action === 'save') {
        const text = typeof input['text'] === 'string' ? input['text'] : '';
        const kind = typeof input['kind'] === 'string' ? (input['kind'] as MemoryKind) : 'journal';
        if (text.trim().length === 0) return { ok: false, output: 'text is required for save' };
        if (!VALID_KINDS.includes(kind)) return { ok: false, output: `invalid kind: ${kind}` };
        const tags = Array.isArray(input['tags'])
          ? (input['tags'] as unknown[]).filter((t): t is string => typeof t === 'string')
          : undefined;
        const entry = await deps.store.append({ kind, text, ...(tags ? { tags } : {}) });
        return { ok: true, output: `saved ${entry.kind} memory ${entry.id}`, meta: { id: entry.id } };
      }

      if (action === 'search') {
        const query = typeof input['query'] === 'string' ? input['query'] : '';
        const hits = await deps.store.search(query, 15);
        if (hits.length === 0) return { ok: true, output: 'no matching memories' };
        const body = hits
          .map((h) => `- [${h.kind}] ${h.id} (${h.createdAt}): ${h.text}`)
          .join('\n');
        return { ok: true, output: body, meta: { count: hits.length } };
      }

      if (action === 'consolidate') {
        const keep = Array.isArray(input['keep_ids'])
          ? (input['keep_ids'] as unknown[]).filter((t): t is string => typeof t === 'string')
          : [];
        const all = await deps.store.all();
        const kept = all.filter((entry) => keep.includes(entry.id));
        await deps.store.replaceAll(kept);
        const removed = all.length - kept.length;
        return {
          ok: true,
          output: `consolidated: kept ${kept.length}, removed ${removed}`,
          meta: { kept: kept.length, removed },
        };
      }

      return { ok: false, output: `unknown action: ${String(action)}` };
    },
  };
}
