import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { runAgent } from '../src/agent/loop.ts';
import { DEFAULT_POLICY, PermissionEngine } from '../src/agent/permissions.ts';
import type { ModelProvider, ModelRequest, StreamEvent, ToolCallRequest } from '../src/model/types.ts';
import { readTool, writeTool } from '../src/tools/file-tools.ts';
import { createRegistry } from '../src/tools/registry.ts';

// 模拟模型：第一回合请求写文件，第二回合给出最终文本。
class ScriptedProvider implements ModelProvider {
  readonly id = 'scripted';
  readonly defaultModel = 'scripted-model';
  private turn = 0;
  readonly seen: ModelRequest[] = [];
  private readonly calls: ToolCallRequest[][];

  constructor(calls: ToolCallRequest[][]) {
    this.calls = calls;
  }

  async *stream(request: ModelRequest): AsyncIterable<StreamEvent> {
    const toolCalls = this.calls[this.turn] ?? [];
    this.seen.push(request);
    this.turn++;
    for (const call of toolCalls) {
      yield { kind: 'toolCall', toolCall: call };
    }
    if (toolCalls.length === 0) {
      yield { kind: 'text', text: 'all done' };
      yield { kind: 'done', finishReason: 'stop' };
      return;
    }
    yield { kind: 'done', finishReason: 'tool_calls' };
  }
}

test('agent loop executes tool calls and feeds results back to the model', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'qoder-open-agent-'));
  const target = join(dir, 'out.txt');
  const provider = new ScriptedProvider([
    [
      {
        id: 'call_1',
        name: 'Write',
        arguments: JSON.stringify({ file_path: target, content: 'hello from tool' }),
      },
    ],
    [],
  ]);
  const registry = createRegistry([readTool, writeTool]);
  const permissions = new PermissionEngine({ ...DEFAULT_POLICY, skipConfirmation: true });

  const result = await runAgent({
    provider,
    registry,
    permissions,
    cwd: dir,
    systemPrompt: 'test',
    model: 'scripted-model',
  });

  assert.equal(await readFile(target, 'utf8'), 'hello from tool');
  assert.equal(result.turns, 2);
  const toolMessages = result.messages.filter((m) => m.role === 'tool');
  assert.equal(toolMessages.length, 1);
  assert.equal(toolMessages[0]?.toolCallId, 'call_1');
  // 第二回合的请求应当带上第一回合的工具结果
  assert.ok(provider.seen.length >= 2);
  const secondRequest = provider.seen[1];
  assert.ok(secondRequest?.messages.some((m) => m.role === 'tool'));
});

test('agent loop stops at maxTurns when the model keeps calling tools', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'qoder-open-agent-max-'));
  const always = (n: number): ToolCallRequest[][] =>
    Array.from({ length: n + 1 }, () => [
      {
        id: 'call_x',
        name: 'Read',
        arguments: JSON.stringify({ file_path: join(dir, 'missing.txt') }),
      },
    ]);
  const provider = new ScriptedProvider(always(5));
  const registry = createRegistry([readTool]);
  const permissions = new PermissionEngine({ ...DEFAULT_POLICY, skipConfirmation: true });

  const result = await runAgent({
    provider,
    registry,
    permissions,
    cwd: dir,
    systemPrompt: 'test',
    maxTurns: 3,
  });

  assert.equal(result.turns, 3);
});
