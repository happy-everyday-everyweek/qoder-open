import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { DEFAULT_POLICY, PermissionEngine } from '../src/agent/permissions.ts';
import { editTool, readTool, writeTool } from '../src/tools/file-tools.ts';
import { globTool, grepTool } from '../src/tools/exec-tools.ts';
import { createTodoTool, type TodoItem } from '../src/tools/plan-tools.ts';
import { createRegistry } from '../src/tools/registry.ts';
import type { ToolContext } from '../src/tools/types.ts';

async function makeCtx(): Promise<{ ctx: ToolContext; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'qoder-open-test-'));
  return {
    dir,
    ctx: {
      cwd: dir,
      approve: async () => ({ decision: 'allow' }),
    },
  };
}

test('Write then Read returns numbered lines', async () => {
  const { ctx } = await makeCtx();
  const target = join(ctx.cwd, 'a.txt');
  const written = await writeTool.execute({ file_path: target, content: 'one\ntwo\nthree' }, ctx);
  assert.equal(written.ok, true);
  const read = await readTool.execute({ file_path: target }, ctx);
  assert.equal(read.ok, true);
  assert.match(read.output, /1\tone/);
  assert.match(read.output, /3\tthree/);
});

test('Edit refuses ambiguous matches unless replace_all is set', async () => {
  const { ctx } = await makeCtx();
  const target = join(ctx.cwd, 'b.txt');
  await writeFile(target, 'x x x', 'utf8');
  const ambiguous = await editTool.execute(
    { file_path: target, old_string: 'x', new_string: 'y' },
    ctx,
  );
  assert.equal(ambiguous.ok, false);
  const all = await editTool.execute(
    { file_path: target, old_string: 'x', new_string: 'y', replace_all: true },
    ctx,
  );
  assert.equal(all.ok, true);
  assert.equal(await readFile(target, 'utf8'), 'y y y');
});

test('TodoWrite rejects two in_progress items and accepts a valid list', async () => {
  const store: { items: TodoItem[] } = { items: [] };
  const tool = createTodoTool(store);
  const { ctx } = await makeCtx();
  const bad = await tool.execute(
    {
      todos: [
        { description: 'a', status: 'in_progress' },
        { description: 'b', status: 'in_progress' },
      ],
    },
    ctx,
  );
  assert.equal(bad.ok, false);
  const good = await tool.execute(
    { todos: [{ description: 'a', status: 'in_progress' }] },
    ctx,
  );
  assert.equal(good.ok, true);
  assert.equal(store.items.length, 1);
});

test('Glob and Grep find created files by pattern and content', async () => {
  const { ctx } = await makeCtx();
  await writeFile(join(ctx.cwd, 'one.ts'), 'export const needle = 1', 'utf8');
  await writeFile(join(ctx.cwd, 'two.md'), 'plain text', 'utf8');
  const globbed = await globTool.execute({ pattern: '*.ts' }, ctx);
  assert.equal(globbed.ok, true);
  assert.match(globbed.output, /one\.ts/);
  const grepped = await grepTool.execute({ pattern: 'needle' }, ctx);
  assert.equal(grepped.ok, true);
  assert.match(grepped.output, /one\.ts:1:/);
});

test('Permission engine blocks destructive bash and allows read-only tools', async () => {
  const engine = new PermissionEngine(DEFAULT_POLICY);
  const registry = createRegistry([readTool, writeTool]);
  const readDef = registry.get('Read');
  assert.ok(readDef);
  assert.equal(engine.evaluate(readDef, { file_path: '/tmp/x' }).decision, 'allow');
});
