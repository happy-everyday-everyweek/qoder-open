import { spawn } from 'node:child_process';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { ToolDefinition } from './types.ts';

const MAX_OUTPUT = 100_000;
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_GREP_MATCHES = 400;
const IGNORED_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', '.next', 'target']);

function str(input: Record<string, unknown>, key: string): string | undefined {
  const v = input[key];
  return typeof v === 'string' ? v : undefined;
}

function num(input: Record<string, unknown>, key: string): number | undefined {
  const v = input[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function truncate(text: string): string {
  if (text.length <= MAX_OUTPUT) return text;
  return `${text.slice(0, MAX_OUTPUT)}\n... (truncated, ${text.length - MAX_OUTPUT} chars omitted)`;
}

// 将常见 glob 形式的模式转换为正则
function globToRegExp(pattern: string): RegExp {
  let out = '';
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i] as string;
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        out += '.*';
        i++;
        if (pattern[i + 1] === '/') i++;
      } else {
        out += '[^/]*';
      }
    } else if (ch === '?') {
      out += '[^/]';
    } else if ('\\^$.|+()[]{}'.includes(ch)) {
      out += `\\${ch}`;
    } else {
      out += ch;
    }
  }
  return new RegExp(`^${out}$`);
}

async function walk(
  root: string,
  dir: string,
  onFile: (abs: string, rel: string) => Promise<boolean> | boolean,
  maxDepth = 12,
  depth = 0,
): Promise<void> {
  if (depth > maxDepth) return;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const abs = join(dir, entry.name);
    const rel = abs.slice(root.length + 1);
    if (entry.isDirectory()) {
      if (IGNORED_DIRS.has(entry.name)) continue;
      await walk(root, abs, onFile, maxDepth, depth + 1);
    } else if (entry.isFile()) {
      const stop = await onFile(abs, rel);
      if (stop) return;
    }
  }
}

export const bashTool: ToolDefinition = {
  name: 'Bash',
  description:
    'Execute a shell command. Use it for build, test, git and other terminal operations. ' +
    'Long running commands can be given an explicit timeout.',
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'Shell command to execute.' },
      timeout_ms: { type: 'number', description: 'Timeout in milliseconds.' },
      description: { type: 'string', description: 'Short description of what the command does.' },
    },
    required: ['command'],
  },
  async execute(input, ctx) {
    const command = str(input, 'command');
    if (!command) return { ok: false, output: 'command is required' };
    const timeout = num(input, 'timeout_ms') ?? DEFAULT_TIMEOUT_MS;
    return await new Promise((done) => {
      const child = spawn(command, { shell: true, cwd: ctx.cwd });
      let out = '';
      let err = '';
      let finished = false;
      let timedOut = false;
      const timer = setTimeout(() => {
        if (!finished) {
          timedOut = true;
          child.kill('SIGTERM');
        }
      }, timeout);
      child.stdout?.on('data', (chunk: Buffer) => {
        out += chunk.toString();
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        err += chunk.toString();
      });
      const onAbort = () => child.kill('SIGTERM');
      ctx.signal?.addEventListener('abort', onAbort, { once: true });
      child.on('error', (e) => {
        finished = true;
        clearTimeout(timer);
        done({ ok: false, output: `spawn failed: ${e.message}` });
      });
      child.on('close', (code) => {
        finished = true;
        clearTimeout(timer);
        ctx.signal?.removeEventListener('abort', onAbort);
        const body = [out, err].filter((s) => s.length > 0).join('\n');
        done({
          ok: code === 0,
          title: str(input, 'description'),
          output: truncate(body.length > 0 ? body : `(no output, exit code ${code})`),
          meta: { exitCode: code, timedOut },
        });
      });
    });
  },
};

export const globTool: ToolDefinition = {
  name: 'Glob',
  description: 'Find files by name pattern, returned sorted by modification time.',
  readOnly: true,
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Glob pattern such as **/*.ts.' },
      path: { type: 'string', description: 'Directory to search in, defaults to the working directory.' },
    },
    required: ['pattern'],
  },
  async execute(input, ctx) {
    const pattern = str(input, 'pattern');
    if (!pattern) return { ok: false, output: 'pattern is required' };
    const root = resolve(ctx.cwd, str(input, 'path') ?? '.');
    const rx = globToRegExp(pattern);
    const hits: { abs: string; mtime: number }[] = [];
    await walk(root, root, async (abs, rel) => {
      if (!rx.test(rel)) return false;
      try {
        const info = await stat(abs);
        hits.push({ abs, mtime: info.mtimeMs });
      } catch {
        /* ignore */
      }
      return false;
    });
    hits.sort((a, b) => b.mtime - a.mtime);
    const listed = hits.slice(0, 300).map((h) => h.abs);
    return {
      ok: true,
      output: listed.length > 0 ? listed.join('\n') : 'no files matched',
      meta: { total: hits.length },
    };
  },
};

export const grepTool: ToolDefinition = {
  name: 'Grep',
  description: 'Search file contents with a regular expression, showing matching lines.',
  readOnly: true,
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Regular expression to search for.' },
      path: { type: 'string', description: 'Directory to search in.' },
      include: { type: 'string', description: 'Only search files whose path matches this glob.' },
      case_insensitive: { type: 'boolean', description: 'Ignore case.' },
    },
    required: ['pattern'],
  },
  async execute(input, ctx) {
    const pattern = str(input, 'pattern');
    if (!pattern) return { ok: false, output: 'pattern is required' };
    const root = resolve(ctx.cwd, str(input, 'path') ?? '.');
    const includeRaw = str(input, 'include');
    const includeRx = includeRaw ? globToRegExp(includeRaw) : undefined;
    let rx: RegExp;
    try {
      rx = new RegExp(pattern, input['case_insensitive'] === true ? 'i' : '');
    } catch (err) {
      return { ok: false, output: `invalid pattern: ${(err as Error).message}` };
    }
    const lines: string[] = [];
    let matched = 0;
    await walk(root, root, async (abs, rel) => {
      if (includeRx && !includeRx.test(rel)) return false;
      try {
        const info = await stat(abs);
        if (info.size > 2 * 1024 * 1024) return false;
        const text = await readFile(abs, 'utf8');
        if (text.includes('\u0000')) return false;
        const fileLines = text.split('\n');
        for (let i = 0; i < fileLines.length; i++) {
          const line = fileLines[i] as string;
          if (rx.test(line)) {
            lines.push(`${rel}:${i + 1}:${line.slice(0, 300)}`);
            matched++;
            if (matched >= MAX_GREP_MATCHES) return true;
          }
        }
      } catch {
        /* ignore unreadable files */
      }
      return false;
    });
    return {
      ok: true,
      output: lines.length > 0 ? lines.join('\n') : 'no matches',
      meta: { matched },
    };
  },
};

export const __moduleMarker = true;
