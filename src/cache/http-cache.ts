import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

// HTTP 响应缓存。上游客户端把缓存落在 SQLite 表 cacheInterceptorV3 中，
// 字段包含 body、deleteAt、statusCode、statusMessage、headers、etag、
// cacheControlDirectives。本实现用 JSON 快照文件承载相同语义。
export interface CacheEntry {
  key: string;
  statusCode: number;
  headers: Record<string, string>;
  body: string;
  etag?: string;
  createdAt: number;
  deleteAt?: number;
}

export interface CacheControlDirectives {
  noStore: boolean;
  noCache: boolean;
  maxAgeSeconds?: number;
  mustRevalidate: boolean;
}

export function parseCacheControl(value: string | null | undefined): CacheControlDirectives {
  const out: CacheControlDirectives = { noStore: false, noCache: false, mustRevalidate: false };
  if (!value) return out;
  for (const raw of value.split(',')) {
    const token = raw.trim().toLowerCase();
    if (token === 'no-store') out.noStore = true;
    else if (token === 'no-cache') out.noCache = true;
    else if (token === 'must-revalidate') out.mustRevalidate = true;
    else if (token.startsWith('max-age=')) {
      const seconds = Number.parseInt(token.slice('max-age='.length), 10);
      if (Number.isFinite(seconds) && seconds >= 0) out.maxAgeSeconds = seconds;
    }
  }
  return out;
}

export function cacheKey(method: string, url: string, varyHeaders: Record<string, string> = {}): string {
  const parts = [method.toUpperCase(), url];
  for (const key of Object.keys(varyHeaders).sort()) {
    parts.push(`${key}:${varyHeaders[key]}`);
  }
  return parts.join('\n');
}

// 以 JSON 快照形式持久化的缓存存储。写入采用整文件重写，
// 适用于配置、文档与模型元信息这类低频率的请求。
export class ResponseCache {
  private readonly file: string;
  private entries = new Map<string, CacheEntry>();
  private loaded = false;
  private dirty = false;

  constructor(baseDir: string, file = 'http-cache.json') {
    this.file = `${baseDir}/${file}`;
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    try {
      const raw = await readFile(this.file, 'utf8');
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        for (const item of parsed as CacheEntry[]) {
          if (item && typeof item.key === 'string') this.entries.set(item.key, item);
        }
      }
    } catch {
      // 无缓存文件或损坏时以空缓存开始
    }
    this.loaded = true;
  }

  async flush(): Promise<void> {
    if (!this.dirty) return;
    await mkdir(dirname(this.file), { recursive: true });
    await writeFile(this.file, JSON.stringify([...this.entries.values()]), 'utf8');
    this.dirty = false;
  }

  async get(key: string, now = Date.now()): Promise<CacheEntry | undefined> {
    await this.ensureLoaded();
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (typeof entry.deleteAt === 'number' && entry.deleteAt <= now) {
      this.entries.delete(key);
      this.dirty = true;
      return undefined;
    }
    return entry;
  }

  async put(entry: CacheEntry): Promise<void> {
    await this.ensureLoaded();
    this.entries.set(entry.key, entry);
    this.dirty = true;
  }

  async delete(key: string): Promise<void> {
    await this.ensureLoaded();
    if (this.entries.delete(key)) this.dirty = true;
  }

  async purgeExpired(now = Date.now()): Promise<number> {
    await this.ensureLoaded();
    let removed = 0;
    for (const [key, entry] of this.entries) {
      if (typeof entry.deleteAt === 'number' && entry.deleteAt <= now) {
        this.entries.delete(key);
        removed++;
      }
    }
    if (removed > 0) this.dirty = true;
    return removed;
  }
}

// 依据响应头决定该响应可否缓存及其失效时刻。
export function decideCacheability(
  headers: Record<string, string>,
  now = Date.now(),
): { cacheable: boolean; deleteAt?: number; etag?: string } {
  const directives = parseCacheControl(
    headers['cache-control'] ?? headers['Cache-Control'] ?? null,
  );
  if (directives.noStore || directives.noCache) return { cacheable: false };
  const maxAge = directives.maxAgeSeconds;
  if (typeof maxAge !== 'number') return { cacheable: false };
  const etag = headers['etag'] ?? headers['ETag'];
  return {
    cacheable: true,
    deleteAt: now + maxAge * 1000,
    ...(etag ? { etag } : {}),
  };
}
