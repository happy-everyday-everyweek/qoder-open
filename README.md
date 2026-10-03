# qoder-open

面向真实开发场景的 agentic coding harness 开源实现。

本项目的接口形态、工具集与运行时机制，来自对 Qoder 桌面客户端（产品版本 0.4.3，构建于 2026-09-26 的 Windows x64 安装包）的静态分析。分析过程与结论记录在姊妹仓库 `qoder-re` 的 docs 目录。

## 与上游的关系

本项目不是 Qoder 的官方项目，也未获得其授权，仓库中不包含任何原厂代码或二进制。实现对已被本项目分析记录的协议与机制做了独立重写。原厂产品的商标与版权归其所有者所有。

## 已实现

模型层支持两种协议形态：OpenAI 兼容（chat completions 流式）与 Anthropic 兼容（messages 流式），均按增量事件解析文本、推理内容与工具调用。

工具集包含 Read、Write、Edit、Bash、Glob、Grep、TodoWrite、Memory、WebFetch、WebSearch、Task 以及由 MCP 服务器提供的动态工具。

运行时为回合制循环：组装系统提示与历史、流式请求模型、解析工具调用、按权限策略执行、回填结果、进入下一回合，并支持回合上限、上下文裁剪与取消。

权限引擎对每次工具调用给出允许、拒绝或询问，规则可基于工具名与输入内容匹配，并可携带自然语言约束与理由；非交互场景可跳过询问。

记忆以 JSONL 追加存储，支持三种动作：save（含当日记忆）、search（关键词检索）、consolidate（按保留 id 重写存储）。

技能从 SKILL.md 加载并解析 frontmatter，只把索引注入系统提示，避免上下文膨胀。

agent profile 支持从 Markdown 加 frontmatter 或 JSON 定义，可覆盖系统提示、模型、工具白名单与黑名单、技能范围、MCP 服务器、回合上限与初始提示。

MCP 客户端实现 HTTP 传输（JSON-RPC，兼容 SSE 响应），支持按 include_tools 与 exclude_tools 裁剪工具面，远端工具以 `mcp__<server>__<tool>` 命名注入。

## 快速开始

```bash
npm install
npm run build
export QODER_OPEN_API_KEY=sk-...
export QODER_OPEN_BASE_URL=https://api.openai.com/v1
export QODER_OPEN_MODEL=gpt-4o-mini
node dist/index.js "列出这个仓库的目录结构并总结用途"
```

使用 Anthropic 兼容端点：

```bash
export QODER_OPEN_PROVIDER=anthropic-compatible
export QODER_OPEN_BASE_URL=https://api.anthropic.com
export QODER_OPEN_MODEL=claude-sonnet-4-5
node dist/index.js --provider anthropic-compatible "修复 test 目录下失败的用例"
```

以非交互方式运行（跳过权限询问）：

```bash
node dist/index.js -y -p "运行 npm test 并总结失败原因"
```

## 目录约定

```
<cwd>/.qoder-open/memory.jsonl     记忆存储
<cwd>/.qoder-open/mcp.json         MCP 服务器配置
<cwd>/.qoder/skills/<name>/SKILL.md 技能
<cwd>/.qoder/agents/*.md | *.json  agent profile
~/.qoder-open/skills               全局技能
~/.qoder-open/agents               全局 agent profile
```

mcp.json 采用常见的服务器映射形式：

```json
{
  "mcpServers": {
    "files": {
      "type": "http",
      "http_url": "https://example.com/mcp",
      "headers": { "authorization": "Bearer xxx" },
      "timeout": 30000,
      "include_tools": ["read_file"],
      "exclude_tools": ["delete_file"]
    }
  }
}
```

agent profile 示例（Markdown 加 frontmatter）：

```markdown
---
name: reviewer
description: 只做代码评审，不修改文件
tools: Read, Glob, Grep, TodoWrite
permission_mode: read-only
---
你负责评审变更。先阅读相关文件，再给出带行号的问题清单，不要修改任何文件。
```

## 环境变量

| 变量 | 说明 |
| --- | --- |
| QODER_OPEN_API_KEY | 模型密钥，必填 |
| QODER_OPEN_BASE_URL | 端点基址 |
| QODER_OPEN_MODEL | 模型标识 |
| QODER_OPEN_PROVIDER | openai-compatible 或 anthropic-compatible |
| QODER_OPEN_MAX_TURNS | 回合上限 |
| QODER_OPEN_COMPACT_TOKENS | 触发上下文裁剪的估算 token 数 |
| QODER_OPEN_SEARCH_URL | WebSearch 后端地址 |
| QODER_OPEN_YES | 设为 1 等同 --yes |

## 测试与质量

CI 执行 typecheck、构建、CLI 冒烟与单元测试。本地可直接运行：

```bash
npm run typecheck
npm run build
npm test
```

## 路线图

交互式终端界面、本地会话与响应缓存层（对应分析中记录的 cacheInterceptorV3）、hooks 执行器、隔离子代理（isolation 与 background）、以及基于真实模型的端到端评测。

## 许可

Apache-2.0。
