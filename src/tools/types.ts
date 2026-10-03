// 工具层公共类型。
//
// 权限模型参照上游运行时：每次工具调用都产生一条判定结果，
// 判定包含行为（allow / deny / ask）、自然语言约束与理由。

export type PermissionDecision = 'allow' | 'deny' | 'ask';

export interface PermissionVerdict {
  decision: PermissionDecision;
  constraints?: string;
  rationale?: string;
}

// 单次工具调用所处的运行环境
// 单次工具调用所处的运行上下文
export interface ToolContext {
  cwd: string;
  signal?: AbortSignal;
  askUser?: (question: string) => Promise<boolean>;
  approve: (tool: string, input: Record<string, unknown>) => Promise<PermissionVerdict>;
}

export interface ToolResult {
  ok: boolean;
  output: string;
  // 可选项，供上层做展示或统计
  title?: string;
  meta?: Record<string, unknown>;
}

export interface ToolDefinition {
  name: string;
  description: string;
  // JSON Schema 片段，直接作为模型侧参数定义
  parameters: Record<string, unknown>;
  // 只读工具可与写入类工具并发执行
  readOnly?: boolean;
  execute(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}

export interface ToolRegistry {
  list(): ToolDefinition[];
  get(name: string): ToolDefinition | undefined;
  schemas(): { name: string; description: string; parameters: Record<string, unknown> }[];
}
