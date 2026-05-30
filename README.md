<div align="center">

# Mech-Code

**An AI-powered coding agent for the terminal — your mechanical partner for developers.**

[中文文档](./README.zh-CN.md)

</div>

---

Mech-Code is an AI-powered coding agent designed to be the ultimate mechanical partner for developers. It seamlessly integrates into your workflow to automate complex tasks, refactor legacy code, and provide intelligent context-aware suggestions—empowering you to ship production-ready software with speed and precision.

## Features

- **Multi-turn conversation** — Maintains full context across an interactive terminal session
- **Streaming output** — Responses appear token-by-token, just like Claude Code
- **Tool use / Function calling** — Define type-safe tools with Zod schemas; the agent invokes them automatically
- **Multi-provider support** — Works with Anthropic, OpenAI, and any OpenAI-compatible endpoint (DeepSeek, Ollama, etc.)
- **MCP integration** — Connect external MCP servers via stdio JSON-RPC to extend the agent's capabilities
- **Middleware pipeline** — Plug in retry, rate-limiting, permissions, and other cross-cutting concerns without touching core logic
- **Multimodal messages** — Pass text, images (base64 / URL), and files in the same conversation
- **Project-level config** — Drop a `.mech.json` in your repo to set the model, system prompt, and enabled skills per project

## Architecture

Mech-Code is a **pnpm monorepo** with an SDK-first design: the core library contains all intelligence, and the CLI is simply a consumer of it.

```
packages/
├── @mech/core      ← Agent loop, providers, tools, MCP client, middleware
├── @mech/cli       ← Terminal UI (React Ink) + config loading + CLI entry
└── @mech/shared    ← Shared types and utilities
```

## Getting Started

> The project is currently under active development. Installation instructions will be added on first release.

**Prerequisites:** Node.js ≥ 20, pnpm ≥ 9

```bash
# Clone the repository
git clone https://github.com/your-username/mech-code.git
cd mech-code

# Install dependencies
pnpm install

# Start all packages in development mode
pnpm dev
```

## Configuration

**Global config** `~/.mech/config.json`:

```json
{
  "default": "anthropic",
  "providers": {
    "anthropic": {
      "model": "claude-sonnet-4-20250514",
      "apiKeyEnv": "ANTHROPIC_API_KEY"
    },
    "deepseek": {
      "baseUrl": "https://api.deepseek.com/v1",
      "model": "deepseek-chat",
      "apiKey": "sk-xxx"
    },
    "local": {
      "baseUrl": "http://localhost:11434/v1",
      "model": "llama3",
      "apiKey": "none"
    }
  }
}
```

**Project config** `.mech.json` (overrides global):

```json
{
  "provider": "anthropic",
  "model": "claude-sonnet-4-20250514",
  "system": "You are a code assistant for this project.",
  "mcp": {
    "servers": {
      "filesystem": { "command": "npx", "args": ["-y", "@mcp/filesystem"] }
    }
  }
}
```

Config priority: **CLI flags > `.mech.json` > `~/.mech/config.json` > environment variables**

## Development

```bash
pnpm dev          # Start all packages in watch mode
pnpm build        # Build all packages
pnpm test         # Run tests (Vitest)
pnpm test:watch   # Run tests in watch mode
pnpm typecheck    # TypeScript type-check
pnpm lint         # ESLint
pnpm lint:fix     # ESLint with auto-fix
```

Commits follow the [Conventional Commits](https://www.conventionalcommits.org/) specification (enforced by commitlint). ESLint and Prettier run automatically on every commit via lint-staged.

## License

MIT

---

<a name="中文"></a>

## 中文

Mech-Code 是一个由 LLM 驱动的终端编程智能体，定位类似 Claude Code，致力于成为开发者最得力的"机械搭档"。它深度融入你的开发工作流，自动化处理复杂任务、重构遗留代码，并提供具备上下文感知能力的智能建议，助你以极高的速度和精度交付生产级代码。

### 特性

- **多轮对话** —— 在交互式终端会话中完整维护上下文
- **流式输出** —— 响应逐 token 实时显示，体验类似 Claude Code
- **工具调用** —— 使用 Zod schema 定义类型安全的工具，智能体自动调用
- **多 Provider 支持** —— 支持 Anthropic、OpenAI 及任意 OpenAI 兼容端点（DeepSeek、Ollama 等）
- **MCP 集成** —— 通过 stdio JSON-RPC 接入外部 MCP 服务，无限扩展智能体能力
- **中间件管道** —— 以可插拔方式接入重试、限流、权限等横切逻辑，不侵入核心代码
- **多模态消息** —— 在同一会话中传入文本、图片（base64 / URL）和文件
- **项目级配置** —— 在仓库根目录放置 `.mech.json`，即可为当前项目单独设定模型、系统提示词和启用的技能

### 架构

Mech-Code 采用 **pnpm monorepo** + **SDK-First** 架构：核心库承载所有智能，CLI 只是 SDK 的消费者。

```
packages/
├── @mech/core      ← Agent Loop、Provider、工具系统、MCP 客户端、中间件
├── @mech/cli       ← 终端 UI（React Ink）+ 配置加载 + CLI 入口
└── @mech/shared    ← 跨包共享类型与工具函数
```

### 快速开始

> 项目正在积极开发中，正式安装说明将在首个发布版本时补充。

**前置要求：** Node.js ≥ 20，pnpm ≥ 9

```bash
# 克隆仓库
git clone https://github.com/your-username/mech-code.git
cd mech-code

# 安装依赖
pnpm install

# 以开发模式启动所有包
pnpm dev
```

### 配置说明

**全局配置** `~/.mech/config.json`：

```json
{
  "default": "anthropic",
  "providers": {
    "anthropic": {
      "model": "claude-sonnet-4-20250514",
      "apiKeyEnv": "ANTHROPIC_API_KEY"
    },
    "deepseek": {
      "baseUrl": "https://api.deepseek.com/v1",
      "model": "deepseek-chat",
      "apiKey": "sk-xxx"
    },
    "local": {
      "baseUrl": "http://localhost:11434/v1",
      "model": "llama3",
      "apiKey": "none"
    }
  }
}
```

**项目级配置** `.mech.json`（覆盖全局）：

```json
{
  "provider": "anthropic",
  "model": "claude-sonnet-4-20250514",
  "system": "You are a code assistant for this project.",
  "mcp": {
    "servers": {
      "filesystem": { "command": "npx", "args": ["-y", "@mcp/filesystem"] }
    }
  }
}
```

配置优先级：**CLI 参数 > `.mech.json` > `~/.mech/config.json` > 环境变量**

### 开发命令

```bash
pnpm dev          # 监听模式启动所有包
pnpm build        # 构建所有包
pnpm test         # 运行测试（Vitest）
pnpm test:watch   # 监听模式运行测试
pnpm typecheck    # TypeScript 类型检查
pnpm lint         # ESLint 检查
pnpm lint:fix     # ESLint 自动修复
```

提交信息遵循 [Conventional Commits](https://www.conventionalcommits.org/zh-hans/) 规范（commitlint 强制执行）。每次提交前 lint-staged 会自动运行 ESLint 和 Prettier。

### 许可证

MIT
