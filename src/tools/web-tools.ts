import type { ToolDefinition } from './types.ts';

const MAX_BYTES = 300_000;
const USER_AGENT = 'qoder-open/0.1 (+https://github.com/happy-everyday-everyweek/qoder-open)';

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// 拉取网页并转为纯文本。上游以 WebFetch 工具提供同等能力。
export const webFetchTool: ToolDefinition = {
  name: 'WebFetch',
  description:
    'Fetch a URL and return its content as plain text. Use it to read documentation or issue pages.',
  readOnly: true,
  parameters: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'Absolute URL to fetch.' },
      max_bytes: { type: 'number', description: 'Maximum bytes to read from the response.' },
    },
    required: ['url'],
  },
  async execute(input, ctx) {
    const url = typeof input['url'] === 'string' ? input['url'] : '';
    if (!/^https?:\/\//.test(url)) return { ok: false, output: 'url must start with http:// or https://' };
    const requested = typeof input['max_bytes'] === 'number' ? input['max_bytes'] : MAX_BYTES;
    const limit = Math.min(MAX_BYTES, Math.max(1024, Math.floor(requested)));
    try {
      const response = await fetch(url, {
        headers: { 'user-agent': USER_AGENT, accept: 'text/html,application/json,text/plain,*/*' },
        redirect: 'follow',
        ...(ctx.signal ? { signal: ctx.signal } : {}),
      });
      if (!response.ok) return { ok: false, output: `HTTP ${response.status} for ${url}` };
      const contentType = response.headers.get('content-type') ?? '';
      const raw = await response.text();
      const trimmed = raw.length > limit ? raw.slice(0, limit) : raw;
      const text = contentType.includes('html') ? stripHtml(trimmed) : trimmed;
      return {
        ok: true,
        title: url,
        output: `${url} (${contentType || 'unknown type'}, ${raw.length} bytes)\n\n${text}`,
      };
    } catch (err) {
      return { ok: false, output: `fetch failed: ${(err as Error).message}` };
    }
  },
};

// 网络检索。上游提供自有检索服务，本实现改为可插拔的搜索后端：
// 配置 QODER_OPEN_SEARCH_URL 时以 GET <url>?q=... 请求，返回 JSON 或纯文本。
export function createWebSearchTool(searchUrl: string | undefined): ToolDefinition {
  return {
    name: 'WebSearch',
    description: 'Search the web and return ranked results with titles, URLs and snippets.',
    readOnly: true,
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query.' },
      },
      required: ['query'],
    },
    async execute(input, ctx) {
      const query = typeof input['query'] === 'string' ? input['query'].trim() : '';
      if (query.length === 0) return { ok: false, output: 'query is required' };
      if (!searchUrl) {
        return {
          ok: false,
          output: 'no search backend configured: set QODER_OPEN_SEARCH_URL',
        };
      }
      const endpoint = `${searchUrl}${searchUrl.includes('?') ? '&' : '?'}q=${encodeURIComponent(query)}`;
      try {
        const response = await fetch(endpoint, {
          headers: { 'user-agent': USER_AGENT, accept: 'application/json,text/plain' },
          ...(ctx.signal ? { signal: ctx.signal } : {}),
        });
        if (!response.ok) return { ok: false, output: `search failed: HTTP ${response.status}` };
        const body = await response.text();
        return { ok: true, title: query, output: body.slice(0, MAX_BYTES) };
      } catch (err) {
        return { ok: false, output: `search failed: ${(err as Error).message}` };
      }
    },
  };
}
