import { readFile } from 'node:fs/promises';

// loop 定义文件。上游将其上限固定为 8192 字符，并使用两个标记位注入到上下文：
// <<loop.md>> 对应静态部分，<<loop.md-dynamic>> 对应需重新渲染的动态部分。
export const LOOP_FILE_LIMIT = 8192;
export const LOOP_MARK = '<<loop.md>>';
export const LOOP_DYNAMIC_MARK = '<<loop.md-dynamic>>';

export interface LoopDefinition {
  raw: string;
  staticPart: string;
  dynamicPart: string;
  truncated: boolean;
}

// 文件内可选地包含 `<!-- dynamic -->` 分隔线，其后内容视为动态部分。
// 未提供分隔时，全部内容视为静态部分。
export function parseLoopDefinition(raw: string): LoopDefinition {
  const truncated = raw.length > LOOP_FILE_LIMIT;
  const text = truncated ? raw.slice(0, LOOP_FILE_LIMIT) : raw;
  const marker = '<!-- dynamic -->';
  const index = text.indexOf(marker);
  if (index < 0) {
    return { raw: text, staticPart: text.trim(), dynamicPart: '', truncated };
  }
  return {
    raw: text,
    staticPart: text.slice(0, index).trim(),
    dynamicPart: text.slice(index + marker.length).trim(),
    truncated,
  };
}

export async function loadLoopDefinition(path: string): Promise<LoopDefinition | undefined> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    return undefined;
  }
  const parsed = parseLoopDefinition(raw);
  if (parsed.staticPart.length === 0 && parsed.dynamicPart.length === 0) return undefined;
  return parsed;
}

// 渲染注入片段。只注入非空部分，便于在上下文紧张时自行决定是否仅保留动态部分。
export function renderLoopInjection(
  definition: LoopDefinition,
  options: { includeStatic?: boolean; includeDynamic?: boolean } = {},
): string {
  const includeStatic = options.includeStatic ?? true;
  const includeDynamic = options.includeDynamic ?? definition.dynamicPart.length > 0;
  const parts: string[] = [];
  if (includeStatic && definition.staticPart.length > 0) {
    parts.push(`${LOOP_MARK}\n${definition.staticPart}`);
  }
  if (includeDynamic && definition.dynamicPart.length > 0) {
    parts.push(`${LOOP_DYNAMIC_MARK}\n${definition.dynamicPart}`);
  }
  return parts.join('\n\n');
}
