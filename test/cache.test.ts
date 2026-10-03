import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  ResponseCache,
  cacheKey,
  decideCacheability,
  parseCacheControl,
} from '../src/cache/http-cache.ts';

test('cache-control parsing understands the common directives', () => {
  const directives = parseCacheControl('max-age=60, no-cache, must-revalidate');
  assert.equal(directives.maxAgeSeconds, 60);
  assert.equal(directives.noCache, true);
  assert.equal(directives.mustRevalidate, true);
  assert.equal(directives.noStore, false);
});

test('cacheability requires max-age and rejects no-store', () => {
  const cacheable = decideCacheability({ 'cache-control': 'max-age=30', etag: 'abc' }, 1000);
  assert.equal(cacheable.cacheable, true);
  assert.equal(cacheable.deleteAt, 31000);
  assert.equal(cacheable.etag, 'abc');

  const blocked = decideCacheability({ 'cache-control': 'no-store, max-age=60' });
  assert.equal(blocked.cacheable, false);

  const noMaxAge = decideCacheability({ 'cache-control': 'public' });
  assert.equal(noMaxAge.cacheable, false);
});

test('cache key includes method, url and vary headers', () => {
  const a = cacheKey('GET', 'https://x/y', { accept: 'json' });
  const b = cacheKey('GET', 'https://x/y', { accept: 'json' });
  const c = cacheKey('GET', 'https://x/y', { accept: 'text' });
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.match(a, /^GET\nhttps:\/\/x\/y/);
});

test('response cache stores, expires and purges entries', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'qoder-open-cache-'));
  const cache = new ResponseCache(dir);
  const key = cacheKey('GET', 'https://example.com/a');
  await cache.put({
    key,
    statusCode: 200,
    headers: { 'content-type': 'application/json' },
    body: '{}',
    createdAt: 0,
    deleteAt: 1000,
  });
  assert.ok(await cache.get(key, 500));
  assert.equal(await cache.get(key, 2000), undefined);

  await cache.put({ key: 'k2', statusCode: 200, headers: {}, body: 'x', createdAt: 0, deleteAt: 10 });
  const purged = await cache.purgeExpired(50);
  assert.equal(purged, 1);
  await cache.flush();
});
