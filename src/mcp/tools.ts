import { readFile } from 'node:fs/promises';
import type { ToolDefinition } from '../tools/types.ts';
import { McpHttpClient } from './client.ts';
import type { McpServerConfig, McpToolDescriptor } from './types.ts';

function isAllowed(config: McpServerConfig, toolName: string): boolean {
  if (config.excludeTools?.includes(toolName)) return false;
  if (config.includeTools && config.includeTools.length > 0) {
    return config.includeTools.includes(toolName);
  }
  return true;
}

// 把 MCP 工具包装为本地工具，命名为 mcp__<server>__<tool>，
// 避免与内置工具重名，并保留 include/exclude 裁剪。
export async function loadMcpTools(
  configs: McpServerConfig[],
): Promise<{ tools: ToolDefinition[]; errors: string[] }> {
  const tools: ToolDefinition[] = [];
  const errors: string[] = [];

  for (const config of configs) {
    if ((config.type ?? 'http') !== 'http' || !config.httpUrl) {
      errors.push(`mcp server ${config.name}: only http transport is supported`);
      continue;
    }
    const client = new McpHttpClient(config);
    let descriptors: McpToolDescriptor[];
    try {
      descriptors = await client.listTools();
    } catch (err) {
      errors.push(`mcp server ${config.name}: ${(err as Error).message}`);
      continue;
    }
    for (const descriptor of descriptors) {
      if (!descriptor.name || !isAllowed(config, descriptor.name)) continue;
      const localName = `mcp__${config.name}__${descriptor.name}`;
      tools.push({
        name: localName,
        description:
          descriptor.description ?? `Tool ${descriptor.name} provided by MCP server ${config.name}`,
        parameters: descriptor.inputSchema ?? { type: 'object', properties: {} },
        async execute(input) {
          try {
            const result = await client.callTool(descriptor.name, input);
            return { ok: !result.isError, output: result.text, title: localName };
          } catch (err) {
            return { ok: false, output: `mcp call failed: ${(err as Error).message}` };
          }
        },
      });
    }
  }

  return { tools, errors };
}

// 读取 mcp.json。支持两种形式：{ "mcpServers": { "name": {...} } }
// 或直接的数组形式 [ { "name": ... } ]。
export async function loadMcpConfigFile(path: string): Promise<McpServerConfig[]> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed as McpServerConfig[];
    }
    if (typeof parsed === 'object' && parsed !== null) {
      const record = parsed as Record<string, unknown>;
      const servers = record['mcpServers'];
      if (servers && typeof servers === 'object' && !Array.isArray(servers)) {
        return Object.entries(servers as Record<string, unknown>).map(([name, value]) => {
          const entry = (value ?? {}) as Record<string, unknown>;
          return {
            name,
            ...(typeof entry['type'] === 'string' ? { type: entry['type'] as 'http' | 'tcp' } : {}),
            ...(typeof entry['http_url'] === 'string' ? { httpUrl: entry['http_url'] } : {}),
            ...(typeof entry['headers'] === 'object' && entry['headers'] !== null
              ? { headers: entry['headers'] as Record<string, string> }
              : {}),
            ...(typeof entry['timeout'] === 'number' ? { timeoutMs: entry['timeout'] } : {}),
            ...(typeof entry['trust'] === 'boolean' ? { trust: entry['trust'] } : {}),
            ...(typeof entry['description'] === 'string' ? { description: entry['description'] } : {}),
            ...(Array.isArray(entry['include_tools'])
              ? { includeTools: entry['include_tools'] as string[] }
              : {}),
            ...(Array.isArray(entry['exclude_tools'])
              ? { excludeTools: entry['exclude_tools'] as string[] }
              : {}),
          };
        });
      }
    }
  } catch {
    return [];
  }
  return [];
}
