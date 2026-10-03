import type { PermissionVerdict, ToolDefinition } from '../tools/types.ts';

export interface PermissionRule {
  // 工具名，或 * 匹配全部
  tool: string;
  decision: 'allow' | 'deny' | 'ask';
  // 可选：当输入中的字段匹配该正则时才生效
  whenField?: string;
  whenPattern?: string;
  constraints?: string;
  rationale?: string;
}

export interface PermissionPolicy {
  rules: PermissionRule[];
  // 无规则命中时的默认值
  defaultDecision: 'allow' | 'deny' | 'ask';
  // 跳过确认（对应上游的 --dangerously-skip-permissions）
  skipConfirmation?: boolean;
}

export const DEFAULT_POLICY: PermissionPolicy = {
  defaultDecision: 'ask',
  rules: [
    { tool: 'Read', decision: 'allow', rationale: 'reading files is non-destructive' },
    { tool: 'Glob', decision: 'allow', rationale: 'listing file names is non-destructive' },
    { tool: 'Grep', decision: 'allow', rationale: 'searching file contents is non-destructive' },
    { tool: 'TodoWrite', decision: 'allow', rationale: 'the todo list is internal session state' },
    {
      tool: 'Bash',
      decision: 'deny',
      whenField: 'command',
      whenPattern: '(^|\\s)rm\\s+-(rf|fr)\\s+/(\\s|$)',
      constraints: 'recursive deletion of the filesystem root is never permitted',
      rationale: 'destructive command matching a hard block rule',
    },
  ],
};

function matches(rule: PermissionRule, tool: string, input: Record<string, unknown>): boolean {
  if (rule.tool !== '*' && rule.tool !== tool) return false;
  if (!rule.whenField || !rule.whenPattern) return true;
  const value = input[rule.whenField];
  if (typeof value !== 'string') return false;
  try {
    return new RegExp(rule.whenPattern).test(value);
  } catch {
    return false;
  }
}

export class PermissionEngine {
  constructor(private readonly policy: PermissionPolicy = DEFAULT_POLICY) {}

  evaluate(tool: ToolDefinition, input: Record<string, unknown>): PermissionVerdict {
    for (const rule of this.policy.rules) {
      if (!matches(rule, tool.name, input)) continue;
      return {
        decision: rule.decision,
        ...(rule.constraints ? { constraints: rule.constraints } : {}),
        ...(rule.rationale ? { rationale: rule.rationale } : {}),
      };
    }
    if (this.policy.skipConfirmation && this.policy.defaultDecision === 'ask') {
      return {
        decision: 'allow',
        rationale: 'confirmation is skipped by policy',
      };
    }
    if (tool.readOnly && this.policy.defaultDecision === 'ask') {
      return { decision: 'allow', rationale: 'tool is declared read-only' };
    }
    return { decision: this.policy.defaultDecision, rationale: 'no matching rule' };
  }
}
