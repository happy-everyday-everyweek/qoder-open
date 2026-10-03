#!/usr/bin/env node
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { stdin, stdout } from 'node:process';
import { createInterface } from 'node:readline/promises';
import { runAgent, type AgentEvent } from './agent/loop.ts';
import { DEFAULT_POLICY, PermissionEngine } from './agent/permissions.ts';
import { DEFAULT_SYSTEM_PROMPT, loadConfig } from './config/index.ts';
import { MemoryStore } from './memory/store.ts';
import { createProvider, type ProviderKind } from './model/factory.ts';
import type { ModelProvider } from './model/types.ts';
import { loadSkills, renderSkillIndex } from './skills/loader.ts';
import { bashTool, globTool, grepTool } from './tools/exec-tools.ts';
import { editTool, readTool, writeTool } from './tools/file-tools.ts';
import { createMemoryTool } from './tools/memory-tools.ts';
import { createTodoTool, type TodoItem } from './tools/plan-tools.ts';
import { createRegistry } from './tools/registry.ts';
import { createTaskTool } from './tools/task-tool.ts';
import { createWebSearchTool, webFetchTool } from './tools/web-tools.ts';
import type { ToolRegistry } from './tools/types.ts';

interface Args {
  prompt?: string;
  cwd: string;
  model?: string;
  baseUrl?: string;
  provider?: string;
  maxTurns?: number;
  yes: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { cwd: process.cwd(), yes: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i] as string;
    const next = argv[i + 1];
    switch (token) {
      case '--prompt':
      case '-p':
        if (next) {
          args.prompt = next;
          i++;
        }
        break;
      case '--cwd':
        if (next) {
          args.cwd = next;
          i++;
        }
        break;
      case '--model':
        if (next) {
          args.model = next;
          i++;
        }
        break;
      case '--base-url':
        if (next) {
          args.baseUrl = next;
          i++;
        }
        break;
      case '--provider':
        if (next) {
          args.provider = next;
          i++;
        }
        break;
      case '--max-turns':
        if (next) {
          args.maxTurns = Number.parseInt(next, 10);
          i++;
        }
        break;
      case '--yes':
      case '-y':
        args.yes = true;
        break;
      case '--help':
      case '-h':
        args.help = true;
        break;
      default:
        if (!token.startsWith('-') && !args.prompt) args.prompt = token;
    }
  }
  return args;
}

const HELP = `qoder-open - agentic coding harness

Usage:
  qoder-open [prompt] [options]

Options:
  -p, --prompt <text>     Task to run; omit to read the prompt from stdin
      --cwd <dir>         Working directory (default: current directory)
      --model <name>      Model identifier
      --provider <kind>   openai-compatible | anthropic-compatible
      --base-url <url>    Endpoint base URL
      --max-turns <n>     Maximum agent turns (default: 40)
  -y, --yes               Skip permission confirmation prompts
  -h, --help              Show this help

Environment:
  QODER_OPEN_BASE_URL, QODER_OPEN_API_KEY, QODER_OPEN_MODEL,
  QODER_OPEN_PROVIDER, QODER_OPEN_MAX_TURNS, QODER_OPEN_COMPACT_TOKENS,
  QODER_OPEN_SEARCH_URL, QODER_OPEN_YES

Tools: Read, Write, Edit, Bash, Glob, Grep, TodoWrite, Memory, WebFetch,
WebSearch, Task

Memory and skills:
  memories are stored under <cwd>/.qoder-open/memory.jsonl
  skills are loaded from <cwd>/.qoder/skills and ~/.qoder-open/skills
`;

function render(event: AgentEvent): void {
  switch (event.type) {
    case 'text':
      stdout.write(event.text ?? '');
      break;
    case 'tool-start':
      if (event.toolInput) {
        stdout.write(`\n[tool] ${event.toolName} ${JSON.stringify(event.toolInput).slice(0, 300)}\n`);
      }
      break;
    case 'tool-end':
      stdout.write(`[tool] ${event.toolName} ${event.ok ? 'ok' : 'failed'}\n`);
      break;
    case 'compacted':
      stdout.write(`[context] compacted ${event.text ?? ''}\n`);
      break;
    case 'done':
      stdout.write('\n');
      break;
    default:
      break;
  }
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString('utf8').trim();
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    stdout.write(HELP);
    return 0;
  }

  const config = loadConfig({
    ...(args.baseUrl ? { baseUrl: args.baseUrl } : {}),
    ...(args.model ? { model: args.model } : {}),
    ...(args.provider ? { provider: args.provider } : {}),
    ...(typeof args.maxTurns === 'number' ? { maxTurns: args.maxTurns } : {}),
    ...(args.yes ? { skipConfirmation: true } : {}),
  });

  if (config.apiKey.length === 0) {
    stdout.write('error: no API key configured (set QODER_OPEN_API_KEY)\n');
    return 2;
  }

  const prompt = args.prompt ?? (await readStdin());
  if (prompt.length === 0) {
    stdout.write('error: empty prompt\n');
    return 2;
  }

  const workspace = resolve(args.cwd);
  const memory = new MemoryStore(join(workspace, '.qoder-open'));
  const skills = await loadSkills([
    join(workspace, '.qoder', 'skills'),
    join(homedir(), '.qoder-open', 'skills'),
  ]);

  // 依赖顺序：权限策略 -> 模型提供方 -> 工具注册表（Task 回到注册表本身）
  const permissions = new PermissionEngine({
    ...DEFAULT_POLICY,
    skipConfirmation: config.skipConfirmation,
  });

  const provider = createProvider({
    kind: config.provider as ProviderKind,
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    model: config.model,
  });

  const taskRef: { provider?: ModelProvider; registry?: ToolRegistry } = {};
  const todoStore: { items: TodoItem[] } = { items: [] };
  const registry = createRegistry([
    readTool,
    writeTool,
    editTool,
    bashTool,
    globTool,
    grepTool,
    createTodoTool(todoStore),
    createMemoryTool({ store: memory }),
    webFetchTool,
    createWebSearchTool(process.env['QODER_OPEN_SEARCH_URL']),
    createTaskTool({
      getProvider: () => taskRef.provider,
      getRegistry: () => taskRef.registry,
      permissions,
      model: config.model,
    }),
  ]);
  taskRef.provider = provider;
  taskRef.registry = registry;

  const systemPrompt = [DEFAULT_SYSTEM_PROMPT, renderSkillIndex(skills)]
    .filter((part) => part.length > 0)
    .join('\n\n');

  const rl = args.yes ? undefined : createInterface({ input: stdin, output: stdout });
  const askUser = async (question: string): Promise<boolean> => {
    if (!rl) return true;
    const answer = await rl.question(`${question} [y/N] `);
    return answer.trim().toLowerCase().startsWith('y');
  };

  try {
    await runAgent({
      provider,
      registry,
      permissions,
      cwd: workspace,
      systemPrompt,
      model: config.model,
      maxTurns: config.maxTurns,
      compactThreshold: config.compactThreshold,
      onEvent: render,
      askUser,
    });
    return 0;
  } catch (err) {
    stdout.write(`\nerror: ${(err as Error).message}\n`);
    return 1;
  } finally {
    rl?.close();
  }
}

void (async (): Promise<void> => {
  process.exitCode = await main();
})();
