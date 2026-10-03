#!/usr/bin/env node
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { stdin, stdout } from 'node:process';
import { createInterface } from 'node:readline/promises';
import { loadAgentProfiles } from './agents/profile.ts';
import { runAgent, type AgentEvent } from './agent/loop.ts';
import { DEFAULT_POLICY, PermissionEngine } from './agent/permissions.ts';
import { DEFAULT_SYSTEM_PROMPT, loadConfig } from './config/index.ts';
import { loadMcpConfigFile, loadMcpTools } from './mcp/tools.ts';
import { MemoryStore } from './memory/store.ts';
import { createProvider, type ProviderKind } from './model/factory.ts';
import type { ModelProvider } from './model/types.ts';
import { resolveCompactThreshold } from './agent/context.ts';
import { loadLoopDefinition, renderLoopInjection } from './session/loop.ts';
import { loadSkills, renderSkillIndex } from './skills/loader.ts';
import { bashTool, globTool, grepTool } from './tools/exec-tools.ts';
import { editTool, readTool, writeTool } from './tools/file-tools.ts';
import { createMemoryTool } from './tools/memory-tools.ts';
import { createTodoTool, type TodoItem } from './tools/plan-tools.ts';
import { createRegistry } from './tools/registry.ts';
import { createTaskTool } from './tools/task-tool.ts';
import type { ToolDefinition, ToolRegistry } from './tools/types.ts';
import { createWebSearchTool, webFetchTool } from './tools/web-tools.ts';

interface Args {
  prompt?: string;
  cwd: string;
  model?: string;
  baseUrl?: string;
  provider?: string;
  agent?: string;
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
      case '--agent':
        if (next) {
          args.agent = next;
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
      --agent <name>      Use an agent profile from .qoder/agents
      --max-turns <n>     Maximum agent turns (default: 40)
  -y, --yes               Skip permission confirmation prompts
  -h, --help              Show this help

Environment:
  QODER_OPEN_BASE_URL, QODER_OPEN_API_KEY, QODER_OPEN_MODEL,
  QODER_OPEN_PROVIDER, QODER_OPEN_MAX_TURNS, QODER_OPEN_COMPACT_TOKENS,
  QODER_OPEN_SEARCH_URL, QODER_OPEN_YES

Layout:
  memories  <cwd>/.qoder-open/memory.jsonl
  mcp       <cwd>/.qoder-open/mcp.json
  skills    <cwd>/.qoder/skills and ~/.qoder-open/skills
  agents    <cwd>/.qoder/agents and ~/.qoder-open/agents
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

// 按模型覆写的压缩阈值。格式：{"gpt-5": 200000, "claude": 160000}
// 对应上游由配置服务下发的 auto_compact_model_threshold_caps。
function parseCompactCaps(raw: string | undefined): Record<string, number> | undefined {
  if (!raw) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined;
    const out: Record<string, number> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === 'number' && Number.isFinite(value)) out[key] = value;
    }
    return Object.keys(out).length > 0 ? out : undefined;
  } catch {
    return undefined;
  }
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

  const loopDefinition = await loadLoopDefinition(join(workspace, '.qoder', 'loop.md'));

  const profiles = await loadAgentProfiles([
    join(workspace, '.qoder', 'agents'),
    join(homedir(), '.qoder-open', 'agents'),
  ]);
  const activeProfile = args.agent ? profiles.find((p) => p.name === args.agent) : undefined;
  if (args.agent && !activeProfile) {
    stdout.write(`error: agent profile not found: ${args.agent}\n`);
    return 2;
  }

  const permissions = new PermissionEngine({
    ...DEFAULT_POLICY,
    skipConfirmation: config.skipConfirmation,
  });

  const model = activeProfile?.model ?? config.model;
  const provider = createProvider({
    kind: config.provider as ProviderKind,
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    model,
  });

  const mcpConfigs =
    activeProfile?.mcpServers && activeProfile.mcpServers.length > 0
      ? activeProfile.mcpServers
      : await loadMcpConfigFile(join(workspace, '.qoder-open', 'mcp.json'));
  const mcpResult = await loadMcpTools(mcpConfigs);
  for (const message of mcpResult.errors) {
    stdout.write(`[mcp] ${message}\n`);
  }

  const taskRef: { provider?: ModelProvider; registry?: ToolRegistry } = {};
  const todoStore: { items: TodoItem[] } = { items: [] };

  const allTools: ToolDefinition[] = [
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
    ...mcpResult.tools,
    createTaskTool({
      getProvider: () => taskRef.provider,
      getRegistry: () => taskRef.registry,
      permissions,
      model,
    }),
  ];

  const selectedTools = allTools.filter((tool) => {
    if (!activeProfile) return true;
    if (activeProfile.disallowedTools?.includes(tool.name)) return false;
    if (activeProfile.tools && activeProfile.tools.length > 0) {
      return activeProfile.tools.includes(tool.name);
    }
    return true;
  });

  const registry = createRegistry(selectedTools);
  taskRef.provider = provider;
  taskRef.registry = registry;

  const systemPrompt = [
    activeProfile?.systemPrompt ?? DEFAULT_SYSTEM_PROMPT,
    activeProfile?.initialPrompt ?? '',
    loopDefinition ? renderLoopInjection(loopDefinition) : '',
    renderSkillIndex(
      activeProfile?.skills && activeProfile.skills.length > 0
        ? skills.filter((s) => activeProfile.skills?.includes(s.name))
        : skills,
    ),
  ]
    .filter((part) => part.length > 0)
    .join('\n\n');

  const compactCaps = parseCompactCaps(process.env['QODER_OPEN_COMPACT_CAPS']);

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
      model,
      maxTurns: activeProfile?.maxTurns ?? config.maxTurns,
      compactThreshold: resolveCompactThreshold(model, compactCaps, config.compactThreshold),
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
