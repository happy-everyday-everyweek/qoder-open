import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export type MemoryKind = 'user' | 'feedback' | 'project' | 'reference' | 'journal';

export interface MemoryEntry {
  id: string;
  kind: MemoryKind;
  text: string;
  createdAt: string;
  tags?: string[];
}

// 记忆存储：JSONL 追加写入，便于审计与逐步整理。
// 对应上游运行时的三类机制：当日记忆（journal）、记忆复核（review）、
// 记忆整理（consolidation）。本实现只做存储与检索，整理策略由上层决定。
export class MemoryStore {
  private readonly file: string;

  constructor(private readonly baseDir: string, file = 'memory.jsonl') {
    this.file = join(baseDir, file);
  }

  private get path(): string {
    return this.file;
  }

  async append(entry: Omit<MemoryEntry, 'id' | 'createdAt'> & { id?: string; createdAt?: string }): Promise<MemoryEntry> {
    const full: MemoryEntry = {
      id: entry.id ?? `m_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      kind: entry.kind,
      text: entry.text,
      createdAt: entry.createdAt ?? new Date().toISOString(),
      ...(entry.tags ? { tags: entry.tags } : {}),
    };
    await mkdir(dirname(this.path), { recursive: true });
    await appendFile(this.path, `${JSON.stringify(full)}\n`, 'utf8');
    return full;
  }

  async all(): Promise<MemoryEntry[]> {
    try {
      const raw = await readFile(this.path, 'utf8');
      const out: MemoryEntry[] = [];
      for (const line of raw.split('\n')) {
        const trimmed = line.trim();
        if (trimmed.length === 0) continue;
        try {
          out.push(JSON.parse(trimmed) as MemoryEntry);
        } catch {
          // 忽略损坏行，保证后续条目仍可读
        }
      }
      return out;
    } catch {
      return [];
    }
  }

  // 简单关键词检索：按词频与时间倒序打分
  async search(query: string, limit = 10): Promise<MemoryEntry[]> {
    const terms = query
      .toLowerCase()
      .split(/\s+/)
      .filter((t) => t.length > 1);
    const entries = await this.all();
    const scored = entries.map((entry) => {
      const haystack = `${entry.text} ${(entry.tags ?? []).join(' ')}`.toLowerCase();
      let score = 0;
      for (const term of terms) {
        if (haystack.includes(term)) score += 1;
      }
      return { entry, score };
    });
    return scored
      .filter((s) => (terms.length === 0 ? true : s.score > 0))
      .sort((a, b) => b.score - a.score || b.entry.createdAt.localeCompare(a.entry.createdAt))
      .slice(0, limit)
      .map((s) => s.entry);
  }

  // 记忆整理：根据整理结果重写存储文件
  async replaceAll(entries: MemoryEntry[]): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const body = entries.map((e) => JSON.stringify(e)).join('\n');
    await writeFile(this.path, body.length > 0 ? `${body}\n` : '', 'utf8');
  }
}
