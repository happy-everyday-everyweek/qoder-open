import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  LOOP_DYNAMIC_MARK,
  LOOP_FILE_LIMIT,
  LOOP_MARK,
  parseLoopDefinition,
  renderLoopInjection,
} from '../src/session/loop.ts';
import { estimateTokens, resolveCompactThreshold, trimToolOutputs } from '../src/agent/context.ts';
import type { ChatMessage } from '../src/model/types.ts';

test('loop definition splits static and dynamic parts', () => {
  const def = parseLoopDefinition('static part\n<!-- dynamic -->\ndynamic part');
  assert.equal(def.staticPart, 'static part');
  assert.equal(def.dynamicPart, 'dynamic part');
  const rendered = renderLoopInjection(def);
  assert.match(rendered, new RegExp(LOOP_MARK.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(rendered, new RegExp(LOOP_DYNAMIC_MARK.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('loop definition is truncated at the documented limit', () => {
  const def = parseLoopDefinition('x'.repeat(LOOP_FILE_LIMIT + 500));
  assert.equal(def.truncated, true);
  assert.equal(def.raw.length, LOOP_FILE_LIMIT);
});

test('compact threshold resolves by longest model prefix', () => {
  const caps = { claude: 160000, 'claude-sonnet': 200000 };
  assert.equal(resolveCompactThreshold('claude-sonnet-4-5', caps, 60000), 200000);
  assert.equal(resolveCompactThreshold('claude-opus-4', caps, 60000), 160000);
  assert.equal(resolveCompactThreshold('gpt-5', caps, 60000), 60000);
});

test('trimToolOutputs keeps recent tool messages intact', () => {
  const messages: ChatMessage[] = [];
  for (let i = 0; i < 10; i++) {
    messages.push({ role: 'tool', toolCallId: `c${i}`, content: 'y'.repeat(5000) });
  }
  const trimmed = trimToolOutputs(messages, 1000, 2);
  const first = trimmed[0] as ChatMessage;
  const last = trimmed[trimmed.length - 1] as ChatMessage;
  assert.ok(String(first.content).length < 5000);
  assert.equal(String(last.content).length, 5000);
  assert.ok(estimateTokens(trimmed) < estimateTokens(messages));
});
