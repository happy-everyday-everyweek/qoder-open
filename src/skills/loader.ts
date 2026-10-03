import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

export interface Skill {
  name: string;
  description: string;
  dir: string;
  body: string;
  // frontmatter 中的其他字段
  meta: Record<string, string>;
}

// 解析 SKILL.md 的 YAML frontmatter（仅支持简单的 key: value 形式）
function parseFrontmatter(raw: string): { meta: Record<string, string>; body: string } {
  if (!raw.startsWith('---')) return { meta: {}, body: raw };
  const end = raw.indexOf('\n---', 3);
  if (end < 0) return { meta: {}, body: raw };
  const header = raw.slice(3, end);
  const body = raw.slice(end + 4).replace(/^\n/, '');
  const meta: Record<string, string> = {};
  for (const line of header.split('\n')) {
    const idx = line.indexOf(':');
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim().replace(/^["']|["']$/g, '');
    if (key.length > 0) meta[key] = value;
  }
  return { meta, body };
}

// 从若干根目录加载技能。上游在运行时内置 skill-creator、agent-creator、sdk、
// hook-config、security-scan 等技能包，并以 SKILL.md 描述每个技能的适用场景。
export async function loadSkills(roots: string[]): Promise<Skill[]> {
  const skills: Skill[] = [];
  for (const root of roots) {
    let entries: string[];
    try {
      entries = await readdir(root);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const dir = join(root, entry);
      try {
        const info = await stat(dir);
        if (!info.isDirectory()) continue;
      } catch {
        continue;
      }
      const file = join(dir, 'SKILL.md');
      let raw: string;
      try {
        raw = await readFile(file, 'utf8');
      } catch {
        continue;
      }
      const { meta, body } = parseFrontmatter(raw);
      skills.push({
        name: meta['name'] ?? entry,
        description: meta['description'] ?? '',
        dir,
        body,
        meta,
      });
    }
  }
  return skills;
}

// 生成可注入系统提示的技能索引
// 只列出名称与描述，正文在需要时单独读取，避免上下文膨胀。
export function renderSkillIndex(skills: Skill[]): string {
  if (skills.length === 0) return '';
  const lines = skills.map((s) => `- ${s.name}: ${s.description || '(no description)'}`);
  return ['Available skills (read the skill directory before applying one):', ...lines].join('\n');
}
