import { stdin, stdout } from 'node:process';
import { createInterface } from 'node:readline/promises';
import { runAgent, type AgentEvent } from '../agent/loop.ts';
import type { PermissionEngine } from '../agent/permissions.ts';
import type { ModelProvider } from '../model/types.ts';
import type { MemoryStore } from '../memory/store.ts';
import type { ToolRegistry } from '../tools/types.ts';

export interface ReplOptions {
  provider: ModelProvider;
  registry: ToolRegistry;
  permissions: PermissionEngine;
  memory: MemoryStore;
  cwd: string;
  systemPrompt: string;
  model: string;
  maxTurns: number;
  compactThreshold: number;
  render: (event: AgentEvent) => void;
}

const BANNER = [
  'qoder-open interactive mode',
  '  /help              show this help',
  '  /memory search <q> search stored memories',
  '  /memory save <t>   store a project memory',
  '  /model             show the active model',
  '  /exit              quit',
].join('\n');

// 交互式 REPL。每个输入作为一轮独立的 agent 任务运行，
// 工具、权限、记忆与模型配置在会话内复用。
export async function runRepl(options: ReplOptions): Promise<number> {
  const rl = createInterface({ input: stdin, output: stdout });
  stdout.write(`${BANNER}\n\n`);

  try {
    while (true) {
      const line = (await rl.question('> ')).trim();
      if (line.length === 0) continue;

      if (line === '/exit' || line === '/quit') break;
      if (line === '/help') {
        stdout.write(`${BANNER}\n\n`);
        continue;
      }
      if (line === '/model') {
        stdout.write(`model: ${options.model}\n`);
        continue;
      }
      if (line.startsWith('/memory')) {
        const rest = line.slice('/memory'.length).trim();
        if (rest.startsWith('search')) {
          const query = rest.slice('search'.length).trim();
          const hits = await options.memory.search(query, 10);
          stdout.write(
            hits.length > 0
              ? `${hits.map((h) => `- [${h.kind}] ${h.text}`).join('\n')}\n`
              : 'no matching memories\n',
          );
        } else if (rest.startsWith('save')) {
          const text = rest.slice('save'.length).trim();
          if (text.length === 0) {
            stdout.write('usage: /memory save <text>\n');
          } else {
            const entry = await options.memory.append({ kind: 'project', text });
            stdout.write(`saved ${entry.id}\n`);
          }
        } else {
          stdout.write('usage: /memory search <q> | /memory save <text>\n');
        }
        continue;
      }

      try {
        await runAgent({
          provider: options.provider,
          registry: options.registry,
          permissions: options.permissions,
          cwd: options.cwd,
          systemPrompt: options.systemPrompt,
          model: options.model,
          maxTurns: options.maxTurns,
          compactThreshold: options.compactThreshold,
          onEvent: options.render,
          askUser: async (question) => {
            const answer = await rl.question(`${question} [y/N] `);
            return answer.trim().toLowerCase().startsWith('y');
          },
        });
      } catch (err) {
        stdout.write(`error: ${(err as Error).message}\n`);
      }
    }
    return 0;
  } finally {
    rl.close();
  }
}
