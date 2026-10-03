import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import type { ToolDefinition } from './types.ts';

const MAX_READ_BYTES = 512 * 1024;
const MAX_LINES = 4000;

function toAbsolute(ctx: { cwd: string }, path: string): string {
  return isAbsolute(path) ? path : resolve(ctx.cwd, path);
}

function str(input: Record<string, unknown>, key: string): string | undefined {
  const v = input[key];
  return typeof v === 'string' ? v : undefined;
}

function num(input: Record<string, unknown>, key: string): number | undefined {
  const v = input[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

export const readTool: ToolDefinition = {
  name: 'Read',
  description:
    'Read a file from the local filesystem. Returns the contents with line numbers. ' +
    'Use offset and limit to read part of a large file.',
  readOnly: true,
  parameters: {
    type: 'object',
    properties: {
      file_path: { type: 'string', description: 'Absolute path of the file to read.' },
      offset: { type: 'number', description: 'Line number to start reading from (1-based).' },
      limit: { type: 'number', description: 'Maximum number of lines to read.' },
    },
    required: ['file_path'],
  },
  async execute(input, ctx) {
    const p = str(input, 'file_path');
    if (!p) return { ok: false, output: 'file_path is required' };
    const abs = toAbsolute(ctx, p);
    try {
      const info = await stat(abs);
      if (info.isDirectory()) return { ok: false, output: `not a file: ${abs}` };
      if (info.size > MAX_READ_BYTES) {
        return { ok: false, output: `file too large (${info.size} bytes): ${abs}` };
      }
      const text = await readFile(abs, 'utf8');
      const lines = text.split('\n');
      const offset = Math.max(1, Math.floor(num(input, 'offset') ?? 1));
      const limit = Math.min(MAX_LINES, Math.max(1, Math.floor(num(input, 'limit') ?? lines.length)));
      const slice = lines.slice(offset - 1, offset - 1 + limit);
      const width = String(offset + slice.length - 1).length;
      const body = slice
        .map((line, i) => `${String(offset + i).padStart(width, ' ')}\t${line}`)
        .join('\n');
      const truncated = offset - 1 + slice.length < lines.length;
      return {
        ok: true,
        title: abs,
        output: body + (truncated ? `\n... (${lines.length - (offset - 1 + slice.length)} more lines)` : ''),
      };
    } catch (err) {
      return { ok: false, output: `read failed: ${(err as Error).message}` };
    }
  },
};

export const writeTool: ToolDefinition = {
  name: 'Write',
  description:
    'Write a file to the local filesystem, replacing any existing content. ' +
    'Prefer Edit for modifying existing files.',
  parameters: {
    type: 'object',
    properties: {
      file_path: { type: 'string', description: 'Absolute path of the file to write.' },
      content: { type: 'string', description: 'Full content to write.' },
    },
    required: ['file_path', 'content'],
  },
  async execute(input, ctx) {
    const p = str(input, 'file_path');
    const content = str(input, 'content');
    if (!p || content === undefined) return { ok: false, output: 'file_path and content are required' };
    const abs = toAbsolute(ctx, p);
    try {
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, content, 'utf8');
      return { ok: true, title: abs, output: `wrote ${content.length} chars to ${abs}` };
    } catch (err) {
      return { ok: false, output: `write failed: ${(err as Error).message}` };
    }
  },
};

export const editTool: ToolDefinition = {
  name: 'Edit',
  description:
    'Replace an exact string in a file. The old_string must match exactly and must be unique ' +
    'in the file unless replace_all is true.',
  parameters: {
    type: 'object',
    properties: {
      file_path: { type: 'string', description: 'Absolute path of the file to edit.' },
      old_string: { type: 'string', description: 'Exact text to replace.' },
      new_string: { type: 'string', description: 'Replacement text.' },
      replace_all: { type: 'boolean', description: 'Replace every occurrence instead of requiring uniqueness.' },
    },
    required: ['file_path', 'old_string', 'new_string'],
  },
  async execute(input, ctx) {
    const p = str(input, 'file_path');
    const oldStr = str(input, 'old_string');
    const newStr = str(input, 'new_string');
    if (!p || oldStr === undefined || newStr === undefined) {
      return { ok: false, output: 'file_path, old_string and new_string are required' };
    }
    if (oldStr === newStr) return { ok: false, output: 'old_string and new_string are identical' };
    const abs = toAbsolute(ctx, p);
    const replaceAll = input['replace_all'] === true;
    try {
      const text = await readFile(abs, 'utf8');
      const occurrences = text.split(oldStr).length - 1;
      if (occurrences === 0) return { ok: false, output: `old_string not found in ${abs}` };
      if (occurrences > 1 && !replaceAll) {
        return {
          ok: false,
          output: `old_string appears ${occurrences} times in ${abs}; make it unique or set replace_all`,
        };
      }
      const updated = replaceAll
        ? text.split(oldStr).join(newStr)
        : text.replace(oldStr, newStr);
      await writeFile(abs, updated, 'utf8');
      return {
        ok: true,
        title: abs,
        output: `replaced ${replaceAll ? occurrences : 1} occurrence(s) in ${abs}`,
        meta: { occurrences },
      };
    } catch (err) {
      return { ok: false, output: `edit failed: ${(err as Error).message}` };
    }
  },
};
