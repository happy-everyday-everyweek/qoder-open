#!/usr/bin/env node
import { stdin, stdout } from 'node:process';
import { createInterface } from 'node:readline/promises';
import { runAgent, type AgentEvent } from './agent/loop.ts';
import { PermissionEngine, DEFAULT_POLICY } from './agent/permissions.ts';
import { DEFAULT_SYSTEM_PROMPT, loadConfig } from './config/index.ts';
import { OpenAICompatibleProvider } from './model/openai.ts';
import { bashTool, globTool, grepTool } from './tools/exec-tools.ts';
import { editTool, readTool, writeTool } from './tools/file-tools.ts';
import { createTodoTool, type TodoItem } from './tools/plan-tools.ts';
import { createRegistry } from './tools/registry.ts';
import type { PermissionVerdict } from './tools/types.ts';

interface Args {
  prompt?: string;
  cwd: string;
  model?: string;
  baseUrl?: string;
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
      --base-url <url>    OpenAI compatible endpoint
      --max-turns <n>     Maximum agent turns (default: 40)
  -y, --yes               Skip permission confirmation prompts
  -h, --help              Show this help

Environment:
  QODER_OPEN_BASE_URL, QODER_OPEN_API_KEY, QODER_OPEN_MODEL,
  QODER_OPEN_MAX_TURNS, QODER_OPEN_COMPACT_TOKENS, QODER_OPEN_YES
`;

function render(event: AgentEvent): void {
  switch (event.type) {
    case 'text':
      stdout.write(event.text ?? '');
      break;
    case 'reasoning':
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
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
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

  const todoStore: { items: TodoItem[] } = { items: [] };
  const registry = createRegistry([
    readTool,
    writeTool,
    editTool,
    bashTool,
    globTool,
    grepTool,
    createTodoTool(todoStore),
  ]);

  const provider = new OpenAICompatibleProvider({
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    model: config.model,
  });

  const rl = args.yes ? undefined : createInterface({ input: stdin, output: stdout });
  const askUser = async (question: string): Promise<boolean> => {
    if (!rl) return true;
    const answer = await rl.question(`${question} [y/N] `);
    return answer.trim().toLowerCase().startsWith('y');
  };

  const permissions = new PermissionEngine({
    ...DEFAULT_POLICY,
    skipConfirmation: config.skipConfirmation,
  });

  try {
    await runAgent({
      provider,
      registry,
      permissions,
      cwd: args.cwd,
      systemPrompt: DEFAULT_SYSTEM_PROMPT,
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

void stdout;
void (async (): Promise<void> => {
  const code = await main();
  process.exitCode = code;
})();

type _UnusedPermissionVerdict = PermissionVerdict;
