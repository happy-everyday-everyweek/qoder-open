import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { McpServerConfig } from '../mcp/types.ts';

// agent profile 的字段来自对上游 worker 产物中 agent 定义构造函数的静态分析。
// 上游字段：kind/name/description/color/promptConfig/modelConfig/runConfig/
// toolConfig/mcpServers/inputConfig/metadata/disallowedTools/skills/effort/
// initialPrompt/permissionMode/hooks/memory/background/isolation。
export interface AgentProfile {
  name: string;
  description?: string;
  color?: string;
  systemPrompt?: string;
  model?: string;
  temperature?: number;
  maxTurns?: number;
  maxTimeMinutes?: number;
  tools?: string[];
  disallowedTools?: string[];
  mcpServers?: McpServerConfig[];
  skills?: string[];
  effort?: string;
  initialPrompt?: string;
  permissionMode?: string;
  hooks?: Record<string, unknown>;
  memory?: unknown;
  background?: boolean;
  isolation?: string;
  inputSchema?: Record<string, unknown>;
  filePath?: string;
}

function parseFrontmatter(raw: string): { meta: Record<string, string>; body: string } {
  if (!raw.startsWith('---')) return { meta: {}, body: raw };
  const end = raw.indexOf('\n---', 3);
  if (end < 0) return { meta: {}, body: raw };
  const header = raw.slice(3, end);
  const body = raw.slice(end + 4).replace(/^\n/, '');
  const meta: Record<string, string> = {};
  for (const line of header.split('\n')) {
    const idx = line.indexOf(':');
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim().replace(/^["']|["']$/g, '');
    if (key.length > 0) meta[key] = value;
  }
  return { meta, body };
}

function fromJson(raw: string, filePath: string): AgentProfile | undefined {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const name = typeof parsed['name'] === 'string' ? parsed['name'] : undefined;
    if (!name) return undefined;
    return {
      name,
      ...(typeof parsed['description'] === 'string' ? { description: parsed['description'] } : {}),
      ...(typeof parsed['model'] === 'string' ? { model: parsed['model'] } : {}),
      ...(typeof parsed['temperature'] === 'number' ? { temperature: parsed['temperature'] } : {}),
      ...(typeof parsed['maxTurns'] === 'number' ? { maxTurns: parsed['maxTurns'] } : {}),
      ...(typeof parsed['prompt'] === 'string' ? { systemPrompt: parsed['prompt'] } : {}),
      ...(Array.isArray(parsed['tools']) ? { tools: parsed['tools'] as string[] } : {}),
      ...(Array.isArray(parsed['disallowedTools'])
        ? { disallowedTools: parsed['disallowedTools'] as string[] }
        : {}),
      ...(Array.isArray(parsed['mcpServers'])
        ? { mcpServers: parsed['mcpServers'] as McpServerConfig[] }
        : {}),
      filePath,
    };
  } catch {
    return undefined;
  }
}

// 从目录加载 agent 定义，支持 .md（带 frontmatter）与 .json 两种形式。
export async function loadAgentProfiles(roots: string[]): Promise<AgentProfile[]> {
  const profiles: AgentProfile[] = [];
  for (const root of roots) {
    let entries: string[];
    try {
      entries = await readdir(root);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const filePath = join(root, entry);
      try {
        const info = await stat(filePath);
        if (!info.isFile()) continue;
      } catch {
        continue;
      }
      let raw: string;
      try {
        raw = await readFile(filePath, 'utf8');
      } catch {
        continue;
      }
      if (entry.endsWith('.json')) {
        const profile = fromJson(raw, filePath);
        if (profile) profiles.push(profile);
        continue;
      }
      if (!entry.endsWith('.md')) continue;
      const { meta, body } = parseFrontmatter(raw);
      const name = meta['name'] ?? entry.replace(/\.md$/, '');
      profiles.push({
        name,
        ...(meta['description'] ? { description: meta['description'] } : {}),
        ...(meta['model'] ? { model: meta['model'] } : {}),
        ...(meta['tools']
          ? { tools: meta['tools'].split(',').map((t) => t.trim()).filter((t) => t.length > 0) }
          : {}),
        ...(meta['permission_mode'] ? { permissionMode: meta['permission_mode'] } : {}),
        ...(meta['effort'] ? { effort: meta['effort'] } : {}),
        ...(body.trim().length > 0 ? { systemPrompt: body.trim() } : {}),
        filePath,
      });
    }
  }
  return profiles;
}
