// MCP 服务器配置。字段命名沿用上游客户端对 mcpServers 条目的枚举结果：
// http_url、headers、tcp、type、timeout、trust、description、include_tools、exclude_tools。
export interface McpServerConfig {
  name: string;
  type?: 'http' | 'tcp';
  httpUrl?: string;
  headers?: Record<string, string>;
  tcp?: string;
  timeoutMs?: number;
  trust?: boolean;
  description?: string;
  includeTools?: string[];
  excludeTools?: string[];
}

export interface McpToolDescriptor {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}
